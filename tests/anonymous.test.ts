import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runTrace } from "../extension/src/execution/runner.ts";
import { History } from "../core/snapshots/history.ts";
import { cfg } from "./helpers.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dsv-anon-"));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const CODE = `#include <cstdio>
#include <cstdlib>
struct U { int kind; union { int i; float f; }; int tail; };                          // anonymous union in a struct
union S { struct { short lo, hi; }; int whole; };                                      // anonymous struct in a union
struct Deep { int a; struct { int b; union { int c; char d; }; }; int e; };            // two levels
struct Mixed { int x; union { long l; double dd; }; struct { int p, q; } named; };     // anonymous next to named
int main() {
  U* u = (U*)malloc(sizeof(U)); u->kind = 1; u->i = 42; u->tail = 7;
  S* s = (S*)malloc(sizeof(S)); s->lo = 3; s->hi = 4;
  Deep* d = (Deep*)malloc(sizeof(Deep)); d->a = 1; d->b = 2; d->c = 3; d->e = 5;
  Mixed* m = (Mixed*)malloc(sizeof(Mixed)); m->x = 9; m->l = 11; m->named.p = 1; m->named.q = 2;
  U su; su.kind = 2; su.i = 5; su.tail = 6;                                            // on the stack
  int sink = u->i + s->lo + d->c + (int)m->l + su.i;
  printf("%d\\n", sink);
  free(u); free(s); free(d); free(m);
  return 0;
}
`;
const flat = (v: any): any => (v && typeof v === "object" && v.kind === "struct" ? Object.fromEntries(Object.entries(v.fields).map(([k, x]) => [k, flat(x)])) : v);

async function stateAtPrintf() {
  const file = path.join(tmp, "anon.cpp"); fs.writeFileSync(file, CODE);
  const r = await runTrace(file, cfg);
  const h = new History(r.trace);
  const line = CODE.split("\n").findIndex((t) => t.includes("printf")) + 1;
  const st = h.stateAt(h.steps.findIndex((s) => s.file === "main" && s.line === line));
  const obj = (t: string) => flat({ kind: "struct", fields: (Object.values(st.objects).find((o) => o.type === t) as any).fields });
  return { st, obj };
}

test("anonymous union inside a struct: its members sit next to the named ones", async () => {
  const { obj } = await stateAtPrintf();
  const u = obj("U");
  assert.equal(u.kind, 1); assert.equal(u.tail, 7); assert.equal(u.i, 42); assert.ok("f" in u);
});

test("anonymous struct inside a union", async () => {
  const { obj } = await stateAtPrintf();
  const s = obj("S");
  assert.equal(s.lo, 3); assert.equal(s.hi, 4); assert.ok("whole" in s);
  assert.equal(s.whole, 3 + (4 << 16));          // the union view agrees with the struct view
});

test("two levels of anonymous nesting", async () => {
  const { obj } = await stateAtPrintf();
  const d = obj("Deep");
  assert.deepEqual([d.a, d.b, d.c, d.e], [1, 2, 3, 5]); assert.ok("d" in d);
});

test("anonymous members alongside a named member of an anonymous type (still a field of its own)", async () => {
  const { obj } = await stateAtPrintf();
  const m = obj("Mixed");
  assert.equal(m.x, 9); assert.equal(m.l, 11); assert.ok("dd" in m);
  assert.deepEqual(m.named, { p: 1, q: 2 });
});

test("a stack struct with an anonymous union is read the same way", async () => {
  const { st } = await stateAtPrintf();
  const su = flat(st.frames.at(-1)!.locals.su);
  assert.equal(su.kind, 2); assert.equal(su.i, 5); assert.equal(su.tail, 6);
});

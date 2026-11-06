import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { load, stepAt, scenesAt, chain, ptrTarget, outEdges, cfg } from "./helpers.ts";
import { runTrace, RunnerError, languageOf, makeDriver } from "../extension/src/execution/runner.ts";
import { History } from "../core/snapshots/history.ts";
import { setupTemplate } from "../extension/src/commands/templates.ts";

const printed = (o: string) => o.trim().split(/\s+/);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dsv-ctest-"));
const src = (name: string, code: string) => { const p = path.join(tmp, name); fs.writeFileSync(p, code); return p; };
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test("C BST: in-order of the drawn tree equals program output; BST property holds", async () => {
  const l = await load("c/bst.c");
  const { scenes } = scenesAt(l, stepAt(l, "inorder(root);"));
  const sc = scenes.find((s) => s.kind === "binary-tree")!;
  assert.ok(sc);
  const inorder = (id: string | null | undefined): number[] => {
    if (!id) return [];
    const L = outEdges(sc, id, "left")[0]?.to, R = outEdges(sc, id, "right")[0]?.to;
    return [...inorder(L), Number(sc.nodes.find((n) => n.id === id)!.label), ...inorder(R)];
  };
  const seq = inorder(ptrTarget(sc, "root"));
  assert.deepEqual(seq.map(String), printed(l.output));
  assert.deepEqual(seq, [...seq].sort((a, b) => a - b));
  assert.equal(sc.nodes.length, 5);
});

test("C singly list (malloc/free, typedef'd node): drawn order equals the output; free() leaves no live edge to the freed node", async () => {
  const l = await load("c/singly.c");
  const { scenes } = scenesAt(l, stepAt(l, "for (Node* c = head"));
  const sc = scenes.find((s) => s.kind === "singly-linked-list")!;
  assert.ok(sc);
  assert.deepEqual(chain(sc, ptrTarget(sc, "head")), printed(l.output));            // 1 2 4
  const i = l.history.steps.findIndex((s) => s.events.some((e) => e.type === "object_freed"));
  assert.ok(i >= 0);
  const freed = (l.history.steps[i]!.events.find((e) => e.type === "object_freed") as { addr: string }).addr;
  const sc2 = scenesAt(l, i).scenes.find((s) => s.kind === "singly-linked-list")!;
  assert.equal(sc2.edges.filter((e) => e.to === freed && !e.id.includes("freed")).length, 0);
});

test("C dynamic array grown with realloc: the drawn array holds the printed values; realloc(NULL, n) is the first allocation", async () => {
  const l = await load("c/dynarray.c");
  const { scenes, state } = scenesAt(l, stepAt(l, "for (int i = 0; i < v.len"));
  const arr = scenes.find((s) => s.kind === "array" && s.title.includes("int["))!;
  assert.ok(arr);
  assert.deepEqual(arr.nodes.map((n) => n.label).slice(0, 7), printed(l.output));     // 1 4 9 16 25 36 49 (capacity 8: one unused cell)
  assert.equal(Object.values(state.objects).filter((o) => o.state === "LIVE").length, 1, "only the current block is live; the moved-from blocks are not");
});

test("C hash table (anonymous typedef Table): drawn chains equal the printed chains", async () => {
  const l = await load("c/hash.c");
  const { scenes } = scenesAt(l, stepAt(l, "for (int b = 0"));
  const sc = scenes.find((s) => s.kind === "hash-table")!;
  assert.ok(sc);
  const bucket = (i: number) => { const e = sc.edges.find((x) => x.from === `${sc.id}[${i}]`); return e ? chain(sc, e.to) : []; };
  const lines = l.output.trim().split("\n").map((ln) => ln.split(":")[1]!.trim().split(/\s+/).filter(Boolean).map((kv) => kv.split("=")[0]!));
  for (let b = 0; b < 5; b++) assert.deepEqual(bucket(b), lines[b], `bucket ${b}`);
  assert.deepEqual(bucket(1), ["11", "6", "1"]);
  assert.match(sc.nodes.find((n) => n.label === "6")!.sub ?? "", /val=666/);
});

test("type names: anonymous typedef struct is named by the typedef; 'struct Node' and 'Node' are one type", async () => {
  const l = await load("c/dynarray.c");
  const v = l.history.stateAt(l.history.length - 2).frames[0]!.locals.v as { kind: string; type: string };
  assert.equal(v.type, "Vec");
  const s = await load("c/singly.c");
  const st = s.history.stateAt(stepAt(s, "for (Node* c = head"));
  const types = new Set(Object.values(st.objects).map((o) => o.type));
  assert.deepEqual([...types], ["Node"]);                                            // allocated as Node*, fields declared 'struct Node *'
  const first = Object.values(st.objects).find((o) => o.state === "LIVE")!;
  assert.equal((first.fields!.next as { to?: string }).to, "Node");
});

test("realloc keeps the learned type, whether the block grows in place or moves", async () => {
  // p teaches the tracer 'int'; after p = NULL only the untyped void* q refers to the block, so only the remembered type can keep it drawn.
  const p = src("realloc_types.c", `#include <stdlib.h>
int main(void) {
  int* p = malloc(4 * sizeof(int));
  p[0] = 1; p[1] = 2; p[2] = 3; p[3] = 4;
  void* q = p;
  p = NULL;
  q = realloc(q, 16 * sizeof(int));
  void* r = malloc(8);
  q = realloc(q, 1024);
  free(q);
  free(r);
  return 0;
}
`);
  const r = await runTrace(p, cfg);
  const h = new History(r.trace);
  const at = (line: number) => h.stateAt(h.steps.findIndex((s) => s.file === "main" && s.line === line));
  const live = (st: ReturnType<typeof at>) => Object.values(st.objects).filter((o) => o.state === "LIVE");
  const before = live(at(7))[0]!, inPlace = live(at(8))[0]!, moved = live(at(10))[0]!;     // state observed before each line runs
  assert.equal(before.type, "int[]"); assert.equal(before.elems!.length, 4);
  assert.equal(inPlace.addr, before.addr, "test premise: the block next to the top chunk grows in place");
  assert.equal(inPlace.type, "int[]"); assert.equal(inPlace.elems!.length, 16); assert.deepEqual(inPlace.elems!.slice(0, 4), [1, 2, 3, 4]);
  assert.notEqual(moved.addr, before.addr, "test premise: with a neighbour in the way the block must move");
  assert.equal(moved.type, "int[]"); assert.equal(moved.elems!.length, 256); assert.deepEqual(moved.elems!.slice(0, 4), [1, 2, 3, 4]);
  assert.equal(live(at(10)).length, 1, "only the new block is live");
  assert.equal(at(10).objects[before.addr]!.state, "FREED", "the moved-from block is reported freed, as free() would");
});

test("language is chosen by extension: .c is C, .cpp .cc .cxx .C are C++", () => {
  for (const f of ["a.c", "/x/y/b.c"]) assert.equal(languageOf(f), "c", f);
  for (const f of ["a.cpp", "a.cc", "a.cxx", "a.C", "a.hpp"]) assert.equal(languageOf(f), "c++", f);
});

test("C driver mode: generated main(void), the file's own main() is not run", async () => {
  assert.match(makeDriver("/f.c", "x();", "c"), /int main\(void\) \{/);
  assert.match(makeDriver("/f.cpp", "x();", "c++"), /int main\(\) \{/);
  const p = src("lib.c", `#include <stdlib.h>
typedef struct N { int v; struct N* next; } N;
N* push(N* h, int v) { N* n = malloc(sizeof(N)); n->v = v; n->next = h; return n; }
int main(void) { return 42; }
`);
  const r = await runTrace(p, { ...cfg, entry: { setup: "N* h = NULL;\nh = push(h, 1);\nh = push(h, 2);" } });
  assert.equal(r.trace.end?.exitCode, 0);                       // would be 42 if the file's main() had run
  assert.match(r.sources.driver!, /int main\(void\)/);
  assert.ok(r.trace.steps.some((s) => s.events.some((e) => e.type === "object_created")));
});

test("C is compiled with the C compiler (-std from cStd, -lm linked); a C++-only construct is a compile error", async () => {
  const ok = src("m.c", `#include <math.h>
#include <stdio.h>
int main(void) { volatile double x = 16.0; printf("%g\\n", sqrt(x)); return 0; }
`);
  const r = await runTrace(ok, cfg);
  assert.equal(r.programOutput.trim(), "4");
  const bad = src("bad.c", `int main(void) { int* p = new int(3); return 0; }\n`);
  await assert.rejects(runTrace(bad, cfg), (e: unknown) => e instanceof RunnerError && /compilation failed/.test(e.message));
  const c23 = src("std.c", `int main(void) { int x = 0b101; return x == 5 ? 0 : 1; }\n`);          // binary literals: GNU extension in c11, standard in c23
  assert.equal((await runTrace(c23, { ...cfg, cStd: "c2x" })).trace.end?.exitCode, 0);
  const flag = src("flag.c", `#ifndef DSV_TEST\n#error need the flag\n#endif\nint main(void) { return 0; }\n`);
  assert.equal((await runTrace(flag, { ...cfg, extraCFlags: ["-DDSV_TEST"] })).trace.end?.exitCode, 0);
});

test("setup template: C uses struct syntax (no 'Node obj;' for a plain struct), typedef names are used bare", () => {
  assert.equal(setupTemplate({ kind_: "class", name: "Node" }, "c"), "struct Node obj = {0}; /* use &obj */");
  assert.equal(setupTemplate({ kind_: "class", name: "Vec", typedef: true }, "c"), "Vec obj = {0}; /* use &obj */");
  assert.equal(setupTemplate({ kind_: "class", name: "Node" }, "c++"), "Node obj; /* obj.method(); */");
  assert.equal(setupTemplate({ kind_: "function", name: "push", params: "Node* h, int v" }, "c"), "push(/* Node* h, int v */);");
});

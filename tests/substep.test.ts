import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { runTrace, type RunnerConfig } from "../extension/src/execution/runner.ts";
import { parseTrace } from "../core/events/types.ts";
import type { Step, Value } from "../core/events/types.ts";
import { cfg, root } from "./helpers.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dsv-sub-"));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
let k = 0;
const trace = async (code: string, over: Partial<RunnerConfig> = {}) => {
  const f = path.join(tmp, `p${k++}.cpp`); fs.writeFileSync(f, code);
  return runTrace(f, { ...cfg, ...over });
};
const loc = (s: Step, name: string): Value | undefined => s.frames[0]!.locals[name];
const onLine = (steps: Step[], text: string, code: string) => { const ln = code.split("\n").findIndex((t) => t.includes(text)) + 1; return steps.filter((s) => s.file === "main" && s.line === ln); };

const SWAP = `int main() {
  int a = 1, b = 2, tmp = 0;
  tmp = a; a = b; b = tmp;
  return a + b + tmp;
}
`;

test("one-line swap: three stops, each showing the state after one more statement", async () => {
  const r = await trace(SWAP);
  const st = onLine(r.trace.steps, "tmp = a; a = b", SWAP);
  assert.deepEqual(st.map((s) => s.sub), [undefined, 1, 2]);
  assert.deepEqual(st.map((s) => [loc(s, "a"), loc(s, "b"), loc(s, "tmp")]), [[1, 2, 0], [1, 2, 1], [2, 2, 1]]);
  const next = r.trace.steps.find((s) => s.step === st[2]!.step + 1)!;            // the line after: b = tmp has run
  assert.deepEqual([loc(next, "a"), loc(next, "b"), loc(next, "tmp")], [2, 1, 1]);
  assert.equal(r.trace.end?.subStep?.armedAtEnd, 0);
  assert.equal(r.trace.end?.subStep?.enabled, true);
});

test("sub-stepping off (dsv.subSteps=false): one step per line, no `sub`", async () => {
  const r = await trace(SWAP, { subSteps: false });
  assert.equal(onLine(r.trace.steps, "tmp = a; a = b", SWAP).length, 1);
  assert.ok(r.trace.steps.every((s) => s.sub === undefined));
});

test("a line with calls: stops after each call returns; the callee's own lines are still traced", async () => {
  const code = `int g(int x) { return x + 1; }
int main() {
  int a = 1, b = 10, t = 0;
  a = g(a); b = g(b); t = a + b;
  return t;
}
`;
  const r = await trace(code);
  const subs = r.trace.steps.filter((s) => s.fn === "main" && s.sub !== undefined && s.line === 4);
  assert.deepEqual(subs.map((s) => [s.sub, loc(s, "a"), loc(s, "b"), loc(s, "t")]), [[1, 2, 10, 0], [2, 2, 11, 0]]);
  assert.ok(r.trace.steps.filter((s) => s.fn === "g").length >= 2);
});

test("one-line loop: stops per iteration, loop-condition stops with no change are dropped", async () => {
  const code = `int main() {
  int a = 0, b = 0;
  for (int i = 0; i < 3; i++) { a += i + 1; b += a; }
  return a + b;
}
`;
  const r = await trace(code);
  const st = onLine(r.trace.steps, "for (int i", code);
  const seq = st.map((s) => `${loc(s, "i")}:${loc(s, "a")}:${loc(s, "b")}`);
  assert.deepEqual(seq.slice(0, 5), ["0:0:0", "0:1:0", "0:1:1", "1:1:1", "1:3:1"]);
  assert.ok(st.length > 6);
  assert.ok((r.trace.end?.subStep?.dropped ?? 0) > 0);
  assert.equal(r.trace.end?.subStep?.armedAtEnd, 0);
});

test("INVARIANT: no sub stop repeats the state of the step before it", async () => {
  const r = await trace(SWAP);
  const s = r.trace.steps;
  for (let i = 1; i < s.length; i++) if (s[i]!.sub !== undefined) assert.notDeepEqual(s[i]!.frames, s[i - 1]!.frames);
});

test("budget per line: a line over it is read whole from then on (truncated), the run still finishes with the same result", async () => {
  const code = `int main() {
  int a = 0, b = 0;
  for (int i = 0; i < 50; i++) { a += i; b += a; }
  return a > 0 ? 0 : 1;
}
`;
  const full = await trace(code, { maxSubStepsPerLine: 100000 }), cut = await trace(code, { maxSubStepsPerLine: 6 });
  const st = onLine(cut.trace.steps, "for (int i", code);
  const shown = st.filter((s) => s.sub !== undefined).length;
  assert.ok(shown >= 1 && shown <= 6, `shown ${shown}`);                  // stops that changed nothing count against the budget but are not shown
  assert.equal(cut.trace.end?.subStep?.truncatedLines, 1);
  assert.deepEqual(cut.trace.end?.subStep?.truncated, [["main", 3]]);
  assert.equal(cut.trace.end?.reason, "exited"); assert.equal(full.trace.end?.reason, "exited");
  assert.ok(cut.trace.steps.length < full.trace.steps.length);
  const last = (t: typeof full) => t.trace.steps.at(-1)!.frames[0]!.locals;
  assert.equal(JSON.stringify(last(cut)), JSON.stringify(last(full)));
  assert.equal(cut.trace.end?.subStep?.armedAtEnd, 0);
  const marks = cut.trace.steps.filter((s) => s.subCut);                                   // the cut is visible on exactly one stop, the one that shows the rest whole
  assert.equal(marks.length, 1); assert.deepEqual(marks[0]!.subCut, { why: "line", limit: 6, line: 3 });
  assert.equal(marks[0]!.sub, undefined);
  assert.ok(full.trace.steps.every((s) => !s.subCut));
});

test("budget per run: once spent, lines are read whole", async () => {
  const r = await trace(SWAP, { maxSubStepsPerRun: 1 });
  assert.equal(r.trace.end?.subStep?.budgetExceeded, true);
  assert.equal(r.trace.steps.filter((s) => s.sub !== undefined).length, 1);
  assert.equal(r.trace.end?.reason, "exited");
  const marks = r.trace.steps.filter((s) => s.subCut);
  assert.equal(marks.length, 1); assert.deepEqual(marks[0]!.subCut, { why: "run", limit: 1 });
});

test("recursion: only the frame that owns the line is sub-stepped", async () => {
  const code = `int f(int n) {
  int x = 0, y = 0;
  x = n; y = x + 1; if (n > 0) f(n - 1);
  return y;
}
int main() { f(2); return 0; }
`;
  const r = await trace(code);
  assert.equal(r.trace.end?.reason, "exited");
  for (const s of r.trace.steps.filter((s) => s.fn === "f" && s.sub !== undefined && s.line === 3)) {
    const n = loc(s, "n") as number, x = loc(s, "x") as number;
    assert.equal(x, n);                                         // the sub stop belongs to the frame it reports: x was just set from this frame's n
  }
  assert.equal(r.trace.end?.subStep?.armedAtEnd, 0);
});

test("exception unwinding out of a sub-stepped line removes the row breakpoints", async () => {
  const code = `#include <stdexcept>
int h(int v) { if (v > 0) throw std::runtime_error("x"); return v; }
int main() {
  int a = 0, b = 0;
  try { a = 1; b = h(a); a = 2; } catch (const std::exception&) { b = -1; }
  a = 5; b = 6;
  return 0;
}
`;
  const r = await trace(code);
  assert.equal(r.trace.end?.reason, "exited");
  assert.equal(r.trace.end?.subStep?.armedAtEnd, 0);
  const last = r.trace.steps.find((s) => s.line === 7 && s.file === "main")!;
  assert.deepEqual([loc(last, "a"), loc(last, "b")], [5, 6]);
  assert.ok(r.trace.steps.some((s) => s.line === 6 && s.sub !== undefined));      // sub-stepping went on working after the unwinding
});

test("program exit in the middle of a multi-statement line removes the row breakpoints", async () => {
  const code = `#include <cstdlib>
int main() {
  int a = 0, b = 0;
  a = 1; b = 2; exit(a + b - 3);
  return 1;
}
`;
  const r = await trace(code);
  assert.equal(r.trace.end?.reason, "exited"); assert.equal(r.trace.end?.exitCode, 0);
  assert.equal(r.trace.end?.subStep?.armedAtEnd, 0);
});

test("a line whose rows cannot be read (objdump missing) is read whole, with the reason, and the run does not fail", async () => {
  process.env.DSV_OBJDUMP = "/nonexistent/objdump";
  try {
    const r = await trace(SWAP);
    assert.equal(r.trace.end?.reason, "exited");
    assert.ok(r.trace.steps.every((s) => s.sub === undefined));
    assert.equal(r.trace.end?.subStep?.enabled, false);
    assert.match(r.trace.end?.subStep?.note ?? "", /objdump/);
  } finally { delete process.env.DSV_OBJDUMP; }
});

test("schema: v4 traces (no `sub`, no `subStep`) load without migration; v5 fields are optional; other versions are rejected", () => {
  const v4 = [
    `{"kind":"step","schema":4,"step":0,"fn":"main","file":"main","line":2,"depth":1,"frames":[{"fn":"main","file":"main","line":2,"locals":{"a":1}}],"events":[]}`,
    `{"kind":"step","schema":4,"step":1,"fn":"main","file":"main","line":3,"depth":1,"frames":[{"fn":"main","file":"main","line":3,"d":1,"locals":{"a":2}}],"events":[]}`,
    `{"kind":"end","schema":4,"reason":"exited","exitCode":0}`].join("\n");
  const t = parseTrace(v4);
  assert.equal(t.steps.length, 2); assert.equal(t.steps[1]!.sub, undefined); assert.equal(t.steps[1]!.frames[0]!.locals.a, 2); assert.equal(t.end?.subStep, undefined);
  assert.throws(() => parseTrace(v4.replace(/"schema":4/g, '"schema":3')), /unsupported schema/);
  assert.throws(() => parseTrace(v4.replace(/"schema":4/g, '"schema":6')), /unsupported schema/);
});

// --- the DWARF line-row parser (engine/debugger/linetable.py), on fixtures from real objdump output ---
const lt = (file: string, ...args: string[]) => JSON.parse(execFileSync("python3", ["-I", path.join(root, "engine/debugger/linetable.py"), path.join(root, "tests/fixtures", file), ...args], { encoding: "utf8" }));
test("line-row parser: current binutils layout (rows the GDB line table drops are present)", () => {
  assert.deepEqual(lt("objdump-2.47.txt", "m9.cpp", "5", "0x401162").after, [0x401168, 0x40116e]);            // the swap
  assert.deepEqual(lt("objdump-2.47.txt", "m9.cpp", "7", "0x40118d").after, [0x40119a, 0x4011a7]);            // calls: GDB's table has one row for this line
  assert.equal(lt("objdump-2.47.txt", "m9.cpp", "8", "0x4011b2").after.length, 5);                            // one-line loop
  assert.deepEqual(lt("objdump-2.47.txt", "m9.cpp", "9", "0x4011d1").after, []);                              // a single-row line is left alone
  assert.deepEqual(lt("objdump-2.47.txt", "m9.cpp", "5", "0x401168").after, [0x40116e]);                      // from the middle of a line
  assert.deepEqual(lt("objdump-2.47.txt", "m9.cpp", "6", "0x401162").after, []);                              // the row at addr belongs to another line
});
test("line-row parser: older layout without View/Stmt columns", () => {
  assert.deepEqual(lt("objdump-old.txt", "a.c", "4", "0x1131").after, [0x1138]);
});
test("line-row parser is strict: an unrecognised line is an error, never a partial table", () => {
  assert.match(lt("objdump-bad.txt").error, /not understood/);
});

// --- loop headers whose body is on other lines are not sub-stepped (their stops only repeat the body's first state) ---
const subsOn = (steps: Step[], text: string, code: string) => onLine(steps, text, code).filter((s) => s.sub !== undefined);
const hdr = (src: string) => lt("objdump-2.47.txt", "m9.cpp", "5", "0x401162") && JSON.parse(execFileSync("python3", ["-I", path.join(root, "engine/debugger/linetable.py"), "header", src], { encoding: "utf8" })).header as boolean;

test("loop-header rule on source text: comments are ignored, one-line loops are not headers", () => {
  assert.equal(hdr("  for (int i = 0; i < n; i++) {"), true);
  assert.equal(hdr("  while (c != nullptr)"), true);
  assert.equal(hdr("  for (int i = 0;   // { not a body"), true);                // split header, comment holds a brace
  assert.equal(hdr("      i < n; i++) {"), true);                                // continuation line of a split header
  assert.equal(hdr("  for (auto x : v) /* { */ {"), true);
  assert.equal(hdr("  for (int i = 0; i < n; i++) // { a += i; }"), true);       // the "body" is a comment
  assert.equal(hdr("  for (int i = 0; i < 3; i++) { a += i; b += a; }"), false);
  assert.equal(hdr("  while (c) { x++; }"), false);
  assert.equal(hdr("  for (;;) x++;"), false);
  assert.equal(hdr("  } while (c);"), false);
  assert.equal(hdr("  tmp = a; a = b; b = tmp;"), false);
});

const LOOPS = `int main() {
  int sum = 0, k = 0, j = 0, m = 0;
  for (int i = 0; i < 4; i++) {
    sum += i;
  }
  while (k < 4)
  {
    k++;
  }
  for (j = 0;
       j < 4; j++) {
    sum += j;
  }
  for (int i = 0; i < 4; i++) { // { trailing comment with a brace
    m += i;
  }
  int a = 1, b = 2, t = 0;
  t = a; a = b; b = t;
  return sum + k + m + (a - b) * 0 > 0 ? 0 : 1;
}
`;
test("header-only for/while (also split over lines, with a `{` in a trailing comment) are not sub-stepped; a later swap still is", async () => {
  const r = await trace(LOOPS);
  const lines = LOOPS.split("\n");
  const headers = ["for (int i = 0; i < 4; i++) {", "while (k < 4)", "for (j = 0;", "j < 4; j++) {", "i++) { // {"].map((t) => lines.findIndex((x) => x.includes(t)) + 1);
  assert.ok(headers.every((n) => n > 0));
  for (const n of headers) assert.equal(r.trace.steps.filter((s) => s.line === n && s.sub !== undefined).length, 0, "header line " + n);
  assert.equal(subsOn(r.trace.steps, "t = a; a = b", LOOPS).length, 2);
  const swapLine = lines.findIndex((x) => x.includes("t = a; a = b")) + 1;
  const declLine = lines.findIndex((x) => x.includes("int a = 1, b = 2, t = 0;")) + 1;      // multi-declaration lines are legitimately split too
  const decl0 = lines.findIndex((x) => x.includes("int sum = 0, k = 0")) + 1;
  assert.deepEqual([...new Set(r.trace.steps.filter((s) => s.sub !== undefined).map((s) => s.line))].sort((x, y) => x - y), [decl0, declLine, swapLine], "only statement lines are split, no loop header");
});

test("a header-only loop does not eat the run budget: the swap after 2000 iterations is still split", async () => {
  const code = `int main() {
  int s = 0;
  for (int i = 0; i < 2000; i++) {
    s++;
  }
  int a = 1, b = 2, t = 0;
  t = a; a = b; b = t;
  return s > 0 ? 0 : 1;
}
`;
  const r = await trace(code, { maxSubStepsPerRun: 50 });
  assert.equal(r.trace.end?.subStep?.budgetExceeded, false);
  assert.equal(subsOn(r.trace.steps, "t = a; a = b", code).length, 2);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { statementRange } from "../core/explain/columns.ts";

const cut = (t: string, col: number | undefined) => { const r = statementRange(t, col); return r && t.slice(r[0], r[1]); };

test("statementRange: GCC's column points at the operator; the range is the whole statement", () => {
  const swap = "  tmp = a; a = b; b = tmp;";
  assert.equal(cut(swap, 7), "tmp = a;");                 // col of the first `=`
  assert.equal(cut(swap, 14), "a = b;");
  assert.equal(cut(swap, 21), "b = tmp;");
});
test("statementRange: declarators and comma expressions are separate ranges", () => {
  assert.equal(cut("  int a = 1, b = 2, tmp = 0;", 7), "int a = 1");      // the first declarator keeps its type
  assert.equal(cut("  int a = 1, b = 2, tmp = 0;", 14), "b = 2");
  assert.equal(cut("  int a = 1, b = 2, tmp = 0;", 21), "tmp = 0;");
  const comma = "  int c = (a = 5, b = 6, a + b);";
  assert.equal(cut(comma, 14), "a = 5");
  assert.equal(cut(comma, 21), "b = 6");
  assert.equal(cut(comma, 29), "a + b");
});
test("statementRange: calls keep their argument commas; one-line loop body statements", () => {
  assert.equal(cut("  a = g(a, b); b = 2;", 8), "a = g(a, b);");
  const loop = "  for (int i = 0; i < 3; i++) { a += i; b += a; }";
  assert.equal(cut(loop, loop.indexOf("+=") + 1), "a += i;");
  assert.equal(cut(loop, loop.lastIndexOf("+=") + 1), "b += a;");
});
test("statementRange: missing / 0 / out-of-range column -> null (whole line)", () => {
  assert.equal(statementRange("  a = 1;", undefined), null);
  assert.equal(statementRange("  a = 1;", 0), null);
  assert.equal(statementRange("  a = 1;", 99), null);
  assert.equal(statementRange("   ", 2), null);
});
test("statementRange: the column counts UTF-8 bytes, the range is in characters", () => {
  const t = '  s = "é"; t = 1;';                          // `é` is two bytes: the second `=` is at byte column 14, character index 13
  assert.equal(cut(t, 14), "t = 1;");
});

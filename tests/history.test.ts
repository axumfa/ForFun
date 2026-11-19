import { test } from "node:test";
import assert from "node:assert/strict";
import type { Step, Trace, TraceEvent } from "../core/events/types.ts";
import { History } from "../core/snapshots/history.ts";

const ptr = (o: string) => ({ ptr: o, kind: "object" as const, obj: o, offset: 0, to: "N" });
function mk(n: number): Trace {
  const steps: Step[] = [];
  for (let i = 0; i < n; i++) {
    const events: TraceEvent[] = [];
    if (i % 5 === 1) events.push({ type: "object_created", addr: "0x" + i, obj_type: "N", size: 16, fields: { v: i, next: { ptr: "0x0", kind: "null", to: "N" } } });
    if (i % 5 === 3 && i > 3) events.push({ type: "field_changed", addr: "0x" + (i - 2), field: "next", old: null, new: ptr("0x" + (i - 2)) });
    if (i === 17) events.push({ type: "object_freed", addr: "0x1" });
    steps.push({ kind: "step", schema: 4, step: i, fn: "main", file: "main", line: i + 1, depth: 1, frames: [], events });
  }
  return { steps, end: null };
}

test("stateAt(i) is identical for every access order (forward, backward, random)", () => {
  const t = mk(100);
  const h = new History(t, 7);
  const forward = Array.from({ length: 100 }, (_, i) => JSON.stringify(h.stateAt(i).objects));
  for (let i = 99; i >= 0; i--) assert.equal(JSON.stringify(h.stateAt(i).objects), forward[i]);
  for (const i of [50, 3, 77, 0, 99, 14, 15, 16]) assert.equal(JSON.stringify(h.stateAt(i).objects), forward[i]);
});

test("a different keyframe interval gives the same states", () => {
  const t = mk(60);
  const a = new History(t, 1), b = new History(t, 1000);
  for (let i = 0; i < 60; i++) assert.deepEqual(a.stateAt(i).objects, b.stateAt(i).objects);
});

test("events are attributed to the previous step's line; freed objects keep last known fields", () => {
  const h = new History(mk(30), 4);
  const s = h.stateAt(1);
  assert.equal(s.objects["0x1"]!.createdAt?.line, 1);       // created by the line of step 0
  const f = h.stateAt(20).objects["0x1"]!;
  assert.equal(f.state, "FREED");
  assert.equal(f.freedAt?.line, 17);
  assert.equal((f.fields as { v: number }).v, 1);
});

test("out of range is an error, not a guess", () => {
  assert.throws(() => new History(mk(3)).stateAt(3), RangeError);
});

// ---- schema v4 frame deltas ---------------------------------------------------------------------------------------------------------
import { applyPatch, expandFrames, parseTrace, type Frame, type WireFrame, type Value } from "../core/events/types.ts";

test("applyPatch: list/dict patches, removals, growth, shrink; unchanged children keep their reference", () => {
  const keep = { x: 1 };
  const old = { kind: "vector", elems: [1, 2, 3, keep], cap: 4 } as unknown as Value;
  const p = { $o: { elems: { $l: 5, $o: { "1": 9, "4": 7 } }, cap: 8 } } as unknown as Value;
  const n = applyPatch(old, p) as unknown as { elems: unknown[]; cap: number };
  assert.deepEqual(n.elems, [1, 9, 3, keep, 7]); assert.equal(n.cap, 8); assert.equal(n.elems[3], keep);
  assert.deepEqual(applyPatch({ a: 1, b: 2 } as unknown as Value, { $o: {}, $x: ["a"] } as unknown as Value), { b: 2 });
  assert.deepEqual(applyPatch([1, 2, 3] as unknown as Value, { $l: 2, $o: {} } as unknown as Value), [1, 2]);
  assert.equal(applyPatch(5, 6), 6);
});

test("expandFrames: delta against the same depth from the outermost frame; keys control order; mismatch throws", () => {
  const prev: Frame[] = [{ fn: "f", file: "main", line: 3, locals: { a: 1, b: 2 } }, { fn: "main", file: "main", line: 9, locals: { x: 5 } }];
  const wire: WireFrame[] = [{ fn: "f", file: "main", line: 4, d: 1, locals: { b: 7, c: 1 }, keys: ["c", "a", "b"] }, { fn: "main", file: "main", line: 9, d: 1, locals: {} }];
  const out = expandFrames(wire, prev);
  assert.deepEqual(Object.keys(out[0]!.locals), ["c", "a", "b"]); assert.deepEqual(out[0]!.locals, { c: 1, a: 1, b: 7 });
  assert.equal(out[1]!.locals.x, 5); assert.equal(out[0]!.line, 4);
  assert.throws(() => expandFrames([{ fn: "g", file: "main", line: 1, d: 1, locals: {} }], prev), /delta frame/);
  const deeper = expandFrames([{ fn: "g", file: "main", line: 1, locals: { q: 1 } }, ...wire], prev);   // a new inner call: outer frames still line up
  assert.equal(deeper.length, 3); assert.deepEqual(deeper[1]!.locals, { c: 1, a: 1, b: 7 });
});

test("parseTrace rejects the previous schema", () => {
  assert.throws(() => parseTrace('{"kind":"step","schema":3,"step":0,"fn":"main","file":"main","line":1,"depth":1,"frames":[],"events":[]}'), /unsupported schema/);
});

test("nextHeapChange: skips steps without heap writes (local_changed does not count), both directions, null at the ends", () => {
  const t = mk(30), h = new History(t, 7);
  const idx = t.steps.filter((s) => s.events.some((e) => e.type !== "local_changed")).map((s) => s.step);
  assert.ok(idx.length > 3);
  assert.equal(h.nextHeapChange(0, 1), idx.find((i) => i > 0));
  for (const i of idx) assert.equal(h.nextHeapChange(i, 1), idx.find((k) => k > i) ?? null);
  for (const i of idx) assert.equal(h.nextHeapChange(i, -1), [...idx].reverse().find((k) => k < i) ?? null);
  assert.equal(h.nextHeapChange(29, 1), null); assert.equal(h.nextHeapChange(0, -1), null);
  t.steps[10]!.events.push({ type: "local_changed", var: "x", old: 1, new: 2 });
  assert.equal(new History(t, 7).nextHeapChange(9, 1), idx.find((k) => k > 9), "a local change alone is not a heap change");
});

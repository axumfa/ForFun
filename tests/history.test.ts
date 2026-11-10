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
    steps.push({ kind: "step", schema: 3, step: i, fn: "main", file: "main", line: i + 1, depth: 1, frames: [], events });
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

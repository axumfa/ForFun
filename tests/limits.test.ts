import test from "node:test";
import assert from "node:assert/strict";
import { load, scenesAt } from "./helpers.ts";

test("a 400-node linked list is traced to the end (chain reads are recursive: the tracer must not hit Python's default recursion limit)", async () => {
  const l = await load("linked-lists/singly.cpp", "LinkedList l; for (int i = 0; i < 400; i++) l.push_front(i);");
  const end = l.history.trace.end;
  assert.equal(end?.reason, "exited", `trace ended with ${end?.reason}: ${end?.message}`);
  const last = l.history.length - 1, { state, scenes } = scenesAt(l, last);
  assert.equal(Object.values(state.objects).filter((o) => o.state === "LIVE").length, 400);
  const list = scenes.find((s) => s.kind === "singly-linked-list");
  assert.equal(list?.nodes.length, 400, "all 400 nodes are drawn");
});

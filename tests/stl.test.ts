import test from "node:test";
import assert from "node:assert/strict";
import { load, scenesAt, stepAt, stlItems, driverStep, finalStep } from "./helpers.ts";
import { collectStl } from "../core/adapters/stl.ts";
import type { StlValue } from "../core/events/types.ts";

const printed = (o: string) => o.trim().split(/\s+/);
const stlAt = (l: Awaited<ReturnType<typeof load>>, i: number): StlValue => collectStl(l.history.stateAt(i))[0]!.v;

test("INVARIANT: STL scenes have unique node ids and never invent edges, at every step of every STL example", async () => {
  for (const f of ["map", "set", "list", "deque", "unordered_map", "custom_alloc"]) {
    const l = await load(`stl/${f}.cpp`);
    for (let i = 0; i < l.history.length; i++) {
      for (const sc of scenesAt(l, i).scenes) {
        const ids = sc.nodes.map((n) => n.id);
        assert.equal(new Set(ids).size, ids.length, `stl/${f}@${i}: duplicate node ids in ${sc.id}`);
        assert.equal(sc.edges.length, 0, `stl/${f}@${i}: the logical view has no observed pointer to draw`);
      }
    }
  }
});

test("std::map / std::set: drawn elements equal the program's output, in order", async () => {
  const m = await load("stl/map.cpp");
  const sm = scenesAt(m, finalStep(m)).scenes.filter((s) => s.kind === "map");
  assert.equal(sm.length, 1, "the range-for's hidden __range1 alias must not make a second scene");
  assert.deepEqual(stlItems(sm[0]!), printed(m.output).map((p) => p.replace(":", "=")));      // 1=10 3=33 4=40 5=50
  assert.match(sm[0]!.title, /std::map m — 4 elements/);
  const s = await load("stl/set.cpp");
  assert.deepEqual(stlItems(scenesAt(s, finalStep(s)).scenes.find((x) => x.kind === "set")!), printed(s.output));    // 2 5 7
});

test("std::list and std::deque: drawn sequence equals the output (list keeps push_front/insert order)", async () => {
  const l = await load("stl/list.cpp");
  assert.deepEqual(stlItems(scenesAt(l, finalStep(l)).scenes.find((x) => x.title.includes("std::list"))!), printed(l.output));   // 2 9 3 4
  const d = await load("stl/deque.cpp");
  const sc = scenesAt(d, finalStep(d)).scenes;
  assert.deepEqual(stlItems(sc.find((x) => x.title.includes("std::deque"))!), printed(d.output));                            // 0 1 2
  assert.equal(sc.length, 1, "deque chunks and iterator internals must not appear as stray arrays");
});

test("std::unordered_map: iteration order equals the output; bucket_count is shown", async () => {
  const l = await load("stl/unordered_map.cpp");
  const sc = scenesAt(l, finalStep(l)).scenes.find((x) => x.kind === "unordered")!;
  assert.deepEqual(stlItems(sc), printed(l.output).map((p) => p.replace(":", "=")));
  const v = stlAt(l, finalStep(l));
  assert.ok(typeof v.bucketCount === "number" && v.bucketCount > 0);
  assert.ok(sc.notes.some((n) => n.includes(`bucket_count = ${v.bucketCount}`)));
});

test("map identity: node addresses are stable across insert and erase, so entries animate instead of being redrawn", async () => {
  const l = await load("stl/map.cpp");
  const at = (marker: string) => scenesAt(l, stepAt(l, marker)).scenes.find((s) => s.kind === "map")!;
  const before = at("m[8] = 80;"), after = at("m[1] = 10;");            // keys {3,5} then {3,5,8}
  const idOf = (s: typeof before, label: string) => s.nodes.find((n) => n.label === label)!.id;
  assert.equal(idOf(after, "3"), idOf(before, "3")); assert.equal(idOf(after, "5"), idOf(before, "5"));
  const firstWith8 = l.history.steps.findIndex((_, i) => scenesAt(l, i).scenes.some((sc) => sc.kind === "map" && sc.nodes.some((n) => n.label === "8")));
  assert.equal(scenesAt(l, firstWith8).scenes.find((sc) => sc.kind === "map")!.nodes.find((n) => n.label === "8")!.status, "created", "a new node is flagged the first time it is seen");
  assert.equal(idOf(scenesAt(l, firstWith8).scenes.find((sc) => sc.kind === "map")!, "8"), idOf(after, "8"), "and keeps its id afterwards");
  assert.ok(/^0x[0-9a-f]+$/.test(idOf(after, "8")), "ids are heap addresses (the node walk succeeded)");
  const pre = at("for (const auto& kv : m)"), post = at("std::printf(\"\\n\")");
  void post;
  assert.ok(!pre.nodes.some((n) => n.label === "8"), "erased key is gone");
  const prior = at("m.erase(8);");
  assert.equal(idOf(pre, "5"), idOf(prior, "5"), "erasing another key does not change a surviving node's id");
  assert.equal(prior.nodes.find((n) => n.label === "3")!.sub, "→ 33");
  const ch = scenesAt(l, stepAt(l, "m.erase(8);")).scenes.find((s) => s.kind === "map")!;
  assert.equal(ch.nodes.find((n) => n.label === "3")!.status, "changed", "m[3] = 33 changes the mapped value in place");
});

test("multimap / multiset: duplicate keys get distinct node ids", async () => {
  const l = await load("stl/map.cpp", "std::multimap<int, int> mm;\nmm.insert({1, 10});\nmm.insert({1, 20});\nmm.insert({2, 5});\nint done = 1;");
  const l2 = await load("stl/set.cpp", "std::multiset<int> ms = {4, 4, 4};\nint done = 1;");
  const mm = collectStl(l.history.stateAt(finalStep(l))).find((r) => r.label === "mm")!, ms = collectStl(l2.history.stateAt(finalStep(l2))).find((r) => r.label === "ms")!;
  assert.deepEqual(mm.v.entries.map((e) => [e.key, e.value]), [[1, 10], [1, 20], [2, 5]]);
  assert.equal(new Set(mm.v.entries.map((e) => e.id)).size, 3);
  assert.equal(new Set(ms.v.entries.map((e) => e.id)).size, 3);
  assert.equal(mm.v.source, "walk");
});

test("cap: a 1000-element map reads only the first 200 entries; size is exact; the UI marker says what is hidden", async () => {
  const l = await load("stl/map.cpp", "std::map<int, int> big;\nfor (int i = 0; i < 1000; i++) big.emplace_hint(big.end(), i, i);\nint done = 1;");
  const i = finalStep(l), v = collectStl(l.history.stateAt(i)).find((r) => r.label === "big")!.v;
  assert.equal(v.size, 1000); assert.equal(v.truncated, true); assert.equal(v.entries.length, 200);
  assert.deepEqual(v.entries.map((e) => e.key), Array.from({ length: 200 }, (_, k) => k));
  assert.ok(v.entries.every((e) => e.id), "the partial in-order walk still provides node ids");
  assert.equal(v.internal, null); assert.match(v.internalError!, /1000 elements/);
  const sc = scenesAt(l, i).scenes.find((s) => s.id.includes("stl:"))!;
  const more = sc.nodes.find((n) => n.id.endsWith(":more"))!;
  assert.equal(more.label, "+800");
  assert.ok(sc.notes.some((n) => n.includes("first 200 of 1000")));
  const mid = collectStl(l.history.stateAt(driverStep(l, 40))).find((r) => r.label === "big");
  assert.ok(mid === undefined || mid.v.entries.length <= 200);
});

test("custom allocator: no internal walk (explicit reason), contents still shown via the printer, ids fall back to the key", async () => {
  const l = await load("stl/custom_alloc.cpp");
  const v = stlAt(l, finalStep(l));
  assert.equal(v.source, "printer"); assert.equal(v.internal, null); assert.match(v.internalError!, /allocator .* is not std::allocator/);
  const sc = scenesAt(l, finalStep(l)).scenes.find((s) => s.kind === "set")!;
  assert.deepEqual(stlItems(sc), printed(l.output));                                  // 1 3 4
  assert.ok(sc.nodes.every((n) => n.id.includes(":k:")), "identity by key when the walk is unavailable");
});

test("the walk is validated: red-black links of the full tree agree with the entries (root black, no red-red)", async () => {
  const l = await load("stl/map.cpp", "std::map<int, int> t;\nfor (int i = 1; i <= 40; i++) t.emplace((i * 7) % 41, i);\nint done = 1;");
  const v = collectStl(l.history.stateAt(finalStep(l))).find((r) => r.label === "t")!.v;
  assert.equal(v.source, "walk"); assert.equal(v.internal!.kind, "rb");
  const root = (v.internal as { root: number }).root, ns = v.entries.map((e) => e.n!);
  assert.equal(ns[root]![0], 1, "root is black"); assert.equal(ns[root]![1], -2, "root's parent is the header");
  ns.forEach(([c, p, lc, rc], i) => {
    for (const ch of [lc, rc]) if (ch >= 0) { assert.equal(ns[ch]![1], i, "child's parent link points back"); if (c === 0) assert.equal(ns[ch]![0], 1, "red node has black children"); }
    if (p >= 0) assert.ok(ns[p]![2] === i || ns[p]![3] === i);
  });
  const keys = v.entries.map((e) => e.key as number);
  assert.deepEqual(keys, [...keys].sort((a, b) => a - b));                            // in-order = sorted
});

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

// ---- internal view (red-black tree) ------------------------------------------------------------------------------------------------
const INT = { stlView: { m: "internal", s: "internal", t: "internal", mm: "internal", ms: "internal", big: "internal" } } as const;
const treeOf = (sc: { nodes: { id: string; label: string }[]; edges: { from: string; to: string; kind: string }[]; pointers: { name: string; target: string | null }[] }): string[] => {
  const out: string[] = [], lab = new Map(sc.nodes.map((n) => [n.id, n.label]));
  const kid = (id: string, k: string) => sc.edges.find((e) => e.from === id && e.kind === k)?.to;
  const walk = (id: string | undefined | null) => { if (!id) return; walk(kid(id, "left")); out.push(lab.get(id)!); walk(kid(id, "right")); };
  walk(sc.pointers.find((p) => p.name === "root")?.target);
  return out;
};

test("internal view: drawn red-black tree in-order equals the program's output; root black; colours and links come from the nodes", async () => {
  for (const [f, kind, label] of [["map", "map", "m"], ["set", "set", "s"]] as const) {
    const l = await load(`stl/${f}.cpp`);
    const { scenes } = scenesAt(l, finalStep(l), INT);
    const sc = scenes.find((s) => s.title.includes(`std::${kind} ${label}`))!;
    assert.equal(sc.kind, "binary-tree"); assert.equal(sc.views!.current, "internal"); assert.equal(sc.views!.internal, true);
    assert.deepEqual(treeOf(sc), printed(l.output).map((p) => p.split(":")[0]!), f);
    const root = sc.nodes.find((n) => n.id === sc.pointers.find((p) => p.name === "root")!.target)!;
    assert.equal(root.fill, "black");
    for (const e of sc.edges) {
      const a = sc.nodes.find((n) => n.id === e.from)!, b = sc.nodes.find((n) => n.id === e.to)!;
      assert.ok(!(a.fill === "red" && b.fill === "red"), "no red node has a red child");
    }
    assert.ok(sc.notes.some((n) => n.startsWith("Red-black properties hold")), f);
  }
});

test("internal view, every step: unique ids, edges only between drawn nodes and only from observed links, same ids as the logical view", async () => {
  for (const f of ["map", "set"]) {
    const l = await load(`stl/${f}.cpp`);
    for (let i = 0; i < l.history.length; i++) {
      const lg = scenesAt(l, i).scenes, it = scenesAt(l, i, INT).scenes;
      for (const sc of it.filter((s) => s.views)) {
        const ids = sc.nodes.map((n) => n.id);
        assert.equal(new Set(ids).size, ids.length, `${f}@${i}`);
        const ref = collectStl(l.history.stateAt(i)).find((r) => r.id === sc.id)!;
        const links = new Set<string>();
        ref.v.entries.forEach((e, k) => { if (e.n) for (const c of [e.n[2], e.n[3]]) if (c >= 0) links.add(`${e.id}>${ref.v.entries[c]!.id}`); });
        for (const e of sc.edges) assert.ok(links.has(`${e.from}>${e.to}`), `${f}@${i}: invented edge ${e.id}`);
        assert.equal(sc.edges.length, links.size, `${f}@${i}: every observed link is drawn`);
        const logicalIds = lg.find((s) => s.id === sc.id)!.nodes.map((n) => n.id).filter((x) => !x.endsWith(":more")).sort();
        assert.deepEqual([...ids].sort(), logicalIds, `${f}@${i}: both views name the same nodes`);
      }
    }
  }
});

test("internal view: rebalancing keeps node identities and flags the changed links / colours (ascending inserts force rotations)", async () => {
  const l = await load("stl/map.cpp", "std::map<int, int> t;\nfor (int i = 1; i <= 15; i++) {\n  t.emplace(i, i);\n}\nint done = 1;");
  let prevIds = new Set<string>(), sawChangedEdge = false, sawRecolor = false;
  const idxs = l.history.steps.map((s, i) => (s.file === "driver" ? i : -1)).filter((i) => i >= 0);
  for (const i of idxs) {
    const sc = scenesAt(l, i, INT).scenes.find((s) => s.views?.key === "t");
    if (!sc) continue;
    const ids = new Set(sc.nodes.map((n) => n.id));
    for (const id of prevIds) assert.ok(ids.has(id), `step ${i}: node ${id} vanished although nothing was erased`);
    for (const e of sc.edges) if (e.changed && prevIds.has(e.from) && prevIds.has(e.to)) sawChangedEdge = true;
    if (sc.nodes.some((n) => n.status === "changed")) sawRecolor = true;
    prevIds = ids;
  }
  assert.equal(prevIds.size, 15);
  assert.ok(sawChangedEdge, "a rotation re-links existing nodes: that edge is flagged changed, the nodes are not recreated");
  assert.ok(sawRecolor, "recolouring is flagged on the same node");
});

test("internal view: multimap duplicates are separate tree nodes; truncated and custom-allocator containers refuse the internal view with the reason", async () => {
  const mm = await load("stl/map.cpp", "std::multimap<int, int> mm;\nmm.insert({1, 10});\nmm.insert({1, 20});\nmm.insert({1, 30});\nint done = 1;");
  const sc = scenesAt(mm, finalStep(mm), INT).scenes.find((s) => s.views?.key === "mm")!;
  assert.equal(sc.views!.current, "internal"); assert.equal(sc.nodes.length, 3); assert.deepEqual(treeOf(sc), ["1", "1", "1"]);
  const big = await load("stl/map.cpp", "std::map<int, int> big;\nfor (int i = 0; i < 300; i++) big.emplace_hint(big.end(), i, i);\nint done = 1;");
  const b = scenesAt(big, finalStep(big), INT).scenes.find((s) => s.views?.key === "big")!;
  assert.equal(b.views!.internal, false); assert.equal(b.views!.current, "logical", "asking for internal falls back to logical");
  assert.match(b.views!.reason!, /300 elements/);
  const ca = await load("stl/custom_alloc.cpp");
  const c = scenesAt(ca, finalStep(ca), { stlView: { s: "internal" } }).scenes.find((s) => s.views)!;
  assert.equal(c.views!.internal, false); assert.match(c.views!.reason!, /allocator/);
});

test("containers without an internal view (deque, unordered_map) show no Logical | Internal switch", async () => {
  for (const f of ["deque", "unordered_map"]) {
    const l = await load(`stl/${f}.cpp`);
    for (const sc of scenesAt(l, finalStep(l), { stlView: { d: "internal", u: "internal" } }).scenes) assert.equal(sc.views, undefined, f);
  }
});

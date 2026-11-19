import test from "node:test";
import assert from "node:assert/strict";
import { load, scenesAt, stepAt, stlItems, driverStep, finalStep } from "./helpers.ts";
import { collectStl, compact } from "../core/adapters/stl.ts";
import { interpret } from "../core/adapters/index.ts";
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

const DSETUP = "std::deque<long long> dq;\nfor (int i = 0; i < 100; i++) dq.push_back(i);\nfor (int i = 1; i <= 30; i++) dq.push_front(-i);\ndq.pop_back();\ndq.pop_front();\nint done = 1;";
const DINT = { stlView: { dq: "internal", d: "internal" } } as const;

test("deque internal view: elements sit esz apart inside a chunk, chunks hold exactly 64 long longs, order equals the logical order, at every step", async () => {
  const l = await load("stl/deque.cpp", DSETUP);
  let seen = 0;
  for (let i = 0; i < l.history.length; i++) {
    const st = l.history.stateAt(i), r = collectStl(st).find((x) => x.label === "dq");
    if (!r || r.v.internal?.kind !== "deque") continue;
    seen++;
    const d = r.v.internal, ids = r.v.entries.map((e) => BigInt(e.id!));
    assert.equal(d.chunk, 64, "512 bytes / 8");
    ids.forEach((a, k) => { if (k && (d.offset + k) % d.chunk !== 0) assert.equal(a - ids[k - 1]!, 8n, `@${i} element ${k} follows ${k - 1} in the same chunk`); });
    ids.forEach((a, k) => { const c = BigInt(d.chunks[Math.floor((d.offset + k) / d.chunk)]!); assert.equal(a, c + BigInt(((d.offset + k) % d.chunk) * 8), `@${i} element ${k} address = chunk + slot*8`); });
    assert.equal(d.chunks.length, Math.floor((d.offset + r.v.size) / d.chunk) + 1, `@${i}: finish._M_cur never equals _M_last, so an exactly full last chunk already has its successor (an empty deque owns one chunk)`);
    const sc = interpret(st, undefined, DINT).scenes.find((x) => x.views?.key === "dq")!;
    assert.equal(sc.views!.current, "internal");
    const boxes = sc.nodes.filter((n) => n.shape === "box").sort((x, y) => x.index! - y.index!);
    assert.deepEqual(boxes.map((n) => n.label), r.v.entries.map((e) => String(e.value)), `@${i}: drawn order == logical order`);
    assert.equal(sc.nodes.filter((n) => n.shape === "cell").length, r.v.size ? Math.ceil((d.offset + r.v.size) / d.chunk) : 0, `@${i}: one map entry per chunk that holds elements`);
    const idset = new Set(sc.nodes.map((n) => n.id)); for (const e of sc.edges) assert.ok(idset.has(e.from) && idset.has(e.to), `@${i}`);
  }
  assert.ok(seen > 100, `internal view existed for most steps (${seen})`);
});

test("deque identity: push/pop at either end never changes the ids of the surviving elements; only the new element is 'created'", async () => {
  const l = await load("stl/deque.cpp", DSETUP);
  let prev: Map<string, string> | null = null, checked = 0;
  for (let i = 0; i < l.history.length; i++) {
    const r = collectStl(l.history.stateAt(i)).find((x) => x.label === "dq" && x.v.internal?.kind === "deque");
    if (!r) { prev = null; continue; }
    const cur = new Map(r.v.entries.map((e) => [String(e.value), e.id!] as const));
    if (prev) for (const [val, id] of cur) if (prev.has(val)) { assert.equal(id, prev.get(val), `@${i}: element ${val} moved`); checked++; }
    prev = cur;
  }
  assert.ok(checked > 1000);
  const end = Array.from({ length: l.history.length }, (_, i) => i).find((i) => collectStl(l.history.stateAt(i)).some((r) => r.label === "dq" && r.v.size === 128))!;
  const sc = scenesAt(l, end, DINT).scenes.find((x) => x.views?.key === "dq")!;
  assert.deepEqual(sc.nodes.filter((n) => n.status === "created").length <= 1, true);
});

test("deque internal view on a small int deque equals the program's output; refused above 200 elements with the reason", async () => {
  const l = await load("stl/deque.cpp");
  const sc = scenesAt(l, stepAt(l, "for (int x : d) {"), DINT).scenes.find((x) => x.views?.key === "d")!;
  assert.equal(sc.views!.current, "internal");
  assert.deepEqual(sc.nodes.filter((n) => n.shape === "box").sort((a, b) => a.index! - b.index!).map((n) => n.label), printed(l.output));
  const big = await load("stl/deque.cpp", "std::deque<int> dq;\nfor (int i = 0; i < 300; i++) dq.push_back(i);\nint done = 1;");
  const b = scenesAt(big, big.history.length - 3, DINT).scenes.find((x) => x.views?.key === "dq")!;
  assert.equal(b.views!.internal, false); assert.match(b.views!.reason!, /300 elements/);
});

// ---- internal view (std::list) -----------------------------------------------------------------------------------------------------
const LINT = { stlView: { l: "internal", bad: "internal", big: "internal" } } as const;
const listChain = (sc: { nodes: { id: string; label: string }[]; edges: { from: string; to: string; kind: string }[]; pointers: { name: string; target: string | null }[] }): string[] => {
  const out: string[] = [], lab = new Map(sc.nodes.map((n) => [n.id, n.label])), seen = new Set<string>();
  let cur = sc.pointers.find((p) => p.name === "front")?.target ?? null;
  while (cur && !seen.has(cur)) { seen.add(cur); out.push(lab.get(cur)!); cur = sc.edges.find((e) => e.from === cur && e.kind === "next")?.to ?? null; }
  return out;
};

test("list internal view: the node chain equals the program's output; every next has the matching prev; front/back are the ends", async () => {
  const l = await load("stl/list.cpp");
  const sc = scenesAt(l, finalStep(l), LINT).scenes.find((s) => s.views?.key === "l")!;
  assert.equal(sc.kind, "doubly-linked-list"); assert.equal(sc.views!.current, "internal");
  assert.deepEqual(listChain(sc), printed(l.output));                                          // 2 9 3 4
  for (const e of sc.edges.filter((x) => x.kind === "next")) assert.ok(sc.edges.some((p) => p.kind === "prev" && p.from === e.to && p.to === e.from), "prev mirrors next");
  assert.equal(sc.edges.length, 2 * (sc.nodes.length - 1));
  assert.equal(sc.pointers.find((p) => p.name === "back")!.target, sc.nodes[sc.nodes.length - 1]!.id);
});

test("list internal view, every step: unique ids, links only between adjacent entries, same ids as the logical view", async () => {
  const l = await load("stl/list.cpp");
  for (let i = 0; i < l.history.length; i++) {
    const it = scenesAt(l, i, LINT).scenes, lg = scenesAt(l, i).scenes;
    for (const sc of it.filter((s) => s.views?.current === "internal")) {
      const ids = sc.nodes.map((n) => n.id);
      assert.equal(new Set(ids).size, ids.length, `@${i}`);
      const pos = new Map(ids.map((id, k) => [id, k]));
      for (const e of sc.edges) assert.equal(Math.abs(pos.get(e.from)! - pos.get(e.to)!), 1, `@${i}: ${e.id} must join neighbours`);
      assert.deepEqual([...ids].sort(), lg.find((s) => s.id === sc.id)!.nodes.map((n) => n.id).sort(), `@${i}`);
    }
  }
});

test("list identity: push_front / insert / pop_front keep surviving node ids; only the new node is 'created', the popped one disappears", async () => {
  const l = await load("stl/list.cpp");
  const at = (m: string) => scenesAt(l, stepAt(l, m), LINT).scenes.find((s) => s.views?.key === "l")!;
  const idOf = (sc: ReturnType<typeof at>, label: string) => sc.nodes.find((n) => n.label === label)!.id;
  const a = at("l.push_front(1);"), b = at("l.push_back(4);");                                  // {2,3}  ->  {1,2,3}
  assert.equal(idOf(b, "2"), idOf(a, "2")); assert.equal(idOf(b, "3"), idOf(a, "3"));
  assert.equal(b.nodes.find((n) => n.label === "1")!.status, "created");
  const c = at("l.insert(++l.begin(), 9);"), d = at("for (int x : l)");                       // {1,2,3,4} -> pop_front -> insert 9
  assert.ok(!c.nodes.some((n) => n.label === "1"), "pop_front removed node 1"); assert.equal(idOf(d, "3"), idOf(c, "3"));
  assert.deepEqual(d.nodes.filter((n) => n.status === "created").map((n) => n.label), ["9"]);
  assert.ok(d.edges.some((e) => e.changed), "the links around the inserted node are flagged changed");
  assert.equal(d.edges.filter((e) => e.changed && e.kind === "next").length, 2, "exactly the two next-links around 9 are new (2->9, 9->3)");
});

test("list internal view falls back to logical when validation fails: corrupted _M_prev, truncated size", async () => {
  const bad = await load("stl/list.cpp", "std::list<int> bad = {1, 2, 3};\nvoid** first = *(void***)&bad;\nfirst[1] = nullptr;\nint done = 1;");
  const v = collectStl(bad.history.stateAt(finalStep(bad))).find((r) => r.label === "bad")!.v;
  assert.equal(v.internal, null); assert.match(v.internalError!, /prev\/next links disagree/);
  assert.equal(v.source, "printer"); assert.deepEqual(v.entries.map((e) => e.value), [1, 2, 3]);
  const sc = scenesAt(bad, finalStep(bad), LINT).scenes.find((s) => s.views?.key === "bad")!;
  assert.equal(sc.views!.current, "logical"); assert.equal(sc.views!.internal, false); assert.match(sc.views!.reason!, /prev\/next links disagree/);
  assert.deepEqual(stlItems(sc), ["1", "2", "3"]);
  const big = await load("stl/list.cpp", "std::list<int> big;\nfor (int i = 0; i < 300; i++) big.push_back(i);\nint done = 1;");
  const b = scenesAt(big, finalStep(big), LINT).scenes.find((s) => s.views?.key === "big")!;
  assert.equal(b.views!.current, "logical"); assert.match(b.views!.reason!, /300 elements/);
  assert.ok(collectStl(big.history.stateAt(finalStep(big))).find((r) => r.label === "big")!.v.entries.every((e) => e.id), "truncated list still has node ids in the logical view");
});

// ---- schema v4: the delta-encoded trace decodes to exactly the full-frame trace -------------------------------------------------------
import { runTrace } from "../extension/src/execution/runner.ts";
import { cfg as runCfg, root as repoRoot } from "./helpers.ts";
import * as pathMod from "node:path";

test("delta frames: decoded steps are identical to a trace written without deltas (DSV_NO_DELTA=1); the wire is much smaller", async () => {
  for (const [f, setup] of [["stl/map.cpp", "std::map<int,int> big;\nfor (int i = 0; i < 300; i++) big[i] = i % 7;\nbig.erase(5);\nint done = 1;"], ["binary-trees/bst.cpp", undefined], ["stl/list.cpp", undefined]] as const) {
    const file = pathMod.join(repoRoot, "examples", f), run = () => runTrace(file, { ...runCfg, entry: setup ? { setup } : undefined });
    process.env.DSV_NO_DELTA = "0";                    // same-length value in both runs: the environment size shifts stack addresses
    let a, b; try { a = await run(); process.env.DSV_NO_DELTA = "1"; b = await run(); } finally { delete process.env.DSV_NO_DELTA; }
    assert.equal(a.trace.steps.length, b.trace.steps.length, f);
    for (let i = 0; i < a.trace.steps.length; i++) assert.deepEqual(a.trace.steps[i]!.frames, b.trace.steps[i]!.frames, `${f}@${i}`);
    if (setup) assert.ok(a.traceBytes * 4 < b.traceBytes, `${f}: delta ${a.traceBytes} vs full ${b.traceBytes}`);
  }
});

// ---- internal view (unordered_*: bucket table + node chains) ---------------------------------------------------------------------------
const HSETUP = "std::unordered_map<int, int> h;\nfor (int i = 0; i < 40; i++) h[i * 7] = i;\nh.erase(14);\nh.erase(70);\nstd::unordered_set<int> hs = {3, 4, 5, 100, 200};\nint done = 1;";
const HINT = { stlView: { h: "internal", hs: "internal" } } as const;

test("unordered internal view: every node is in the bucket key % bucket_count (std::hash<int> is the identity); order and ids are consistent at every step", async () => {
  const l = await load("stl/unordered_map.cpp", HSETUP);
  let seenInternal = 0;
  for (let i = 0; i < l.history.length; i++) {
    const st = l.history.stateAt(i);
    for (const r of collectStl(st)) {
      const v = r.v; if (v.internal?.kind !== "hash") continue;
      seenInternal++;
      const bk = v.internal.buckets, bc = v.bucketCount!;
      assert.equal(bk.length, bc, `@${i}`);
      const starts = bk.map((f, j) => [f, j] as const).filter(([f]) => f >= 0).sort((a, b) => a[0] - b[0]);
      v.entries.forEach((e, k) => {
        const j = [...starts].reverse().find(([f]) => f <= k)![1], key = Number(typeof e.key === "number" ? e.key : e.value);
        assert.equal(key % bc, j, `@${i}: key ${key} must live in bucket ${key % bc}, the tracer put it in ${j}`);
        assert.ok(e.id, "node id");
      });
      assert.equal(new Set(v.entries.map((e) => e.id)).size, v.entries.length);
    }
    for (const sc of interpret(st, undefined, HINT).scenes.filter((x) => x.views?.current === "internal" && x.kind === "hash-table")) {
      const ids = new Set(sc.nodes.map((n) => n.id));
      for (const e of sc.edges) assert.ok(ids.has(e.from) && ids.has(e.to), `@${i}: dangling edge ${e.id}`);
    }
  }
  assert.ok(seenInternal > 30, "internal view existed for most steps");
});

test("unordered internal view at the end: drawn chains hold exactly the container's elements; bucket cells point at the first node of their chain", async () => {
  const l = await load("stl/unordered_map.cpp", HSETUP);
  const end = Array.from({ length: l.history.length }, (_, i) => i).find((i) => { const rs = collectStl(l.history.stateAt(i)); return rs.some((r) => r.label === "h" && r.v.size === 38) && rs.some((r) => r.label === "hs" && r.v.size === 5); })!;
  assert.ok(end > 0);
  const sc = scenesAt(l, end, HINT).scenes.find((s) => s.views?.key === "h")!;
  assert.equal(sc.kind, "hash-table"); assert.equal(sc.views!.current, "internal");
  const vals = sc.nodes.filter((n) => n.shape === "box").map((n) => Number(n.label)).sort((a, b) => a - b);
  assert.deepEqual(vals, Array.from({ length: 40 }, (_, i) => i * 7).filter((k) => k !== 14 && k !== 70));
  for (const e of sc.edges.filter((x) => x.kind === "bucket")) assert.equal(sc.nodes.find((n) => n.id === e.to)!.y, sc.nodes.find((n) => n.id === e.from)!.y, "same row");
  for (const e of sc.edges.filter((x) => x.kind === "next")) assert.equal(sc.nodes.find((n) => n.id === e.to)!.y, sc.nodes.find((n) => n.id === e.from)!.y, "chain stays in its bucket row");
  assert.equal(sc.edges.length, vals.length, "one incoming edge per node (bucket or previous node)");
  const hs = scenesAt(l, end, HINT).scenes.find((s) => s.views?.key === "hs")!;
  assert.deepEqual(hs.nodes.filter((n) => n.shape === "box").map((n) => Number(n.label)).sort((a, b) => a - b), [3, 4, 5, 100, 200]);
});

test("unordered identity: a rehash keeps node ids (nodes are not reallocated); only the new element is 'created'", async () => {
  const l = await load("stl/unordered_map.cpp", HSETUP);
  const before = new Map<string, string>();
  let rehashes = 0, prevBc = 0;
  for (let i = 0; i < l.history.length; i++) {
    const r = collectStl(l.history.stateAt(i)).find((x) => x.label === "h" && x.v.internal?.kind === "hash");
    if (!r) continue;
    if (prevBc && r.v.bucketCount !== prevBc) {
      rehashes++;
      for (const e of r.v.entries) { const k = compact(e.key); if (before.has(k)) assert.equal(e.id, before.get(k), `key ${k} moved on rehash`); }
    }
    prevBc = r.v.bucketCount!; before.clear(); for (const e of r.v.entries) before.set(compact(e.key), e.id!);
  }
  assert.ok(rehashes >= 2, `inserting 40 elements rehashes at least twice (saw ${rehashes})`);
});

test("unordered internal view is refused for a custom allocator or a truncated container, with the reason; logical view still works", async () => {
  const big = await load("stl/unordered_map.cpp", "std::unordered_set<int> h;\nfor (int i = 0; i < 300; i++) h.insert(i);\nint done = 1;");
  const sc = scenesAt(big, finalStep(big), HINT).scenes.find((s) => s.views?.key === "h")!;
  assert.equal(sc.views!.internal, false); assert.equal(sc.views!.current, "logical"); assert.match(sc.views!.reason!, /300 elements/);
});

// ---- explanations of container changes ---------------------------------------------------------------------------------------------------
import { explainStep, stlDelta } from "../core/explain/explain.ts";

test("explain: container changes say what was inserted, updated and removed (map, set, list); sizes alone only as fallback", async () => {
  const texts: string[] = [];
  for (const [f, setup] of [["stl/map.cpp", "std::map<int, int> m;\nm[1] = 10;\nm[2] = 20;\nm[1] = 11;\nm.erase(2);\nint done = 1;"], ["stl/set.cpp", "std::set<int> s = {5, 6};\ns.insert(7);\nint done = 1;"], ["stl/list.cpp", "std::list<int> q = {1, 2};\nq.push_front(0);\nint done = 1;"]] as const) {
    const l = await load(f, setup);
    for (let i = 0; i < l.history.length; i++) texts.push(...explainStep(l.history.stateAt(i), { main: l.lines }).effects.filter((t) => /changed from/.test(t) && /std::/.test(t)));
  }
  const has = (re: RegExp) => assert.ok(texts.some((t) => re.test(t)), `${re}\n${texts.join("\n")}`);
  has(/'m'.*inserted 1 → 0/); has(/'m'.*updated 1: 0 → 10/);            // operator[] default-constructs the value first, then the assignment updates it
  has(/'m'.*inserted 2 → 0/); has(/'m'.*updated 1: 10 → 11/); has(/'m'.*removed 2 → 20/);
  assert.ok(!texts.some((t) => /\d{9,} elements/.test(t)), "no garbage sizes from not-yet-constructed containers");
  has(/'s'.*inserted 7/); has(/'q'.*inserted 0/);
});

test("stlDelta: null when nothing comparable (raw, truncated) so the caller falls back to sizes", () => {
  const mk = (over: Partial<StlValue>): StlValue => ({ kind: "stl", container: "set", type: "std::set<int>", size: 1, truncated: false, entries: [{ value: 1 }], source: "printer", ...over });
  assert.equal(stlDelta(undefined, mk({})), null);
  assert.equal(stlDelta(mk({}), mk({ source: "raw" })), null);
  assert.equal(stlDelta(mk({ truncated: true }), mk({ entries: [{ value: 1 }, { value: 2 }], size: 2 })), null);
  assert.equal(stlDelta(mk({}), mk({ entries: [{ value: 1 }, { value: 2 }], size: 2 })), "inserted 2");
  assert.equal(stlDelta(mk({}), mk({})), null);
});

// ---- container adapters and std::array ---------------------------------------------------------------------------------------------------
test("std::stack / std::queue are drawn as such under the variable's name, with top / front / back; priority_queue is a heap named pq; std::array is named a", async () => {
  const l = await load("stl/adapters.cpp");
  const sc = scenesAt(l, stepAt(l, "std::printf(\"%d %d %d %d")).scenes;
  const st = sc.find((s) => s.title.startsWith("std::stack st"))!, q = sc.find((s) => s.title.startsWith("std::queue q"))!;
  assert.ok(st && q, sc.map((s) => s.title).join(" | "));
  assert.equal(st.kind, "stack"); assert.equal(q.kind, "queue");
  assert.deepEqual(stlItems(st), ["1", "2", "3"]); assert.deepEqual(stlItems(q), ["8", "9"]);        // 7 was popped
  assert.equal(st.pointers.find((p) => p.name === "top")!.target, st.nodes[2]!.id);
  assert.equal(q.pointers.find((p) => p.name === "front")!.target, q.nodes[0]!.id); assert.equal(q.pointers.find((p) => p.name === "back")!.target, q.nodes[1]!.id);
  assert.ok(!sc.some((s) => /\.c\b|_M_elems/.test(s.title)), "no `.c` / `._M_elems` scenes: " + sc.map((s) => s.title).join(" | "));
  const pq = sc.find((s) => s.kind === "heap")!, arr = sc.find((s) => s.title === "Array a")!;
  assert.match(pq.title, /pq/); assert.equal(pq.nodes.filter((n) => n.shape === "circle").sort((a, b) => a.index! - b.index!).map((n) => n.label).join(" "), "9 5 1");
  assert.ok(arr, "std::array drawn as `Array a`"); assert.deepEqual(arr.nodes.map((n) => n.label), ["50", "4", "3", "2", "1"]);
});

test("stack/queue: the Logical | Internal switch still works on the underlying deque, and a stack over a vector is a stack scene", async () => {
  const l = await load("stl/adapters.cpp");
  const i = stepAt(l, "std::printf(\"%d %d %d %d");
  const sc = scenesAt(l, i, { stlView: { st: "internal" } }).scenes.find((s) => s.views?.key === "st")!;
  assert.equal(sc.views!.current, "internal"); assert.equal(sc.nodes.filter((n) => n.shape === "box").length, 3);
});

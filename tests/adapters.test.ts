import { test } from "node:test";
import assert from "node:assert/strict";
import { load, stepAt, scenesAt, chain, ptrTarget, outEdges } from "./helpers.ts";
import { isPtr } from "../core/adapters/analysis.ts";
import { interpret } from "../core/adapters/index.ts";
import { findings } from "../core/analysis/findings.ts";

const printed = (o: string) => o.trim().split(/\s+/);

test("INVARIANT: every drawn heap edge exists in the observed pointer data (all examples, all steps)", async () => {
  const files = ["linked-lists/list.cpp", "linked-lists/singly.cpp", "linked-lists/malloc_list.cpp", "linked-lists/doubly.cpp", "linked-lists/sentinel.cpp", "linked-lists/globals.cpp", "arrays/heap_arrays.cpp", "hash-tables/open_addressing.cpp", "graphs/dijkstra.cpp", "linked-lists/shared_ptr_list.cpp", "binary-trees/unique_ptr_tree.cpp", "binary-trees/shared_tree.cpp", "graphs/dfs_ptr.cpp", "arrays/union_find.cpp", "binary-trees/bst.cpp", "binary-trees/avl.cpp", "binary-trees/rbtree.cpp",
    "hash-tables/chained.cpp", "tries/trie.cpp", "stacks-queues/stack_queue.cpp",
    "stl/map.cpp", "stl/adapters.cpp", "stl/ptr_map.cpp", "stl/set.cpp", "stl/list.cpp", "stl/deque.cpp", "stl/unordered_map.cpp", "stl/custom_alloc.cpp",
    "c/singly.c", "c/bst.c", "c/dynarray.c", "c/hash.c", "c/strings_matrix.c"];
  for (const f of files) {
    const l = await load(f);
    for (let i = 0; i < l.history.length; i++) {
      const state = l.history.stateAt(i);
      for (const sc of interpret(state).scenes) {
        const ids = new Set(sc.nodes.map((n) => n.id));
        for (const e of sc.edges) {
          assert.ok(ids.has(e.from) && ids.has(e.to), `${f}@${i}: edge ${e.id} references a missing node`);
          const a = state.objects[e.from];
          if (!a) continue;                                           // bucket cells etc. are not heap objects
          const vals = Object.values(a.fields ?? {}).flatMap((v) => (isPtr(v) ? [v] : typeof v === "object" && v && "elems" in v ? v.elems.filter(isPtr) : []));
          assert.ok(vals.some((p) => p.obj === e.to && p.kind !== "null" && p.kind !== "unresolved"), `${f}@${i}: invented edge ${e.id}`);
        }
        // STL scenes' pointers (top/front/back of an adapter) name container elements, not heap objects.
        if (!sc.id.startsWith("stl:")) for (const p of sc.pointers) if (p.state === "live") assert.equal(state.objects[p.target!]?.state, "LIVE");
        for (const n of sc.nodes) if (n.status === "freed") assert.equal(state.objects[n.id]?.state, "FREED");
      }
    }
  }
});

test("singly linked list: scene order equals what the program printed", async () => {
  const l = await load("linked-lists/singly.cpp");
  const { scenes } = scenesAt(l, stepAt(l, "for (Node* c = l.head"));
  const sc = scenes.find((s) => s.kind === "singly-linked-list")!;
  assert.ok(sc);
  assert.deepEqual(chain(sc, ptrTarget(sc, "l.head")), printed(l.output));          // 1 2 4
  assert.equal(sc.nodes.length, 3);                                                  // node 3 was deleted, not drawn
});

test("singly list: removal frees the node and no live edge points at it", async () => {
  const l = await load("linked-lists/singly.cpp");
  const i = l.history.steps.findIndex((s) => s.events.some((e) => e.type === "object_freed"));
  const { scenes, state } = scenesAt(l, i);
  const sc = scenes.find((s) => s.kind === "singly-linked-list")!;
  const freed = l.history.steps[i]!.events.find((e) => e.type === "object_freed")!;
  assert.ok("addr" in freed);
  const ghost = sc.nodes.find((n) => n.id === (freed as { addr: string }).addr);
  if (ghost) assert.equal(ghost.status, "freed");                                     // shown only as a dangling ghost
  assert.equal(sc.edges.filter((e) => e.to === (freed as { addr: string }).addr && !e.id.includes("freed")).length, 0, "no live node may link to the freed node");
  assert.equal(state.objects[(freed as { addr: string }).addr]!.state, "FREED");
});

test("malloc/calloc/free list: drawn as a singly linked list matching the output; free() marks the node freed", async () => {
  const l = await load("linked-lists/malloc_list.cpp");
  const { scenes } = scenesAt(l, stepAt(l, "for (Node* c = head"));
  const sc = scenes.find((s) => s.kind === "singly-linked-list")!;
  assert.ok(sc);
  assert.deepEqual(chain(sc, ptrTarget(sc, "head")), printed(l.output));            // 1 3 4
  assert.deepEqual(sc.nodes.filter((n) => n.status !== "freed").map((n) => n.label), ["1", "3", "4"]);
  assert.deepEqual(sc.nodes.filter((n) => n.status === "freed").map((n) => n.label), ["2"]);   // 'dead' still points at it: shown as a freed ghost
  const i = l.history.steps.findIndex((s) => s.events.some((e) => e.type === "object_freed"));
  assert.ok(i >= 0, "free() must produce an object_freed event");
  const freed = (l.history.steps[i]!.events.find((e) => e.type === "object_freed") as { addr: string }).addr;
  assert.equal(l.history.stateAt(i).objects[freed]!.state, "FREED");
  assert.equal(findings(l.history, l.lines).filter((f) => f.code === "leak").length, 0);   // everything reachable or freed: no false leak
});

test("empty list and single node: no fabricated edges", async () => {
  const l = await load("linked-lists/singly.cpp");
  const first = scenesAt(l, stepAt(l, "l.push_back(2);")).scenes.filter((s) => s.kind === "singly-linked-list");
  assert.equal(first.length, 0);                                                    // nothing allocated yet: nothing drawn
  const one = scenesAt(l, stepAt(l, "l.push_front(1);")).scenes.find((s) => s.kind === "singly-linked-list")!;
  assert.equal(one.nodes.length, 1);
  assert.equal(one.edges.length, 0);
  assert.equal(ptrTarget(one, "l.head"), one.nodes[0]!.id);
});

test("doubly linked list: next/prev symmetric, order matches output", async () => {
  const l = await load("linked-lists/doubly.cpp");
  const { scenes } = scenesAt(l, stepAt(l, "for (Node* c = l.head"));
  const sc = scenes.find((s) => s.kind === "doubly-linked-list")!;
  assert.ok(sc);
  assert.deepEqual(chain(sc, ptrTarget(sc, "l.head"), "next"), printed(l.output));
  assert.deepEqual(chain(sc, ptrTarget(sc, "l.tail"), "prev"), [...printed(l.output)].reverse());
  for (const e of sc.edges.filter((x) => x.kind === "next")) assert.ok(sc.edges.some((p) => p.kind === "prev" && p.from === e.to && p.to === e.from));
});

test("BST: in-order of the drawn tree equals program output; BST property holds", async () => {
  const l = await load("binary-trees/bst.cpp");
  const { scenes } = scenesAt(l, stepAt(l, "inorder(root);"));
  const sc = scenes.find((s) => s.kind === "binary-tree")!;
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

test("BST during recursion: the call chain shows one 'root' pointer per active frame", async () => {
  const l = await load("binary-trees/bst.cpp");
  let maxRoots = 0;
  for (let i = 0; i < l.history.length; i++) {
    const sc = scenesAt(l, i).scenes.find((s) => s.kind === "binary-tree");
    if (sc) maxRoots = Math.max(maxRoots, sc.pointers.filter((p) => p.name.startsWith("root")).length);
  }
  assert.ok(maxRoots >= 3);
});

test("AVL: balanced shape after rotations, heights correct", async () => {
  const l = await load("binary-trees/avl.cpp");
  const { scenes } = scenesAt(l, stepAt(l, "inorder(root);"));
  const sc = scenes.find((s) => s.kind === "binary-tree")!;
  const root = sc.nodes.find((n) => n.id === ptrTarget(sc, "root"))!;
  assert.equal(root.label, "20");                                          // 10,20,30 rotates to 20; 40,50 rotates the right subtree
  assert.match(root.sub ?? "", /height=3/);
});

test("red-black: colours are taken from the enum values", async () => {
  const l = await load("binary-trees/rbtree.cpp");
  const { scenes } = scenesAt(l, stepAt(l, "inorder(root);"));
  const sc = scenes.find((s) => s.kind === "binary-tree")!;
  assert.equal(sc.nodes.find((n) => n.id === ptrTarget(sc, "root"))!.fill, "black");
  assert.ok(sc.nodes.some((n) => n.fill === "red"));
});

test("array with size: unused cells dimmed, values match the program", async () => {
  const l = await load("arrays/array_ops.cpp");
  const { scenes } = scenesAt(l, stepAt(l, "for (int i = 0; i < a.size; i++)"));
  const sc = scenes.find((s) => s.kind === "array")!;
  assert.deepEqual(sc.nodes.filter((n) => n.status !== "unused").map((n) => n.label), printed(l.output));
  assert.equal(sc.nodes.filter((n) => n.status === "unused").length, 6);
});

test("min-heap: shown as heap, array row equals the program's final vector", async () => {
  const l = await load("heaps/minheap.cpp");
  const { scenes } = scenesAt(l, stepAt(l, "for (int v : h.a)"));
  const sc = scenes.find((s) => s.kind === "heap")!;
  assert.ok(sc);
  const row = sc.nodes.filter((n) => n.shape === "cell").map((n) => n.label);
  assert.deepEqual(row, printed(l.output).slice(1));
  assert.match(sc.notes.join(" "), /heap property holds/);
});

test("hash table: chains per bucket, newest entry first; update does not add an entry", async () => {
  const l = await load("hash-tables/chained.cpp");
  const { scenes } = scenesAt(l, stepAt(l, 'std::printf("done'));
  const sc = scenes.find((s) => s.kind === "hash-table")!;
  assert.ok(sc);
  const bucket = (i: number) => { const e = sc.edges.find((x) => x.from === `${sc.id}[${i}]`); return e ? chain(sc, e.to) : []; };
  assert.deepEqual(bucket(1), ["11", "6", "1"]);
  assert.deepEqual(bucket(2), ["2"]);
  assert.deepEqual(bucket(0), []);
  assert.match(sc.nodes.find((n) => n.label === "6")!.sub ?? "", /val=666/);
});

test("graph from adjacency list: edges 0-1,0-2,1-3,2-4, undirected", async () => {
  const l = await load("graphs/bfs.cpp");
  const { scenes } = scenesAt(l, stepAt(l, "for (int d : dist)"));
  const sc = scenes.find((s) => s.kind === "graph")!;
  assert.ok(sc);
  const es = sc.edges.map((e) => [e.from, e.to].map((x) => x.split(".v")[1]).join("-")).sort();
  assert.deepEqual(es, ["0-1", "0-2", "1-3", "2-4"]);
  assert.ok(sc.edges.every((e) => !e.directed));
  const dist = scenes.find((s) => s.kind === "array" && s.title.includes("dist"))!;
  assert.deepEqual(dist.nodes.map((n) => n.label), printed(l.output));
});

test("trie: 6 nodes, end-of-word marks match the inserted words", async () => {
  const l = await load("tries/trie.cpp");
  const { scenes } = scenesAt(l, stepAt(l, 'std::printf("ok'));
  const sc = scenes.find((s) => s.kind === "trie")!;
  assert.ok(sc);
  assert.equal(sc.nodes.length, 6);
  assert.equal(sc.nodes.filter((n) => n.doubleBorder).length, 3);
});

test("stack and queue", async () => {
  const l = await load("stacks-queues/stack_queue.cpp");
  const { scenes } = scenesAt(l, stepAt(l, 'std::printf("%d %d'));
  const st = scenes.find((s) => s.kind === "stack")!;
  assert.deepEqual(chain(st, ptrTarget(st, "s.top")), ["2", "1"]);                   // 3 was popped
  const q = scenes.find((s) => s.kind === "queue")!;
  assert.ok(q);
  assert.deepEqual(q.nodes.map((n) => n.label), ["7", "8", "9", "10"]);            // slot 0 still holds the dequeued 7: dequeue only moves head
  assert.deepEqual(q.markers.map((m) => m.name).sort(), ["head"]);
});

// ---- breadth examples: smart pointers, sentinel lists, pointer graphs, arrays-as-forests -----------------------------------------------
const inorder = (sc: ReturnType<typeof scenesAt>["scenes"][number], id: string | null | undefined): string[] => {
  if (!id) return [];
  const lab = sc.nodes.find((n) => n.id === id)!.label, l = outEdges(sc, id, "left")[0]?.to, r = outEdges(sc, id, "right")[0]?.to;
  return [...inorder(sc, l), lab, ...inorder(sc, r)];
};

test("unique_ptr tree: smart pointers are followed like raw pointers; in-order of the drawn tree equals the output", async () => {
  const l = await load("binary-trees/unique_ptr_tree.cpp");
  const i = stepAt(l, "std::printf(\"\\n\");");
  const sc = scenesAt(l, i).scenes.find((s) => s.kind === "binary-tree")!;
  assert.ok(sc, "drawn as a tree, not a generic graph");
  assert.equal(sc.nodes.length, 6); assert.equal(sc.edges.length, 5);
  assert.deepEqual(inorder(sc, ptrTarget(sc, "root")), printed(l.output));
  assert.ok(!scenesAt(l, i).scenes.some((s) => s.kind === "generic"));
});

test("shared_ptr/weak_ptr list: next and prev links are drawn; chain equals the output", async () => {
  const l = await load("linked-lists/shared_ptr_list.cpp");
  const sc = scenesAt(l, stepAt(l, "for (auto n = head; n; n = n->next) std::printf")).scenes.find((s) => s.kind === "doubly-linked-list")!;
  assert.ok(sc);
  assert.deepEqual(chain(sc, ptrTarget(sc, "head")), printed(l.output));
  assert.equal(sc.edges.filter((e) => e.kind === "prev").length, 3, "weak_ptr back links");
});

test("sentinel circular list: the circle is closed with observed links only (sentinel is a node, 2 links per node)", async () => {
  const l = await load("linked-lists/sentinel.cpp");
  const sc = scenesAt(l, stepAt(l, "for (Node* n = d.head->next;")).scenes.find((s) => s.kind === "doubly-linked-list")!;
  assert.ok(sc); assert.equal(sc.nodes.length, 4); assert.equal(sc.edges.length, 8);
  const head = ptrTarget(sc, "d.head")!;
  assert.deepEqual(chain(sc, outEdges(sc, head, "next")[0]!.to).slice(0, 3), printed(l.output));   // sentinel excluded: 2 3 4
});

test("pointer graph: neighbour-vector edges equal the program's adjacency; no node is a dead end except where the program says", async () => {
  const l = await load("graphs/dfs_ptr.cpp");
  const sc = scenesAt(l, stepAt(l, "for (GNode* n : g) delete n;")).scenes.find((s) => s.kind === "graph")!;
  assert.ok(sc); assert.equal(sc.nodes.length, 5); assert.equal(sc.edges.length, 6);   // 0->1,2  1->3  2->3,4  3->0
  const lab = (id: string) => sc.nodes.find((n) => n.id === id)!.label;
  const adj = sc.edges.map((e) => `${lab(e.from)}>${lab(e.to)}`).sort();
  assert.deepEqual(adj, ["0>1", "0>2", "1>3", "2>3", "2>4", "3>0"]);
  assert.ok(!scenesAt(l, stepAt(l, "for (GNode* n : g) delete n;")).scenes.some((s) => /GNode@0x[0-9a-f]+\.out/.test(s.title)), "per-node neighbour vectors are not drawn a second time as array scenes");
});

test("union-find arrays: following the drawn parent array reproduces the printed roots", async () => {
  const l = await load("arrays/union_find.cpp");
  const sc = scenesAt(l, stepAt(l, "for (int i = 0; i < 8; i++) std::printf")).scenes.find((s) => s.title.includes("d.parent"))!;
  assert.ok(sc);
  const parent = sc.nodes.map((n) => Number(n.label));
  const root = (x: number) => { while (parent[x] !== x) x = parent[x]!; return x; };
  assert.deepEqual(parent.map((_, i) => String(root(i))), printed(l.output));
});

test("make_shared: the node inside the control block is drawn as a normal heap object; tree equals the output; no leak, no control-block noise; freed at the end", async () => {
  const l = await load("binary-trees/shared_tree.cpp");
  const i = stepAt(l, "inorder(root);");
  const scs = scenesAt(l, i).scenes;
  const sc = scs.find((s) => s.kind === "binary-tree")!;
  assert.ok(sc); assert.equal(sc.nodes.length, 6); assert.equal(sc.edges.length, 5);
  assert.deepEqual(inorder(sc, ptrTarget(sc, "root")), printed(l.output));
  assert.deepEqual(scs.filter((s) => s.kind === "generic"), [], "control blocks are not drawn as stray objects");
  assert.equal(findings(l.history, l.lines).filter((f) => f.code === "leak").length, 0);
  const last = l.history.stateAt(l.history.length - 1);
  assert.ok(Object.values(last.objects).filter((o) => o.type === "Node").every((o) => o.state === "FREED"), "all nodes freed when root goes out of scope");
  assert.equal(Object.values(last.objects).filter((o) => o.type === "Node").length, 6);
});

test("make_shared list with weak_ptr back links: both directions drawn, chain equals the output", async () => {
  const l = await load("linked-lists/shared_ptr_list.cpp");
  const sc = scenesAt(l, stepAt(l, "for (auto n = head; n; n = n->next) std::printf")).scenes.find((s) => s.kind === "doubly-linked-list")!;
  assert.ok(sc); assert.deepEqual(chain(sc, ptrTarget(sc, "head")), printed(l.output));
  assert.equal(sc.edges.filter((e) => e.kind === "prev").length, 3);
});

test("pointer cells carry a ref to the pointee: vector<Node*> cells and map values point at drawn heap objects (no cross-scene edges)", async () => {
  const l = await load("graphs/dfs_ptr.cpp");
  const sc = scenesAt(l, stepAt(l, "for (GNode* n : g) delete n;")).scenes;
  const vec = sc.find((s) => s.title.includes("Vector g"))!;
  const graph = sc.find((s) => s.kind === "graph")!;
  assert.equal(vec.nodes.length, 5);
  for (const c of vec.nodes) { assert.ok(c.ref, "every cell of g holds a live object pointer"); assert.ok(graph.nodes.some((n) => n.id === c.ref), "and the pointee is a node of the graph scene"); }
  assert.deepEqual(vec.edges, [], "refs are not edges");
  const m = await load("stl/ptr_map.cpp");
  const at = scenesAt(m, stepAt(m, "for (const auto& kv : index)")).scenes;
  const sm = at.find((x) => x.kind === "map")!, nodes = at.filter((x) => x.kind !== "map").flatMap((x) => x.nodes);
  assert.ok(sm, "the map is drawn"); const refs = sm.nodes.filter((n) => n.ref);
  assert.equal(refs.length, 3, "all three values are object pointers");
  for (const n of refs) assert.ok(nodes.some((x) => x.id === n.ref), "the pointee Node is drawn by its own adapter, under the id the ref names");
});

import { GLOBALS_FN } from "../core/events/types.ts";
import { explainStep } from "../core/explain/explain.ts";

test("globals: file-scope variables are read as an outermost pseudo-frame; the global list head is a named pointer and the global array is drawn", async () => {
  const l = await load("linked-lists/globals.cpp");
  const i = stepAt(l, "for (int i = 0; i < 6; i++) std::printf");
  const st = l.history.stateAt(i), g = st.frames[st.frames.length - 1]!;
  assert.equal(g.fn, GLOBALS_FN); assert.deepEqual(Object.keys(g.locals), ["head", "arr", "count"], "declaration order");
  assert.equal(st.frames.filter((f) => f.fn === GLOBALS_FN).length, 1);
  const sc = scenesAt(l, i).scenes;
  const list = sc.find((s) => s.kind === "singly-linked-list")!;
  assert.deepEqual(chain(list, ptrTarget(list, "head")), ["3", "2", "1"]);
  const arr = sc.find((s) => s.title === "Array arr")!;
  assert.deepEqual(arr.nodes.map((n) => n.label), printed(l.output).slice(0, 6), "the global array, sorted by sort_arr(), equals the program's output");
  assert.equal(l.history.steps[i]!.depth, 1, "the globals pseudo-frame does not count as call depth");
});

test("globals: a change to a global is an observed event and is explained; globals are in every step", async () => {
  const l = await load("linked-lists/globals.cpp");
  const texts: string[] = [];
  for (let i = 0; i < l.history.length; i++) {
    assert.equal(l.history.stateAt(i).frames.at(-1)!.fn, GLOBALS_FN, `@${i}`);
    texts.push(...explainStep(l.history.stateAt(i), { main: l.lines }).effects);
  }
  assert.ok(texts.some((t) => /Variable 'count' changed from 0 to 1/.test(t)), texts.join("\n"));
  assert.ok(texts.some((t) => /Variable 'head' changed/.test(t)));
});

test("heap arrays are named after their owner (a, s.data), carry the index markers of the running function, and the sorted array equals the output", async () => {
  const l = await load("arrays/heap_arrays.cpp");
  const mid = stepAt(l, "int t = a[i]; a[i] = a[hi]; a[hi] = t;");
  const sc = scenesAt(l, mid).scenes;
  const a = sc.find((s) => s.title.includes("a → int[6]"))!;
  assert.ok(a, sc.map((s) => s.title).join(" | "));
  assert.ok(sc.some((s) => s.title.includes("s.data → int[")), "member pointer s.data names its array");
  assert.ok(!sc.some((s) => /int\[\d\] @0x/.test(s.title)), "no array is left named by address only");
  const names = a.markers.map((m) => m.name);
  assert.ok(["i", "lo", "hi"].every((n) => names.includes(n)), `markers ${names.join(",")}`);
  const end = scenesAt(l, stepAt(l, "for (int i = 0; i < 6; i++) std::printf")).scenes.find((s) => s.title.includes("a → int[6]"))!;
  assert.deepEqual(end.nodes.map((n) => n.label), printed(l.output));
});

test("arrays of structs/pairs show their content in the cells (key-like field as label, rest below), not '…'", async () => {
  const l = await load("hash-tables/open_addressing.cpp");
  const sc = scenesAt(l, stepAt(l, "std::printf(\"%d\\n\", h.table[5].val)")).scenes.find((s) => s.title.includes("h.table"))!;
  assert.ok(sc); assert.equal(sc.nodes.length, 8);
  const by = new Map(sc.nodes.map((n) => [n.index!, n]));
  assert.equal(by.get(3)!.label, "3"); assert.equal(by.get(3)!.sub, "30,true");
  assert.equal(by.get(4)!.label, "11"); assert.equal(by.get(5)!.label, "19");          // 11 and 19 probed past 3 (all hash to 3): linear probing
  assert.equal(by.get(6)!.label, "4", "4 % 8 = 4 is taken by 11, so 4 sits at 6");
  assert.equal(by.get(0)!.sub, "0,false");
  assert.match(by.get(3)!.tip!, /key=3, val=30, used=true/);
  assert.ok(sc.nodes.every((n) => n.label !== "…"));
});

test("Dijkstra: pq of pairs is a heap with readable nodes; no storage-duplicate or generic scenes from range-for iterators; dist equals the output", async () => {
  const l = await load("graphs/dijkstra.cpp");
  const line = l.lines.findIndex((t) => t.includes("for (Edge e : g[u])")) + 1;
  const mid = l.history.steps.findIndex((st, i) => st.file === "main" && st.line === line && scenesAt(l, i).scenes.some((s) => s.kind === "heap" && s.nodes.length >= 2));
  assert.ok(mid > 0, "a step with a non-empty pq inside the relaxation loop");
  const sc = scenesAt(l, mid).scenes;
  assert.ok(!sc.some((s) => /@0x/.test(s.title)), sc.map((s) => s.title).join(" | "));
  assert.ok(!sc.some((s) => s.kind === "generic"));
  const pq = sc.find((s) => s.title.includes("pq"))!;
  assert.equal(pq.kind, "heap"); assert.ok(pq.nodes.every((n) => n.label !== "…"));
  const g = sc.find((s) => s.title.includes("g"))!;
  assert.ok(g.nodes.every((n) => n.label !== "…"));
  const end = scenesAt(l, stepAt(l, "for (int x : dist)")).scenes.find((s) => s.title === "Vector dist")!;
  assert.deepEqual(end.nodes.map((n) => n.label), printed(l.output));
});

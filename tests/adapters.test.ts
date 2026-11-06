import { test } from "node:test";
import assert from "node:assert/strict";
import { load, stepAt, scenesAt, chain, ptrTarget, outEdges } from "./helpers.ts";
import { isPtr } from "../core/adapters/analysis.ts";
import { interpret } from "../core/adapters/index.ts";
import { findings } from "../core/analysis/findings.ts";

const printed = (o: string) => o.trim().split(/\s+/);

test("INVARIANT: every drawn heap edge exists in the observed pointer data (all examples, all steps)", async () => {
  const files = ["linked-lists/list.cpp", "linked-lists/singly.cpp", "linked-lists/malloc_list.cpp", "linked-lists/doubly.cpp", "binary-trees/bst.cpp", "binary-trees/avl.cpp", "binary-trees/rbtree.cpp",
    "hash-tables/chained.cpp", "tries/trie.cpp", "stacks-queues/stack_queue.cpp"];
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
        for (const p of sc.pointers) if (p.state === "live") assert.equal(state.objects[p.target!]?.state, "LIVE");
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

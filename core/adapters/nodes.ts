import type { Value } from "../events/types.ts";
import type { HeapObject, RuntimeState } from "../snapshots/history.ts";
import type { EdgeKind, Scene, SNode } from "../models/scene.ts";
import type { Claims, DataStructureAdapter } from "./types.ts";
import { analyzeNodeTypes, baseType, collectRoots, isArr, isPtr, isScalar, labelField, normType, objChanged, show, target, type NodeType } from "./analysis.ts";
import { layoutCircle, layoutTree } from "./layout.ts";
import { fit, newScene, pointersTo } from "./scene-util.ts";

const PREV = /prev|back|before|parent|up/i, NEXT = /next|nxt|link|succ/i, LEFT = /^(left|l|lc|lchild|lft)$/i, RIGHT = /^(right|r|rc|rchild|rgt)$/i;
const edgeKindOf = (f: string): EdgeKind => (LEFT.test(f) ? "left" : RIGHT.test(f) ? "right" : PREV.test(f) ? "prev" : NEXT.test(f) ? "next" : "ptr");

export type NodeClass = { kind: "singly" | "doubly" | "tree" | "trie" | "graph" | "generic"; confidence: number; reason: string };

/** Classify a node type from *observed* field types + names + (when ambiguous) observed back-links. */
export function classify(t: NodeType, state: RuntimeState): NodeClass {
  if (t.selfArrayFields.length) return { kind: "trie", confidence: 0.8, reason: `field '${t.selfArrayFields[0]}' is an array of ${t.name}* (children indexed by symbol)` };
  if (t.selfVecFields.length) return { kind: "graph", confidence: 0.8, reason: `field '${t.selfVecFields[0]}' is a vector of ${t.name}* (neighbour list)` };
  const f = t.selfFields;
  if (f.length === 0) return { kind: "generic", confidence: 0, reason: "no self-referencing pointer" };
  if (f.length === 1) return { kind: "singly", confidence: 0.9, reason: `one self-pointer '${f[0]}' → singly linked list` };
  const left = f.find((x) => LEFT.test(x)), right = f.find((x) => RIGHT.test(x));
  if (left && right) return { kind: "tree", confidence: 0.95, reason: `self-pointers '${left}'/'${right}' → binary tree` };
  const prev = f.find((x) => PREV.test(x)), next = f.find((x) => NEXT.test(x));
  if (f.length === 2 && prev && next) return { kind: "doubly", confidence: 0.95, reason: `self-pointers '${prev}'/'${next}' → doubly linked list` };
  if (f.length === 2) {
    let pairs = 0, edges = 0;
    for (const o of t.objs) {
      const a = target(state, o.fields?.[f[0]!]);
      if (a?.fields) { edges++; if (target(state, a.fields[f[1]!])?.addr === o.addr) pairs++; }
    }
    if (pairs > 0 && pairs === edges) return { kind: "doubly", confidence: 0.75, reason: `'${f[1]}' links back to the node whose '${f[0]}' reaches it (observed ${pairs}×)` };
    return { kind: "tree", confidence: 0.55, reason: `two self-pointers '${f[0]}'/'${f[1]}' without observed back-links → assumed binary tree` };
  }
  if (left && right) return { kind: "tree", confidence: 0.85, reason: "left/right plus extra pointers" };
  return { kind: "generic", confidence: 0.4, reason: `${f.length} self-pointers: drawn as a generic pointer graph` };
}

interface Built { nodes: Map<string, HeapObject>; ids: (o: string) => string | null; }

/** Heap nodes of type t that are LIVE, plus FREED ghosts only if something observed still points at them. */
function collectNodes(state: RuntimeState, t: NodeType, claims: Claims): Built {
  const nodes = new Map<string, HeapObject>();
  for (const o of t.objs) if (o.state === "LIVE" && !claims.objects.has(o.addr)) nodes.set(o.addr, o);
  const ghost = (v: Value | undefined) => { const g = target(state, v); if (g && g.state === "FREED" && baseType(g) === t.name && !claims.objects.has(g.addr)) nodes.set(g.addr, g); };
  for (const r of collectRoots(state)) ghost(r.ptr);
  for (const o of [...nodes.values()]) for (const v of Object.values(o.fields ?? {})) { ghost(v); if (isArr(v)) v.elems.forEach(ghost); }
  return { nodes, ids: (a) => (nodes.has(a) ? a : null) };
}

export function mkNode(state: RuntimeState, t: NodeType, o: HeapObject, x: number, y: number, shape: "box" | "circle"): SNode {
  const lf = labelField(t);
  const extras = t.scalarFields.filter((f) => f !== lf).map((f) => `${f}=${show(o.fields?.[f])}`);
  const ch = objChanged(state, o);
  const colorField = t.scalarFields.find((f) => /colou?r|red|black/i.test(f));
  const cv = colorField ? String(o.fields?.[colorField]) : "";
  return {
    id: o.addr, label: lf ? show(o.fields?.[lf]) : "•", sub: extras.join(" "), x, y, w: shape === "circle" ? 44 : 72, h: shape === "circle" ? 44 : 40,
    shape, status: o.state === "FREED" ? "freed" : ch ?? "live", addr: o.addr,
    fill: /RED/i.test(cv) ? "red" : /BLACK/i.test(cv) ? "black" : undefined,
  };
}
export const edgeId = (a: string, f: string, b: string, i?: number) => `${a}.${f}${i === undefined ? "" : `[${i}]`}->${b}`;

function addEdges(s: Scene, state: RuntimeState, t: NodeType, b: Built): void {
  const prevEdges = new Set<string>();
  if (state.prev) for (const o of Object.values(state.prev.objects)) for (const [f, v] of Object.entries(o.fields ?? {})) {
    if (isPtr(v) && v.obj) prevEdges.add(edgeId(o.addr, f, v.obj));
  }
  for (const o of b.nodes.values()) {
    for (const [f, v] of Object.entries(o.fields ?? {})) {
      const list = isArr(v) ? v.elems.map((e, i) => [e, i] as const) : [[v, undefined] as const];
      for (const [e, i] of list) {
        const tg = target(state, e);
        if (!tg || !b.nodes.has(tg.addr) || !isPtr(e) || normType(e.to) !== t.name) continue;
        const id = edgeId(o.addr, f, tg.addr, i);
        s.edges.push({ id, from: o.addr, to: tg.addr, kind: edgeKindOf(f), label: i !== undefined ? String(i) : undefined, directed: true,
          changed: !prevEdges.has(edgeId(o.addr, f, tg.addr)) });
      }
    }
  }
}

function incoming(b: Built, fields: string[], state: RuntimeState): Map<string, number> {
  const inc = new Map<string, number>();
  for (const o of b.nodes.values()) for (const f of fields) { const tg = target(state, o.fields?.[f]); if (tg && b.nodes.has(tg.addr)) inc.set(tg.addr, (inc.get(tg.addr) ?? 0) + 1); }
  return inc;
}
const byAge = (a: HeapObject, b: HeapObject) => (a.createdAt?.step ?? 0) - (b.createdAt?.step ?? 0) || a.addr.localeCompare(b.addr);

function listScene(state: RuntimeState, t: NodeType, cls: NodeClass, claims: Claims): Scene[] {
  const b = collectNodes(state, t, claims);
  if (!b.nodes.size && !pointersTo(state, t.name, () => null).length) return [];
  const doubly = cls.kind === "doubly";
  const nextF = t.selfFields.find((f) => NEXT.test(f)) ?? t.selfFields[0]!;
  const roots = collectRoots(state).map((r) => r.name);
  const stack = /stack/i.test(t.name) || roots.some((n) => /(^|\.)top$/i.test(n));
  const queue = /queue/i.test(t.name) || roots.some((n) => /(^|\.)(front|rear)$/i.test(n));
  const kind = stack ? "stack" : queue ? "queue" : doubly ? "doubly-linked-list" : "singly-linked-list";
  const s = newScene(`list:${t.name}`, kind, `${stack ? "Stack" : queue ? "Queue" : doubly ? "Doubly" : "Singly"} linked list of ${t.name}`, cls.confidence, cls.reason);
  const inc = incoming(b, [nextF], state);
  const order = [...b.nodes.values()].sort(byAge);
  const starts = order.filter((o) => !inc.get(o.addr));
  const placed = new Set<string>();
  let row = 0, maxCol = 0;
  const walk = (o: HeapObject) => {
    let cur: HeapObject | null = o, col = 0;
    while (cur && !placed.has(cur.addr)) {
      placed.add(cur.addr);
      s.nodes.push(mkNode(state, t, cur, 40 + col * 110, 50 + row * 90, "box"));
      col++; maxCol = Math.max(maxCol, col);
      const n = target(state, cur.fields?.[nextF]);
      cur = n && b.nodes.has(n.addr) ? n : null;
    }
    row++;
  };
  starts.forEach(walk); order.forEach((o) => { if (!placed.has(o.addr)) walk(o); });
  addEdges(s, state, t, b);
  s.pointers = pointersTo(state, t.name, b.ids);
  if (s.nodes.some((n) => n.status === "freed")) s.notes.push("Dashed nodes were freed; they are shown because a pointer still refers to them (dangling).");
  if (row > 1) s.notes.push(`${row} separate chains (nodes not reachable from each other via '${nextF}').`);
  fit(s); return [s];
}

function treeScene(state: RuntimeState, t: NodeType, cls: NodeClass, claims: Claims): Scene[] {
  const b = collectNodes(state, t, claims);
  if (!b.nodes.size) return [];
  const treeF = t.selfFields.filter((f) => LEFT.test(f) || RIGHT.test(f));
  const fields = treeF.length ? treeF : t.selfFields;
  const ordered = (o: HeapObject): (string | null)[] => {
    const fs = treeF.length ? [t.selfFields.find((f) => LEFT.test(f)), t.selfFields.find((f) => RIGHT.test(f))] : fields;
    return fs.map((f) => { const tg = f ? target(state, o.fields?.[f]) : null; return tg && b.nodes.has(tg.addr) ? tg.addr : null; });
  };
  const inc = incoming(b, fields, state);
  const order = [...b.nodes.values()].sort(byAge);
  const roots = order.filter((o) => !inc.get(o.addr)).map((o) => o.addr);
  const L = layoutTree(roots.length ? roots : order.map((o) => o.addr).slice(0, 1), (id) => ordered(b.nodes.get(id)!));
  const missing = order.filter((o) => !L.pos.has(o.addr));
  let ex = L.width;
  const s = newScene(`tree:${t.name}`, "binary-tree", `Binary tree of ${t.name}`, cls.confidence, cls.reason);
  for (const o of order) {
    const p = L.pos.get(o.addr) ?? { x: (ex += 56), y: 40 };
    s.nodes.push(mkNode(state, t, o, p.x - 22, p.y - 22, "circle"));
  }
  void missing;
  addEdges(s, state, t, b);
  s.pointers = pointersTo(state, t.name, b.ids);
  if (roots.length > 1) s.notes.push(`${roots.length} separate trees (roots with no parent among live nodes).`);
  fit(s); return [s];
}

function trieScene(state: RuntimeState, t: NodeType, cls: NodeClass, claims: Claims): Scene[] {
  const b = collectNodes(state, t, claims);
  if (!b.nodes.size) return [];
  const cf = t.selfArrayFields[0]!;
  const kids = (o: HeapObject): (string | null)[] => {
    const arr = o.fields?.[cf];
    return isArr(arr) ? arr.elems.map((e) => { const tg = target(state, e); return tg && b.nodes.has(tg.addr) ? tg.addr : null; }) : [];
  };
  const inc = new Map<string, number>();
  for (const o of b.nodes.values()) kids(o).forEach((k) => k && inc.set(k, 1));
  const order = [...b.nodes.values()].sort(byAge);
  const roots = order.filter((o) => !inc.get(o.addr)).map((o) => o.addr);
  const L = layoutTree(roots, (id) => kids(b.nodes.get(id)!).filter((k) => k !== null), 60, 80);
  const endF = t.scalarFields.find((f) => /^(end|is_?end|word|terminal|leaf|eow)$/i.test(f));
  const s = newScene(`trie:${t.name}`, "trie", `Trie of ${t.name}`, cls.confidence, cls.reason);
  for (const o of order) {
    const p = L.pos.get(o.addr) ?? { x: 40, y: 40 };
    const n = mkNode(state, t, o, p.x - 22, p.y - 22, "circle");
    n.label = inc.get(o.addr) ? "" : "root"; n.sub = undefined;
    n.doubleBorder = !!endF && o.fields?.[endF] === true;
    s.nodes.push(n);
  }
  addEdges(s, state, t, b);
  s.pointers = pointersTo(state, t.name, b.ids);
  if (endF) s.notes.push(`Double border = '${endF}' is true.`);
  s.notes.push("Edge labels are child-array indices (symbols are not decoded).");
  fit(s); return [s];
}

function nodeGraphScene(state: RuntimeState, t: NodeType, cls: NodeClass, claims: Claims): Scene[] {
  const b = collectNodes(state, t, claims);
  if (!b.nodes.size) return [];
  const order = [...b.nodes.values()].sort(byAge);
  const pts = layoutCircle(order.length);
  const s = newScene(`graph:${t.name}`, "graph", `Graph of ${t.name}`, cls.confidence, cls.reason);
  order.forEach((o, i) => s.nodes.push(mkNode(state, t, o, pts[i]!.x - 22, pts[i]!.y - 22, "circle")));
  addEdges(s, state, { ...t, selfFields: [...t.selfFields, ...t.selfVecFields] }, b);
  s.pointers = pointersTo(state, t.name, b.ids);
  fit(s); return [s];
}

function genericScene(state: RuntimeState, t: NodeType, cls: NodeClass, claims: Claims): Scene[] {
  const b = collectNodes(state, t, claims);
  if (!b.nodes.size) return [];
  const order = [...b.nodes.values()].sort(byAge);
  const s = newScene(`generic:${t.name}`, "generic", `Pointer graph of ${t.name}`, cls.confidence, cls.reason);
  const cols = Math.ceil(Math.sqrt(order.length));
  order.forEach((o, i) => s.nodes.push(mkNode(state, t, o, 40 + (i % cols) * 110, 40 + Math.floor(i / cols) * 90, "box")));
  addEdges(s, state, t, b);
  s.pointers = pointersTo(state, t.name, b.ids);
  fit(s); return [s];
}

/** One adapter per node-structure family; each claims the heap objects it draws. */
function nodeAdapter(id: string, kinds: NodeClass["kind"][], build: typeof listScene): DataStructureAdapter {
  const matching = (state: RuntimeState, claims: Claims) => [...analyzeNodeTypes(state).values()]
    .map((t) => ({ t, cls: classify(t, state) })).filter((x) => kinds.includes(x.cls.kind) && x.t.objs.some((o) => !claims.objects.has(o.addr)));
  return {
    id,
    canHandle: (state, claims) => matching(state, claims).length > 0,
    interpret(state, claims) {
      const scenes: Scene[] = [];
      for (const { t, cls } of matching(state, claims)) {
        const out = build(state, t, cls, claims);
        for (const sc of out) { scenes.push(sc); for (const n of sc.nodes) if (n.addr) claims.objects.add(n.addr); }
      }
      return scenes;
    },
  };
}
export const trieAdapter = nodeAdapter("trie", ["trie"], trieScene);
export const nodeGraphAdapter = nodeAdapter("graph-nodes", ["graph"], nodeGraphScene);
export const treeAdapter = nodeAdapter("binary-tree", ["tree"], treeScene);
export const listAdapter = nodeAdapter("linked-list", ["singly", "doubly"], listScene);
export const genericAdapter = nodeAdapter("generic-graph", ["generic"], genericScene);
void isScalar;

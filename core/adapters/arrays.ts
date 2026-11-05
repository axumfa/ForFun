import type { ArrayValue, Value } from "../events/types.ts";
import type { RuntimeState } from "../snapshots/history.ts";
import type { Scene, SNode } from "../models/scene.ts";
import type { Claims, DataStructureAdapter } from "./types.ts";
import { analyzeNodeTypes, isArr, isPtr, isScalar, isStruct, normType, show, target } from "./analysis.ts";
import { classify, edgeId, mkNode } from "./nodes.ts";
import { layoutCircle, layoutTree } from "./layout.ts";
import { fit, newScene } from "./scene-util.ts";

export interface ArrayRef {
  id: string; label: string; owner?: string; kind: "array" | "vector"; elems: Value[]; elemType: string;
  siblings: Record<string, Value>; capacity?: number; released?: boolean;
}
type Src = Pick<RuntimeState, "frames" | "objects">;

/** All array-like storage visible in a state: locals (outermost frame first so owners win over aliases), struct members, heap arrays. */
export function collectArrays(src: Src): ArrayRef[] {
  const refs = new Map<string, ArrayRef>();
  const add = (id: string | undefined, label: string, v: ArrayValue, owner: string | undefined, sib: Record<string, Value>) => {
    const key = id ?? `arr:${label}`;
    if (!refs.has(key)) refs.set(key, { id: key, label, owner, kind: v.kind as "array" | "vector", elems: v.elems, elemType: v.elemType, siblings: sib, capacity: v.capacity, released: v.released });
  };
  const walk = (name: string, v: Value, owner: string | undefined, sib: Record<string, Value>, depth: number) => {
    if (isArr(v)) add(v.addr ? `arr:${v.addr}` : undefined, name, v, owner, sib);
    else if (isStruct(v) && depth < 3) for (const [k, fv] of Object.entries(v.fields)) walk(`${name}.${k}`, fv, v.type, v.fields, depth + 1);
  };
  [...src.frames].reverse().forEach((f, fi) => {
    for (const [k, v] of Object.entries(f.locals)) walk(k, v, undefined, {}, 0);
    void fi;
  });
  for (const o of Object.values(src.objects)) {
    if (o.state !== "LIVE") continue;
    const t = o.type.replace(/\[\]$/, "");
    if (o.elems) add(`arr:${o.addr}`, `${t}[${o.elems.length}] @${o.addr}`, { kind: "array", elemType: t, elems: o.elems }, undefined, {});
    for (const [k, v] of Object.entries(o.fields ?? {})) if (isArr(v)) add(v.addr ? `arr:${v.addr}` : `arr:${o.addr}.${k}`, `${t}@${o.addr}.${k}`, v, t, o.fields!);
  }
  return [...refs.values()];
}

const BOUND = /^(size|count|len|length|n|cnt|num)$/i, POS = /^(head|tail|front|rear|back|top|first|last|end|cur|curr|pos|idx|index)$/i;
const IDX = /^(i|j|k|idx|index|lo|hi|low|high|mid|l|r|p|q|pos|cur|curr|front|back|head|tail|top|start|stop|pivot)$/i;
const num = (v: Value | undefined): number | null => (typeof v === "number" && Number.isInteger(v) ? v : null);
const textOf = (r: ArrayRef) => `${r.label} ${r.owner ?? ""}`;
const prevOf = (state: RuntimeState, id: string): ArrayRef | undefined => (state.prev ? collectArrays(state.prev).find((r) => r.id === id) : undefined);

function cells(s: Scene, r: ArrayRef, prev: ArrayRef | undefined, bound: number | null, y: number, idp = ""): SNode[] {
  return r.elems.map((e, i) => {
    const changed = !prev || JSON.stringify(prev.elems[i]) !== JSON.stringify(e);
    const n: SNode = { id: `${s.id}${idp}[${i}]`, label: show(isPtr(e) && e.kind === "object" ? e.ptr.slice(-4) : e), x: 40 + i * 56, y, w: 56, h: 40, shape: "cell", status: bound !== null && i >= bound ? "unused" : prev && changed ? "changed" : "live", index: i };
    return n;
  });
}

function arrayScene(state: RuntimeState, r: ArrayRef, claims: Claims): Scene | null {
  const text = textOf(r);
  const scalars = r.elems.every((e) => isScalar(e));
  const kind = /heap|priority|pq/i.test(text) && scalars ? "heap" : /queue/i.test(text) ? "queue" : /stack/i.test(text) ? "stack" : "array";
  const sib = Object.entries(r.siblings);
  const hasPos = sib.some(([k]) => POS.test(k));
  const boundE = sib.find(([k, v]) => BOUND.test(k) && num(v) !== null);
  const bound = boundE && !hasPos ? (boundE[1] as number) : null;
  const s = newScene(r.id, kind, `${kind === "array" ? (r.kind === "vector" ? "Vector" : "Array") : kind[0]!.toUpperCase() + kind.slice(1)} ${r.label}`, kind === "array" ? 1 : 0.85,
    kind === "array" ? "contiguous storage" : `${kind} inferred from the name '${text.trim()}'`);
  if (r.released) { s.notes.push("Storage was released (container destroyed); contents are not read."); s.nodes = []; fit(s); return s; }
  const prev = prevOf(state, r.id);
  const twoD = r.elems.length > 0 && r.elems.every(isArr);
  if (twoD) {
    (r.elems as ArrayValue[]).forEach((row, ri) => row.elems.forEach((e, ci) => s.nodes.push({ id: `${s.id}[${ri}][${ci}]`, label: show(e), x: 40 + ci * 48, y: 40 + ri * 44, w: 48, h: 40, shape: "cell", status: "live", index: ci })));
    s.title = `2D array ${r.label}`; fit(s); return s;
  }
  const base = kind === "heap" ? 0 : 50;
  const row = cells(s, r, prev, bound, kind === "heap" ? 40 + 3 * 76 : base);
  if (kind === "heap") {
    const n = r.elems.length;
    const L = layoutTree(n ? ["0"] : [], (id) => { const i = Number(id); return [2 * i + 1 < n ? String(2 * i + 1) : null, 2 * i + 2 < n ? String(2 * i + 2) : null].filter((x) => x !== null) as string[]; }, 52, 64);
    const maxY = Math.max(0, ...[...L.pos.values()].map((p) => p.y));
    for (const [id, p] of L.pos) {
      const i = Number(id), ch = !prev || JSON.stringify(prev.elems[i]) !== JSON.stringify(r.elems[i]);
      s.nodes.push({ id: `${s.id}.t[${i}]`, label: show(r.elems[i]), x: p.x - 20, y: p.y - 20, w: 40, h: 40, shape: "circle", status: prev && ch ? "changed" : "live", index: i });
      for (const c of [2 * i + 1, 2 * i + 2]) if (c < n) s.edges.push({ id: `${s.id}.t${i}->${c}`, from: `${s.id}.t[${i}]`, to: `${s.id}.t[${c}]`, kind: "child", directed: false });
    }
    row.forEach((c) => { c.y = maxY + 80; });
    const bad = r.elems.findIndex((e, i) => i > 0 && typeof e === "number" && typeof r.elems[Math.floor((i - 1) / 2)] === "number" && (r.elems[Math.floor((i - 1) / 2)] as number) > e);
    const badMax = r.elems.findIndex((e, i) => i > 0 && typeof e === "number" && (r.elems[Math.floor((i - 1) / 2)] as number) < e);
    s.notes.push(bad < 0 ? "Min-heap property holds (parent ≤ child)." : badMax < 0 ? "Max-heap property holds (parent ≥ child)." : `Heap property is violated at index ${bad} (may be transient during sift-up/down).`);
  }
  s.nodes.push(...row);
  // markers: struct siblings first (observed members), then index-like int locals of the innermost frame
  const mk = (name: string, v: Value | undefined) => { const i = num(v); if (i !== null && i >= 0 && i < r.elems.length) s.markers.push({ name, node: `${s.id}[${i}]` }); };
  for (const [k, v] of sib) if (POS.test(k)) mk(k, v);
  const top = state.frames[0];
  if (top) for (const [k, v] of Object.entries(top.locals)) if (IDX.test(k) && !(k in r.siblings)) mk(k, v);
  if (bound !== null) s.notes.push(`Cells beyond '${boundE![0]}' = ${bound} are unused.`);
  if (s.markers.length) s.notes.push("Markers are integer variables/members with index-like names used as positions (heuristic).");
  if (r.kind === "vector" && r.capacity !== undefined) s.notes.push(`size ${r.elems.length}, capacity ${r.capacity}`);
  void claims;
  fit(s); return s;
}

export const arrayAdapter: DataStructureAdapter = {
  id: "array",
  canHandle: (state, claims) => collectArrays(state).some((r) => !claims.arrays.has(r.id)),
  interpret(state, claims) {
    const out: Scene[] = [];
    for (const r of collectArrays(state)) {
      if (claims.arrays.has(r.id)) continue;
      if (r.elems.length === 0 && !r.released) continue;   // empty containers draw nothing (their size is in the variables panel)
      const s = arrayScene(state, r, claims);
      if (s) { out.push(s); claims.arrays.add(r.id); }
    }
    return out;
  },
};

/** Array (or vector) of pointers to a singly-linked node type → hash table with chaining. */
export const hashAdapter: DataStructureAdapter = {
  id: "hash-table",
  canHandle: (state, claims) => candidates(state, claims).length > 0,
  interpret(state, claims) {
    const out: Scene[] = [];
    for (const { r, nodeType: t } of candidates(state, claims)) {
      const named = /bucket|table|hash|map|set|slot/i.test(textOf(r));
      const s = newScene(r.id, "hash-table", `Hash table ${r.label}`, named ? 0.9 : 0.6,
        named ? `array of ${t.name}* named like a hash table; each bucket is a chain` : `array of ${t.name}* where ${t.name} is a singly linked node: looks like bucket chains`);
      const nextF = t.selfFields[0]!;
      const seen = new Set<string>();
      let entries = 0, maxCol = 0;
      r.elems.forEach((e, i) => {
        s.nodes.push({ id: `${s.id}[${i}]`, label: String(i), sub: isPtr(e) && e.kind === "null" ? "∅" : undefined, x: 40, y: 40 + i * 64, w: 48, h: 40, shape: "cell", status: "live", index: i });
        let cur = target(state, e), col = 0, from = `${s.id}[${i}]`, kind: "bucket" | "next" = "bucket";
        while (cur && cur.state === "LIVE" && !seen.has(cur.addr)) {
          seen.add(cur.addr); entries++;
          s.nodes.push(mkNode(state, t, cur, 130 + col * 110, 40 + i * 64, "box"));
          s.edges.push({ id: edgeId(from, kind, cur.addr), from, to: cur.addr, kind, directed: true });
          from = cur.addr; kind = "next"; col++; maxCol = Math.max(maxCol, col);
          cur = target(state, cur.fields?.[nextF]);
        }
      });
      s.title += ` — ${r.elems.length} buckets, ${entries} entries`;
      s.notes.push("Bucket index shown on the left; chains follow the node's next pointer.");
      claims.arrays.add(r.id); for (const n of s.nodes) if (n.addr) claims.objects.add(n.addr);
      fit(s); out.push(s);
    }
    return out;
  },
};
function candidates(state: RuntimeState, claims: Claims) {
  const types = analyzeNodeTypes(state);
  const out: { r: ArrayRef; nodeType: import("./analysis.ts").NodeType }[] = [];
  for (const r of collectArrays(state)) {
    if (claims.arrays.has(r.id) || r.released || !r.elems.length || !r.elems.every(isPtr)) continue;
    const tn = normType((r.elems[0] as { to?: string }).to);
    const t = types.get(tn);
    if (t && classify(t, state).kind === "singly") out.push({ r, nodeType: t });
  }
  return out;
}

/** vector<vector<int>> / int[N][N]: adjacency list or adjacency matrix → graph. */
export const graphArrayAdapter: DataStructureAdapter = {
  id: "graph-array",
  canHandle: (state, claims) => gcands(state, claims).length > 0,
  interpret(state, claims) {
    const out: Scene[] = [];
    for (const g of gcands(state, claims)) {
      const { r, kind } = g, n = r.elems.length;
      const named = /graph|adj|edge|neigh/i.test(textOf(r));
      const edges = edgeSet(r, kind);
      const prevR = prevOf(state, r.id);
      const prevEdges = prevR ? edgeSet(prevR, kind) : null;
      const sym = [...edges].every((e) => { const [a, b] = e.split(">").map(Number) as [number, number]; return edges.has(`${b}>${a}`); });
      const s = newScene(r.id, "graph", `Graph (${kind === "list" ? "adjacency list" : "adjacency matrix"}) ${r.label}`, named ? 0.85 : 0.5,
        named ? `'${r.label}' named like a graph` : `${kind === "list" ? "nested array whose values are all valid vertex indices" : "square 0/1 matrix"}`);
      const pts = layoutCircle(n);
      pts.forEach((p, i) => s.nodes.push({ id: `${s.id}.v${i}`, label: String(i), x: p.x - 20, y: p.y - 20, w: 40, h: 40, shape: "circle", status: "live", index: i }));
      for (const e of edges) {
        const [a, b] = e.split(">").map(Number) as [number, number];
        if (sym && a > b) continue;
        s.edges.push({ id: `${s.id}.${a}>${b}`, from: `${s.id}.v${a}`, to: `${s.id}.v${b}`, kind: "edge", directed: !sym, changed: !!prevEdges && !prevEdges.has(e) });
      }
      s.notes.push(sym ? "All edges are symmetric: drawn as undirected." : "Edges are directed.");
      claims.arrays.add(r.id); fit(s); out.push(s);
    }
    return out;
  },
};
function edgeSet(r: ArrayRef, kind: "list" | "matrix"): Set<string> {
  const e = new Set<string>();
  (r.elems as ArrayValue[]).forEach((row, u) => row.elems.forEach((v, j) => {
    if (kind === "list" && typeof v === "number") e.add(`${u}>${v}`);
    if (kind === "matrix" && v === 1) e.add(`${u}>${j}`);
  }));
  return e;
}
function gcands(state: RuntimeState, claims: Claims): { r: ArrayRef; kind: "list" | "matrix" }[] {
  const out: { r: ArrayRef; kind: "list" | "matrix" }[] = [];
  for (const r of collectArrays(state)) {
    if (claims.arrays.has(r.id) || r.released || r.elems.length < 2 || !r.elems.every(isArr)) continue;
    const rows = r.elems as ArrayValue[], n = rows.length;
    const ints = rows.every((row) => row.elems.every((v) => typeof v === "number"));
    if (!ints) continue;
    const square01 = rows.every((row) => row.elems.length === n && row.elems.every((v) => v === 0 || v === 1));
    const validIds = rows.every((row) => row.elems.every((v) => (v as number) >= 0 && (v as number) < n));
    const listy = /list|adj\b|graph|neigh/i.test(textOf(r));
    if (square01 && !listy) out.push({ r, kind: "matrix" });
    else if (validIds && rows.some((row) => row.elems.length > 0)) out.push({ r, kind: "list" });
  }
  return out;
}

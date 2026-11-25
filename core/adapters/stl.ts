import type { StlEntry, StlValue, Value } from "../events/types.ts";
import type { RuntimeState } from "../snapshots/history.ts";
import type { Scene, SNode } from "../models/scene.ts";
import type { DataStructureAdapter } from "./types.ts";
import { edgeId } from "./nodes.ts";
import { layoutTree } from "./layout.ts";
import { isArr, isPtr, isScalar, isStl, isStruct } from "./analysis.ts";
import { fit, newScene } from "./scene-util.ts";

/** Compact one-line text for any observed value (elements of STL containers can be structs, strings, nested containers). */
export function compact(v: Value | undefined, depth = 0): string {
  if (v === undefined || v === null) return "?";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (isScalar(v)) return String(v);
  if (isPtr(v)) return v.kind === "null" ? "∅" : v.str !== undefined ? JSON.stringify(v.str) : v.ptr;
  if (depth > 1) return "…";
  if (isArr(v)) return `[${v.elems.slice(0, 4).map((e) => compact(e, depth + 1)).join(",")}${v.elems.length > 4 ? ",…" : ""}]`;
  if (isStl(v)) return `${v.container}(${v.size})`;
  if (isStruct(v)) return `{${Object.values(v.fields).slice(0, 3).map((e) => compact(e, depth + 1)).join(",")}}`;
  return "…";
}
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

export interface StlRef { id: string; label: string; v: StlValue; wrapper?: "stack" | "queue"; }
type Src = Pick<RuntimeState, "frames" | "objects">;

/** Every STL container visible in a state: locals (outermost frame first), members of struct locals, members of heap objects. */
export function collectStl(src: Src): StlRef[] {
  const refs = new Map<string, StlRef>();
  const wrap = new Map<StlValue, "stack" | "queue">();      // containers that are the `c` of a std::stack / std::queue: drawn as that adapter, under the variable's name
  const walk = (name: string, v: Value | undefined, depth: number) => {
    if (isStruct(v)) { const m = /^std::(stack|queue)</.exec(v.type), c = v.fields.c; if (m && isStl(c)) { wrap.set(c, m[1] as "stack" | "queue"); walk(name, c, depth + 1); return; } }
    if (isStl(v)) {
      // compiler temporary not yet bound (range-for `__for_range`): a stale slot, read as garbage ("raw") or as an empty container (printer/walk of zeroed or foreign memory). Not data.
      if (name.split(".").some((p) => p.startsWith("__")) && (v.source === "raw" || (v.size <= 0 && v.entries.length === 0))) return;
      const id = `stl:${v.addr ?? name}`, old = refs.get(id), wrapper = wrap?.get(v);          // a range-for's hidden `__range1` aliases the real variable: keep the user's name
      if (!old || (old.label.startsWith("__") && !name.startsWith("__"))) refs.set(id, { id, label: name, v, wrapper });
    }
    else if (isStruct(v) && depth < 3) for (const [k, fv] of Object.entries(v.fields)) walk(`${name}.${k}`, fv, depth + 1);
  };
  [...src.frames].reverse().forEach((f) => { for (const [k, v] of Object.entries(f.locals)) walk(k, v, 0); });
  for (const o of Object.values(src.objects)) if (o.state === "LIVE") for (const [k, v] of Object.entries(o.fields ?? {})) walk(`${o.type}@${o.addr}.${k}`, v, 1);
  return [...refs.values()];
}

const ASSOC = new Set(["map", "multimap", "set", "multiset", "unordered_map", "unordered_multimap", "unordered_set", "unordered_multiset"]);
const SCENE_KIND = (c: StlValue["container"]): Scene["kind"] => (c === "map" || c === "multimap" ? "map" : c === "set" || c === "multiset" ? "set" : c.startsWith("unordered") ? "unordered" : "sequence");

/** Stable id per entry: node address when the walk succeeded; else key (+occurrence, keys repeat in multi containers); else position. */
export function entryIds(sceneId: string, v: StlValue): string[] {
  const seen = new Map<string, number>();
  return v.entries.map((e, i) => {
    if (e.id) return e.id;
    if (ASSOC.has(v.container)) {
      const k = compact(e.key !== undefined ? e.key : e.value), n = seen.get(k) ?? 0; seen.set(k, n + 1);
      return `${sceneId}:k:${k}${n ? `#${n}` : ""}`;
    }
    return `${sceneId}[${i}]`;
  });
}

const label = (e: StlEntry, maplike: boolean) => (maplike ? compact(e.key) : compact(e.value));

/** Logical view: the container's elements in iteration order, one box per element (map: key, with `→ value` below). */
export function logicalScene(ref: StlRef, prev: StlRef | undefined): Scene {
  const v = ref.v, maplike = v.keyType !== undefined || v.container.endsWith("map");
  const s = newScene(ref.id, ref.wrapper ?? SCENE_KIND(v.container), ref.wrapper ? `std::${ref.wrapper} ${ref.label} (over std::${v.container})` : `std::${v.container} ${ref.label}`, 1,
    v.source === "walk" ? "libstdc++ container; elements read by a validated node walk" : v.source === "printer" ? "libstdc++ container; elements read through GDB's pretty-printer" : "libstdc++ container; no reader available");
  s.title += v.size >= 0 ? ` — ${v.size} element${v.size === 1 ? "" : "s"}` : "";
  s.views = viewsOf(ref, "logical");
  if (v.source === "raw") {
    s.notes.push(`Contents not shown: ${v.unavailable ?? "unavailable"}.`);
    if (v.text) s.notes.push(`Raw: ${clip(v.text, 160)}`);
    fit(s); return s;
  }
  const ids = entryIds(ref.id, v), prevIds = prev && prev.v.source !== "raw" ? new Map(entryIds(prev.id, prev.v).map((id, i) => [id, prev.v.entries[i]!] as const)) : null;
  const cell = (e: StlEntry, i: number) => ({ main: label(e, maplike), sub: maplike ? `→ ${compact(e.value)}` : undefined, i });
  const cells = v.entries.map(cell);
  const w = Math.max(56, 14 + 8 * Math.max(1, ...cells.map((c) => Math.max(clip(c.main, 14).length, clip(c.sub ?? "", 14).length))));
  const perRow = Math.max(1, Math.floor(880 / (w + 12)));
  const place = (i: number) => ({ x: 40 + (i % perRow) * (w + 12), y: 30 + Math.floor(i / perRow) * 62 });
  cells.forEach((c, i) => {
    const e = v.entries[i]!, id = ids[i]!, was = prevIds?.get(id);
    const n: SNode = { id, label: clip(c.main, 14), sub: c.sub ? clip(c.sub, 14) : undefined, ...place(i), w, h: 44, shape: "box", index: i,
      status: !prevIds ? "live" : !was ? "created" : JSON.stringify(was.value) !== JSON.stringify(e.value) || JSON.stringify(was.key) !== JSON.stringify(e.key) ? "changed" : "live" };
    s.nodes.push(n);
  });
  if (ref.wrapper && s.nodes.length && !v.truncated && v.entries.length === v.size) {
    const first = s.nodes[0]!.id, last = s.nodes[v.entries.length - 1]!.id;
    s.pointers = ref.wrapper === "stack" ? [{ name: "top", target: last, state: "live" }] : [{ name: "front", target: first, state: "live" }, { name: "back", target: last, state: "live" }];
    s.notes.push(ref.wrapper === "stack" ? "std::stack: push/pop/top work at the last element of the underlying container." : "std::queue: push at the back, pop/front at the front of the underlying container.");
  }
  if (v.truncated || v.entries.length < v.size) {
    const i = v.entries.length;
    s.nodes.push({ id: `${ref.id}:more`, label: `+${v.size - i}`, sub: "more", ...place(i), w, h: 44, shape: "box", status: "unused" });
    s.notes.push(`Showing the first ${i} of ${v.size} elements (limit ${i}); the rest are counted but not read.`);
  }
  if (v.bucketCount !== undefined) s.notes.push(`bucket_count = ${v.bucketCount}; elements are listed in the container's iteration order.`);
  else if (v.container === "deque") s.notes.push("Elements by position; the Internal view shows the chunk layout.");
  else if (v.source !== "walk" && v.internalError) s.notes.push(`Internal view unavailable: ${v.internalError}.`);
  fit(s); return s;
}

/** Which internal views exist. Only containers that have a node walk offer the switch; it is disabled (with the reason) when the walk was refused or truncated. */
const WALKABLE = new Set(["map", "multimap", "set", "multiset", "list", "unordered_map", "unordered_multimap", "unordered_set", "unordered_multiset", "deque"]);
const hasInternal = (v: StlValue) => v.internal?.kind === "rb" || v.internal?.kind === "list" || v.internal?.kind === "hash" || v.internal?.kind === "deque";
function viewsOf(ref: StlRef, current: "logical" | "internal"): Scene["views"] {
  const v = ref.v;
  if (!WALKABLE.has(v.container) || v.source === "raw") return undefined;
  return { key: ref.label, current, internal: hasInternal(v), reason: hasInternal(v) ? undefined : v.internalError ?? "internal view not available" };
}

/** [from, kind, to] entry indices of every parent→child link read from the red-black nodes. */
function rbLinks(v: StlValue): [number, "left" | "right", number][] {
  const out: [number, "left" | "right", number][] = [];
  v.entries.forEach((e, i) => { if (e.n) { if (e.n[2] >= 0) out.push([i, "left", e.n[2]]); if (e.n[3] >= 0) out.push([i, "right", e.n[3]]); } });
  return out;
}
/** "" if the red-black properties hold (black root, no red node with a red child, equal black height on every path), else what is wrong. */
export function rbProblem(v: StlValue): string {
  const ns = v.entries.map((e) => e.n!), root = (v.internal as { root: number }).root;
  if (root < 0) return "";
  if (ns[root]![0] !== 1) return "the root is red";
  const bh = (i: number): number => {
    if (i < 0) return 1;
    const [c, , l, r] = ns[i]!;
    if (c === 0 && [l, r].some((k) => k >= 0 && ns[k]![0] === 0)) return -1;
    const a = bh(l), b = bh(r);
    return a < 0 || b < 0 || a !== b ? -1 : a + (c === 1 ? 1 : 0);
  };
  return bh(root) < 0 ? "a red node has a red child, or black heights differ" : "";
}

/** Internal view of map/set/multimap/multiset: the red-black tree exactly as the nodes link to each other (colours from `_M_color`). */
function rbScene(ref: StlRef, prev: StlRef | undefined): Scene {
  const v = ref.v, maplike = v.container.endsWith("map"), ids = entryIds(ref.id, v), root = (v.internal as { root: number }).root;
  const s = newScene(ref.id, "binary-tree", `std::${v.container} ${ref.label} — red-black tree, ${v.size} node${v.size === 1 ? "" : "s"}`, 1,
    "red-black tree links (_M_parent/_M_left/_M_right/_M_color) read from the nodes and validated against size() and the pretty-printer");
  s.views = viewsOf(ref, "internal");
  const kids = (i: number) => [v.entries[i]!.n![2], v.entries[i]!.n![3]].map((k) => (k >= 0 ? ids[k]! : null));
  const byId = new Map(ids.map((id, i) => [id, i] as const));
  const L = layoutTree(root >= 0 ? [ids[root]!] : [], (id) => kids(byId.get(id)!));
  const pv = prev && prev.v.source === "walk" && prev.v.internal?.kind === "rb" ? prev : undefined;
  const was = pv ? new Map(entryIds(pv.id, pv.v).map((id, i) => [id, pv.v.entries[i]!] as const)) : null;
  v.entries.forEach((e, i) => {
    const p = L.pos.get(ids[i]!) ?? { x: 40, y: 40 }, pe = was?.get(ids[i]!);
    const main = maplike ? e.key : e.value;
    s.nodes.push({ id: ids[i]!, label: clip(compact(main), 6), sub: maplike ? clip(`→${compact(e.value)}`, 6) : undefined, x: p.x - 22, y: p.y - 22, w: 44, h: 44, shape: "circle",
      fill: e.n![0] === 0 ? "red" : "black", index: i, tip: `${maplike ? `${compact(e.key)} → ` : ""}${compact(e.value)} (${e.n![0] === 0 ? "red" : "black"}) @${ids[i]}`,
      status: !was ? "live" : !pe ? "created" : JSON.stringify(pe.value) !== JSON.stringify(e.value) || pe.n?.[0] !== e.n![0] ? "changed" : "live" });
  });
  const prevLinks = pv ? new Set(rbLinks(pv.v).map(([a, k, b]) => edgeId(entryIds(pv.id, pv.v)[a]!, k, entryIds(pv.id, pv.v)[b]!))) : null;
  for (const [a, k, b] of rbLinks(v)) {
    const id = edgeId(ids[a]!, k, ids[b]!);
    s.edges.push({ id, from: ids[a]!, to: ids[b]!, kind: k, directed: true, changed: !!prevLinks && !prevLinks.has(id) });
  }
  s.pointers = [{ name: "root", target: root >= 0 ? ids[root]! : null, state: root >= 0 ? "live" : "null" }];
  const bad = rbProblem(v);
  s.notes.push(bad ? `Red-black properties violated: ${bad}.` : "Red-black properties hold: the root is black, no red node has a red child, every path has the same number of black nodes.");
  s.notes.push("Colours are the nodes' _M_color. Hover a node for its key and value; nodes keep their address while the tree rebalances.");
  fit(s); return s;
}

/**
 * Internal view of std::list: the doubly linked nodes. The walk (validated: every node live, `_M_prev` of each node is the node before it, count == size())
 * guarantees the links are exactly "entry i <-> entry i+1", so they are drawn from the order; the sentinel inside the list object closes the circle.
 */
function listScene(ref: StlRef, prev: StlRef | undefined): Scene {
  const v = ref.v, ids = entryIds(ref.id, v), n = ids.length;
  const s = newScene(ref.id, "doubly-linked-list", `std::list ${ref.label} — doubly linked nodes, ${v.size} node${v.size === 1 ? "" : "s"}`, 1,
    "list links (_M_next/_M_prev) read from the nodes and validated against size() and the pretty-printer");
  s.views = viewsOf(ref, "internal");
  const pv = prev && prev.v.source === "walk" && prev.v.internal?.kind === "list" ? prev : undefined;
  const pids = pv ? entryIds(pv.id, pv.v) : [];
  const was = pv ? new Map(pids.map((id, i) => [id, pv.v.entries[i]!] as const)) : null;
  const perRow = 8;
  v.entries.forEach((e, i) => {
    const pe = was?.get(ids[i]!);
    s.nodes.push({ id: ids[i]!, label: clip(compact(e.value), 8), x: 40 + (i % perRow) * 110, y: 50 + Math.floor(i / perRow) * 90, w: 72, h: 40, shape: "box", index: i,
      tip: `${compact(e.value)} @${ids[i]}`, status: !was ? "live" : !pe ? "created" : JSON.stringify(pe.value) !== JSON.stringify(e.value) ? "changed" : "live" });
  });
  const old = new Set<string>();
  pids.forEach((id, i) => { if (i + 1 < pids.length) { old.add(edgeId(id, "next", pids[i + 1]!)); old.add(edgeId(pids[i + 1]!, "prev", id)); } });
  for (let i = 0; i + 1 < n; i++) {
    const nx = edgeId(ids[i]!, "next", ids[i + 1]!), pr = edgeId(ids[i + 1]!, "prev", ids[i]!);
    s.edges.push({ id: nx, from: ids[i]!, to: ids[i + 1]!, kind: "next", directed: true, changed: !!pv && !old.has(nx) });
    s.edges.push({ id: pr, from: ids[i + 1]!, to: ids[i]!, kind: "prev", directed: true, changed: !!pv && !old.has(pr) });
  }
  s.pointers = [{ name: "front", target: n ? ids[0]! : null, state: n ? "live" : "null" }, { name: "back", target: n ? ids[n - 1]! : null, state: n ? "live" : "null" }];
  s.notes.push("Every node's prev/next agree. The sentinel node inside the std::list object closes the circle (front.prev and back.next point to it; it holds no value and is not drawn).");
  fit(s); return s;
}

const MAX_BUCKET_ROWS = 48;
/**
 * Internal view of unordered_*: the bucket table and the node chains. libstdc++ keeps ALL nodes in one singly linked list; `_M_buckets[j]` points at the node *before*
 * bucket j's first node, so bucket membership is read from memory (validated by the tracer), not recomputed from a hash. Drawn: bucket j -> its first node, and `_M_nxt`
 * between consecutive nodes of the same bucket (the last node's `_M_nxt` really points on into the next non-empty bucket's first node; that cross-bucket link is not drawn).
 */
function hashScene(ref: StlRef, prev: StlRef | undefined): Scene {
  const v = ref.v, maplike = v.container.endsWith("map"), ids = entryIds(ref.id, v), buckets = (v.internal as { buckets: number[] }).buckets;
  const s = newScene(ref.id, "hash-table", `std::${v.container} ${ref.label} — ${buckets.length} buckets, ${v.size} element${v.size === 1 ? "" : "s"}`, 1,
    "bucket table (_M_buckets) and node chain (_M_nxt) read from memory and validated against size() and the pretty-printer");
  s.views = viewsOf(ref, "internal");
  const pv = prev && prev.v.internal?.kind === "hash" ? prev : undefined;
  const was = pv ? new Map(entryIds(pv.id, pv.v).map((id, i) => [id, pv.v.entries[i]!] as const)) : null;
  const starts = buckets.map((first, j) => [first, j] as const).filter(([f]) => f >= 0).sort((a, b) => a[0] - b[0]);
  const bucketOf = (i: number) => { let b = -1; for (const [f, j] of starts) { if (f <= i) b = j; else break; } return b; };
  const rows = buckets.length <= MAX_BUCKET_ROWS ? buckets.map((_, j) => j) : starts.map(([, j]) => j).sort((a, b) => a - b);
  const rowOf = new Map(rows.map((j, r) => [j, r]));
  const oldEdges = new Set<string>();
  if (pv) { const pids = entryIds(pv.id, pv.v), pb = (pv.v.internal as { buckets: number[] }).buckets;
    const ps = pb.map((f, j) => [f, j] as const).filter(([f]) => f >= 0);
    pb.forEach((f, j) => { if (f >= 0) oldEdges.add(edgeId(`${s.id}[${j}]`, "bucket", pids[f]!)); });
    pids.forEach((id, i) => { if (i + 1 < pids.length && !ps.some(([f]) => f === i + 1)) oldEdges.add(edgeId(id, "next", pids[i + 1]!)); }); }
  for (const j of rows) {
    const first = buckets[j]!;
    s.nodes.push({ id: `${s.id}[${j}]`, label: String(j), sub: first < 0 ? "∅" : undefined, x: 40, y: 30 + rowOf.get(j)! * 60, w: 48, h: 40, shape: "cell", status: "live", index: j });
  }
  const col = new Map<number, number>();
  v.entries.forEach((e, i) => {
    const j = bucketOf(i), c = col.get(j) ?? 0; col.set(j, c + 1);
    const pe = was?.get(ids[i]!), main = maplike ? compact(e.key) : compact(e.value), sub = maplike ? `→ ${compact(e.value)}` : undefined;
    s.nodes.push({ id: ids[i]!, label: clip(main, 10), sub: sub ? clip(sub, 10) : undefined, x: 130 + c * 100, y: 30 + (rowOf.get(j) ?? 0) * 60, w: 84, h: 40, shape: "box", index: i,
      tip: `${main}${sub ? " " + sub : ""} @${ids[i]}`,
      status: !was ? "live" : !pe ? "created" : JSON.stringify(pe.value) !== JSON.stringify(e.value) || JSON.stringify(pe.key) !== JSON.stringify(e.key) ? "changed" : "live" });
    const first = buckets[j] === i, from = first ? `${s.id}[${j}]` : ids[i - 1]!, kind = first ? "bucket" : "next";
    if (j >= 0) { const id = edgeId(from, kind, ids[i]!); s.edges.push({ id, from, to: ids[i]!, kind, directed: true, changed: !!pv && !oldEdges.has(id) }); }
  });
  s.pointers = [];
  if (buckets.length > MAX_BUCKET_ROWS) s.notes.push(`${buckets.length} buckets: only the ${rows.length} non-empty ones are drawn.`);
  s.notes.push("Chains: the bucket points at the node before its first node in libstdc++'s single node list; drawn as bucket → first node. The last node of a chain links on into the next non-empty bucket (not drawn).");
  fit(s); return s;
}

const PER_LINE = 14;
/**
 * Internal view of std::deque: the chunk map (`_M_map[r]` -> chunk r) and, per chunk, the slots in use. Elements live at fixed addresses (push/pop at the ends never moves them),
 * which is the identity used for animation. The first chunk starts at slot `offset`; the last may be partly used; middle chunks are full. Validated by the tracer against size() and the printer.
 */
function dequeScene(ref: StlRef, prev: StlRef | undefined): Scene {
  const v = ref.v, d = v.internal as { chunk: number; offset: number; chunks: string[] }, ids = entryIds(ref.id, v), n = d.chunk;
  const s = newScene(ref.id, "sequence", `std::deque ${ref.label} — ${d.chunks.length} chunk${d.chunks.length === 1 ? "" : "s"} of ${n}, ${v.size} element${v.size === 1 ? "" : "s"}`, 1,
    "chunk map and element slots read from memory (iterators validated against size() and the pretty-printer)");
  s.views = viewsOf(ref, "internal");
  const pv = prev && prev.v.internal?.kind === "deque" ? prev : undefined;
  const was = pv ? new Map(entryIds(pv.id, pv.v).map((id, i) => [id, pv.v.entries[i]!] as const)) : null;
  const oldEdges = new Set<string>();
  if (pv) { const pd = pv.v.internal as { chunk: number; offset: number; chunks: string[] }, pids = entryIds(pv.id, pv.v);
    pd.chunks.forEach((_, r) => { const k = r === 0 ? 0 : pd.chunk - pd.offset + (r - 1) * pd.chunk; if (pids[k]) oldEdges.add(edgeId(`${s.id}:c${r}`, "bucket", pids[k]!)); }); }
  let y = 30, i = 0;
  d.chunks.forEach((addr, r) => {
    const lo = r === 0 ? d.offset : 0, used = Math.min(n - lo, v.size - i), first = ids[i];
    if (used <= 0 || !first) return;
    const hid = `${s.id}:c${r}`;
    s.nodes.push({ id: hid, label: `map[${r}]`, sub: `slots ${lo}–${lo + used - 1}`, x: 40, y, w: 72, h: 40, shape: "cell", status: "live", tip: `chunk @${addr}` });
    for (let k = 0; k < used; k++, i++) {
      const e = v.entries[i]!, pe = was?.get(ids[i]!), main = compact(e.key !== undefined ? e.key : e.value);
      s.nodes.push({ id: ids[i]!, label: clip(main, 8), x: 130 + (k % PER_LINE) * 58, y: y + Math.floor(k / PER_LINE) * 52, w: 52, h: 40, shape: "box", index: i, tip: `${compact(e.value)} @${ids[i]}`,
        status: !was ? "live" : !pe ? "created" : JSON.stringify(pe.value) !== JSON.stringify(e.value) ? "changed" : "live" });
    }
    const eid = edgeId(hid, "bucket", first);
    s.edges.push({ id: eid, from: hid, to: first, kind: "bucket", directed: true, changed: !!pv && !oldEdges.has(eid) });
    y += Math.ceil(used / PER_LINE) * 52 + 14;
  });
  s.pointers = v.size ? [{ name: "begin", target: ids[0]!, state: "live" }, { name: "end−1", target: ids[v.size - 1]!, state: "live" }] : [];
  s.notes.push("Each map[r] entry points at a fixed-size chunk. Elements keep their address when the deque grows or shrinks at either end; only the slots in use are drawn.");
  fit(s); return s;
}

/** Elements that are (or, for maps, whose value is) a pointer to a tracked heap object get `ref`: the UI can jump to the pointee although no edge crosses scenes. */
const refOfEntry = (e: StlEntry): string | undefined => {
  for (const x of [e.value, e.key]) if (isPtr(x) && x.kind === "object" && x.obj && !x.offset) return x.obj;
  return undefined;
};
function withRefs(s: Scene, v: StlValue): Scene {
  for (const n of s.nodes) { const e = n.index !== undefined ? v.entries[n.index] : undefined; const r = e && refOfEntry(e); if (r) n.ref = r; }
  return s;
}

/** Internal view of whichever kind the walk validated. */
export function internalScene(ref: StlRef, prev: StlRef | undefined): Scene {
  const k = ref.v.internal?.kind;
  return withRefs(k === "list" ? listScene(ref, prev) : k === "hash" ? hashScene(ref, prev) : k === "deque" ? dequeScene(ref, prev) : rbScene(ref, prev), ref.v);
}

export const stlAdapter: DataStructureAdapter = {
  id: "stl",
  canHandle: (state) => collectStl(state).length > 0,
  interpret(state, _claims, opts) {
    const prev = state.prev ? new Map(collectStl(state.prev).map((r) => [r.id, r])) : null;
    return collectStl(state).map((r) => (opts?.stlView?.[r.label] === "internal" && hasInternal(r.v) ? internalScene(r, prev?.get(r.id)) : withRefs(logicalScene(r, prev?.get(r.id)), r.v)));
  },
};

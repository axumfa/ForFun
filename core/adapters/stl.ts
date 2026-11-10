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
  if (isPtr(v)) return v.kind === "null" ? "∅" : v.ptr;
  if (depth > 1) return "…";
  if (isArr(v)) return `[${v.elems.slice(0, 4).map((e) => compact(e, depth + 1)).join(",")}${v.elems.length > 4 ? ",…" : ""}]`;
  if (isStl(v)) return `${v.container}(${v.size})`;
  if (isStruct(v)) return `{${Object.values(v.fields).slice(0, 3).map((e) => compact(e, depth + 1)).join(",")}}`;
  return "…";
}
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

export interface StlRef { id: string; label: string; v: StlValue; }
type Src = Pick<RuntimeState, "frames" | "objects">;

/** Every STL container visible in a state: locals (outermost frame first), members of struct locals, members of heap objects. */
export function collectStl(src: Src): StlRef[] {
  const refs = new Map<string, StlRef>();
  const walk = (name: string, v: Value | undefined, depth: number) => {
    if (isStl(v)) {
      if (v.source === "raw" && name.split(".").some((p) => p.startsWith("__"))) return;   // compiler temporary not yet bound (range-for `__range1`): garbage, not data
      const id = `stl:${v.addr ?? name}`, old = refs.get(id);          // a range-for's hidden `__range1` aliases the real variable: keep the user's name
      if (!old || (old.label.startsWith("__") && !name.startsWith("__"))) refs.set(id, { id, label: name, v });
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
  const s = newScene(ref.id, SCENE_KIND(v.container), `std::${v.container} ${ref.label}`, 1,
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
  if (v.truncated || v.entries.length < v.size) {
    const i = v.entries.length;
    s.nodes.push({ id: `${ref.id}:more`, label: `+${v.size - i}`, sub: "more", ...place(i), w, h: 44, shape: "box", status: "unused" });
    s.notes.push(`Showing the first ${i} of ${v.size} elements (limit ${i}); the rest are counted but not read.`);
  }
  if (v.bucketCount !== undefined) s.notes.push(`bucket_count = ${v.bucketCount}; elements are listed in the container's iteration order.`);
  else if (v.container === "deque") s.notes.push("Logical view only: elements by position (a deque's chunk layout is not drawn).");
  else if (v.source !== "walk" && v.internalError) s.notes.push(`Internal view unavailable: ${v.internalError}.`);
  fit(s); return s;
}

/** Which internal views exist. Only containers that have a node walk offer the switch; it is disabled (with the reason) when the walk was refused or truncated. */
const WALKABLE = new Set(["map", "multimap", "set", "multiset", "list"]);
const hasInternal = (v: StlValue) => v.internal?.kind === "rb";
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
export function internalScene(ref: StlRef, prev: StlRef | undefined): Scene {
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

export const stlAdapter: DataStructureAdapter = {
  id: "stl",
  canHandle: (state) => collectStl(state).length > 0,
  interpret(state, _claims, opts) {
    const prev = state.prev ? new Map(collectStl(state.prev).map((r) => [r.id, r])) : null;
    return collectStl(state).map((r) => (opts?.stlView?.[r.label] === "internal" && hasInternal(r.v) ? internalScene(r, prev?.get(r.id)) : logicalScene(r, prev?.get(r.id))));
  },
};

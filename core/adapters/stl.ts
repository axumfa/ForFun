import type { StlEntry, StlValue, Value } from "../events/types.ts";
import type { RuntimeState } from "../snapshots/history.ts";
import type { Scene, SNode } from "../models/scene.ts";
import type { DataStructureAdapter } from "./types.ts";
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

export const stlAdapter: DataStructureAdapter = {
  id: "stl",
  canHandle: (state) => collectStl(state).length > 0,
  interpret(state) {
    const prev = state.prev ? new Map(collectStl(state.prev).map((r) => [r.id, r])) : null;
    return collectStl(state).map((r) => logicalScene(r, prev?.get(r.id)));
  },
};

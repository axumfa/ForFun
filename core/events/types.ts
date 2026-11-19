/** Trace schema v4. Documented in docs/events.md. Pure types + parser; no I/O, no VS Code, no debugger. */
export const SCHEMA_VERSION = 4;

/** A pointer as observed in the debuggee. Only `kind: "object"` denotes a relationship to a tracked heap allocation. */
export interface PointerValue {
  ptr: string;
  to?: string;                // static pointee type, e.g. "Node" (lets a null pointer still be recognised as Node*)
  kind: "null" | "object" | "freed" | "unresolved";
  obj?: string;               // base address of the containing heap allocation (object|freed)
  offset?: number;            // byte offset inside that allocation (interior pointers)
}
export interface ArrayValue { kind: "array" | "vector"; elemType: string; elems: Value[]; capacity?: number; released?: boolean; addr?: string; }
export interface StructValue { kind: "struct"; type: string; fields: Record<string, Value>; addr?: string; }

export type StlContainer = "map" | "multimap" | "set" | "multiset" | "unordered_map" | "unordered_multimap" | "unordered_set" | "unordered_multiset" | "list" | "deque";
/** One element. `id` is the node address when the node walk succeeded (map/set/list); `key` is present for map-like containers only.
 *  `n` (red-black containers, full walk only) = [color 0 red | 1 black, parent, left, right]: *indices into `entries`*, -1 = none, -2 = the header. */
export interface StlEntry { id?: string; key?: Value; value: Value; n?: [number, number, number, number]; }
/**
 * A libstdc++ container read through GDB's pretty-printer (`source: "printer"`) or by walking its nodes (`"walk"`).
 * `identity` says what `entries[i].id` means: "node" (heap address), or absent (the adapter falls back to key / position).
 * `internal` (map/set/list) exists only if the node walk was validated end to end; otherwise `internalError` says why not.
 * `source: "raw"`: no printer and no walk: only `text` (raw struct text) and `unavailable` are meaningful.
 */
export interface StlValue {
  kind: "stl"; container: StlContainer; type: string; size: number; truncated: boolean; entries: StlEntry[];
  source: "printer" | "walk" | "raw"; addr?: string; keyType?: string; valType?: string;
  bucketCount?: number; text?: string; unavailable?: string;
  internal?: { kind: "rb"; header: string; root: number } | { kind: "list"; header: string } | { kind: "hash"; buckets: number[] } | null; internalError?: string;
}
export type Value = number | string | boolean | PointerValue | ArrayValue | StructValue | StlValue | null;

export type FileKey = "main" | "driver";
export interface Frame { fn: string; file: FileKey; line: number; locals: Record<string, Value>; }
/** On the wire (v4) a frame may be a delta against the frame at the same depth (counted from the outermost) of the previous step; `parseTrace` expands it. */
export interface WireFrame extends Frame { d?: 1; keys?: string[]; }
/** Apply a `vdiff` patch (see gdb_tracer.py). Anything that is not a patch replaces the old value. Unchanged children keep their reference. */
export function applyPatch(o: Value, p: Value): Value {
  if (typeof p !== "object" || p === null || Array.isArray(p) || !("$o" in p || "$l" in p)) return p;
  const q = p as unknown as { $o: Record<string, Value>; $l?: number; $x?: string[] };
  if (q.$l !== undefined) {
    const old = o as unknown as Value[], out = old.slice(0, q.$l);
    for (const [i, v] of Object.entries(q.$o)) out[+i] = +i < old.length ? applyPatch(old[+i]!, v) : v;
    return out as unknown as Value;
  }
  const old = o as unknown as Record<string, Value>, out: Record<string, Value> = {}, rm = new Set(q.$x ?? []);
  for (const k of Object.keys(old)) if (!rm.has(k)) out[k] = k in q.$o ? applyPatch(old[k]!, q.$o[k]!) : old[k]!;
  for (const [k, v] of Object.entries(q.$o)) if (!(k in old)) out[k] = v;
  return out as unknown as Value;
}
/** Rebuild full frames from `wire` using the previous step's full frames. Unchanged values keep the previous *reference* (structural sharing). */
export function expandFrames(wire: WireFrame[], prev: Frame[]): Frame[] {
  const n = wire.length, m = prev.length;
  return wire.map((w, i) => {
    if (!w.d) return { fn: w.fn, file: w.file, line: w.line, locals: w.locals };
    const p = prev[m - n + i];
    if (!p || p.fn !== w.fn || p.file !== w.file) throw new Error("trace: delta frame without a matching previous frame");
    const locals: Record<string, Value> = {};
    for (const k of w.keys ?? Object.keys(p.locals)) locals[k] = k in w.locals ? (k in p.locals ? applyPatch(p.locals[k]!, w.locals[k]!) : w.locals[k]!) : p.locals[k]!;
    return { fn: w.fn, file: w.file, line: w.line, locals };
  });
}

export type TraceEvent =
  | { type: "object_created"; addr: string; obj_type: string; size: number; fields?: Record<string, Value>; elems?: Value[] }
  | { type: "object_freed"; addr: string }
  | { type: "field_changed"; addr: string; field: string; old: Value | undefined; new: Value }
  | { type: "elem_changed"; addr: string; index: number; old: Value | undefined; new: Value }
  | { type: "local_changed"; var: string; old: Value | undefined; new: Value };

/** State observed *before* line `line` of `file` executes. `events` are the effects of the previous step's line. */
export interface Step {
  kind: "step"; schema: number; step: number;
  fn: string; file: FileKey; line: number; depth: number;
  frames: Frame[];            // innermost first, user-code frames only
  events: TraceEvent[];
}

export type EndReason = "exited" | "step_limit" | "error" | "crashed" | "stalled" | "timeout";
export interface EndRecord {
  kind: "end"; schema: number; reason: EndReason; exitCode: number | null;
  message?: string; signal?: string; line?: number; doubleFrees?: string[];
}
export interface Trace { steps: Step[]; end: EndRecord | null; }

const SMART = /^std::(unique_ptr|shared_ptr|weak_ptr)</;
/** First raw pointer inside a smart-pointer struct: libstdc++ keeps it in `_M_ptr` (shared/weak) or `_M_head_impl` (unique), possibly nested. */
function innerPtr(v: Value | undefined): PointerValue | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  if ("ptr" in v) return v;
  if ("fields" in v && v.kind === "struct") {
    for (const k of ["_M_ptr", "_M_head_impl"]) { const p = innerPtr(v.fields[k]); if (p) return p; }
    for (const f of Object.values(v.fields)) { const p = innerPtr(f); if (p) return p; }
  }
  return undefined;
}
/**
 * Smart pointers (unique_ptr/shared_ptr/weak_ptr) are, for drawing purposes, just the raw pointer they hold: replace the struct by that
 * PointerValue so every adapter follows them like `T*`. Done in core (not the tracer) so the trace stays a pure observation.
 */
export function normalizeSmartPointers(v: Value | undefined): Value | undefined {
  if (typeof v !== "object" || v === null) return v;
  if ("fields" in v && v.kind === "struct") {
    if (SMART.test(v.type)) { const p = innerPtr(v); if (p) return p; }
    let fields: Record<string, Value> | undefined;
    for (const [k, f] of Object.entries(v.fields)) { const n = normalizeSmartPointers(f) as Value; if (n !== f) (fields ??= { ...v.fields })[k] = n; }
    return fields ? { ...v, fields } : v;
  }
  if ("elems" in v) { let ch = false; const elems = v.elems.map((e) => { const n = normalizeSmartPointers(e) as Value; ch ||= n !== e; return n; }); return ch ? { ...v, elems } : v; }
  if ("entries" in v && v.kind === "stl") {
    let ch = false;
    const entries = v.entries.map((e) => {
      const val = normalizeSmartPointers(e.value) as Value, key = e.key === undefined ? undefined : (normalizeSmartPointers(e.key) as Value);
      if (val === e.value && key === e.key) return e; ch = true; return key === undefined ? { ...e, value: val } : { ...e, value: val, key };
    });
    return ch ? { ...v, entries } : v;
  }
  return v;
}
/** Pure (returns the same reference for unchanged values, so structural sharing from `expandFrames` survives). */
function normalizeStep(st: Step): void {
  st.frames = st.frames.map((f) => { let ls: Record<string, Value> | undefined; for (const [k, v] of Object.entries(f.locals)) { const n = normalizeSmartPointers(v) as Value; if (n !== v) (ls ??= { ...f.locals })[k] = n; } return ls ? { ...f, locals: ls } : f; });
  for (const e of st.events) {
    if (e.type === "object_created") { if (e.fields) for (const [k, v] of Object.entries(e.fields)) e.fields[k] = normalizeSmartPointers(v) as Value; if (e.elems) e.elems = e.elems.map((x) => normalizeSmartPointers(x) as Value); }
    else if (e.type !== "object_freed") { e.old = normalizeSmartPointers(e.old); e.new = normalizeSmartPointers(e.new) as Value; }
  }
}

/** Parse JSONL produced by the engine. Throws on schema mismatch or malformed records (never guesses). */
export function parseTrace(jsonl: string): Trace {
  const trace: Trace = { steps: [], end: null };
  let prevFrames: Frame[] = [];
  const hasSmart = /"std::(unique|shared|weak)_ptr</.test(jsonl);   // cheap pre-check: most traces have none
  const lines = jsonl.split("\n").filter((l) => l.trim().length > 0);
  lines.forEach((l, i) => {
    let rec: unknown;
    try { rec = JSON.parse(l); } catch {
      if (i === lines.length - 1) return;           // last line may be cut by a kill; earlier lines are intact
      throw new Error(`trace line ${i + 1}: invalid JSON`);
    }
    const r = rec as { kind?: string; schema?: number };
    if (r.schema !== SCHEMA_VERSION) throw new Error(`trace line ${i + 1}: unsupported schema ${String(r.schema)}`);
    if (r.kind === "step") { const st = rec as Step; st.frames = prevFrames = expandFrames(st.frames as WireFrame[], prevFrames); if (hasSmart) normalizeStep(st); trace.steps.push(st); }
    else if (r.kind === "end") trace.end = rec as EndRecord;
    else throw new Error(`trace line ${i + 1}: unknown record kind ${String(r.kind)}`);
  });
  return trace;
}

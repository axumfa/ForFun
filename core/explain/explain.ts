import type { FileKey, PointerValue, TraceEvent, Value } from "../events/types.ts";
import type { HeapObject, RuntimeState } from "../snapshots/history.ts";
import { isArr, isPtr, isScalar, isStl, isStruct } from "../adapters/analysis.ts";
import { compact, entryIds } from "../adapters/stl.ts";
import type { StlValue } from "../events/types.ts";

export function describeObject(o: HeapObject | undefined, addr: string): string {
  if (!o) return addr;
  const scal = Object.entries(o.fields ?? {}).find(([, v]) => isScalar(v));
  return `${o.type}${scal ? `(${scal[0]}=${String(scal[1])})` : ""}@${addr}`;
}
export function describeValue(v: Value | undefined, objects: Record<string, HeapObject>): string {
  if (v === undefined || v === null) return "(none)";
  if (isPtr(v)) return describePointer(v, objects);
  if (isScalar(v)) return String(v);
  if (isArr(v)) return `${v.kind}[${v.elems.length}]`;
  if (isStruct(v)) return `${v.type}{…}`;
  if (isStl(v)) return v.source !== "raw" && v.size >= 0 && v.size < 1e9 ? `std::${v.container} with ${v.size} element${v.size === 1 ? "" : "s"}` : `std::${v.container} (not constructed yet, or unreadable)`;   // a not-yet-constructed container reads as garbage
  return "?";
}
export function describePointer(p: PointerValue, objects: Record<string, HeapObject>): string {
  switch (p.kind) {
    case "null": return "nullptr";
    case "object": return `→ ${describeObject(objects[p.obj!], p.obj!)}${p.offset ? ` (+${p.offset} bytes, inside the object)` : ""}`;
    case "freed": return `→ freed memory ${p.obj}`;
    default: return `${p.ptr} (not a tracked heap object)`;
  }
}

const MAX_LISTED = 4;
/**
 * What changed inside an STL container, from the recorded entries of two consecutive steps. Elements are matched by node id (map/set/list/unordered_*), else by key,
 * else by position. null when either side cannot be compared (raw, or cut at the per-container read limit): the caller then reports sizes only.
 */
export function stlDelta(a: StlValue | undefined, b: StlValue): string | null {
  if (!a || a.container !== b.container || a.source === "raw" || b.source === "raw" || a.truncated || b.truncated) return null;
  const maplike = b.container.endsWith("map"), show = (e: { key?: Value; value: Value }) => (maplike ? `${compact(e.key)} → ${compact(e.value)}` : compact(e.value));
  const ia = entryIds("a", a), ib = entryIds("a", b), ma = new Map(ia.map((id, i) => [id, a.entries[i]!] as const)), mb = new Map(ib.map((id, i) => [id, b.entries[i]!] as const));
  const out: string[] = [];
  for (const [id, e] of mb) { const o = ma.get(id); if (!o) out.push(`inserted ${show(e)}`); else if (JSON.stringify(o.value) !== JSON.stringify(e.value)) out.push(maplike ? `updated ${compact(e.key)}: ${compact(o.value)} → ${compact(e.value)}` : `${compact(o.value)} became ${compact(e.value)}`); }
  for (const [id, e] of ma) if (!mb.has(id)) out.push(`removed ${show(e)}`);
  if (!out.length) return null;
  return out.length > MAX_LISTED ? `${out.slice(0, MAX_LISTED).join("; ")}; … (${out.length} changes)` : out.join("; ");
}

export interface Explanation {
  executed: { file: FileKey; fn: string; line: number; text: string } | null;   // the line whose execution produced `effects`
  next: { file: FileKey; fn: string; line: number; text: string };               // the line about to execute
  effects: string[];
}

function effectText(e: TraceEvent, s: RuntimeState): string {
  const o = s.objects;
  switch (e.type) {
    case "object_created": return `Allocated ${e.obj_type} at ${e.addr}${e.fields ? " with " + Object.entries(e.fields).map(([k, v]) => `${k}=${describeValue(v, o)}`).join(", ") : ""}.`;
    case "object_freed": return `Freed ${describeObject(o[e.addr], e.addr)}. Pointers that still hold ${e.addr} are now dangling.`;
    case "field_changed": return `${describeObject(o[e.addr], e.addr)}: field '${e.field}' changed from ${describeValue(e.old, o)} to ${describeValue(e.new, o)}.`;
    case "elem_changed": return `${o[e.addr]?.type ?? "array"}@${e.addr}[${e.index}] changed from ${describeValue(e.old, o)} to ${describeValue(e.new, o)}.`;
    case "local_changed": {
      const cur = s.frames[0]?.locals[e.var], was = s.prev?.frames[0]?.locals[e.var];
      const d = isStl(cur) ? stlDelta(isStl(was) ? was : undefined, cur) : null;
      return `Variable '${e.var}' changed from ${describeValue(e.old, o)} to ${describeValue(e.new, o)}${d ? `: ${d}` : ""}.`;
    }
  }
}

/** Deterministic, source-and-trace-grounded explanation of one step. Every sentence is derived from an event or a source line. */
export function explainStep(s: RuntimeState, sources: Partial<Record<FileKey, string[]>>): Explanation {
  const text = (f: FileKey, l: number) => (sources[f]?.[l - 1] ?? "").trim();
  return {
    executed: s.cause ? { file: s.cause.file, fn: s.cause.fn, line: s.cause.line, text: text(s.cause.file, s.cause.line) } : null,
    next: { file: s.file, fn: s.fn, line: s.line, text: text(s.file, s.line) },
    effects: s.events.map((e) => effectText(e, s)),
  };
}

/** Facts handed to an optional external explainer (e.g. an LLM). Nothing here is inferred; an explainer must not add states. */
export interface GroundedContext { step: number; executedLine: string | null; nextLine: string; events: TraceEvent[]; frames: RuntimeState["frames"]; }
export interface ExplanationProvider { readonly id: string; explain(ctx: GroundedContext): Promise<string>; }
export const builtinProvider: ExplanationProvider = {
  id: "builtin",
  async explain(ctx) { return ctx.events.length ? `After \`${ctx.executedLine ?? "start"}\`: ${ctx.events.length} observed change(s). Next: \`${ctx.nextLine}\`.` : `Next: \`${ctx.nextLine}\`.`; },
};
export function groundedContext(s: RuntimeState, sources: Partial<Record<FileKey, string[]>>): GroundedContext {
  const e = explainStep(s, sources);
  return { step: s.step, executedLine: e.executed?.text ?? null, nextLine: e.next.text, events: s.events, frames: s.frames };
}

import type { FileKey, PointerValue, TraceEvent, Value } from "../events/types.ts";
import type { HeapObject, RuntimeState } from "../snapshots/history.ts";
import { isArr, isPtr, isScalar, isStruct } from "../adapters/analysis.ts";

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
    case "local_changed": return `Variable '${e.var}' changed from ${describeValue(e.old, o)} to ${describeValue(e.new, o)}.`;
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

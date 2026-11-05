/** Trace schema v2. Documented in docs/events.md. Pure types + parser; no I/O, no VS Code, no debugger. */
export const SCHEMA_VERSION = 2;

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
export type Value = number | string | boolean | PointerValue | ArrayValue | StructValue | null;

export type FileKey = "main" | "driver";
export interface Frame { fn: string; file: FileKey; line: number; locals: Record<string, Value>; }

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

/** Parse JSONL produced by the engine. Throws on schema mismatch or malformed records (never guesses). */
export function parseTrace(jsonl: string): Trace {
  const trace: Trace = { steps: [], end: null };
  const lines = jsonl.split("\n").filter((l) => l.trim().length > 0);
  lines.forEach((l, i) => {
    let rec: unknown;
    try { rec = JSON.parse(l); } catch {
      if (i === lines.length - 1) return;           // last line may be cut by a kill; earlier lines are intact
      throw new Error(`trace line ${i + 1}: invalid JSON`);
    }
    const r = rec as { kind?: string; schema?: number };
    if (r.schema !== SCHEMA_VERSION) throw new Error(`trace line ${i + 1}: unsupported schema ${String(r.schema)}`);
    if (r.kind === "step") trace.steps.push(rec as Step);
    else if (r.kind === "end") trace.end = rec as EndRecord;
    else throw new Error(`trace line ${i + 1}: unknown record kind ${String(r.kind)}`);
  });
  return trace;
}

import type { ArrayValue, PointerValue, StlValue, StructValue, Value } from "../events/types.ts";
import type { HeapObject, RuntimeState } from "../snapshots/history.ts";

export const isPtr = (v: Value | undefined): v is PointerValue => typeof v === "object" && v !== null && "ptr" in v;
export const isArr = (v: Value | undefined): v is ArrayValue => typeof v === "object" && v !== null && "elems" in v && (v.kind === "array" || v.kind === "vector");
export const isStruct = (v: Value | undefined): v is StructValue => typeof v === "object" && v !== null && "fields" in v && v.kind === "struct";
export const isStl = (v: Value | undefined): v is StlValue => typeof v === "object" && v !== null && "kind" in v && v.kind === "stl";
export const isScalar = (v: Value | undefined): v is number | string | boolean => typeof v === "number" || typeof v === "string" || typeof v === "boolean";

/** "const struct Node *" -> "Node" */
export function normType(s: string | undefined): string {
  return (s ?? "").replace(/\b(const|volatile|struct|class|union)\b/g, "").replace(/[*&]/g, "").replace(/\s+/g, " ").trim();
}
export const baseType = (o: HeapObject): string => normType(o.type.replace(/\[\]$/, ""));

export interface NamedPtr { name: string; ptr: PointerValue; }

/** Every pointer reachable by *name* from the stack: locals, struct-local members, array elements of locals. */
export function collectRoots(state: RuntimeState): NamedPtr[] {
  const out: NamedPtr[] = [];
  const nameCount = new Map<string, number>();
  state.frames.forEach((f) => Object.keys(f.locals).forEach((k) => nameCount.set(k, (nameCount.get(k) ?? 0) + 1)));
  const walk = (name: string, v: Value | undefined, depth: number) => {
    if (isPtr(v)) out.push({ name, ptr: v });
    else if (isStruct(v) && depth < 4) for (const [k, fv] of Object.entries(v.fields)) walk(`${name}.${k}`, fv, depth + 1);
    else if (isArr(v) && depth < 3) v.elems.forEach((e, i) => walk(`${name}[${i}]`, e, depth + 1));
  };
  state.frames.forEach((f, fi) => {
    for (const [k, v] of Object.entries(f.locals)) {
      if (k === "this") continue;
      const dup = (nameCount.get(k) ?? 0) > 1;
      walk(dup ? `${k}@${state.frames.length - 1 - fi}` : k, v, 0);
    }
  });
  return out;
}

export interface NodeType {
  name: string;
  objs: HeapObject[];
  selfFields: string[];          // single-pointer fields to the same type
  selfArrayFields: string[];     // arrays of pointers to the same type (trie children)
  selfVecFields: string[];       // vectors of pointers to the same type (graph neighbours)
  scalarFields: string[];
}

function fieldKinds(name: string, v: Value | undefined): "self" | "selfArr" | "selfVec" | "scalar" | "other" {
  if (isPtr(v)) return normType(v.to) === name ? "self" : "other";
  if (isArr(v)) {
    const e = v.elems.find(isPtr);
    if (e && normType(e.to) === name) return v.kind === "vector" ? "selfVec" : "selfArr";
    if (!v.elems.length && v.kind === "vector" && normType(v.elemType) === name + "*") return "selfVec";
    return "other";
  }
  return isScalar(v) ? "scalar" : "other";
}

/** Group struct-typed heap allocations by type and classify each field from *observed* values and static pointee types. */
export function analyzeNodeTypes(state: RuntimeState): Map<string, NodeType> {
  const types = new Map<string, NodeType>();
  for (const o of Object.values(state.objects)) {
    if (!o.fields) continue;
    const name = baseType(o);
    let t = types.get(name);
    if (!t) types.set(name, (t = { name, objs: [], selfFields: [], selfArrayFields: [], selfVecFields: [], scalarFields: [] }));
    t.objs.push(o);
    for (const [f, v] of Object.entries(o.fields)) {
      const k = fieldKinds(name, v);
      const list = k === "self" ? t.selfFields : k === "selfArr" ? t.selfArrayFields : k === "selfVec" ? t.selfVecFields : k === "scalar" ? t.scalarFields : null;
      if (list && !list.includes(f)) list.push(f);
    }
  }
  return types;
}

/** Target heap object of a pointer if (and only if) it exactly addresses a tracked allocation base. */
export function target(state: RuntimeState, v: Value | undefined): HeapObject | null {
  if (!isPtr(v) || (v.kind !== "object" && v.kind !== "freed") || v.obj === undefined) return null;
  if (v.offset !== undefined && v.offset !== 0) return null;
  return state.objects[v.obj] ?? null;
}

const LABEL_PREF = ["key", "val", "value", "data", "x", "id", "item", "k", "v"];
export function labelField(t: NodeType): string | undefined {
  for (const p of LABEL_PREF) if (t.scalarFields.includes(p)) return p;
  return t.scalarFields[0];
}
export function show(v: Value | undefined): string {
  if (v === undefined || v === null) return "?";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (isScalar(v)) return String(v);
  if (isPtr(v)) return v.kind === "null" ? "∅" : v.ptr;
  return "…";
}

/** Did this heap object change at `state.step` (from the point of view of the previous step)? */
export function objChanged(state: RuntimeState, o: HeapObject): "created" | "changed" | null {
  if (!state.prev) return null;
  const p = state.prev.objects[o.addr];
  if (!p || p.state !== o.state && o.state === "LIVE") return "created";
  if (JSON.stringify(p.fields) !== JSON.stringify(o.fields) || JSON.stringify(p.elems) !== JSON.stringify(o.elems)) return "changed";
  return null;
}

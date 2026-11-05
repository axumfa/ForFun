import type { Trace, Value } from "../events/types.ts";
import { History, type HeapObject, type RuntimeState } from "../snapshots/history.ts";
import { collectRoots, isArr, isPtr, isStruct } from "../adapters/analysis.ts";

export interface Finding { severity: "error" | "warning" | "info"; code: string; message: string; step?: number; line?: number; }
export interface Suggestion { step: number; text: string; }
export interface FunctionCost { fn: string; calls: number; steps: number; }

/** Heap objects reachable (transitively, through observed pointers) from named stack pointers. */
export function reachable(state: RuntimeState): Set<string> {
  const seen = new Set<string>(); const work: string[] = [];
  const push = (v: Value | undefined) => {
    if (isPtr(v)) { if (v.kind === "object" && v.obj && !seen.has(v.obj)) { seen.add(v.obj); work.push(v.obj); } }
    else if (isArr(v)) v.elems.forEach(push);
    else if (isStruct(v)) Object.values(v.fields).forEach(push);
  };
  collectRoots(state).forEach((r) => push(r.ptr));
  for (const f of state.frames) Object.values(f.locals).forEach(push);
  while (work.length) { const o: HeapObject | undefined = state.objects[work.pop()!]; if (o) { Object.values(o.fields ?? {}).forEach(push); o.elems?.forEach(push); } }
  return seen;
}

export function findings(h: History, sourceLines: string[]): Finding[] {
  const out: Finding[] = [];
  const end = h.trace.end;
  if (!h.length) return [{ severity: "warning", code: "no-steps", message: "No line of the selected file was executed." }];
  const last = h.length - 1, s = h.stateAt(last);
  if (end?.reason === "crashed") {
    const text = sourceLines[(end.line ?? 0) - 1] ?? "";
    const nulls = Object.entries(s.frames[0]?.locals ?? {}).filter(([k, v]) => isPtr(v) && v.kind === "null" && new RegExp(`(\\b${k}\\s*->|\\*\\s*${k}\\b|\\b${k}\\s*\\[)`).test(text)).map(([k]) => k);
    out.push({ severity: "error", code: "crash", step: last, line: end.line, message: `Program received ${end.signal ?? "a fatal signal"} at line ${end.line}: \`${text.trim()}\`.` + (nulls.length ? ` Pointer ${nulls.map((n) => `'${n}'`).join(", ")} is nullptr at that moment.` : "") });
  }
  for (const a of end?.doubleFrees ?? []) out.push({ severity: "error", code: "double-free", message: `Memory at ${a} was freed more than once.` });
  if (end?.reason === "step_limit") out.push({ severity: "warning", code: "truncated", message: "Trace truncated at the step limit; later behaviour is not shown." });
  if (end?.reason === "stalled") out.push({ severity: "warning", code: "stalled", line: end.line, message: end.message ?? "Execution stalled on one line." });
  if (end?.reason === "timeout") out.push({ severity: "warning", code: "timeout", message: end.message ?? "Time limit reached." });
  const reach = reachable(s);
  const live = Object.values(s.objects).filter((o) => o.state === "LIVE" && o.fields);
  const lost = live.filter((o) => !reach.has(o.addr));
  if (end?.reason === "exited" && lost.length) out.push({ severity: "warning", code: "leak", step: last, message: `${lost.length} heap object(s) (${[...new Set(lost.map((o) => o.type))].join(", ")}) were never freed and are not reachable from any variable at the end: a memory leak.` });
  else if (end?.reason === "exited" && live.length) out.push({ severity: "info", code: "not-freed", step: last, message: `${live.length} heap object(s) were still allocated when main ended (still referenced by variables, no delete).` });
  for (const r of collectRoots(s)) if (r.ptr.kind === "freed") out.push({ severity: "info", code: "dangling", step: last, message: `Pointer '${r.name}' still holds ${r.ptr.ptr}, which was freed: do not dereference it.` });
  return out;
}

export function suggestions(h: History): Suggestion[] {
  const out: Suggestion[] = [];
  const first = (pred: (e: Trace["steps"][number]["events"][number]) => boolean) => h.steps.find((s) => s.events.some(pred));
  const fr = first((e) => e.type === "object_freed");
  if (fr) out.push({ step: fr.step, text: "First deallocation: check which pointers still refer to the freed node." });
  const cr = h.trace.end?.reason === "crashed" ? h.length - 1 : null;
  if (cr !== null) out.push({ step: cr, text: "The program crashed here: inspect the pointer values in the variables panel." });
  let best = h.steps[0]; for (const s of h.steps) if (s.events.length > (best?.events.length ?? 0)) best = s;
  if (best && best.events.length > 1) out.push({ step: best.step, text: `Largest single change (${best.events.length} events): a good place to see a structural update.` });
  return out;
}

/** Observed cost per function in *this run* (grounded; complements the static estimate). */
export function observedCost(h: History): FunctionCost[] {
  const m = new Map<string, FunctionCost>();
  h.steps.forEach((s, i) => {
    const c = m.get(s.fn) ?? { fn: s.fn, calls: 0, steps: 0 };
    c.steps++;
    const p = h.steps[i - 1];
    if (!p || s.depth > p.depth || p.fn !== s.fn) c.calls += !p || s.depth > p.depth ? 1 : 0;
    m.set(s.fn, c);
  });
  return [...m.values()];
}

import * as fs from "node:fs";
import * as path from "node:path";
import { runTrace, type RunnerConfig } from "../extension/src/execution/runner.ts";
import { History, type RuntimeState } from "../core/snapshots/history.ts";
import { interpret } from "../core/adapters/index.ts";
import type { Scene } from "../core/models/scene.ts";

export const root = path.resolve(import.meta.dirname, "..");
export const cfg: RunnerConfig = { engineDir: path.join(root, "engine"), compiler: "g++", gdb: "gdb", std: "c++17", extraFlags: [],
  compileTimeoutMs: 30000, runTimeoutMs: 60000, maxSteps: 20000, maxOutputBytes: 1 << 20, maxMemoryMB: 0, isolateNetwork: false };

export interface Loaded { history: History; output: string; source: string; lines: string[]; file: string; }
const cache = new Map<string, Promise<Loaded>>();
export function load(rel: string, setup?: string): Promise<Loaded> {
  const key = rel + "|" + (setup ?? "");
  if (!cache.has(key)) cache.set(key, (async () => {
    const file = path.join(root, "examples", rel);
    const r = await runTrace(file, { ...cfg, entry: setup ? { setup } : undefined });
    const source = fs.readFileSync(file, "utf8");
    return { history: new History(r.trace), output: r.programOutput, source, lines: source.split("\n"), file };
  })());
  return cache.get(key)!;
}
/** Index of the first step executing the source line that contains `marker` (in the user's file). */
export function stepAt(l: Loaded, marker: string, nth = 0): number {
  const ln = l.lines.map((t, i) => (t.includes(marker) ? i + 1 : -1)).filter((x) => x > 0)[nth];
  if (!ln) throw new Error("marker not found: " + marker);
  const i = l.history.steps.findIndex((s) => s.file === "main" && s.line === ln);
  if (i < 0) throw new Error("line never executed: " + marker);
  return i;
}
export const scenesAt = (l: Loaded, i: number): { state: RuntimeState; scenes: Scene[] } => {
  const state = l.history.stateAt(i);
  return { state, scenes: interpret(state).scenes };
};
export const outEdges = (s: Scene, id: string, kind: string) => s.edges.filter((e) => e.from === id && e.kind === kind);
export function chain(s: Scene, start: string | null | undefined, kind = "next"): string[] {
  const out: string[] = []; let cur = start ?? null; const seen = new Set<string>();
  while (cur && !seen.has(cur)) { seen.add(cur); out.push(s.nodes.find((n) => n.id === cur)!.label); cur = outEdges(s, cur, kind)[0]?.to ?? null; }
  return out;
}
export const ptrTarget = (s: Scene, name: string) => s.pointers.find((p) => p.name === name)?.target;

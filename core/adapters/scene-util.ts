import type { Scene, SceneKind, SPointer, SNode } from "../models/scene.ts";
import type { RuntimeState } from "../snapshots/history.ts";
import { collectRoots, normType } from "./analysis.ts";

export function newScene(id: string, kind: SceneKind, title: string, confidence: number, reason: string): Scene {
  return { id, kind, title, confidence, reason, nodes: [], edges: [], pointers: [], markers: [], width: 0, height: 0, notes: [] };
}
export function fit(s: Scene, pad = 24): void {
  s.width = Math.max(120, ...s.nodes.map((n) => n.x + n.w + pad));
  s.height = Math.max(80, ...s.nodes.map((n) => n.y + n.h + pad));
}
/** Named pointers of static type `typeName*`: live (into this scene), null, or dangling. Garbage/unresolved pointers are never drawn. */
export function pointersTo(state: RuntimeState, typeName: string, nodeIdOf: (objAddr: string) => string | null): SPointer[] {
  const out: SPointer[] = [];
  for (const r of collectRoots(state)) {
    if (normType(r.ptr.to) !== typeName) continue;
    if (r.ptr.kind === "null") out.push({ name: r.name, target: null, state: "null" });
    else if ((r.ptr.kind === "object" || r.ptr.kind === "freed") && r.ptr.obj && (r.ptr.offset ?? 0) === 0) {
      const id = nodeIdOf(r.ptr.obj);
      if (id) out.push({ name: r.name, target: id, state: r.ptr.kind === "object" ? "live" : "dangling" });
    }
  }
  return out;
}
export const nodeById = (s: Scene, id: string): SNode | undefined => s.nodes.find((n) => n.id === id);

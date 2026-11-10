import type { RuntimeState } from "../snapshots/history.ts";
import type { Scene } from "../models/scene.ts";

/** Objects/arrays already drawn by a higher-priority adapter; later adapters must not draw them again. */
export interface Claims { objects: Set<string>; arrays: Set<string>; }
/** Render-time choices that never change the trace: the same History yields a different scene. `stlView` is keyed by container name. */
export interface InterpretOptions { stlView?: Record<string, "logical" | "internal">; }
export interface DataStructureAdapter {
  readonly id: string;
  canHandle(state: RuntimeState, claims: Claims): boolean;
  interpret(state: RuntimeState, claims: Claims, opts?: InterpretOptions): Scene[];
}

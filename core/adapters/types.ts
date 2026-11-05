import type { RuntimeState } from "../snapshots/history.ts";
import type { Scene } from "../models/scene.ts";

/** Objects/arrays already drawn by a higher-priority adapter; later adapters must not draw them again. */
export interface Claims { objects: Set<string>; arrays: Set<string>; }
export interface DataStructureAdapter {
  readonly id: string;
  canHandle(state: RuntimeState, claims: Claims): boolean;
  interpret(state: RuntimeState, claims: Claims): Scene[];
}

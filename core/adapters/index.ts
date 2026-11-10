import type { RuntimeState } from "../snapshots/history.ts";
import type { VisualizationState } from "../models/scene.ts";
import type { Claims, DataStructureAdapter, InterpretOptions } from "./types.ts";
import { arrayAdapter, graphArrayAdapter, hashAdapter } from "./arrays.ts";
import { stlAdapter } from "./stl.ts";
import { genericAdapter, listAdapter, nodeGraphAdapter, treeAdapter, trieAdapter } from "./nodes.ts";

export type { DataStructureAdapter, Claims, InterpretOptions } from "./types.ts";
/** Priority order matters: earlier adapters claim the objects they draw, later ones skip them. */
export const DEFAULT_ADAPTERS: DataStructureAdapter[] = [stlAdapter, hashAdapter, graphArrayAdapter, trieAdapter, nodeGraphAdapter, treeAdapter, listAdapter, arrayAdapter, genericAdapter];

export function interpret(state: RuntimeState, adapters: DataStructureAdapter[] = DEFAULT_ADAPTERS, opts: InterpretOptions = {}): VisualizationState {
  const claims: Claims = { objects: new Set(), arrays: new Set() };
  const scenes = [];
  for (const a of adapters) if (a.canHandle(state, claims)) scenes.push(...a.interpret(state, claims, opts));
  return { step: state.step, scenes };
}

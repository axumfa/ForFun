import type { RuntimeState } from "../snapshots/history.ts";
import type { VisualizationState } from "../models/scene.ts";
import type { Claims, DataStructureAdapter } from "./types.ts";
import { arrayAdapter, graphArrayAdapter, hashAdapter } from "./arrays.ts";
import { genericAdapter, listAdapter, nodeGraphAdapter, treeAdapter, trieAdapter } from "./nodes.ts";

export type { DataStructureAdapter, Claims } from "./types.ts";
/** Priority order matters: earlier adapters claim the objects they draw, later ones skip them. */
export const DEFAULT_ADAPTERS: DataStructureAdapter[] = [hashAdapter, graphArrayAdapter, trieAdapter, nodeGraphAdapter, treeAdapter, listAdapter, arrayAdapter, genericAdapter];

export function interpret(state: RuntimeState, adapters: DataStructureAdapter[] = DEFAULT_ADAPTERS): VisualizationState {
  const claims: Claims = { objects: new Set(), arrays: new Set() };
  const scenes = [];
  for (const a of adapters) if (a.canHandle(state, claims)) scenes.push(...a.interpret(state, claims));
  return { step: state.step, scenes };
}

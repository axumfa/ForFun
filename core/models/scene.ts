/** Renderer-independent description of what to draw. Produced by adapters, consumed by the webview. */
export type SceneKind = "array" | "heap" | "stack" | "queue" | "singly-linked-list" | "doubly-linked-list" | "binary-tree"
  | "hash-table" | "graph" | "trie" | "generic" | "map" | "set" | "sequence" | "unordered";

export type NodeStatus = "live" | "freed" | "created" | "changed" | "unused";
export interface SNode {
  id: string;                     // stable across steps (heap address or "<scene>[i]"), used for animation + selection
  label: string;
  sub?: string;                   // secondary text (extra fields such as height)
  x: number; y: number; w: number; h: number;
  shape: "cell" | "box" | "circle";
  status: NodeStatus;
  fill?: "red" | "black";
  doubleBorder?: boolean;         // e.g. trie end-of-word
  addr?: string;                  // heap address when the node is a heap object
  index?: number;                 // array index when the node is a cell
  tip?: string;                   // hover text with the full content when the label had to be shortened
}
export type EdgeKind = "next" | "prev" | "left" | "right" | "child" | "ptr" | "edge" | "bucket";
export interface SEdge { id: string; from: string; to: string; kind: EdgeKind; label?: string; changed?: boolean; directed: boolean; }
/** A named variable/field that points into the scene (or is null/dangling). Never invented: comes from observed pointer values. */
export interface SPointer { name: string; target: string | null; state: "live" | "null" | "dangling"; }
export interface Marker { name: string; node: string; }

export interface Scene {
  id: string;
  kind: SceneKind;
  title: string;
  confidence: number;             // 0..1: how sure the adapter is about the *classification* (edges are always observed facts)
  reason: string;                 // why this classification was chosen
  nodes: SNode[];
  edges: SEdge[];
  pointers: SPointer[];
  markers: Marker[];              // index-like variables pointing at array cells
  width: number; height: number;
  notes: string[];
  /** STL containers: which view this scene is, and whether the other one exists (UI shows a Logical | Internal switch). `key` = container name. */
  views?: { key: string; current: "logical" | "internal"; internal: boolean; reason?: string };
}
export interface VisualizationState { step: number; scenes: Scene[]; }

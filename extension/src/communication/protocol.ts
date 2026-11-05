import type { FileKey, Trace } from "../../../core/events/types.ts";
/** extension -> webview. The webview never talks to the debugger. */
export type ToWebview =
  | { type: "loading"; message: string }
  | { type: "trace"; id: number; fileName: string; sources: Record<string, string>; trace: Trace; programOutput: string }
  | { type: "error"; message: string };
/** webview -> extension */
export type FromWebview = { type: "ready" } | { type: "step"; file: FileKey; line: number };

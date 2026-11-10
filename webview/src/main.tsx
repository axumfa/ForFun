import { createRoot } from "react-dom/client";
import { useEffect, useState } from "react";
import type { ToWebview } from "../../extension/src/communication/protocol.ts";
import { Viewer, type StlView } from "./components/Viewer.tsx";

declare function acquireVsCodeApi(): { postMessage(m: unknown): void };
const vscode = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : null;

function App() {
  const [msg, setMsg] = useState<ToWebview | null>(null);
  // Logical/Internal choice per container name: kept here (not in Viewer, which is re-created on every run) so it lasts the whole session.
  const [stlView, setStlView] = useState<StlView>({});
  useEffect(() => {
    const h = (e: MessageEvent<ToWebview>) => setMsg(e.data);
    window.addEventListener("message", h);
    vscode?.postMessage({ type: "ready" });
    return () => window.removeEventListener("message", h);
  }, []);
  if (!msg) return <div className="note">Run “Data Structure Visualizer: Visualize Code” on a C or C++ file.</div>;
  if (msg.type === "loading") return <div className="note">⏳ {msg.message}</div>;
  if (msg.type === "error") return <pre className="error">{msg.message}</pre>;
  return <Viewer key={msg.id} fileName={msg.fileName} sources={msg.sources} trace={msg.trace} programOutput={msg.programOutput}
    stlView={stlView} onStlView={(k, m) => setStlView((s) => ({ ...s, [k]: m }))}
    onStep={(file, line) => vscode?.postMessage({ type: "step", file, line })} />;
}
createRoot(document.getElementById("root")!).render(<App />);

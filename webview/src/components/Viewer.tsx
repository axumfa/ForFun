import { useEffect, useMemo, useState } from "react";
import type { Trace, FileKey } from "../../../core/events/types.ts";
import { History } from "../../../core/snapshots/history.ts";
import { interpret } from "../../../core/adapters/index.ts";
import { usePlayback } from "../hooks/usePlayback.ts";
import { SceneView } from "../visualizers/SceneView.tsx";
import { Controls } from "../timeline/Timeline.tsx";
import { Inspector, Insights, SourcePanel, StepPanel, Variables } from "./Panels.tsx";

type Tab = "step" | "vars" | "inspect" | "insights";
export type StlView = Record<string, "logical" | "internal">;
export interface ViewerProps { stlView?: StlView; onStlView?(key: string, mode: "logical" | "internal"): void; fileName: string; sources: Record<string, string>; trace: Trace; programOutput: string; initialStep?: number; onStep?(file: FileKey, line: number): void; }

export function Viewer(p: ViewerProps) {
  const history = useMemo(() => new History(p.trace), [p.trace]);
  const pb = usePlayback(history.length, p.initialStep);
  const [sel, setSel] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("step");
  const state = useMemo(() => (history.length ? history.stateAt(pb.index) : null), [history, pb.index]);
  const scenes = useMemo(() => (state ? interpret(state, undefined, { stlView: p.stlView }).scenes : []), [state, p.stlView]);
  const srcLines = useMemo(() => Object.fromEntries(Object.entries(p.sources).map(([k, v]) => [k, v.split("\n")])), [p.sources]);
  useEffect(() => { if (state) p.onStep?.(state.file, state.line); }, [state?.step]);        // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).tagName === "INPUT" || (e.target as HTMLElement).tagName === "SELECT") return;
      if (e.key === "ArrowRight") pb.next(); else if (e.key === "ArrowLeft") pb.prev(); else if (e.key === " ") { e.preventDefault(); pb.toggle(); } else if (e.key === "Home") pb.reset();
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  });
  if (!state) return <div className="note">The program ran, but no line of this file was executed. {p.programOutput && <pre>{p.programOutput}</pre>}</div>;
  const pickNode = (id: string | null) => { setSel(id); if (id) setTab("inspect"); };
  return (
    <div className="layout">
      <SourcePanel sources={p.sources} file={state.file} line={state.line} executed={state.cause ? { file: state.cause.file, line: state.cause.line } : null} />
      <section className="center" aria-label="Data structures">
        {scenes.length === 0 && <p className="muted pad">No recognised data structure is alive at this step. Variables are in the right panel.</p>}
        {scenes.map((s) => <SceneView key={s.id} scene={s} selected={sel} onSelect={pickNode} onView={p.onStlView} />)}
      </section>
      <aside className="side" aria-label="State">
        <nav className="tabs">{(["step", "vars", "inspect", "insights"] as Tab[]).map((t) => <button key={t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>{{ step: "Step", vars: "Variables", inspect: "Inspector", insights: "Insights" }[t]}</button>)}</nav>
        {tab === "step" && <StepPanel state={state} sources={srcLines} />}
        {tab === "vars" && <Variables state={state} />}
        {tab === "inspect" && <Inspector state={state} scenes={scenes} selected={sel} onJump={pb.setIndex} />}
        {tab === "insights" && <Insights history={history} sources={p.sources} onJump={pb.setIndex} />}
        {p.programOutput && <details><summary>Program output</summary><pre>{p.programOutput}</pre></details>}
      </aside>
      <Controls history={history} pb={pb} />
    </div>
  );
}

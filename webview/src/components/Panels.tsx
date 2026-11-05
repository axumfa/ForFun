import { useMemo, useState } from "react";
import type { FileKey, Value } from "../../../core/events/types.ts";
import type { History, HeapObject, RuntimeState } from "../../../core/snapshots/history.ts";
import type { Scene } from "../../../core/models/scene.ts";
import { describeObject, describeValue, explainStep } from "../../../core/explain/explain.ts";
import { analyzeSource } from "../../../core/analysis/static.ts";
import { findings, observedCost, suggestions } from "../../../core/analysis/findings.ts";
import { collectRoots, isArr, isPtr, isStruct } from "../../../core/adapters/analysis.ts";

export function SourcePanel(p: { sources: Record<string, string>; file: FileKey; line: number; executed: { file: FileKey; line: number } | null }) {
  const [peek, setPeek] = useState<{ base: FileKey; file: string } | null>(null);
  const shown = peek && peek.base === p.file ? peek.file : p.file;
  const lines = (p.sources[shown] ?? "").split("\n");
  const names = Object.keys(p.sources);
  return (
    <section className="code" aria-label="Source code">
      {names.length > 1 && <div className="tabs">{names.map((n) => <button key={n} className={n === shown ? "on" : ""} onClick={() => setPeek({ base: p.file, file: n })}>{n === "main" ? "source" : "driver"}</button>)}</div>}
      <div className="lines">
        {lines.map((t, n) => {
          const cur = shown === p.file && n + 1 === p.line, ex = p.executed && shown === p.executed.file && n + 1 === p.executed.line && !cur;
          return (
            <div key={n} className={`line${cur ? " current" : ""}${ex ? " executed" : ""}`} ref={(el) => { if (el && cur) el.scrollIntoView({ block: "nearest" }); }}>
              <span className="ln">{n + 1}</span><span className="src">{t || " "}</span>{cur && <span className="tag">next</span>}{ex && <span className="tag">just ran</span>}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function ValueView({ v, objs }: { v: Value | undefined; objs: Record<string, HeapObject> }) {
  if (isArr(v)) return <span className="arrval">[{v.elems.slice(0, 16).map((e, i) => <span key={i}>{i ? ", " : ""}<ValueView v={e} objs={objs} /></span>)}{v.elems.length > 16 ? ", …" : ""}]{v.released ? " (released)" : ""}</span>;
  if (isStruct(v)) return <span>{"{"}{Object.entries(v.fields).map(([k, x], i) => <span key={k}>{i ? ", " : ""}{k}: <ValueView v={x} objs={objs} /></span>)}{"}"}</span>;
  if (isPtr(v)) return <span className={`pv ${v.kind}`}>{describeValue(v, objs)}</span>;
  return <span>{v === undefined || v === null ? "—" : String(v)}</span>;
}

export function Variables({ state, onJump }: { state: RuntimeState; onJump?: (n: number) => void }) {
  void onJump;
  const changed = (fn: string, name: string, v: Value | undefined) => JSON.stringify(state.prev?.frames.find((f) => f.fn === fn)?.locals[name]) !== JSON.stringify(v);
  return (
    <div>
      {state.frames.map((f, k) => (
        <div key={k} className="frame">
          <div className="fn">{f.fn}() <small>line {f.line}</small></div>
          <table><tbody>{Object.entries(f.locals).map(([name, v]) => (
            <tr key={name} className={k === 0 && state.prev && changed(f.fn, name, v) ? "chg" : ""}><td>{name}</td><td><ValueView v={v} objs={state.objects} /></td></tr>
          ))}</tbody></table>
        </div>
      ))}
    </div>
  );
}

export function StepPanel({ state, sources }: { state: RuntimeState; sources: Partial<Record<FileKey, string[]>> }) {
  const e = explainStep(state, sources);
  return (
    <div className="explain">
      {e.executed && <p><span className="muted">Just executed</span><br /><code>{e.executed.text || `line ${e.executed.line}`}</code> <small>({e.executed.fn}, line {e.executed.line})</small></p>}
      {e.effects.length ? <ul>{e.effects.map((t, i) => <li key={i}>{t}</li>)}</ul> : <p className="muted">No observable change in variables or heap.</p>}
      <p><span className="muted">About to execute</span><br /><code>{e.next.text || `line ${e.next.line}`}</code> <small>({e.next.fn}, line {e.next.line})</small></p>
    </div>
  );
}

export function Inspector(p: { state: RuntimeState; scenes: Scene[]; selected: string | null; onJump(step: number): void }) {
  const { state, selected: id } = p;
  if (!id) return <p className="muted">Click a node to inspect its address, value, pointers and modification history.</p>;
  const scene = p.scenes.find((s) => s.nodes.some((n) => n.id === id));
  const node = scene?.nodes.find((n) => n.id === id);
  const obj = state.objects[id];
  if (!node || !scene) return <p className="muted">The selected node no longer exists at this step.</p>;
  const out = scene.edges.filter((e) => e.from === id), inc = scene.edges.filter((e) => e.to === id);
  const nameOf = (nid: string) => scene.nodes.find((n) => n.id === nid)?.label ?? nid;
  const roots = scene.pointers.filter((q) => q.target === id).map((q) => q.name);
  const J = (c: { step: number; line: number } | null | undefined, label: string) => c ? <div>{label}: <button className="link" onClick={() => p.onJump(c.step)}>step {c.step + 1}, line {c.line}</button></div> : null;
  return (
    <div className="inspector">
      <h4>{node.shape === "cell" ? `cell [${node.index}]` : describeObject(obj, id)}</h4>
      <table><tbody>
        <tr><td>value</td><td>{node.label}{node.sub ? ` (${node.sub})` : ""}</td></tr>
        {obj && <tr><td>address</td><td><code>{obj.addr}</code> ({obj.size} bytes)</td></tr>}
        <tr><td>state</td><td>{obj ? obj.state.toLowerCase() : node.status}</td></tr>
        {obj && Object.entries(obj.fields ?? {}).map(([k, v]) => <tr key={k}><td>.{k}</td><td><ValueView v={v} objs={state.objects} /></td></tr>)}
      </tbody></table>
      <h5>Outgoing</h5>{out.length ? <ul>{out.map((e) => <li key={e.id}>{e.kind}{e.label ? `[${e.label}]` : ""} → {nameOf(e.to)}</li>)}</ul> : <p className="muted">none</p>}
      <h5>Incoming</h5>{inc.length || roots.length ? <ul>{inc.map((e) => <li key={e.id}>{nameOf(e.from)}.{e.kind}</li>)}{roots.map((r) => <li key={r}>variable {r}</li>)}</ul> : <p className="muted">none observed</p>}
      {obj && <><h5>History</h5>{J(obj.createdAt, "created")}{J(obj.modifiedAt, "last modified")}{J(obj.freedAt, "freed")}</>}
    </div>
  );
}

export function Insights(p: { history: History; sources: Record<string, string>; onJump(step: number): void }) {
  const data = useMemo(() => ({
    f: findings(p.history, (p.sources.main ?? "").split("\n")), s: suggestions(p.history), cost: observedCost(p.history), a: analyzeSource(p.sources.main ?? ""),
  }), [p.history, p.sources]);
  const icon = { error: "✖", warning: "⚠", info: "ℹ" } as const;
  return (
    <div className="insights">
      <h4>Findings (from the recorded execution)</h4>
      {data.f.length ? <ul>{data.f.map((f, i) => <li key={i} className={f.severity}>{icon[f.severity]} {f.message} {f.step !== undefined && <button className="link" onClick={() => p.onJump(f.step!)}>go to step</button>}</li>)}</ul> : <p className="muted">Nothing suspicious was observed.</p>}
      {data.s.length > 0 && <><h4>Worth inspecting next</h4><ul>{data.s.map((s, i) => <li key={i}><button className="link" onClick={() => p.onJump(s.step)}>step {s.step + 1}</button> {s.text}</li>)}</ul></>}
      <h4>Observed cost in this run</h4>
      <table><tbody>{data.cost.map((c) => <tr key={c.fn}><td>{c.fn}</td><td>{c.calls} call(s)</td><td>{c.steps} lines executed</td></tr>)}</tbody></table>
      <h4>Static analysis (heuristic)</h4>
      {data.a.structs.map((s) => <p key={s.name}><code>{s.name}</code>: {s.guess} <small className="muted">— {s.evidence}</small></p>)}
      <table><tbody>{data.a.functions.map((f) => <tr key={f.name + f.line}><td>{f.name}</td><td>{f.estimate}</td></tr>)}</tbody></table>
    </div>
  );
}
export { collectRoots };

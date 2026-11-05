import type { History } from "../../../core/snapshots/history.ts";
import type { Playback } from "../hooks/usePlayback.ts";
import { SPEEDS } from "../hooks/usePlayback.ts";

/** Controls + timeline. Ticks: green = allocation, red = free, orange = crash/stall at the end. */
export function Controls(p: { history: History; pb: Playback }) {
  const { history: h, pb } = p, last = h.length - 1, end = h.trace.end;
  const ticks = h.steps.flatMap((s) => {
    const t: { i: number; cls: string }[] = [];
    if (s.events.some((e) => e.type === "object_created")) t.push({ i: s.step, cls: "tk-alloc" });
    if (s.events.some((e) => e.type === "object_freed")) t.push({ i: s.step, cls: "tk-free" });
    return t;
  });
  if (end && end.reason !== "exited" && last >= 0) ticks.push({ i: last, cls: "tk-bad" });
  return (
    <footer className="controls">
      <button onClick={pb.reset} disabled={pb.index === 0 && !pb.playing} title="Reset (Home)">⏮ Reset</button>
      <button onClick={pb.prev} disabled={pb.index === 0} title="Previous step (←)">◀ Prev</button>
      <button onClick={pb.toggle} disabled={last <= 0} title="Play/Pause (Space)" className="primary">{pb.playing ? "⏸ Pause" : "▶ Play"}</button>
      <button onClick={pb.next} disabled={pb.index >= last} title="Next step (→)">Next ▶</button>
      <label className="speed">Speed
        <select value={pb.speed} onChange={(e) => pb.setSpeed(Number(e.target.value))}>{SPEEDS.map((s) => <option key={s} value={s}>{s}×</option>)}</select>
      </label>
      <div className="timeline">
        <div className="ticks" aria-hidden="true">{ticks.map((t, k) => <span key={k} className={t.cls} style={{ left: `${last > 0 ? (t.i / last) * 100 : 0}%` }} />)}</div>
        <input type="range" min={0} max={Math.max(last, 0)} value={pb.index} onChange={(e) => pb.setIndex(Number(e.target.value))} aria-label="Execution timeline" />
      </div>
      <span className="counter">step {h.length ? pb.index + 1 : 0}/{h.length}</span>
      <span className={`status ${end?.reason ?? ""}`}>{end ? ({ exited: `exited (${end.exitCode})`, step_limit: "⚠ truncated: step limit", crashed: `✖ crashed: ${end.signal}`, stalled: "⚠ stalled", timeout: "⚠ time limit", error: `✖ ${end.message ?? "error"}` } as Record<string, string>)[end.reason] : ""}</span>
    </footer>
  );
}

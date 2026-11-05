import type { Scene, SEdge, SNode } from "../../../core/models/scene.ts";

const center = (n: SNode) => ({ x: n.x + n.w / 2, y: n.y + n.h / 2 });
function edgePath(e: SEdge, a: SNode, b: SNode): { d: string; lx: number; ly: number } {
  const ca = center(a), cb = center(b);
  if (a.shape === "circle" || e.kind === "child" || e.kind === "left" || e.kind === "right" || e.kind === "edge") {
    const dx = cb.x - ca.x, dy = cb.y - ca.y, len = Math.hypot(dx, dy) || 1;
    const ra = a.w / 2, rb = b.w / 2;
    const x1 = ca.x + (dx / len) * ra, y1 = ca.y + (dy / len) * ra, x2 = cb.x - (dx / len) * (rb + 3), y2 = cb.y - (dy / len) * (rb + 3);
    return { d: `M${x1},${y1} L${x2},${y2}`, lx: (x1 + x2) / 2, ly: (y1 + y2) / 2 };
  }
  const prev = e.kind === "prev";
  const sx = prev ? a.x : a.x + a.w, sy = a.y + a.h * (prev ? 0.8 : 0.35);
  const tx = prev ? b.x + b.w + 3 : b.x - 3, ty = b.y + b.h * (prev ? 0.8 : 0.35);
  if (Math.abs(sy - ty) < 2 && !prev) return { d: `M${sx},${sy} L${tx},${ty}`, lx: (sx + tx) / 2, ly: sy - 6 };
  const bend = prev ? 26 : 0, mx = (sx + tx) / 2;
  return { d: `M${sx},${sy} C${mx},${sy + bend + (ty - sy) * 0.1} ${mx},${ty + bend} ${tx},${ty}`, lx: mx, ly: (sy + ty) / 2 + bend / 2 };
}

export function SceneView(p: { scene: Scene; selected: string | null; onSelect(id: string | null): void }) {
  const s = p.scene, byId = new Map(s.nodes.map((n) => [n.id, n]));
  const mid = `arrow-${s.id.replace(/\W/g, "")}`;
  const ptrsByNode = new Map<string, string[]>();
  for (const q of s.pointers) if (q.target) ptrsByNode.set(q.target, [...(ptrsByNode.get(q.target) ?? []), q.name + (q.state === "dangling" ? " ✗" : "")]);
  const nulls = s.pointers.filter((q) => q.state === "null");
  const markersByNode = new Map<string, string[]>();
  for (const m of s.markers) markersByNode.set(m.node, [...(markersByNode.get(m.node) ?? []), m.name]);
  const topPad = 16 + 15 * Math.max(1, ...[...ptrsByNode.values()].map((v) => v.length));
  return (
    <figure className="scene" aria-label={s.title}>
      <figcaption>
        <strong>{s.title}</strong>
        <span className="conf" title={s.reason}>{s.confidence >= 0.9 ? "●" : s.confidence >= 0.6 ? "◐" : "○"} {Math.round(s.confidence * 100)}%</span>
        {nulls.length > 0 && <span className="nulls">{nulls.map((q) => `${q.name} = ∅`).join("  ·  ")}</span>}
      </figcaption>
      <svg width={s.width} height={s.height + topPad + 18} onClick={() => p.onSelect(null)} role="img">
        <defs>
          <marker id={mid} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" className="arrow" /></marker>
        </defs>
        <g transform={`translate(0,${topPad})`}>
          {s.edges.map((e) => {
            const a = byId.get(e.from), b = byId.get(e.to);
            if (!a || !b) return null;
            const { d, lx, ly } = edgePath(e, a, b);
            return (
              <g key={e.id} className={`edge ${e.kind} ${e.changed ? "changed" : ""}`}>
                <path d={d} markerEnd={e.directed ? `url(#${mid})` : undefined} />
                {e.label && <text x={lx} y={ly} className="elabel">{e.label}</text>}
              </g>
            );
          })}
          {s.nodes.map((n) => (
            <g key={n.id} className={`node ${n.shape} ${n.status} ${n.fill ?? ""} ${p.selected === n.id ? "sel" : ""}`} style={{ transform: `translate(${n.x}px,${n.y}px)` }}
               onClick={(ev) => { ev.stopPropagation(); p.onSelect(n.id); }} tabIndex={0} role="button" aria-label={`${n.label} ${n.status}`}>
              {n.shape === "circle" ? <>
                <circle cx={n.w / 2} cy={n.h / 2} r={n.w / 2} />
                {n.doubleBorder && <circle cx={n.w / 2} cy={n.h / 2} r={n.w / 2 - 4} className="inner" />}
              </> : <rect width={n.w} height={n.h} rx={n.shape === "box" ? 6 : 2} />}
              <text x={n.w / 2} y={n.sub ? n.h / 2 - 2 : n.h / 2 + 5} className="val">{n.label}</text>
              {n.sub && <text x={n.w / 2} y={n.h / 2 + 12} className="sub">{n.sub}</text>}
              {n.index !== undefined && n.shape === "cell" && <text x={n.w / 2} y={n.h + 14} className="idx">{n.index}</text>}
              {(ptrsByNode.get(n.id) ?? []).map((name, i) => (
                <g key={name} transform={`translate(0,${-12 - i * 15})`}><text x={n.w / 2} y={0} className={`ptr ${name.endsWith("✗") ? "dangling" : ""}`}>{name}</text></g>
              ))}
              {(markersByNode.get(n.id) ?? []).map((name, i) => <text key={name} x={n.w / 2} y={n.h + 28 + i * 14} className="marker">▲ {name}</text>)}
            </g>
          ))}
        </g>
      </svg>
      {s.notes.map((t, i) => <div key={i} className="note-line">{t}</div>)}
    </figure>
  );
}

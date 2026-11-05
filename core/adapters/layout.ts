export const CELL = { w: 56, h: 40, gap: 36 };

/** In-order tidy-ish tree layout. `children` returns ordered child ids (null/undefined entries keep their slot). */
export function layoutTree(roots: string[], children: (id: string) => (string | null)[], dx = 56, dy = 76, x0 = 40, y0 = 40): { pos: Map<string, { x: number; y: number }>; width: number; height: number } {
  const pos = new Map<string, { x: number; y: number }>();
  let next = 0, maxD = 0;
  const seen = new Set<string>();
  const place = (id: string, depth: number): void => {
    if (seen.has(id)) return;
    seen.add(id);
    maxD = Math.max(maxD, depth);
    const kids = children(id);
    const mid = Math.ceil(kids.length / 2);
    kids.slice(0, mid).forEach((k) => { if (k && !seen.has(k)) place(k, depth + 1); });
    pos.set(id, { x: x0 + next * dx, y: y0 + depth * dy }); next++;
    kids.slice(mid).forEach((k) => { if (k && !seen.has(k)) place(k, depth + 1); });
  };
  roots.forEach((r) => { place(r, 0); next += 1; });
  return { pos, width: x0 * 2 + Math.max(next, 1) * dx, height: y0 * 2 + (maxD + 1) * dy };
}

export function layoutCircle(n: number, r = 110, cx = 160, cy = 140): { x: number; y: number }[] {
  if (n === 1) return [{ x: cx, y: cy }];
  return Array.from({ length: n }, (_, i) => ({ x: cx + r * Math.cos((2 * Math.PI * i) / n - Math.PI / 2), y: cy + r * Math.sin((2 * Math.PI * i) / n - Math.PI / 2) }));
}

import { useCallback, useEffect, useRef, useState } from "react";

export const SPEEDS = [0.5, 1, 2, 4, 8] as const;
export interface Playback {
  index: number; playing: boolean; speed: number;
  setIndex(i: number): void; next(): void; prev(): void; reset(): void; toggle(): void; setSpeed(s: number): void;
}
/** Playback state machine. One step per tick; stops at the last step. Pure React: no timers when paused. */
export function usePlayback(length: number, initial = 0): Playback {
  const [index, setIdx] = useState(Math.min(Math.max(initial, 0), Math.max(0, length - 1)));
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const last = Math.max(0, length - 1);
  const clamp = useCallback((i: number) => Math.min(Math.max(i, 0), last), [last]);
  const idxRef = useRef(index); idxRef.current = index;
  useEffect(() => {
    if (!playing) return;
    if (idxRef.current >= last) { setPlaying(false); return; }
    const t = setInterval(() => {
      if (idxRef.current >= last) { setPlaying(false); return; }
      setIdx((i) => clamp(i + 1));
    }, 900 / speed);
    return () => clearInterval(t);
  }, [playing, speed, last, clamp]);
  return {
    index, playing, speed,
    setIndex: (i) => setIdx(clamp(i)),
    next: () => setIdx((i) => clamp(i + 1)),
    prev: () => setIdx((i) => clamp(i - 1)),
    reset: () => { setPlaying(false); setIdx(0); },
    toggle: () => setPlaying((p) => (idxRef.current >= last ? false : !p)),
    setSpeed,
  };
}

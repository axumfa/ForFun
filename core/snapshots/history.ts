import type { Frame, Step, Trace, TraceEvent, Value, FileKey } from "../events/types.ts";

export interface Cause { step: number; fn: string; file: FileKey; line: number; }
export interface HeapObject {
  addr: string; type: string; state: "LIVE" | "FREED"; size: number;
  fields?: Record<string, Value>; elems?: Value[];      // last known contents (for FREED: values before the free)
  createdAt: Cause | null; modifiedAt: Cause | null; freedAt: Cause | null;
}
export interface RuntimeState {
  step: number; fn: string; file: FileKey; line: number;
  frames: Frame[];
  objects: Record<string, HeapObject>;
  events: TraceEvent[];             // effects observed at this step (caused by `cause`)
  cause: Cause | null;              // the line whose execution produced `events`
  prev: { frames: Frame[]; objects: Record<string, HeapObject> } | null;
}

type Heap = Record<string, HeapObject>;
const clone = <T,>(x: T): T => structuredClone(x);

function apply(heap: Heap, events: TraceEvent[], cause: Cause | null): void {
  for (const e of events) {
    switch (e.type) {
      case "object_created":
        heap[e.addr] = { addr: e.addr, type: e.obj_type, state: "LIVE", size: e.size, fields: e.fields ? clone(e.fields) : undefined,
          elems: e.elems ? clone(e.elems) : undefined, createdAt: cause, modifiedAt: cause, freedAt: null };
        break;
      case "object_freed": { const o = heap[e.addr]; if (o) { o.state = "FREED"; o.freedAt = cause; o.modifiedAt = cause; } break; }
      case "field_changed": { const o = heap[e.addr]; if (o) { (o.fields ??= {})[e.field] = clone(e.new); o.modifiedAt = cause; } break; }
      case "elem_changed": { const o = heap[e.addr]; if (o) { (o.elems ??= [])[e.index] = clone(e.new); o.modifiedAt = cause; } break; }
      case "local_changed": break;       // frames carry full locals; nothing to fold into the heap
    }
  }
}

const causeOf = (s: Step | undefined): Cause | null => (s ? { step: s.step, fn: s.fn, file: s.file, line: s.line } : null);

/**
 * Random-access history. Keeps a heap keyframe every `interval` steps; stateAt(i) clones the nearest earlier keyframe and
 * replays at most interval-1 event batches. Backward navigation therefore never re-runs the program.
 */
export class History {
  readonly steps: Step[];
  readonly trace: Trace;
  private readonly interval: number;
  private keyframes = new Map<number, Heap>();
  constructor(trace: Trace, interval = 32) {
    this.trace = trace; this.interval = interval;
    this.steps = trace.steps;
    const heap: Heap = {};
    this.steps.forEach((s, i) => {
      apply(heap, s.events, causeOf(this.steps[i - 1]) ?? causeOf(s));
      if (i % interval === 0) this.keyframes.set(i, clone(heap));
    });
  }
  get length(): number { return this.steps.length; }

  private heapAt(i: number): Heap {
    const kf = Math.floor(i / this.interval) * this.interval;
    const heap = clone(this.keyframes.get(kf) ?? {});
    for (let k = kf + 1; k <= i; k++) apply(heap, this.steps[k]!.events, causeOf(this.steps[k - 1]) ?? causeOf(this.steps[k]));
    return heap;
  }

  stateAt(i: number): RuntimeState {
    if (i < 0 || i >= this.steps.length) throw new RangeError(`step ${i} out of range 0..${this.steps.length - 1}`);
    const s = this.steps[i]!;
    return {
      step: i, fn: s.fn, file: s.file, line: s.line, frames: s.frames, objects: this.heapAt(i), events: s.events,
      cause: causeOf(this.steps[i - 1]) ?? null,
      prev: i > 0 ? { frames: this.steps[i - 1]!.frames, objects: this.heapAt(i - 1) } : null,
    };
  }
}

# Architecture (Milestone 0 proposal, kept for history)

## 1. Environment findings (this machine)
GCC 16.2, GDB 18.1 (Python API), Node 22, VS Code 1.144. **No LLDB, no Clang, no Valgrind.**
The brief assumed LLDB; the debugger must be pluggable. See decision D1.

## 2. Proof of concept (poc/)
`tracer.py` single-steps a real `-g -O0` process under GDB and emits JSONL events
(line, function, locals, pointees). Run on a linked-list push/remove program.
What it showed (verified by running it):

| Finding | Consequence |
|---|---|
| Real execution can be stepped and locals/pointees read | Debugger-based tracing is feasible |
| `n->next = head` (line 6) produced **no** event: it changes heap, not a local | Must diff *reachable heap objects by address*, not locals by name |
| `Node** pp = &head` points into the stack, then to the `next` *field* of a heap node | Need interior-pointer resolution (address -> object + field) |
| Uninitialized locals read as garbage (`next = 0xe283...`, `dead = 0x1`) | Must mark "not yet initialized" (scope/line-based) or the UI shows fabricated pointers |
| After `delete dead`, `dead` is dangling and reads freed memory (`val: 1046`) | Need allocation tracking (malloc/free interception) to mark objects FREED |
| `step` into libc/`new` is slow and noisy | Skip non-user frames with `finish`; step cost is ~ms per line |

PoC limits: not yet tested for speed on long loops, STL types, inlined/-O2 code,
or destructors. Throwaway code; not the basis of the product.

## 3. Key decisions
- **D1 Debugger: GDB (Python API) first, behind a `DebuggerBackend` interface; LLDB backend later.**
  LLDB is not installed and its Python bindings are awkward to ship; GDB is present. The
  interface keeps the choice reversible.
- **D2 Tracing: debugger single-step + malloc/free hooks (LD_PRELOAD shim), not compiler instrumentation.**
  Instrumentation (Clang pass / ASan-style) gives exact write events (fixes the "heap write with no event"
  problem) but needs Clang and rebuilds user code. Debugger stepping works on unmodified code. Hybrid
  (hardware watchpoints on discovered node memory) is the planned answer to missed heap writes; per-line
  heap diffing is the baseline.
- **D3 State model: per-step snapshot of an address-keyed object graph.**
  `Snapshot = { stack frames, objects[addr] = {type, fields, state: LIVE|FREED|UNINIT}, pointers }`.
  Events are derived from snapshot diffs. Store a keyframe snapshot every N steps + deltas;
  backward navigation = apply inverse deltas, never rerun.
- **D4 Structure recognition is heuristic and shown as such.** Rule: a struct with a self-typed pointer field
  = node; 1 self-pointer = list, 2 = (doubly list | binary tree, disambiguated by field names and by
  back-edge check on the *actual graph*). Adapters return a confidence + the raw graph is always
  available as fallback view ("generic pointer graph"). Never invents edges; edges come only from
  real pointer values pointing into LIVE objects.
- **D5 Process isolation:** debugger and inferior run in a child process, with `ulimit`/rlimits
  (CPU time, memory, output), wall-clock timeout, temp dir cwd. Stronger (bubblewrap/namespaces,
  containers) is a Milestone 6 item. Extension host only talks JSON.
- **D6 Frontend:** React + SVG in a Webview, fed only by `Snapshot` + `Event` JSON; knows nothing of GDB.
- **D7 Language:** TypeScript for extension + core (+ tracer-side logic). The GDB-side script is Python
  (required by GDB) and kept thin: it emits raw observations; normalization lives in TS `core/`.
- **D8 Event schema versioned** (`"schema": 1`), documented in `docs/events.md` and validated in tests.

## 4. Components
| Component | Responsibility | Depends on |
|---|---|---|
| `extension/` | commands, "Visualize Code", input prompts, spawn engine, webview host | core types |
| `engine/` | compile (configurable compiler), run under backend, emit raw observations (JSONL stream) | gdb, shim |
| `core/` | schema, normalizer, history/snapshots/diff, adapters (array, list, tree...) | none (pure TS, unit-testable) |
| `webview/` | render snapshots, controls, timeline, inspector | core types only |

Data flow: `engine -> raw JSONL -> core normalizer -> History -> adapters -> VisualizationState -> webview`.
Repository layout follows your suggestion unchanged.

## 5. Risks
1. **Missed heap writes between steps** (seen in PoC). Mitigate: per-step reachable-heap diff; watchpoints.
2. **-O2 / inlining** breaks line stepping and locals. Compile with `-O0 -g`, ignore user flags that override it.
3. **STL containers** (vector, map): need pretty-printers/known layouts; libstdc++-specific. Start with vector via GDB printers.
4. **Performance**: Python-API stepping ~ ms/step; cap steps (default 20k) and document it. Loops with millions of iterations need "step over" granularity.
5. **Uninitialized/dangling reads** must be flagged, not displayed as valid (D3, shim).
6. **Heuristic recognition** will misclassify unusual designs (sentinel nodes, arrays-as-trees, `unique_ptr` nodes). Fallback to generic graph.
7. **Security:** compiling/running arbitrary code; rlimits are not a sandbox.
8. **Portability:** GDB is weak on macOS/Windows; LLDB backend needed for cross-platform (Milestone 6).
9. **Stack addresses in PoC were ASLR-disabled by GDB**; real run differs, fine since we only use relative identity.

## 6. Plan
- M0: DONE. Architecture approved (GDB-first, `-O0 -g`, step cap; no Clang/LLDB install). PoC v2 (`poc/shim.cpp`, `poc/tracer2.py`)
  validated on the list program: heap writes (`field_changed`), interior pointer (`pp` -> node 0x416060 +8), uninitialized
  pointers (`kind: unresolved`, never drawn as edges), delete (`object_freed`, `dead` -> `freed`) all correct vs. the program's real behavior.
  Known caveat: events are observed *before* the next line runs, so effects of line N appear under line N+1; M2 must re-attribute them.
  Not yet tested: loops at scale, STL, destructors, `new[]`, recursion-heavy trees, speed.
- M1: extension scaffold, webview, compile+run engine, line tracking, variable panel.
- M2: events, snapshots, step back/forward, timeline.
- M3: array, singly list, binary tree adapters. Then M4-M6 as in the brief.

## 7. Questions for you
1. OK to make GDB the first backend (LLDB/Clang not installed, can't test them here)?
2. Should I install Clang/LLDB (`sudo dnf install clang lldb`) for a comparison, or stay GDB-only for now?
3. Accept the step cap and `-O0 -g` forced build as MVP constraints?

---
# Status after implementation (current; supersedes plan sections where they differ)
All milestones M0-M6 are implemented for the **GDB/Linux** backend. See `limitations.md` for what that means.

| Module | Where | Notes |
|---|---|---|
| Engine | `engine/debugger/gdb_tracer.py`, `engine/runtime/shim.cpp` | stepping, heap graph, watchdog, crash/exit events |
| Runner | `extension/src/execution/runner.ts` | compile, driver generation, limits, cancellation; no VS Code imports (unit-testable) |
| Core | `core/events`, `snapshots`, `adapters`, `explain`, `analysis` | pure TS, shared by extension and webview |
| Webview | `webview/src` | React + SVG, consumes `History` + adapters only |

Decisions made during implementation:
- **D9** GDB `to_string` does not capture stop messages: signals and exit codes come from `gdb.events.stop/exited`.
- **D10** The whole trace is parsed once into `History` (keyframe every 32 steps, replay forward). Backward navigation = replay from a keyframe.
- **D11** Adapters run in priority order and *claim* objects (hash > graph > trie > tree > list > array > generic) so nothing is drawn twice.
- **D12** Function/class visualisation uses a generated driver that `#include`s the user file with `main` renamed, so debug info keeps real paths and no source is rewritten.
- **D13** Structure kind comes from field types and self-pointers; names only break ties (prev/next vs left/right, heap/queue/stack) and label scenes.

Test strategy: every example prints its own final structure; tests assert the *drawn* scene equals the printed output, plus an invariant test
that no drawn edge lacks a corresponding observed pointer at any step of any example.

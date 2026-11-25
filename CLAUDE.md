# CLAUDE.md

## Project summary
`dsv` (Data Structure Visualizer) is a VS Code extension that compiles a user's **C++** program (`g++ -O0 -g`, forced), runs it under GDB
in a separate process, and visualizes its data structures step by step (arrays, lists, trees, heaps, hash tables, graphs, tries).
Only relationships actually observed in memory are drawn; structure *classification* is heuristic and shown with a confidence.
Linux only (GDB + `LD_PRELOAD`). Targets are C++ (`g++`, default `dsv.compiler`) and plain C (`gcc`, `dsv.cCompiler`, `-std=c11`, `-lm`), chosen by file extension (`.c` = C, everything else C++). The shim is C++ and is always built with `dsv.compiler`.

## Commands
Run from the repo root unless noted. All verified on this machine (Node 22, GDB, g++).
- Install: `npm ci` (npm workspaces: `extension`, `webview`)
- Build: `npm run build` (esbuild -> `extension/dist/{extension.js,webview.js,webview.css}`, copies `engine/` to `extension/engine/`)
- Typecheck: `npm run typecheck` (`tsc -p core && tsc -p extension && tsc -p webview`)
- Test: `npm test` (`node --experimental-strip-types --test tests/*.test.ts`; ~1 min; needs `g++` and `gdb` because tests really compile and trace the examples)
- Package the .vsix: `npm run build && npm run package -w extension -- -o ../dsv.vsix` (`@vscode/vsce` devDependency of `extension/`; script `vsce package --no-dependencies`).
  `*.vsix` is gitignored (not tracked).
- Trace a file and print the scenes: `npm run trace -- examples/binary-trees/bst.cpp [step|last] [--json]` (no arg: step count + program output).
- Run one example via the test helper (prints step count and program output):
  `node --experimental-strip-types -e 'import("./tests/helpers.ts").then(async h => { const l = await h.load("binary-trees/bst.cpp"); console.log(l.history.length, "steps"); console.log(l.output) })'`
  (`load` takes a path under `examples/`; second arg `setup` runs C++ statements via a generated driver instead of `main`.)
- CI: `.github/workflows/ci.yml` runs on push to main and PRs (matrix: ubuntu-latest and ubuntu-22.04; Node 22.18 via `.nvmrc`, apt `gdb`, 20 min timeout): diagnostics (gdb/gcc/ldd/node versions), `npm ci`, build, typecheck, test, then packages `dsv.vsix` and uploads it as the `dsv-vsix` artifact. Failures on Ubuntu but not Fedora may be real portability bugs: diagnose, never skip tests.
- Interactive: open `extension/` in VS Code, F5 (Extension Development Host), right-click a `.cpp` -> "Visualize Code".

## Architecture map
- `engine/debugger/gdb_tracer.py`: GDB-side script. Single-steps the debuggee, reads memory, writes trace JSONL (schema v5). Observations only, no inference. `engine/debugger/linetable.py`: DWARF line rows (columns, discriminators) via the vendored `engine/vendor/pyelftools` (unmodified, Python >= 3.10) for sub-line stepping (no gdb import).
- `engine/runtime/shim.cpp`: `LD_PRELOAD` shim logging `operator new/delete` to an alloc log the tracer reads.
- `core/`: pure TypeScript, no VS Code/Node-runtime coupling, shared by extension and webview.
  - `events/types.ts`: trace schema, `parseTrace`, `SCHEMA_VERSION` (see `docs/events.md`)
  - `snapshots/history.ts`: `History`; keyframe every 32 steps, `stateAt(i)` replays forward -> `RuntimeState`
  - `adapters/`: `RuntimeState` -> `Scene[]`. `index.ts` (priority list `DEFAULT_ADAPTERS`, `interpret`), `nodes.ts` (node-based: tree/list/trie/graph/generic), `arrays.ts` (array/heap/stack/queue/hash/graph-matrix), `analysis.ts` (type analysis helpers), `layout.ts`, `scene-util.ts`, `types.ts`
  - `models/scene.ts`: renderer-independent `Scene`/`SceneKind`/`SNode`/`SEdge`
  - `explain/explain.ts`: step explanations from recorded facts (`ExplanationProvider`; no LLM)
  - `analysis/`: `static.ts` (regex-level complexity/type guesses), `findings.ts` (leak/dangling/crash from the run)
- `extension/src/`: `extension.ts` (activation), `commands/visualize.ts` ("Visualize Code"), `execution/runner.ts` (language by extension, compile, driver generation, limits, spawn gdb, cancel; **no `vscode` import**, unit-testable), `communication/` (panel host + protocol), `logger.ts`
- `webview/src/`: React + SVG UI. `components/` (Viewer, Panels), `timeline/`, `hooks/usePlayback.ts`, `visualizers/SceneView.tsx`. Consumes `History` + adapters only; knows nothing about GDB.
- `examples/<category>/*.cpp` and `examples/c/*.c`: sample programs used by tests (each prints its own final structure). `scripts/build.mjs`: bundler. `poc/`: throwaway M0 prototype, not product code.
- `docs/`: `architecture.md` (decisions D1-D13), `events.md` (schema), `limitations.md`.

Data flow: user program -> compile + `shim.cpp` + `gdb_tracer.py` (in runner.ts's child process) -> JSONL events -> `parseTrace` -> `History` snapshots -> `interpret()` adapters -> `Scene[]` -> webview.
Events observed at step N describe the effects of step N-1's line (`History` exposes it as `cause`).

## Adding a data-structure adapter
Use the `add-adapter` skill (`.claude/skills/add-adapter/SKILL.md`): model on the BST (`treeScene` in `core/adapters/nodes.ts`); adapter order in `DEFAULT_ADAPTERS` matters (`genericAdapter` last).

## Conventions
- TypeScript, ESM, `.ts` extensions in relative imports (`allowImportingTsExtensions`); tests run TS directly via Node type stripping, so **no enums, namespaces or parameter properties** (not erasable syntax).
- `tsconfig.base.json`: `strict`, `noUncheckedIndexedAccess` (indexing yields `T | undefined`), `noImplicitOverride`, `noEmit`. This and `tsc` are the only enforced checks: there is no linter or formatter configured.
- Style in existing code: 2-space indent, double quotes, semicolons, dense one-line helpers, `import type` for types, short doc comments stating invariants.
- `core/` stays pure (no `vscode`, no DOM); `extension/src/execution/runner.ts` must not import `vscode`.
- Tests: `tests/<area>.test.ts` using `node:test` + `node:assert/strict`; shared helpers in `tests/helpers.ts`. Tests trace real examples (no mocks of GDB). `tests/.tmp-*` is gitignored scratch output.
- Examples: `examples/<kebab-category>/<name>.cpp`; C ones in `examples/c/<name>.c` (tests in `tests/c.test.ts`). Scene ids are stable (heap address or `<scene>[i]`).
- Python in `engine/` is deliberately thin; normalization belongs in TS `core/`. Bump `SCHEMA_VERSION` and update `docs/events.md` on any breaking trace change.

## Current status
Milestones M0-M6 are done for the GDB/Linux backend (see `docs/architecture.md`, "Status after implementation").
Known limitations are in [docs/limitations.md](docs/limitations.md); read it before claiming support for something. Do not duplicate it here.

## Roadmap (in order)
- M7: done (malloc family tracking, see D14); remaining: nothing
- M8: done (logical + internal views for map/set/multi*/list/deque/unordered_*; pointer cells carry `SNode.ref` for click-through, no cross-scene edges)
- M9: sub-line stepping done (design A, DWARF rows + internal breakpoints, schema v5 `sub`, see D18 / `docs/architecture.md`); remaining: splitting writes inside one statement (design B, `nexti` + store detection, x86-64 only, not built)
- M13 (not started): incremental snapshots. Every stop re-reads the whole heap (~15 ms/stop at 300 heap objects; see the benchmark in `docs/architecture.md`, "M9"); read only what can have changed (dirty-object tracking, e.g. memory diff against the last read or pointer-reachability from changed locals).
- Uncaught C++ exception (not started): report a trace that ends from an uncaught exception as a crash carrying the exception type, not as `exited` with a null exit code (today it ends at the throw; documented in `docs/limitations.md`, "C++ exceptions").
- Hidden compiler locals (not started): validate `__for_range` and similar hidden `__*` locals by checking that the address they refer to lies in the stack or in a tracked heap allocation, and reject pointers into library mappings, instead of relying on `collectStl`'s empty-container filter (PR #3). Motivation: CI run 45314141416 (ubuntu-latest), where the uninitialised `__for_range` slot pointed at `0x7ffff7ea2f48` (library memory) and was read as an empty `printer` map, drawing a spurious 0-element scene. The filter hides that case but a stale slot that happens to look non-empty would still be drawn.
- M10: done (`.github/workflows/ci.yml`, see Commands > CI)
- M11: bwrap sandbox for the traced run done (`dsv.sandbox`, `bwrapArgs` in runner.ts); remaining: seccomp filter, sandboxed compile step
- M12: LLDB backend
- Future: delta-encoded *heap events inside object_created* and `local_changed` old/new values (frames are already delta-encoded, schema v4, see `docs/events.md`).

## Rules for working in this repo
- Run `npm run typecheck` and `npm test` before declaring anything done; report failures honestly with output.
- Never weaken, skip or delete tests to make them pass. Fix the code, or explain why a test's expectation is wrong.
- When a limitation is removed, update `docs/limitations.md` and `docs/architecture.md` in the same change.
- Keep commits small: one milestone step each.
- Don't push unless asked. Only trace code you trust: the sandbox is best-effort (see limitations).

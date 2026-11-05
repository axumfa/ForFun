# CLAUDE.md

## Project summary
`dsv` (Data Structure Visualizer) is a VS Code extension that compiles a user's **C++** program (`g++ -O0 -g`, forced), runs it under GDB
in a separate process, and visualizes its data structures step by step (arrays, lists, trees, heaps, hash tables, graphs, tries).
Only relationships actually observed in memory are drawn; structure *classification* is heuristic and shown with a confidence.
Linux only (GDB + `LD_PRELOAD`). The target language is C++: sources are compiled with `g++` (default `dsv.compiler`) and the shim is C++; plain C is not a tested target.

## Commands
Run from the repo root unless noted. All verified on this machine (Node 22, GDB, g++).
- Install: `npm ci` (npm workspaces: `extension`, `webview`)
- Build: `npm run build` (esbuild -> `extension/dist/{extension.js,webview.js,webview.css}`, copies `engine/` to `extension/engine/`)
- Typecheck: `npm run typecheck` (`tsc -p core && tsc -p extension && tsc -p webview`)
- Test: `npm test` (`node --experimental-strip-types --test tests/*.test.ts`; 37 tests, ~12 s; needs `g++` and `gdb` because tests really compile and trace the examples)
- Package the .vsix: `npm run build && cd extension && npx vsce@2.15.0 package --no-dependencies -o ../dsv.vsix`
  (`@vsce/vsce` was a 404 on the configured registry; the old unscoped `vsce` works. `dsv.vsix` at the root is a tracked artifact; don't regenerate it casually.)
- Run one example (no CLI exists; use the test helper, prints step count and program output):
  `node --experimental-strip-types -e 'import("./tests/helpers.ts").then(async h => { const l = await h.load("binary-trees/bst.cpp"); console.log(l.history.length, "steps"); console.log(l.output) })'`
  (`load` takes a path under `examples/`; second arg `setup` runs C++ statements via a generated driver instead of `main`.)
- Interactive: open `extension/` in VS Code, F5 (Extension Development Host), right-click a `.cpp` -> "Visualize Code".

## Architecture map
- `engine/debugger/gdb_tracer.py`: GDB-side script. Single-steps the debuggee, reads memory, writes trace JSONL (schema v2). Observations only, no inference.
- `engine/runtime/shim.cpp`: `LD_PRELOAD` shim logging `operator new/delete` to an alloc log the tracer reads.
- `core/`: pure TypeScript, no VS Code/Node-runtime coupling, shared by extension and webview.
  - `events/types.ts`: trace schema, `parseTrace`, `SCHEMA_VERSION` (see `docs/events.md`)
  - `snapshots/history.ts`: `History`; keyframe every 32 steps, `stateAt(i)` replays forward -> `RuntimeState`
  - `adapters/`: `RuntimeState` -> `Scene[]`. `index.ts` (priority list `DEFAULT_ADAPTERS`, `interpret`), `nodes.ts` (node-based: tree/list/trie/graph/generic), `arrays.ts` (array/heap/stack/queue/hash/graph-matrix), `analysis.ts` (type analysis helpers), `layout.ts`, `scene-util.ts`, `types.ts`
  - `models/scene.ts`: renderer-independent `Scene`/`SceneKind`/`SNode`/`SEdge`
  - `explain/explain.ts`: step explanations from recorded facts (`ExplanationProvider`; no LLM)
  - `analysis/`: `static.ts` (regex-level complexity/type guesses), `findings.ts` (leak/dangling/crash from the run)
- `extension/src/`: `extension.ts` (activation), `commands/visualize.ts` ("Visualize Code"), `execution/runner.ts` (compile, driver generation, limits, spawn gdb, cancel; **no `vscode` import**, unit-testable), `communication/` (panel host + protocol), `logger.ts`
- `webview/src/`: React + SVG UI. `components/` (Viewer, Panels), `timeline/`, `hooks/usePlayback.ts`, `visualizers/SceneView.tsx`. Consumes `History` + adapters only; knows nothing about GDB.
- `examples/<category>/*.cpp`: sample programs used by tests (each prints its own final structure). `scripts/build.mjs`: bundler. `poc/`: throwaway M0 prototype, not product code.
- `docs/`: `architecture.md` (decisions D1-D13), `events.md` (schema), `limitations.md`.

Data flow: user program -> compile + `shim.cpp` + `gdb_tracer.py` (in runner.ts's child process) -> JSONL events -> `parseTrace` -> `History` snapshots -> `interpret()` adapters -> `Scene[]` -> webview.
Events observed at step N describe the effects of step N-1's line (`History` exposes it as `cause`).

## Adding a data-structure adapter
Model on the BST: it is `treeScene` in `core/adapters/nodes.ts` wrapped as `treeAdapter = nodeAdapter("binary-tree", ["tree"], treeScene)`.
1. `core/models/scene.ts`: add the new value to `SceneKind` (skip if reusing an existing kind).
2. Recognition: for node structures extend `NodeClass["kind"]` and `classify()` in `nodes.ts` (field types/self-pointers decide; names only break ties). For array-backed ones, add to `core/adapters/arrays.ts`.
3. Write the scene builder (`newScene`, `mkNode`, `addEdges`, `layout.ts` helpers). Edges must come only from observed pointers; set `confidence` and `reason`.
4. Wrap with `nodeAdapter(...)` (it claims drawn objects) or implement `DataStructureAdapter` (`types.ts`) directly.
5. Register in `DEFAULT_ADAPTERS` in `core/adapters/index.ts`. **Order matters**: earlier adapters claim objects, `genericAdapter` must stay last.
6. Webview: `SceneView.tsx` branches on node `shape` and edge `kind`, not scene kind; add a shape/edge kind there (and `style.css`) only if needed.
7. Optional: type-name guess in `core/analysis/static.ts` (e.g. "binary tree node").
8. Example: add `examples/<category>/<name>.cpp` that prints its final structure.
9. Tests in `tests/adapters.test.ts`: assert the drawn scene equals the program's printed output (see the BST test: in-order of drawn tree == output), assert structural invariants, and add the new example's path to the "INVARIANT: every drawn heap edge exists in the observed pointer data" file list. Also `tests/analysis.test.ts` if you touched `static.ts`.

## Conventions
- TypeScript, ESM, `.ts` extensions in relative imports (`allowImportingTsExtensions`); tests run TS directly via Node type stripping, so **no enums, namespaces or parameter properties** (not erasable syntax).
- `tsconfig.base.json`: `strict`, `noUncheckedIndexedAccess` (indexing yields `T | undefined`), `noImplicitOverride`, `noEmit`. This and `tsc` are the only enforced checks: there is no linter or formatter configured.
- Style in existing code: 2-space indent, double quotes, semicolons, dense one-line helpers, `import type` for types, short doc comments stating invariants.
- `core/` stays pure (no `vscode`, no DOM); `extension/src/execution/runner.ts` must not import `vscode`.
- Tests: `tests/<area>.test.ts` using `node:test` + `node:assert/strict`; shared helpers in `tests/helpers.ts`. Tests trace real examples (no mocks of GDB). `tests/.tmp-*` is gitignored scratch output.
- Examples: `examples/<kebab-category>/<name>.cpp`. Scene ids are stable (heap address or `<scene>[i]`).
- Python in `engine/` is deliberately thin; normalization belongs in TS `core/`. Bump `SCHEMA_VERSION` and update `docs/events.md` on any breaking trace change.

## Current status
Milestones M0-M6 are done for the GDB/Linux backend (see `docs/architecture.md`, "Status after implementation").
Known limitations are in [docs/limitations.md](docs/limitations.md); read it before claiming support for something. Do not duplicate it here.

## Roadmap (in order)
- M7: `malloc`/`calloc`/`realloc`/`free` tracking
- M8: STL `map`/`set`/`unordered_map`/`list`/`deque` adapters
- M9: per-write tracking (watchpoints on the active structure)
- M10: GitHub Actions CI (typecheck + tests)
- M11: stronger sandboxing (bwrap/seccomp)
- M12: LLDB backend

## Rules for working in this repo
- Run `npm run typecheck` and `npm test` before declaring anything done; report failures honestly with output.
- Never weaken, skip or delete tests to make them pass. Fix the code, or explain why a test's expectation is wrong.
- When a limitation is removed, update `docs/limitations.md` and `docs/architecture.md` in the same change.
- Keep commits small: one milestone step each.
- Don't push unless asked. Only trace code you trust: the sandbox is best-effort (see limitations).

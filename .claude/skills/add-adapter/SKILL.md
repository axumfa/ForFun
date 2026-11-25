---
name: add-adapter
description: Step-by-step checklist for adding a new data-structure adapter to dsv (scene kind, recognition in nodes.ts/arrays.ts, scene builder, registration order, webview shape, example, tests). Use when adding or extending a structure the visualizer draws.
---

# Adding a data-structure adapter
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

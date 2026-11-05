# Data Structure Visualizer

Visualize **your own C++ implementations** of data structures from their *real execution*. The program is compiled with
`-O0 -g`, run under GDB in a separate process, and every line is recorded: variables, heap allocations, pointer values.
The UI only draws relationships that were observed in memory; it never guesses or replays canned animations.

## Use
1. Open a C++ file, right-click → **Visualize Code** (or run the command from the palette).
2. Pick `main`, a function, or a class. For a function/class, enter the C++ statements to run, e.g.
   `Node* h = nullptr; h = push(h, 3); h = push(h, 4); remove(h, 3);` (a generated `main()` includes your file; yours is not run).
3. Use Play / Pause / Prev / Next / Reset / speed / timeline (keys: ← → Space Home). Click a node to inspect it.

## Recognised structures
Arrays, vectors, singly/doubly linked lists, stacks, queues (list- or array-based), binary trees/BST/AVL/red-black (colour from an enum or
bool field), binary heaps (array/vector named like a heap), hash tables with chaining, graphs (adjacency list/matrix or node with a neighbour
vector), tries, and a generic pointer-graph fallback. Each scene shows a **confidence** and the reason for the classification
(hover). Edges are always observed pointer values; classification is a heuristic.

## Requirements and settings
Linux, `g++`, `gdb` with Python support. Settings under `dsv.*`: compiler, gdb, cppStandard, extraCompilerFlags, timeouts, maxSteps,
maxMemoryMB, isolateNetwork. See `docs/limitations.md` for what is *not* supported (important before relying on it).

## Develop
`npm install && npm run build && npm test` — F5 on `extension/` runs it in an Extension Development Host. Architecture: `docs/architecture.md`.
# ForFun

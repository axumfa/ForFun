[![CI](https://github.com/axumfa/ForFun/actions/workflows/ci.yml/badge.svg)](https://github.com/axumfa/ForFun/actions/workflows/ci.yml)

# Data Structure Visualizer

Visualize **your own C and C++ implementations** of data structures from their *real execution*. The program is compiled with
`-O0 -g`, run under GDB in a separate process, and every line is recorded: variables, heap allocations, pointer values.
The UI only draws relationships that were observed in memory; it never guesses or replays canned animations.

## Install
Linux, or Windows through VS Code's **WSL remote** (WSL 2): the extension runs where your code and compilers are, so on Windows open your folder in WSL (Remote - WSL) and install the extension *in WSL*. macOS is not supported.
1. In Linux/WSL install the tools: `sudo apt install g++ gdb` (Debian/Ubuntu; Fedora: `sudo dnf install gcc-c++ gdb`). `gcc` is needed only for `.c` files.
2. Install the extension: `code --install-extension dsv.vsix` (or Extensions view → "..." → Install from VSIX). If a tool is missing, Visualize Code tells you which one and how to install it.
(Tested on Linux only so far; the WSL path is not yet verified on a real Windows machine.)

## Use
1. Open a `.c` or `.cpp` file, right-click → **Visualize Code** (or run the command from the palette).
2. Pick `main`, a function, or a class. For a function/class, enter the statements to run, e.g.
   `Node* h = nullptr; h = push(h, 3); h = push(h, 4); remove(h, 3);` (C: `Node* h = NULL; ...`; a plain `struct Node` is offered as `struct Node obj = {0};`) (a generated `main()` includes your file; yours is not run).
3. Use Play / Pause / Prev / Next / Reset / speed / timeline (keys: ← → Space Home End, PgUp/PgDn = ±10 steps, [ ] = previous/next step that changed the heap). Click a node to inspect it.

## Recognised structures
Arrays, vectors, singly/doubly linked lists, stacks, queues (list- or array-based), binary trees/BST/AVL/red-black (colour from an enum or
bool field), binary heaps (array/vector named like a heap), hash tables with chaining, graphs (adjacency list/matrix or node with a neighbour
vector, `std::vector<T*>` cells click through to their nodes), tries, STL containers (`map set multimap multiset list deque unordered_*` — a logical view and an internal view: red-black tree, list nodes, bucket chains, deque chunks), smart pointers (`unique_ptr`/`shared_ptr`/`weak_ptr`/`make_shared` are followed like raw pointers), and a generic pointer-graph fallback. Each scene shows a **confidence** and the reason for the classification
(hover). Edges are always observed pointer values; classification is a heuristic.

## What a run covers today
One source file per run: it is compiled on its own, so a program split over several `.c`/`.cpp` files does not link (put the data structure and a `main` in one file, or open the implementation file and pick a function/class to call from a generated `main`). Makefiles and CMake are not used. The program's stdin is empty and it gets no command-line arguments. Only code in the opened file is stepped through; functions defined in included headers run but are not shown line by line.

## Requirements and settings
Linux, `g++` (also builds the allocation shim), `gcc` for C files, `gdb` with Python support. The language comes from the file extension
(`.c` = C; `.cpp .cc .cxx .C` = C++). Heap blocks from `malloc/calloc/realloc/free` and `new/delete` are tracked. Settings under `dsv.*`: compiler, cCompiler,
gdb, cppStandard, cStd (default `c11`), extraCompilerFlags, extraCFlags, timeouts, maxSteps, maxMemoryMB, isolateNetwork, sandbox (`auto`: run the program under bubblewrap when installed: read-only filesystem, no network, `$HOME` hidden). See `docs/limitations.md` for what is *not* supported (important before relying on it).

## Develop
`npm install && npm run build && npm test` — F5 on `extension/` runs it in an Extension Development Host. `npm run trace -- examples/binary-trees/bst.cpp last` traces a file and prints the scenes without VS Code. Architecture: `docs/architecture.md`.

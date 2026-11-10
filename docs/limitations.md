# Limitations and known risks (current)

**Languages**: C (`.c`, `gcc -std=c11`, `-lm` linked) and C++ (`.cpp .cc .cxx .C`, `g++`) are supported; the language is chosen by file extension (case-sensitive: `.C` is C++). Settings: `dsv.cCompiler`, `dsv.cStd`, `dsv.extraCFlags` for C; `dsv.compiler`, `dsv.cppStandard`, `dsv.extraCompilerFlags` for C++.
- The allocation shim is C++ and is always built with `dsv.compiler` (`g++`), even for C programs, so `g++` must be installed. It links `libstdc++` into the traced C program (it logs exactly the program's own allocations; checked).
- **Anonymous nested struct/union members are not read.** Fields of an unnamed member (`struct Item { int kind; union { int i; float f; }; }`: `i` and `f`) are skipped, so values and pointers stored there do not appear. A *named* member of an anonymous type (`struct { int x, y; } pos;`) is read, but its type is shown as `struct {...}`.
- C type names are canonical: a struct with a tag is shown by its tag however it is spelled (`struct Node`, `Node`, a typedef of it); an anonymous `typedef struct {...} Name;` is shown as `Name`.

**Platform**: Linux only (GDB + `LD_PRELOAD`). macOS/Windows return an explicit error. An LLDB backend behind `DebuggerBackend` is future work;
LLDB/Clang were not installed here and nothing was tested with them.

**Tracing**
- Heap objects come from the glibc malloc family (`malloc`, `calloc`, `realloc`, `reallocarray`, `free`, `memalign`, `aligned_alloc`, `posix_memalign`; `operator new/delete` go through it), logged by the `LD_PRELOAD` shim. Requires glibc (the shim calls `__libc_*`). Only the root process is logged: forked and exec'd children are not. Not tracked: `mmap`-based allocators, custom arenas, `unique_ptr` internals' *types*, stack objects. `realloc` is one record (`R old new size`); the tracer keeps the learned type of the block whether it grew in place or moved. A moved-from block is reported freed, like `free()` (drawn as a dashed ghost only while a pointer still refers to it).
  Allocations made before `main` (e.g. by global constructors) are kept on purpose: they are user data. Only blocks whose type was learned from a typed pointer are drawn or counted in findings, so untyped runtime buffers (such as stdio's) never show up.
  Smart pointers appear as plain structs. `std::vector` and `std::string` have their own readers (below: other containers).
- **STL containers (M8, logical view)**: `std::map multimap set multiset list` (node walk, validated), `std::deque unordered_map unordered_multimap unordered_set unordered_multiset` (GDB's libstdc++ pretty-printer). Shown as a sequence of elements in iteration order; `unordered_*` also show `bucket_count`. Their internal structure is **not** drawn yet (no red-black/list/bucket picture) and `deque` / `unordered_*` never will be in M8.
  - At most 200 entries per container per step are read (`DSV_MAX_STL_ELEMS`); the true `size()` is kept and the drawing ends with a "+N more" box. Elements are consumed lazily, never the whole container.
  - **The node walk requires the default `std::allocator`.** `pmr`/custom allocators fall back to the pretty-printer: contents are right but entries are identified by key (map/set) or position (list) instead of node address, so insertions animate less well.
  - **The node layout was checked only against** libstdc++ 6.0.36 (GCC 16.2.1, Fedora 45) with GDB 18.1; Ubuntu `ubuntu-latest` is exercised by CI only. Offsets come from DWARF, not constants; if a field is missing or any check fails (node not a live allocation, links disagree, count != `size()`, walk disagrees with the printer on the first entries) the container silently drops to the printer and says why in `internalError`.
  - Without the libstdc++ printers (not auto-loaded and no `/usr/share/gcc*/python/libstdcxx`): map/set/list still work (node walk, no cross-check); deque and `unordered_*` show an explicit "pretty-printers are not available" note and the raw text. libc++ and MSVC containers are not supported (Linux + libstdc++ only).
  - Pointers *inside* elements are shown as addresses (the pointee is still tracked and drawn by its own adapter); no edges are drawn from a container element to it. Libstdc++ iterators (`it`, a range-for's `__begin`) are shown as text, not followed.
  - A container that is not constructed yet (declaration not executed) or already destroyed reads as "contents not readable" rather than garbage.
- Builds are forced to `-O0 -g -fno-inline`. Optimised or inlined code is not supported.
- A `step` that never returns (a loop whose whole body is on one line and never changes line) is interrupted by a watchdog after
  `DSV_STALL_SECONDS` (3s) and reported as `stalled`; the trace up to that point is kept.
- Reads are per line, not per write: if a line modifies the same field twice, only the net change is seen.
- Objects reachable from stack pointers are discovered when first seen through a typed pointer; an allocation that is never referenced by a
  typed pointer (e.g. only through `void*`) is not drawn. Pointer-typed values pointing at *garbage that happens to fall in a live allocation*
  are reported as pointing there (that is what memory contains).
- Cost: roughly 5-20 ms per step; the default cap is 20000 steps (`dsv.maxSteps`). The whole trace is held in memory and sent to the webview.

**Recognition** is heuristic (field names, field types, observed back-links). Unusual designs (sentinel nodes, arrays-as-trees with unusual names,
intrusive lists) may be classified as `generic` or with low confidence. Heap vs. array detection uses names (`heap`, `queue`, `stack`, `hash`, `graph`).
Index markers on arrays are integer variables with index-like names.

**Security**: user code is compiled and run. Protections: separate process group, wall-clock timeout, CPU `ulimit -t`, address-space `ulimit -v`
(`dsv.maxMemoryMB`), output caps, step cap, and a new network namespace when `unshare -r -n` works (probed at startup). This is **not a sandbox**:
the program can still read/write files as your user. Only trace code you trust. Stronger isolation (bubblewrap/containers) is future work.

**Analysis**: static complexity estimates are regex-level and labelled as estimates. Findings (leak, dangling, crash) come from the recorded run only.
No LLM is used; `ExplanationProvider` is the extension point, and providers receive only recorded facts.

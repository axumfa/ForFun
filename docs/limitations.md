# Limitations and known risks (current)

**Platform**: Linux only (GDB + `LD_PRELOAD`). macOS/Windows return an explicit error. An LLDB backend behind `DebuggerBackend` is future work;
LLDB/Clang were not installed here and nothing was tested with them.

**Tracing**
- Heap objects come from the glibc malloc family (`malloc`, `calloc`, `realloc`, `reallocarray`, `free`, `memalign`, `aligned_alloc`, `posix_memalign`; `operator new/delete` go through it), logged by the `LD_PRELOAD` shim. Requires glibc (the shim calls `__libc_*`). Only the root process is logged: forked and exec'd children are not. Not tracked: `mmap`-based allocators, custom arenas, `unique_ptr` internals' *types*, stack objects. An in-place `realloc` is logged as a resize (a second `A` at a live address); the tracer forgets the learned type of that block until a typed pointer reaches it again.
  Allocations made before `main` (e.g. by global constructors) are kept on purpose: they are user data. Only blocks whose type was learned from a typed pointer are drawn or counted in findings, so untyped runtime buffers (such as stdio's) never show up.
  Smart pointers appear as plain structs. STL containers other than `std::vector` and `std::string` are shown as raw text.
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

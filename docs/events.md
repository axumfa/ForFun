# Trace schema v4
Source of truth: `core/events/types.ts` (`SCHEMA_VERSION = 4`). The engine writes JSONL, every record carries `"schema": 4`; `parseTrace` rejects
other versions and unknown kinds (a truncated *last* line, from a killed run, is tolerated).

## Records
- `step`: `{step, fn, file: "main"|"driver", line, depth, frames[], events[]}` — state observed *before* `line` executes.
  `events` are the effects of the **previous** step's line (`History` exposes that line as `cause`).
- `end`: `{reason: exited|step_limit|error|crashed|stalled|timeout, exitCode, message?, signal?, line?, doubleFrees?}` — always last
  (synthesised as `timeout` by the runner if the process was killed).

## Globals
Variables with static storage declared in the user's source (file scope, `static`; not library globals) are carried as the **last** (outermost) frame of every step: `{fn: "(globals)", file: "main", line: 0, locals}`, in declaration order (`GLOBALS_FN` in `core/events/types.ts`). It is not a call frame: `depth` excludes it. Changes to a global appear as `local_changed` events. Function-local `static` variables are ordinary locals of their function. Added within schema v4 (older v4 traces simply lack the frame).

## Frame deltas (v4)
On the wire a frame may be a delta against the frame at the same depth *counted from the outermost* frame in the previous step (same `fn` and `file`):
`{fn, file, line, d: 1, locals: {only new or changed}, keys?: [all names in order, present only when the set/order changed]}`. A container-valued local
(array/vector/struct/stl) that changed is sent as a structural patch when that is smaller: `{$o: {key|index: value-or-patch}, $l?: newLength, $x?: [removedKeys]}`
(`$` cannot occur in a C++ identifier, so a patch is never confused with a value; anything without `$o`/`$l` replaces the old value). `parseTrace` expands every
step to full frames (`expandFrames`/`applyPatch` in `core/events/types.ts`), sharing unchanged values by reference, so `History`, the adapters and the webview only
ever see full frames. `DSV_NO_DELTA=1` makes the tracer write full frames (used by a differential test). Effect: the 1000-element `std::map` benchmark went 8.4 MB -> 0.8 MB.
`events` (heap changes) were already diffs and are unchanged.

## Values
`number | string | boolean | null | PointerValue | ArrayValue | StructValue | StlValue`
- `PointerValue {ptr, to?, kind: null|object|freed|unresolved, obj?, offset?, str?}` (`str`: the text a `char*` points at) — `to` is the static pointee type. Only `kind: object` (exact
  base address, `offset` 0) is a graph edge. `unresolved` = stack/global/garbage, never drawn as a relationship.
- `ArrayValue {kind: array|vector, elemType, elems, capacity?, released?, addr?}` — `released` = storage already freed, contents not read.
- `StructValue {kind: struct, type, fields, addr?}`.
- `StlValue {kind: stl, container, type, size, truncated, entries[], source, addr?, keyType?, valType?, bucketCount?, internal?, internalError?, text?, unavailable?}`
  (v3). `container` is one of map, multimap, set, multiset, unordered_{map,multimap,set,multiset}, list, deque. `entries[i] = {id?, key?, value, n?}` in
  iteration order, at most `DSV_MAX_STL_ELEMS` (200) per container per step; `size` is always the true size (-1 = unknown) and `truncated` says entries were cut.
  `source`: `walk` (map/set/list: the tracer walked the nodes and validated them; `id` = node address; `internal` is set unless truncated or invalid),
  `printer` (read lazily through libstdc++'s GDB pretty-printer; no ids), `raw` (neither: only `text` and `unavailable`).
  `n = [color 0 red | 1 black, parent, left, right]` are *indices into `entries`* (-1 none, -2 the header), present only when the whole red-black tree was walked and
  every link cross-checked. `internal` is `{kind: rb, header, root}`, `{kind: list, header}` `{kind: hash, buckets}` or `{kind: deque, chunk, offset, chunks}` (`chunk` = elements per chunk, `offset` = slot of the first element in `chunks[0]`, `chunks` = chunk addresses; entry `id` = element address; `buckets[j]` = index into `entries` of bucket j's first node, -1 = empty; entries are in node-chain order and carry node `id`s; for `unordered_*` `source` is `walk` although the values come from the printer), otherwise `null` with `internalError` (custom allocator, layout mismatch,
  more than the cap, ...). A `list`'s links are implicit in the entry order.
- Enums are strings (`"RED"`), bools are booleans.

## Events
`object_created {addr, obj_type, size, fields?|elems?}`, `object_freed {addr}`, `field_changed {addr, field, old, new}`,
`elem_changed {addr, index, old, new}`, `local_changed {var, old, new}` (an `StlValue` in `old`/`new` is slimmed to its summary: `entries: []`).
Freed objects keep their last known contents in `History` (shown dashed, only while something still points at them).

## Versioning
Breaking changes bump `SCHEMA_VERSION`; there is no silent compatibility. v1-v3 traces are rejected (v3 added the `StlValue` variant, v4 the frame deltas).

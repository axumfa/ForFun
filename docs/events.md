# Trace schema v3
Source of truth: `core/events/types.ts` (`SCHEMA_VERSION = 3`). The engine writes JSONL, every record carries `"schema": 3`; `parseTrace` rejects
other versions and unknown kinds (a truncated *last* line, from a killed run, is tolerated).

## Records
- `step`: `{step, fn, file: "main"|"driver", line, depth, frames[], events[]}` — state observed *before* `line` executes.
  `events` are the effects of the **previous** step's line (`History` exposes that line as `cause`).
- `end`: `{reason: exited|step_limit|error|crashed|stalled|timeout, exitCode, message?, signal?, line?, doubleFrees?}` — always last
  (synthesised as `timeout` by the runner if the process was killed).

## Values
`number | string | boolean | null | PointerValue | ArrayValue | StructValue | StlValue`
- `PointerValue {ptr, to?, kind: null|object|freed|unresolved, obj?, offset?}` — `to` is the static pointee type. Only `kind: object` (exact
  base address, `offset` 0) is a graph edge. `unresolved` = stack/global/garbage, never drawn as a relationship.
- `ArrayValue {kind: array|vector, elemType, elems, capacity?, released?, addr?}` — `released` = storage already freed, contents not read.
- `StructValue {kind: struct, type, fields, addr?}`.
- `StlValue {kind: stl, container, type, size, truncated, entries[], source, addr?, keyType?, valType?, bucketCount?, internal?, internalError?, text?, unavailable?}`
  (v3). `container` is one of map, multimap, set, multiset, unordered_{map,multimap,set,multiset}, list, deque. `entries[i] = {id?, key?, value, n?}` in
  iteration order, at most `DSV_MAX_STL_ELEMS` (200) per container per step; `size` is always the true size (-1 = unknown) and `truncated` says entries were cut.
  `source`: `walk` (map/set/list: the tracer walked the nodes and validated them; `id` = node address; `internal` is set unless truncated or invalid),
  `printer` (read lazily through libstdc++'s GDB pretty-printer; no ids), `raw` (neither: only `text` and `unavailable`).
  `n = [color 0 red | 1 black, parent, left, right]` are *indices into `entries`* (-1 none, -2 the header), present only when the whole red-black tree was walked and
  every link cross-checked. `internal` is `{kind: rb, header, root}` or `{kind: list, header}`, otherwise `null` with `internalError` (custom allocator, layout mismatch,
  more than the cap, ...). A `list`'s links are implicit in the entry order.
- Enums are strings (`"RED"`), bools are booleans.

## Events
`object_created {addr, obj_type, size, fields?|elems?}`, `object_freed {addr}`, `field_changed {addr, field, old, new}`,
`elem_changed {addr, index, old, new}`, `local_changed {var, old, new}` (an `StlValue` in `old`/`new` is slimmed to its summary: `entries: []`).
Freed objects keep their last known contents in `History` (shown dashed, only while something still points at them).

## Versioning
Breaking changes bump `SCHEMA_VERSION`; there is no silent compatibility. v1 and v2 traces are rejected (v3 added the `StlValue` variant).

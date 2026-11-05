# Trace schema v2
Source of truth: `core/events/types.ts` (`SCHEMA_VERSION = 2`). The engine writes JSONL, every record carries `"schema": 2`; `parseTrace` rejects
other versions and unknown kinds (a truncated *last* line, from a killed run, is tolerated).

## Records
- `step`: `{step, fn, file: "main"|"driver", line, depth, frames[], events[]}` — state observed *before* `line` executes.
  `events` are the effects of the **previous** step's line (`History` exposes that line as `cause`).
- `end`: `{reason: exited|step_limit|error|crashed|stalled|timeout, exitCode, message?, signal?, line?, doubleFrees?}` — always last
  (synthesised as `timeout` by the runner if the process was killed).

## Values
`number | string | boolean | null | PointerValue | ArrayValue | StructValue`
- `PointerValue {ptr, to?, kind: null|object|freed|unresolved, obj?, offset?}` — `to` is the static pointee type. Only `kind: object` (exact
  base address, `offset` 0) is a graph edge. `unresolved` = stack/global/garbage, never drawn as a relationship.
- `ArrayValue {kind: array|vector, elemType, elems, capacity?, released?, addr?}` — `released` = storage already freed, contents not read.
- `StructValue {kind: struct, type, fields, addr?}`.
- Enums are strings (`"RED"`), bools are booleans.

## Events
`object_created {addr, obj_type, size, fields?|elems?}`, `object_freed {addr}`, `field_changed {addr, field, old, new}`,
`elem_changed {addr, index, old, new}`, `local_changed {var, old, new}`.
Freed objects keep their last known contents in `History` (shown dashed, only while something still points at them).

## Versioning
Breaking changes bump `SCHEMA_VERSION`; there is no silent compatibility. v1 (milestone 1) traces are rejected.

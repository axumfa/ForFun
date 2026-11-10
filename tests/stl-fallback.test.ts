// DSV_NO_PRINTERS=1 makes the tracer behave as if libstdc++'s GDB pretty-printers did not exist, so the fallback tiers
// (node walk for map/set/list, raw text + explicit notice for deque/unordered_*) are tested on every machine, not only where printers are missing.
process.env.DSV_NO_PRINTERS = "1";
import test from "node:test";
import assert from "node:assert/strict";
const { load, scenesAt, stlItems, finalStep } = await import("./helpers.ts");
const { collectStl } = await import("../core/adapters/stl.ts");

const printed = (o: string) => o.trim().split(/\s+/);

test("without printers: map/set/list are still read by the validated node walk (same entries, node ids)", async () => {
  for (const [f, kind] of [["map", "map"], ["set", "set"], ["list", "sequence"]] as const) {
    const l = await load(`stl/${f}.cpp`);
    const sc = scenesAt(l, finalStep(l)).scenes.find((s) => s.kind === kind)!;
    assert.ok(sc, f);
    const expect = printed(l.output).map((p) => p.replace(":", "="));
    assert.deepEqual(stlItems(sc), expect, f);
    assert.equal(collectStl(l.history.stateAt(finalStep(l)))[0]!.v.source, "walk");
  }
});

test("without printers: deque / unordered_map say so explicitly instead of drawing wrong data", async () => {
  for (const f of ["deque", "unordered_map"]) {
    const l = await load(`stl/${f}.cpp`);
    const sc = scenesAt(l, finalStep(l)).scenes.find((s) => s.title.includes(`std::${f}`))!;
    assert.ok(sc, f);
    assert.equal(sc.nodes.length, 0);
    assert.ok(sc.notes.some((n) => /pretty-printers are not available/.test(n)), f);
    assert.equal(collectStl(l.history.stateAt(finalStep(l)))[0]!.v.source, "raw");
  }
});

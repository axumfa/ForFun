/** CLI: trace a program and print what the viewer would draw. `npm run trace -- <file.cpp|file.c> [step|last] [--json]`. Only trace code you trust. */
import * as path from "node:path";
import { runTrace } from "../extension/src/execution/runner.ts";
import { History } from "../core/snapshots/history.ts";
import { interpret } from "../core/adapters/index.ts";
import { cfg } from "../tests/helpers.ts";

const args = process.argv.slice(2), json = args.includes("--json"), pos = args.filter((a) => !a.startsWith("--"));
const [file, at] = pos;
if (!file) { console.error("usage: npm run trace -- <file.cpp|file.c> [step|last] [--json]"); process.exit(2); }
const r = await runTrace(path.resolve(file), cfg);
const h = new History(r.trace), n = h.length, i = at === undefined ? -1 : at === "last" ? n - 2 : Number(at);
if (i < 0) { console.log(`${n} steps, end: ${r.trace.end?.reason ?? "?"}\n--- program output\n${r.programOutput}`); process.exit(0); }
if (!(i >= 0 && i < n)) { console.error(`step ${i} out of range 0..${n - 1}`); process.exit(2); }
const st = h.stateAt(i), res = interpret(st, undefined);
if (json) { console.log(JSON.stringify(res.scenes, null, 1)); process.exit(0); }
console.log(`step ${i}/${n - 1} line ${h.steps[i]!.line} in ${h.steps[i]!.fn}`);
for (const s of res.scenes) {
  console.log(`\n[${s.kind}] ${s.title} (confidence ${s.confidence}): ${s.nodes.length} nodes, ${s.edges.length} edges`);
  for (const e of s.edges) console.log(`  ${e.from} -${e.kind}-> ${e.to}`);
  for (const p of s.pointers) console.log(`  ptr ${p.name} => ${p.target ?? "null"}`);
}

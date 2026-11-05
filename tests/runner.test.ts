import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runTrace, RunnerError, type RunnerConfig } from "../extension/src/execution/runner.ts";

const root = path.resolve(import.meta.dirname, "..");
const cfg: RunnerConfig = { engineDir: path.join(root, "engine"), compiler: "g++", gdb: "gdb", std: "c++17", extraFlags: [],
  compileTimeoutMs: 30000, runTimeoutMs: 30000, maxSteps: 20000, maxOutputBytes: 1 << 20, maxMemoryMB: 0, isolateNetwork: false };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dsvt-"));
const src = (name: string, code: string) => { const p = path.join(tmp, name); fs.writeFileSync(p, code); return p; };

test("linked list: real pointer changes are recorded", async () => {
  const { trace } = await runTrace(path.join(root, "examples/linked-lists/list.cpp"), cfg);
  assert.equal(trace.end?.reason, "exited");
  assert.equal(trace.end?.exitCode, 0);
  const ev = trace.steps.flatMap((s) => s.events);
  assert.equal(ev.filter((e) => e.type === "object_created").length, 3);
  assert.equal(ev.filter((e) => e.type === "object_freed").length, 1);
  // Final relink: node(1).next must now point at node(3) (the object the 3rd push created first).
  const created = ev.filter((e) => e.type === "object_created").map((e) => e.addr);
  const relink = ev.filter((e) => e.type === "field_changed" && e.field === "next").at(-1);
  assert.ok(relink && relink.type === "field_changed");
  assert.equal(relink.addr, created[2]);
  assert.deepEqual((relink.new as { obj?: string }).obj, created[0]);
  // freed node is the middle one
  assert.equal(ev.find((e) => e.type === "object_freed")?.addr, created[1]);
});

test("null pointers and empty structure: no phantom edges", async () => {
  const p = src("null.cpp", "struct N{int v;N*next;};\nint main(){\n N* h=nullptr;\n N* g=h;\n return g?1:0;\n}\n");
  const { trace } = await runTrace(p, cfg);
  assert.equal(trace.end?.exitCode, 0);
  for (const e of trace.steps.flatMap((s) => s.events)) assert.notEqual(e.type, "object_created");
  const objectPtrs = trace.steps.flatMap((s) => s.frames.flatMap((f) => Object.values(f.locals)))
    .filter((v) => typeof v === "object" && v !== null && v.kind === "object");
  assert.equal(objectPtrs.length, 0);
});

test("program stdout is captured", async () => {
  const p = src("out.cpp", '#include <cstdio>\nint main(){ std::puts("hello"); return 3; }\n');
  const r = await runTrace(p, cfg);
  assert.match(r.programOutput, /hello/);
  assert.equal(r.trace.end?.exitCode, 3);
});

test("compile errors are reported, not swallowed", async () => {
  await assert.rejects(runTrace(src("bad.cpp", "int main(){ return x; }"), cfg), (e: Error) => e instanceof RunnerError && /compilation failed/.test(e.message));
});

test("infinite loop hits step limit", async () => {
  const p = src("loop.cpp", "int main(){\n int i=0;\n while(i>=0){\n  i++;\n }\n}\n");
  const { trace } = await runTrace(p, { ...cfg, maxSteps: 200 });
  assert.equal(trace.end?.reason, "step_limit");
  assert.equal(trace.steps.length, 200);
});

test("one-line infinite loop is stopped by the stall watchdog, with a partial trace", async () => {
  const p = src("hang.cpp", "int main(){ int i=0; while(true){ i++; } }");
  const { trace } = await runTrace(p, { ...cfg, maxSteps: 10_000_000 }, os.tmpdir());
  assert.equal(trace.end?.reason, "stalled");
  assert.ok(trace.steps.length >= 1);
});

test("wall-clock timeout returns the partial trace instead of failing", async () => {
  const p = src("slow.cpp", "int main(){\n int i=0;\n while(i>=0){\n  i++;\n }\n}\n");
  const { trace } = await runTrace(p, { ...cfg, maxSteps: 10_000_000, runTimeoutMs: 3000 });
  assert.equal(trace.end?.reason, "timeout");
  assert.ok(trace.steps.length > 10);
});

test("null dereference is reported as a crash at the faulting line", async () => {
  const p = src("crash.cpp", "struct N{int v;};\nint main(){\n N* p=nullptr;\n p->v = 1;\n return 0;\n}\n");
  const { trace } = await runTrace(p, cfg);
  assert.equal(trace.end?.reason, "crashed");
  assert.equal(trace.end?.signal, "SIGSEGV");
  assert.equal(trace.end?.line, 4);
});

test("arrays, vectors and struct values are read from memory", async () => {
  const p = src("vals.cpp", "#include <vector>\nstruct P{int x;int y;};\nint main(){\n int a[3]={1,2,3};\n std::vector<int> v;\n v.push_back(7); v.push_back(8);\n P q{4,5};\n a[1]=9;\n return 0;\n}\n");
  const { trace } = await runTrace(p, cfg);
  const at9 = trace.steps.find((x) => x.line === 9)!;
  const last = at9.frames[0]!.locals as Record<string, any>;
  const fin = trace.steps.at(-1)!.frames[0]!.locals as Record<string, any>;
  assert.equal(fin.v.released, true);          // destroyed vector: storage is not read
  assert.deepEqual(last.a.elems, [1, 9, 3]);
  assert.deepEqual(last.v.elems, [7, 8]);
  assert.deepEqual(last.q.fields, { x: 4, y: 5 });
});

test("driver mode runs a chosen snippet against the user's file; main() is not run", async () => {
  const p = src("lib.cpp", 'struct N{int v;N*next;};\nN* push(N* h,int v){ return new N{v,h}; }\nint main(){ return 42; }\n');
  const r = await runTrace(p, { ...cfg, entry: { setup: "N* h=nullptr;\nh=push(h,1);\nh=push(h,2);" } });
  assert.equal(r.trace.end?.exitCode, 0);
  assert.ok(r.trace.steps.some((s) => s.file === "driver"));
  assert.ok(r.trace.steps.some((s) => s.file === "main" && s.fn === "push"));
  assert.equal(r.trace.steps.flatMap((s) => s.events).filter((e) => e.type === "object_created").length, 2);
  assert.ok(r.sources.driver?.includes("__dsv_user_main"));
});

test("memory limit turns a huge allocation into a reported failure, not a hang", async () => {
  const p = src("mem.cpp", "#include <cstdlib>\n#include <cstring>\nint main(){\n char* p=(char*)malloc(3000000000ull);\n if(p) memset(p,1,3000000000ull);\n return p?0:7;\n}\n");
  const { trace } = await runTrace(p, { ...cfg, maxMemoryMB: 1500 });
  assert.ok(trace.end?.reason === "exited" && trace.end.exitCode === 7 || trace.end?.reason === "crashed", JSON.stringify(trace.end));
});

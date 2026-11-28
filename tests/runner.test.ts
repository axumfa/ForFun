import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runTrace, RunnerError, unsupportedPlatformMessage, resolveStdinFile, type RunnerConfig } from "../extension/src/execution/runner.ts";

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

test("a missing compiler or debugger is named, with an install hint and the setting to change (not 'compilation failed: sh: exec: ... not found')", async () => {
  const cpp = src("ok.cpp", "int main(){ return 0; }"), c = src("ok.c", "int main(void){ return 0; }");
  const msg = async (p: string, c2: Partial<RunnerConfig>) => { try { await runTrace(p, { ...cfg, ...c2 }); return "no error"; } catch (e) { return (e as Error).message; } };
  for (const [m, what, setting] of [[await msg(cpp, { compiler: "dsv-no-such-g++" }), "dsv-no-such-g++", "dsv.compiler"], [await msg(cpp, { gdb: "/no/such/gdb" }), "/no/such/gdb", "dsv.gdb"],
    [await msg(c, { cCompiler: "dsv-no-such-gcc" }), "dsv-no-such-gcc", "dsv.cCompiler"]] as const) {
    assert.match(m, /not found/, m); assert.ok(m.includes(what), m); assert.match(m, /apt install/, m); assert.ok(m.includes(`"${setting}"`), m);
    assert.doesNotMatch(m, /compilation failed|debugger produced no trace/, m);
  }
});

test("the unsupported-platform message tells a Windows user to use the WSL remote", () => {
  assert.match(unsupportedPlatformMessage("win32"), /WSL/);
  assert.match(unsupportedPlatformMessage("darwin"), /Linux only/);
  assert.doesNotMatch(unsupportedPlatformMessage("darwin"), /WSL/);
});

const ARGV_SRC = `#include <cstdio>
int main(int argc, char** argv) { std::printf("argc=%d\\n", argc); for (int i = 1; i < argc; i++) std::printf("[%s]\\n", argv[i]); return 0; }
`;
const SUM_SRC = `#include <cstdio>
int main() { int n = 0, x = 0, s = 0; if (std::scanf("%d", &n) != 1) { std::printf("no input\\n"); return 1; } for (int i = 0; i < n; i++) { std::scanf("%d", &x); s += x; } std::printf("sum=%d\\n", s); return 0; }
`;

test("dsv.args reach main's argv literally (spaces, $VARS, quotes are not interpreted by a shell)", async () => {
  const args = ["hello world", "$HOME", "it's", '"q"', "a;b", "*"];
  const r = await runTrace(src("argv.cpp", ARGV_SRC), { ...cfg, args });
  assert.equal(r.programOutput, `argc=${args.length + 1}\n` + args.map((a) => `[${a}]\n`).join(""));
  assert.equal((await runTrace(src("argv0.cpp", ARGV_SRC), cfg)).programOutput, "argc=1\n", "no args by default");
});

test("dsv.stdin / dsv.stdinFile feed the program's stdin; the default is an empty stdin (EOF)", async () => {
  const f = src("sum.cpp", SUM_SRC);
  assert.equal((await runTrace(f, cfg)).programOutput, "no input\n");
  assert.equal((await runTrace(f, { ...cfg, stdin: "3\n10 20 30\n" })).programOutput, "sum=60\n");
  const inFile = src("in.txt", "2\n5 6\n");
  assert.equal((await runTrace(f, { ...cfg, stdinFile: inFile })).programOutput, "sum=11\n");
  assert.equal((await runTrace(f, { ...cfg, stdin: "1\n99\n", stdinFile: inFile })).programOutput, "sum=11\n", "the file wins over the inline text");
  await assert.rejects(runTrace(f, { ...cfg, stdinFile: path.join(tmp, "missing.txt") }), (e: Error) => e instanceof RunnerError && /stdin file/.test(e.message));
});

test("resolveStdinFile: blank = none, absolute as is, relative to the visualized file's folder", () => {
  assert.equal(resolveStdinFile("", "/w/a/main.cpp"), undefined); assert.equal(resolveStdinFile("  ", "/w/a/main.cpp"), undefined);
  assert.equal(resolveStdinFile("/in/x.txt", "/w/a/main.cpp"), "/in/x.txt"); assert.equal(resolveStdinFile("data/in.txt", "/w/a/main.cpp"), "/w/a/data/in.txt");
});

test("stdin and args also work inside the bubblewrap sandbox", { skip: !sandboxAvailable && "bwrap not usable here" }, async () => {
  const r = await runTrace(src("sum_sb.cpp", SUM_SRC), { ...cfg, sandbox: "auto", stdin: "2\n7 8\n" });
  assert.equal(r.sandbox, "bwrap"); assert.equal(r.programOutput, "sum=15\n");
  assert.equal((await runTrace(src("argv_sb.cpp", ARGV_SRC), { ...cfg, sandbox: "auto", args: ["x y"] })).programOutput, "argc=2\n[x y]\n");
});

test("stdin and args also reach a program run through the function/class driver", async () => {
  const f = src("drv.cpp", `#include <cstdio>
int total() { int n = 0, s = 0; std::scanf("%d", &n); s += n; return s; }
`);
  const r = await runTrace(f, { ...cfg, stdin: "41\n", entry: { setup: 'int t = total(); std::printf("t=%d\\n", t);' } });
  assert.equal(r.programOutput, "t=41\n");
});

test("args with control characters are refused (they would be extra gdb commands); so is an oversized stdin", async () => {
  const f = src("argv2.cpp", ARGV_SRC);
  for (const bad of ["a\nshell id", "a\rb", "a\0b"]) await assert.rejects(runTrace(f, { ...cfg, args: [bad] }), (e: Error) => e instanceof RunnerError && /control character/.test(e.message));
  await assert.rejects(runTrace(f, { ...cfg, stdin: "x".repeat((1 << 20) + 1) }), (e: Error) => e instanceof RunnerError && /stdin is larger/.test(e.message));
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

// ---- sandbox (bubblewrap) ----------------------------------------------------------------------------------------------------------------
import { sandboxAvailable, bwrapArgs } from "../extension/src/execution/runner.ts";
import * as net from "node:net";

const HOSTILE = (target: string, home: string) => `
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <unistd.h>
int main() {
  int a = 0, b = 0, c = 0, d = 0;
  FILE* f = std::fopen("${target}", "w");            // write outside the work directory
  if (f) { std::fputs("x", f); std::fclose(f); a = 1; }
  FILE* g = std::fopen("${home}/.dsv-secret", "r");   // read a file in $HOME
  if (g) { std::fclose(g); b = 1; }
  int s = socket(AF_INET, SOCK_STREAM, 0);            // reach a listener on loopback
  sockaddr_in sa; std::memset(&sa, 0, sizeof sa); sa.sin_family = AF_INET; sa.sin_port = htons(PORT); inet_pton(AF_INET, "127.0.0.1", &sa.sin_addr);
  if (s >= 0 && connect(s, (sockaddr*)&sa, sizeof sa) == 0) c = 1;
  FILE* t = std::fopen("/tmp/dsv-sandbox-leak", "w");   // private /tmp
  if (t) { std::fclose(t); d = 1; }
  std::printf("%d %d %d %d\\n", a, b, c, d);
  return 0;
}`;

test("sandbox: writes outside the work dir, $HOME reads and the network are blocked; the trace is still complete", { skip: !sandboxAvailable && "bwrap not usable here" }, async () => {
  const home = process.env.HOME!, secret = path.join(home, ".dsv-secret"), outside = path.join(os.tmpdir(), "dsv-outside-" + process.pid), leak = "/tmp/dsv-sandbox-leak";
  const server = net.createServer().listen(0, "127.0.0.1"); await new Promise((r) => server.once("listening", r));
  const port = (server.address() as net.AddressInfo).port;
  fs.writeFileSync(secret, "secret"); fs.rmSync(leak, { force: true });
  try {
    const file = src("hostile.cpp", HOSTILE(outside, home).replace("htons(PORT)", `htons(${port})`));
    const open = await runTrace(file, { ...cfg, sandbox: "off" });
    assert.equal(open.sandbox, "none"); assert.equal(open.programOutput.trim(), "1 1 1 1", "control: without the sandbox the hostile program succeeds at all four");
    fs.rmSync(outside, { force: true }); fs.rmSync(leak, { force: true });
    const boxed = await runTrace(file, { ...cfg, sandbox: "auto" });
    assert.equal(boxed.sandbox, "bwrap");
    assert.equal(boxed.trace.end?.reason, "exited");
    assert.equal(boxed.programOutput.trim(), "1 0 0 1", "writes anywhere succeed only in private places; $HOME file and the network are unreachable");
    assert.ok(!fs.existsSync(outside) && !fs.existsSync(leak), "nothing escaped to the real /tmp");
  } finally { server.close(); fs.rmSync(secret, { force: true }); fs.rmSync(outside, { force: true }); fs.rmSync(leak, { force: true }); }
});

test("sandbox: a normal example traces identically inside and outside it", { skip: !sandboxAvailable && "bwrap not usable here" }, async () => {
  const f = path.join(root, "examples/stl/map.cpp");
  process.env.DSV_NO_DELTA = "0";
  try {
    const a = await runTrace(f, { ...cfg, sandbox: "off" }), b = await runTrace(f, { ...cfg, sandbox: "auto" });
    assert.equal(b.sandbox, "bwrap"); assert.equal(a.programOutput, b.programOutput);
    assert.equal(a.trace.steps.length, b.trace.steps.length);
    assert.deepEqual(a.trace.steps.map((s) => [s.fn, s.line, s.events.length]), b.trace.steps.map((s) => [s.fn, s.line, s.events.length]));
  } finally { delete process.env.DSV_NO_DELTA; }
});

test("bwrapArgs: work dir is the only writable bind; allowRead dirs are read-only; no network/pid/ipc sharing", () => {
  const a = bwrapArgs("/tmp/dsv-x", [root]);
  assert.ok(a.includes("--unshare-all") && a.includes("--die-with-parent"));
  const binds = a.flatMap((x, i) => (x === "--bind" ? [a[i + 1]] : []));
  assert.deepEqual(binds, ["/tmp/dsv-x"]);
  assert.ok(a.some((x, i) => x === "--ro-bind" && a[i + 1] === "/") && a.some((x, i) => x === "--ro-bind" && a[i + 1] === root));
});

test("sandbox: the source file stays readable even when it sits directly in the (privatised) /tmp", { skip: !sandboxAvailable && "bwrap not usable here" }, async () => {
  const f = src("selfread.cpp", `#include <cstdio>\nint main() { FILE* f = std::fopen(__FILE__, "r"); std::printf("%d\\n", f != nullptr); return 0; }\n`);
  assert.equal(path.dirname(f).startsWith(os.tmpdir()), true);
  const r = await runTrace(f, { ...cfg, sandbox: "auto" });
  assert.equal(r.sandbox, "bwrap"); assert.equal(r.programOutput.trim(), "1");
});

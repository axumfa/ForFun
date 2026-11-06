import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { root } from "./helpers.ts";

/** These tests drive the LD_PRELOAD shim directly (no gdb): compile a small C program, run it, read the alloc log it produced.
 *  Programs report pointers with write(2) so libc adds no allocations of its own and the log can be compared exactly. */
const work = fs.mkdtempSync(path.join(os.tmpdir(), "dsv-shimtest-"));
const shimSo = path.join(work, "libshim.so");
const built = spawnSync("g++", ["-std=c++17", "-O1", "-shared", "-fPIC", "-o", shimSo, path.join(root, "engine", "runtime", "shim.cpp")], { encoding: "utf8" });
assert.equal(built.status, 0, built.stderr);

const PRE = `#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
#include <malloc.h>
#include <errno.h>
#include <sys/wait.h>
static void out(const char* t, void* p) { char b[64]; int n = snprintf(b, sizeof b, "%s %lx\\n", t, (unsigned long)p); write(1, b, n); }
`;
let seq = 0;
function run(body: string, lang: "c" | "c++" = "c"): { ptrs: Record<string, string>; log: string[] } {
  const id = ++seq, src = path.join(work, `t${id}.${lang === "c" ? "c" : "cpp"}`), exe = path.join(work, `t${id}`), logf = path.join(work, `t${id}.log`);
  fs.writeFileSync(src, PRE + body);
  const c = spawnSync(lang === "c" ? "gcc" : "g++", ["-O0", "-w", "-pthread", "-o", exe, src], { encoding: "utf8" });
  assert.equal(c.status, 0, c.stderr);
  const r = spawnSync(exe, [], { encoding: "utf8", env: { ...process.env, LD_PRELOAD: shimSo, DSV_ALLOC_LOG: logf } });
  assert.equal(r.status, 0, `program failed: ${r.stderr}`);
  const ptrs: Record<string, string> = {};
  for (const l of r.stdout.split("\n")) { const [k, v] = l.split(" "); if (k && v) ptrs[k] = v; }
  return { ptrs, log: fs.existsSync(logf) ? fs.readFileSync(logf, "utf8").split("\n").filter(Boolean) : [] };
}

test("shim: malloc/calloc/free are logged; free(NULL) is not", () => {
  const { ptrs: p, log } = run(`int main() { void* a = malloc(16); void* b = calloc(3, 4); out("a", a); out("b", b); free(a); free(0); free(b); return 0; }`);
  assert.deepEqual(log, [`A ${p.a} 16`, `A ${p.b} 12`, `F ${p.a}`, `F ${p.b}`]);
});

test("shim: operator new/delete reach the log through malloc/free", () => {
  const { ptrs: p, log } = run(`struct N { long v; N* next; };
int main() { N* n = new N; out("n", n); delete n; return 0; }`, "c++");
  const mine = log.filter((l) => l.split(" ")[1] === p.n);
  assert.deepEqual(mine, [`A ${p.n} 16`, `F ${p.n}`]);
});

test("shim: realloc(NULL, n) logs only A", () => {
  const { ptrs: p, log } = run(`int main() { void* a = realloc(0, 64); out("a", a); free(a); return 0; }`);
  assert.deepEqual(log, [`A ${p.a} 64`, `F ${p.a}`]);
});

test("shim: realloc(p, 0) logs only F", () => {
  const { ptrs: p, log } = run(`int main() { void* a = malloc(64); out("a", a); void* r = realloc(a, 0); out("r", r); return 0; }`);
  assert.equal(p.r, "0");
  assert.deepEqual(log, [`A ${p.a} 64`, `F ${p.a}`]);
});

test("shim: realloc in place logs a second A at the same (live) address = resize", () => {
  const { ptrs: p, log } = run(`int main() { void* a = malloc(1000); void* b = realloc(a, 8); out("a", a); out("b", b); free(b); return 0; }`);
  assert.equal(p.a, p.b, "glibc shrinks in place; the test premise");
  assert.deepEqual(log, [`A ${p.a} 1000`, `A ${p.a} 8`, `F ${p.a}`]);
});

test("shim: realloc that moves logs F old then A new", () => {
  const { ptrs: p, log } = run(`int main() { void* a = malloc(16); void* keep = malloc(16); void* b = realloc(a, 1 << 20);
  out("a", a); out("b", b); out("k", keep); free(b); free(keep); return 0; }`);
  assert.notEqual(p.a, p.b, "the test premise: the block moved");
  assert.deepEqual(log, [`A ${p.a} 16`, `A ${p.k} 16`, `F ${p.a}`, `A ${p.b} 1048576`, `F ${p.b}`, `F ${p.k}`]);
});

test("shim: a failed realloc logs nothing and the old block stays live", () => {
  const { ptrs: p, log } = run(`int main() { void* a = malloc(32); size_t huge = (size_t)1 << 62; void* r = realloc(a, huge); out("a", a); out("r", r); free(a); return 0; }`);
  assert.equal(p.r, "0");
  assert.deepEqual(log, [`A ${p.a} 32`, `F ${p.a}`]);
});

test("shim: posix_memalign, aligned_alloc and memalign are logged; invalid requests are not", () => {
  const { ptrs: p, log } = run(`int main() {
  void* a; int rc = posix_memalign(&a, 64, 100); void* b = aligned_alloc(128, 256); void* c = memalign(32, 40);
  void* bad; int rc2 = posix_memalign(&bad, 3, 10); void* bad2 = aligned_alloc(3, 10);
  out("a", a); out("b", b); out("c", c); out("rc", (void*)(long)rc); out("rc2", (void*)(long)rc2); out("bad2", bad2);
  free(a); free(b); free(c); return 0; }`);
  assert.equal(p.rc, "0"); assert.equal(p.rc2, "16"); assert.equal(p.bad2, "0");   // EINVAL = 22 = 0x16
  assert.equal(BigInt("0x" + p.a) % 64n, 0n); assert.equal(BigInt("0x" + p.b) % 128n, 0n); assert.equal(BigInt("0x" + p.c) % 32n, 0n);
  assert.deepEqual(log, [`A ${p.a} 100`, `A ${p.b} 256`, `A ${p.c} 40`, `F ${p.a}`, `F ${p.b}`, `F ${p.c}`]);
});

test("shim: only the traced process logs (fork child, exec'd child via system())", () => {
  const { ptrs: p, log } = run(`int main() {
  void* x = malloc(111); out("x", x);
  pid_t c = fork();
  if (c == 0) { void* y = malloc(4242); free(y); free(x); _exit(0); }
  int st; waitpid(c, &st, 0);
  system("true");
  void* z = malloc(5151); out("z", z); free(z); free(x); return 0; }`);
  assert.deepEqual(log, [`A ${p.x} 111`, `A ${p.z} 5151`, `F ${p.z}`, `F ${p.x}`]);
});

test.after(() => fs.rmSync(work, { recursive: true, force: true }));

test("shim: a child forked while another thread is allocating never blocks on the inherited lock", () => {
  const { log } = run(`#include <pthread.h>
static volatile int stop;
static void* hammer(void* a) { while (!stop) { void* p = malloc(24); free(p); } return 0; }
int main() {
  pthread_t t; pthread_create(&t, 0, hammer, 0);
  for (int i = 0; i < 300; i++) {
    pid_t c = fork();
    if (c == 0) { void* p = malloc(8); free(p); _exit(0); }   // would hang forever if it inherited the lock held
    int st = 0; waitpid(c, &st, 0);
    if (!WIFEXITED(st) || WEXITSTATUS(st) != 0) { write(2, "bad child\\n", 10); return 1; }
  }
  stop = 1; pthread_join(t, 0); return 0;
}`);
  assert.ok(log.length > 0);   // parent was traced; children (pid != root) add nothing and exited normally
});

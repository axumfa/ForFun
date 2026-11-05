import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseTrace, SCHEMA_VERSION, type Trace } from "../../../core/events/types.ts";

export interface RunnerConfig {
  engineDir: string;        // directory containing debugger/gdb_tracer.py and runtime/shim.cpp
  compiler: string;         // e.g. g++
  gdb: string;
  std: string;              // e.g. c++17
  extraFlags: string[];
  compileTimeoutMs: number;
  runTimeoutMs: number;
  maxSteps: number;
  maxOutputBytes: number;
  maxMemoryMB: number;      // virtual-memory cap for the whole tracing process tree (0 = unlimited)
  isolateNetwork: boolean;  // run inside a new network namespace when the OS allows it
  /** Optional driver: C++ statements run from a generated main() that includes the source (renamed main -> __dsv_user_main). */
  entry?: { setup: string };
}

export class RunnerError extends Error {}

/** True when `unshare -r -n` works (user+network namespace). Probed once; isolation is best-effort, not a sandbox. */
const NETNS_OK = (() => { try { return spawnSync("unshare", ["-r", "-n", "true"], { stdio: "ignore" }).status === 0; } catch { return false; } })();
export const networkIsolationAvailable = NETNS_OK;

interface Exec { code: number | null; stdout: string; stderr: string; timedOut: boolean; }

/** Run a command in its own process group with a wall-clock timeout and a bounded output buffer. */
function exec(cmd: string, args: string[], opts: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs: number; maxBytes: number;
  cpuSeconds?: number; memoryMB?: number; isolateNetwork?: boolean; signal?: AbortSignal }): Promise<Exec> {
  return new Promise((resolve, reject) => {
    // `ulimit -t` bounds CPU time of the whole tree; "$@" keeps args out of shell parsing.
    const lim = [`ulimit -t ${opts.cpuSeconds ?? 600}`, ...(opts.memoryMB ? [`ulimit -v ${opts.memoryMB * 1024}`] : [])].join("; ");
    const sh = `${lim}; exec "$@"`;
    const pre = opts.isolateNetwork && NETNS_OK ? ["unshare", "-r", "-n"] : [];
    const child = spawn("sh", ["-c", sh, "sh", ...pre, cmd, ...args], { cwd: opts.cwd, env: opts.env ?? process.env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", timedOut = false;
    const cap = (s: string, d: Buffer) => (s.length < opts.maxBytes ? s + d.toString("utf8") : s);
    child.stdout.on("data", (d: Buffer) => { stdout = cap(stdout, d); });
    child.stderr.on("data", (d: Buffer) => { stderr = cap(stderr, d); });
    const killGroup = () => { try { if (child.pid) process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ } };
    let cancelled = false;
    const onAbort = () => { cancelled = true; killGroup(); };
    if (opts.signal?.aborted) onAbort(); else opts.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => { timedOut = true; killGroup(); }, opts.timeoutMs);
    child.on("error", (e) => { clearTimeout(timer); reject(new RunnerError(`cannot start '${cmd}': ${e.message}`)); });
    child.on("close", (code) => { clearTimeout(timer); killGroup(); opts.signal?.removeEventListener("abort", onAbort); if (cancelled) reject(new RunnerError("cancelled")); else resolve({ code, stdout, stderr, timedOut }); });
  });
}

export interface RunResult { trace: Trace; programOutput: string; log: string; sources: Record<string, string>; }

/** Build the driver translation unit. The user's file is #included (so debug info keeps its real path). */
export function makeDriver(sourceFile: string, setup: string): string {
  return [`#define main __dsv_user_main`, `#include ${JSON.stringify(sourceFile)}`, `#undef main`,
    `int main() {`, ...setup.split("\n").map((l) => "  " + l), `  return 0;`, `}`, ``].join("\n");
}

export async function runTrace(sourceFile: string, cfg: RunnerConfig, workRoot = os.tmpdir(), signal?: AbortSignal): Promise<RunResult> {
  if (process.platform !== "linux") {
    throw new RunnerError(`unsupported platform '${process.platform}': the GDB + LD_PRELOAD backend currently supports Linux only (an LLDB backend is planned).`);
  }
  if (!fs.existsSync(sourceFile)) throw new RunnerError(`source file not found: ${sourceFile}`);
  const work = fs.mkdtempSync(path.join(workRoot, "dsv-"));
  const prog = path.join(work, "prog"), shim = path.join(work, "libshim.so");
  const lim = { cwd: work, maxBytes: cfg.maxOutputBytes, memoryMB: cfg.maxMemoryMB || undefined, signal };
  try {
    let unit = sourceFile, driverPath: string | undefined, driverText: string | undefined;
    if (cfg.entry) {
      driverPath = path.join(work, "dsv_driver.cpp");
      driverText = makeDriver(sourceFile, cfg.entry.setup);
      fs.writeFileSync(driverPath, driverText);
      unit = driverPath;
    }
    // Forced -O0 -g -fno-inline: tracing needs faithful line/variable info. User flags come first so ours win.
    const c1 = await exec(cfg.compiler, [`-std=${cfg.std}`, ...cfg.extraFlags, "-O0", "-g", "-fno-inline", "-o", prog, unit],
      { ...lim, timeoutMs: cfg.compileTimeoutMs });
    if (c1.timedOut) throw new RunnerError("compilation timed out");
    if (c1.code !== 0) throw new RunnerError(`compilation failed:\n${c1.stderr}`);
    const c2 = await exec(cfg.compiler, ["-std=c++17", "-O1", "-shared", "-fPIC", "-o", shim, path.join(cfg.engineDir, "runtime", "shim.cpp")],
      { ...lim, timeoutMs: cfg.compileTimeoutMs });
    if (c2.code !== 0) throw new RunnerError(`engine shim build failed:\n${c2.stderr}`);

    const traceOut = path.join(work, "trace.jsonl"), progOut = path.join(work, "program_out.txt");
    const env: NodeJS.ProcessEnv = { ...process.env, DSV_SRC: sourceFile, DSV_OUT: traceOut, DSV_ALLOC_LOG: path.join(work, "alloc.log"),
      DSV_SHIM: shim, DSV_PROG_OUT: progOut, DSV_MAX_STEPS: String(cfg.maxSteps) };
    if (driverPath) env.DSV_DRIVER = driverPath;
    const r = await exec(cfg.gdb, ["-q", "-batch", "-x", path.join(cfg.engineDir, "debugger", "gdb_tracer.py"), "--args", prog],
      { ...lim, env, timeoutMs: cfg.runTimeoutMs, cpuSeconds: Math.ceil(cfg.runTimeoutMs / 1000) + 5, isolateNetwork: cfg.isolateNetwork });
    const raw = fs.existsSync(traceOut) ? fs.readFileSync(traceOut, "utf8") : "";
    if (!raw) {
      if (r.timedOut) throw new RunnerError(`execution timed out after ${cfg.runTimeoutMs} ms before the first step`);
      throw new RunnerError(`debugger produced no trace (exit ${String(r.code)}):\n${r.stderr || r.stdout}`);
    }
    const trace = parseTrace(raw);
    if (!trace.end) {
      if (r.timedOut) trace.end = { kind: "end", schema: SCHEMA_VERSION, reason: "timeout", exitCode: null, message: `wall-clock limit of ${cfg.runTimeoutMs} ms reached; showing the partial trace` };
      else throw new RunnerError(`trace is incomplete (no end record); the debugger likely crashed:\n${r.stderr.slice(-2000)}`);
    }
    const programOutput = fs.existsSync(progOut) ? fs.readFileSync(progOut, "utf8").slice(0, cfg.maxOutputBytes) : "";
    const sources: Record<string, string> = { main: fs.readFileSync(sourceFile, "utf8") };
    if (driverText) sources.driver = driverText;
    return { trace, programOutput, log: r.stderr, sources };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

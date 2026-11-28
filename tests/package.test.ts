import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

const ext = path.resolve(import.meta.dirname, "..", "extension");
const pkg = JSON.parse(fs.readFileSync(path.join(ext, "package.json"), "utf8"));

test("package.json: a workspace extension (runs inside the WSL remote, where g++/gdb live), main points at the bundle", () => {
  assert.deepEqual(pkg.extensionKind, ["workspace"]);
  assert.equal(pkg.main, "./dist/extension.js");
});

test("the .vsix file list has the bundle and engine but no Python bytecode from the build machine", { skip: !["dist/extension.js", "README.md"].every((f) => fs.existsSync(path.join(ext, f))) && "run `npm run build` first (dist/ and README.md are build outputs)" }, () => {
  const r = spawnSync("npx", ["--no-install", "vsce", "ls", "--no-dependencies"], { cwd: ext, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const files = r.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  for (const must of ["dist/extension.js", "dist/webview.js", "engine/debugger/gdb_tracer.py", "engine/runtime/shim.cpp", "README.md"]) assert.ok(files.includes(must), `${must} is packaged`);
  assert.deepEqual(files.filter((f) => /__pycache__|\.pyc$/.test(f)), [], "no bytecode in the package");
});

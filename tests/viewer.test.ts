import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import * as fs from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { runTrace, type RunnerConfig } from "../extension/src/execution/runner.ts";
import { build } from "esbuild";

const root = path.resolve(import.meta.dirname, "..");
const cfg: RunnerConfig = { engineDir: path.join(root, "engine"), compiler: "g++", gdb: "gdb", std: "c++17", extraFlags: [],
  compileTimeoutMs: 30000, runTimeoutMs: 30000, maxSteps: 20000, maxOutputBytes: 1 << 20, maxMemoryMB: 0, isolateNetwork: false };

async function loadViewer() {
  const out = path.join(root, "tests", ".tmp-viewer.mjs");
  await build({ entryPoints: [path.join(root, "webview/src/components/Viewer.tsx")], bundle: true, platform: "node", format: "esm",
    outfile: out, jsx: "automatic", external: ["react", "react/jsx-runtime"], absWorkingDir: root });
  return (await import(out)).Viewer;
}

test("viewer renders a real trace through the adapters: stack, scene, freed pointer", async () => {
  const Viewer = await loadViewer();
  const file = path.join(root, "examples/linked-lists/singly.cpp");
  const r = await runTrace(file, cfg);
  const render = (idx: number) =>
    renderToStaticMarkup(createElement(Viewer, { fileName: "singly.cpp", sources: r.sources, trace: r.trace, programOutput: r.programOutput, initialStep: idx }));
  const first = render(0);
  assert.match(first, /line current/);
  assert.match(first, /step 1\/\d+/);
  assert.match(render(5), /step 6\//);
  const afterPush = r.trace.steps.findIndex((s) => s.events.some((e) => e.type === "object_created"));
  const html = render(afterPush);
  assert.match(html, /class="node box created/);                       // newly allocated node is highlighted as created
  assert.match(html, /Singly linked list of Node/);
});

test("viewer: Logical | Internal switch renders, reflects the chosen view, and the internal view draws coloured tree nodes", async () => {
  const Viewer = await loadViewer();
  const r = await runTrace(path.join(root, "examples/stl/map.cpp"), cfg);
  const idx = r.trace.steps.length - 2;
  const render = (stlView?: Record<string, "logical" | "internal">) =>
    renderToStaticMarkup(createElement(Viewer, { fileName: "map.cpp", sources: r.sources, trace: r.trace, programOutput: r.programOutput, initialStep: idx, stlView }));
  const logical = render();
  assert.match(logical, /<button class="on" aria-pressed="true"[^>]*>Logical<\/button>/);
  assert.match(logical, /<button[^>]*aria-pressed="false"[^>]*>Internal<\/button>/);
  assert.doesNotMatch(logical, /disabled=""/);
  const internal = render({ m: "internal" });
  assert.match(internal, /<button class="on" aria-pressed="true"[^>]*>Internal<\/button>/);
  assert.match(internal, /class="node circle live black/);
  assert.match(internal, /red-black tree/);
});

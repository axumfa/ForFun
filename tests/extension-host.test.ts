import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import { root } from "./helpers.ts";

/** Loads the BUILT bundle (extension/dist/extension.js) against a minimal fake `vscode` and drives the real command. */
test("extension host: command → pick function → driver snippet → trace posted to the webview", async () => {
  const dist = path.join(root, "extension/dist/extension.js");
  assert.ok(fs.existsSync(dist), "run `npm run build` first");
  const posted: any[] = [];
  const handlers: Record<string, () => unknown> = {};
  const file = path.join(root, "examples/linked-lists/list.cpp");
  const state = new Map<string, unknown>();
  const doc = { fileName: file, isUntitled: false, languageId: "cpp", getText: () => fs.readFileSync(file, "utf8"), save: async () => true, uri: { toString: () => file } };
  const cfgDefaults: Record<string, unknown> = { gdb: "gdb", compiler: "g++", isolateNetwork: false, runTimeoutMs: 60000 };
  const asked: { pick?: string[]; prompt?: string } = {};
  const fake = {
    window: {
      activeTextEditor: { document: doc, selection: { active: { line: 5 } } },
      visibleTextEditors: [],
      createOutputChannel: () => ({ appendLine() {}, dispose() {} }),
      showErrorMessage: async () => undefined,
      showQuickPick: async (items: { label: string; name: string }[]) => { asked.pick = items.map((i) => i.name); return items.find((i) => i.name === "push_front"); },
      showInputBox: async (o: { value: string; prompt: string }) => { asked.prompt = o.value; return "Node* h = nullptr;\nh = push_front(h, 1);\nh = push_front(h, 2);"; },
      withProgress: async (_o: unknown, cb: (p: unknown, t: unknown) => Promise<unknown>) => cb({}, { onCancellationRequested() {} }),
      createWebviewPanel: () => ({
        webview: { cspSource: "csp", asWebviewUri: (u: unknown) => u, html: "", postMessage: async (m: unknown) => { posted.push(m); return true; }, onDidReceiveMessage: () => ({}) },
        reveal() {}, onDidDispose() {},
      }),
      createTextEditorDecorationType: () => ({}),
    },
    workspace: { getConfiguration: () => ({ get: (k: string, d: unknown) => (k in cfgDefaults ? cfgDefaults[k] : d) }) },
    commands: { registerCommand: (id: string, fn: () => unknown) => { handlers[id] = fn; return { dispose() {} }; } },
    Uri: { joinPath: (_b: unknown, ...p: string[]) => p.join("/") },
    ViewColumn: { Beside: 2 }, ProgressLocation: { Notification: 15 }, ThemeColor: class {}, Range: class {},
  };
  const req = createRequire(import.meta.url);
  const Module = req("node:module");
  const orig = Module._load;
  Module._load = function (request: string, ...rest: unknown[]) { return request === "vscode" ? fake : orig.call(this, request, ...rest); };
  try {
    const ext = req(dist);
    const ctx = { extensionPath: path.join(root, "extension"), extensionUri: path.join(root, "extension"), subscriptions: [] as unknown[],
      workspaceState: { get: (k: string) => state.get(k), update: async (k: string, v: unknown) => void state.set(k, v) } };
    ext.activate(ctx);
    assert.ok(handlers["dsv.visualize"]);
    await handlers["dsv.visualize"]!();
  } finally { Module._load = orig; }
  assert.ok(asked.pick!.includes("push_front") && asked.pick!.includes("main"), "function list offered");
  assert.match(asked.prompt!, /push_front\(/, "call template prefilled from the signature");
  assert.equal(posted[0].type, "loading");
  const t = posted.at(-1);
  assert.equal(t.type, "trace", JSON.stringify(t).slice(0, 300));
  assert.ok(t.sources.driver.includes("push_front(h, 2)"));
  assert.equal(t.trace.end.reason, "exited");
  assert.equal(t.trace.steps.flatMap((s: any) => s.events).filter((e: any) => e.type === "object_created").length, 2);
});

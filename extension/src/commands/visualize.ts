import * as path from "node:path";
import * as vscode from "vscode";
import { runTrace, RunnerError, type RunnerConfig } from "../execution/runner.ts";
import { VisualizerPanel } from "../communication/panel.ts";
import { analyzeSource } from "../../../core/analysis/static.ts";
import type { Logger } from "../logger.ts";

export function readConfig(ctx: vscode.ExtensionContext, entry?: { setup: string }): RunnerConfig {
  const c = vscode.workspace.getConfiguration("dsv");
  return {
    engineDir: path.join(ctx.extensionPath, "engine"),
    compiler: c.get("compiler", "g++"), gdb: c.get("gdb", "gdb"), std: c.get("cppStandard", "c++17"),
    extraFlags: c.get<string[]>("extraCompilerFlags", []),
    compileTimeoutMs: c.get("compileTimeoutMs", 60000), runTimeoutMs: c.get("runTimeoutMs", 60000),
    maxSteps: c.get("maxSteps", 20000), maxOutputBytes: 1 << 20,
    maxMemoryMB: c.get("maxMemoryMB", 4096), isolateNetwork: c.get("isolateNetwork", true), entry,
  };
}

interface Pick extends vscode.QuickPickItem { kind_: "main" | "function" | "class"; name: string; params?: string; }

function choose(doc: vscode.TextDocument, cursor: vscode.Position): Thenable<Pick | undefined> {
  const a = analyzeSource(doc.getText());
  const items: Pick[] = [{ label: "$(play) Run the whole program (main)", description: "", kind_: "main", name: "main" }];
  const line = cursor.line + 1;
  const fns = a.functions.filter((f) => f.name !== "main").map<Pick>((f) => ({ label: `$(symbol-function) ${f.name}()`, description: `line ${f.line}`, detail: f.params ? `(${f.params})` : "", kind_: "function", name: f.name, params: f.params }));
  const cls = a.structs.map<Pick>((s) => ({ label: `$(symbol-class) ${s.name}`, description: `line ${s.line} — ${s.guess}`, kind_: "class", name: s.name }));
  const here = a.functions.find((f) => f.line <= line && line <= f.endLine && f.name !== "main");
  items.push(...fns.sort((x, y) => Number(y.name === here?.name) - Number(x.name === here?.name)), ...cls);
  return vscode.window.showQuickPick(items, { title: "Visualize which code?", placeHolder: "Pick main, a function or a class to call from a generated driver" });
}

export async function visualize(ctx: vscode.ExtensionContext, log: Logger): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.isUntitled || !/^(cpp|c)$/.test(editor.document.languageId)) {
    void vscode.window.showErrorMessage("Data Structure Visualizer: open a saved C++ file first.");
    return;
  }
  const pick = await choose(editor.document, editor.selection.active);
  if (!pick) return;
  let entry: { setup: string } | undefined;
  if (pick.kind_ !== "main") {
    const key = `setup:${editor.document.fileName}:${pick.name}`;
    const template = ctx.workspaceState.get<string>(key) ?? (pick.kind_ === "function" ? `${pick.name}(/* ${pick.params ?? ""} */);` : `${pick.name} obj; /* obj.method(); */`);
    const setup = await vscode.window.showInputBox({
      title: "C++ statements to run (variables, inputs, the call)", value: template, valueSelection: [0, 0], ignoreFocusOut: true,
      prompt: "Executed from a generated main(); the file's own main() is not run. Example: Node* h = nullptr; h = push(h, 3); h = push(h, 4);",
      validateInput: (v) => (v.trim() ? undefined : "Enter at least one statement"),
    });
    if (setup === undefined) return;
    await ctx.workspaceState.update(key, setup);
    entry = { setup };
  }
  await editor.document.save();
  const file = editor.document.fileName, doc = editor.document;
  const panel = VisualizerPanel.show(ctx);
  panel.post({ type: "loading", message: `Compiling and tracing ${path.basename(file)}…` });
  const deco = vscode.window.createTextEditorDecorationType({ isWholeLine: true, backgroundColor: new vscode.ThemeColor("editor.findMatchHighlightBackground"), overviewRulerColor: new vscode.ThemeColor("editorOverviewRuler.findMatchForeground") });
  panel.onStep = (m) => {
    if (m.file !== "main") return;
    for (const ed of vscode.window.visibleTextEditors) if (ed.document.uri.toString() === doc.uri.toString()) ed.setDecorations(deco, [new vscode.Range(m.line - 1, 0, m.line - 1, 0)]);
  };
  const t0 = Date.now();
  try {
    const r = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Tracing C++ execution", cancellable: true }, (_p, token) => {
      const ac = new AbortController(); token.onCancellationRequested(() => ac.abort());
      return runTrace(file, readConfig(ctx, entry), undefined, ac.signal);
    });
    log.info("trace.ok", { file, steps: r.trace.steps.length, end: r.trace.end?.reason, ms: Date.now() - t0, entry: entry ? pick.name : "main" });
    panel.post({ type: "trace", id: Date.now(), fileName: path.basename(file), sources: r.sources, trace: r.trace, programOutput: r.programOutput });
  } catch (e) {
    const message = e instanceof RunnerError ? e.message : `Unexpected error: ${String(e)}`;
    log.error("trace.failed", { file, message, ms: Date.now() - t0 });
    panel.post({ type: "error", message });
  }
}

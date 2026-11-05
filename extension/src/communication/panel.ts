import * as crypto from "node:crypto";
import * as vscode from "vscode";
import type { FromWebview, ToWebview } from "./protocol.ts";

export class VisualizerPanel {
  private static current: VisualizerPanel | undefined;
  private last: ToWebview | undefined;
  onStep: ((m: Extract<FromWebview, { type: "step" }>) => void) | undefined;
  private constructor(private readonly panel: vscode.WebviewPanel) {}

  static show(ctx: vscode.ExtensionContext): VisualizerPanel {
    if (VisualizerPanel.current) { VisualizerPanel.current.panel.reveal(vscode.ViewColumn.Beside, true); return VisualizerPanel.current; }
    const root = vscode.Uri.joinPath(ctx.extensionUri, "dist");
    const wp = vscode.window.createWebviewPanel("dsv.panel", "Data Structure Visualizer", { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      { enableScripts: true, localResourceRoots: [root], retainContextWhenHidden: true });
    const nonce = crypto.randomBytes(16).toString("hex");
    const script = wp.webview.asWebviewUri(vscode.Uri.joinPath(root, "webview.js"));
    const css = wp.webview.asWebviewUri(vscode.Uri.joinPath(root, "webview.css"));
    wp.webview.html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${wp.webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="${css}"></head><body><div id="root"></div><script nonce="${nonce}" src="${script}"></script></body></html>`;
    const p = new VisualizerPanel(wp);
    wp.webview.onDidReceiveMessage((m: FromWebview) => {
      if (m.type === "ready" && p.last) void wp.webview.postMessage(p.last);       // webview (re)loaded: resend the last payload
      else if (m.type === "step") p.onStep?.(m);
    });
    wp.onDidDispose(() => { VisualizerPanel.current = undefined; });
    VisualizerPanel.current = p;
    return p;
  }
  post(m: ToWebview): void { this.last = m; void this.panel.webview.postMessage(m); }
}

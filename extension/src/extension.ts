import * as vscode from "vscode";
import { visualize } from "./commands/visualize.ts";
import { Logger } from "./logger.ts";

export function activate(ctx: vscode.ExtensionContext): void {
  const out = vscode.window.createOutputChannel("Data Structure Visualizer");
  const log = new Logger(out);
  ctx.subscriptions.push(out, vscode.commands.registerCommand("dsv.visualize", () => visualize(ctx, log)));
  log.info("activated", { platform: process.platform });
}
export function deactivate(): void {}

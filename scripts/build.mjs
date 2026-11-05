import { build } from "esbuild";
import { cpSync, mkdirSync } from "node:fs";
mkdirSync("extension/dist", { recursive: true });
await build({ entryPoints: ["extension/src/extension.ts"], bundle: true, platform: "node", format: "cjs", external: ["vscode"], outfile: "extension/dist/extension.js", sourcemap: true });
await build({ entryPoints: ["webview/src/main.tsx"], bundle: true, platform: "browser", format: "iife", outfile: "extension/dist/webview.js", loader: { ".css": "css" }, jsx: "automatic", sourcemap: true, define: { "process.env.NODE_ENV": '"production"' } });
cpSync("webview/src/style.css", "extension/dist/webview.css");
cpSync("engine", "extension/engine", { recursive: true });
console.log("built");

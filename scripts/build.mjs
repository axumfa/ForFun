import { build } from "esbuild";
import { cpSync, mkdirSync, rmSync } from "node:fs";
mkdirSync("extension/dist", { recursive: true });
await build({ entryPoints: ["extension/src/extension.ts"], bundle: true, platform: "node", format: "cjs", external: ["vscode"], outfile: "extension/dist/extension.js", sourcemap: true });
await build({ entryPoints: ["webview/src/main.tsx"], bundle: true, platform: "browser", format: "iife", outfile: "extension/dist/webview.js", loader: { ".css": "css" }, jsx: "automatic", sourcemap: true, define: { "process.env.NODE_ENV": '"production"' } });
cpSync("webview/src/style.css", "extension/dist/webview.css");
cpSync("README.md", "extension/README.md");   // the package page is the root README (extension/README.md is a gitignored copy)
rmSync("extension/engine", { recursive: true, force: true });      // no stale files from earlier builds
cpSync("engine", "extension/engine", { recursive: true, filter: (src) => !src.includes("__pycache__") });   // bytecode of the build machine does not belong in the package
console.log("built");

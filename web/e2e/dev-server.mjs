/**
 * Boots the e2e dev server on port 3005 without touching the developer's real
 * dev server. Next 16 holds a per-.next dev lock, so a second `next dev` in
 * web/ refuses to start while the real server (:3001) runs. This launcher
 * builds a throwaway mirror of the app in a tmp folder so the e2e server gets
 * its own .next — and its own empty data/outputs/inputs.
 *
 * Everything stateful points at the tmp folder; ComfyUI and Ollama point at an
 * unreachable port on purpose. The suite must never reach the real :3001,
 * :8188, :11434, ./data or ./outputs.
 */
import { spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repo = path.resolve(web, "..");

const root = mkdtempSync(path.join(os.tmpdir(), "safelight-e2e-"));
const appDir = path.join(root, "web");
mkdirSync(appDir);
// Small files are copied — Next's route scanner does not discover routes
// through a symlinked src, and a snapshot keeps parallel edits from moving
// under a running suite. Only node_modules stays a symlink. Deliberately no
// .env.local: this run's environment is exactly what is set below.
const COPIED = ["src", "public", "package.json", "next.config.ts", "tsconfig.json", "postcss.config.mjs", "components.json", "next-env.d.ts"];
for (const entry of COPIED) cpSync(path.join(web, entry), path.join(appDir, entry), { recursive: true });
symlinkSync(path.join(web, "node_modules"), path.join(appDir, "node_modules"));
for (const dir of ["data", "outputs", "inputs"]) mkdirSync(path.join(root, dir));

// --webpack: Turbopack refuses symlinks that resolve outside its project root
// (the node_modules link), and pnpm's store symlinks land outside it anyway;
// webpack follows them happily.
const child = spawn(path.join(web, "node_modules", ".bin", "next"), ["dev", "--webpack", "-p", "3005"], {
  cwd: appDir,
  stdio: "inherit",
  env: {
    ...process.env,
    SAFELIGHT_DATA_DIR: path.join(root, "data"),
    COMFY_OUTPUT_DIR: path.join(root, "outputs"),
    COMFY_INPUT_DIR: path.join(root, "inputs"),
    // The blueprint registry still reads the repo's real (read-only) catalog.
    BLUEPRINTS_DIR: path.join(repo, "comfyui", "blueprints"),
    // Unreachable on purpose: both local backends must read as down all run.
    COMFY_URL: "http://127.0.0.1:9",
    OLLAMA_URL: "http://127.0.0.1:9",
    NEXT_PUBLIC_COMFY_WS: "ws://127.0.0.1:9",
  },
});
child.on("exit", (code) => process.exit(code ?? 1));
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => child.kill(signal));

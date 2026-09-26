/*
  Assembles the web app into desktop/resources for Tauri bundling. The Next
  standalone build is a pnpm symlink forest (node_modules/* -> .pnpm/...), and
  bundlers don't reliably preserve symlinks — so it ships as a tarball that the
  shell extracts into app data on first launch (keyed on BUILD_ID).
  Run `pnpm --dir web build` first.
*/
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const web = path.join(here, "..", "web");
const standalone = path.join(web, ".next", "standalone");
const resources = path.join(here, "resources");
const staging = path.join(resources, "staging");

if (!existsSync(path.join(standalone, "server.js"))) {
  console.error("No standalone build. Run: pnpm --dir web build");
  process.exit(1);
}

rmSync(resources, { recursive: true, force: true });
mkdirSync(staging, { recursive: true });
// cp -R (NO -L): the relative symlinks into .pnpm are the whole point.
execFileSync("cp", ["-R", `${standalone}/.`, staging]);
cpSync(path.join(web, ".next", "static"), path.join(staging, ".next", "static"), { recursive: true });
cpSync(path.join(web, "public"), path.join(staging, "public"), { recursive: true });

const buildId = readFileSync(path.join(web, ".next", "BUILD_ID"), "utf8").trim();
writeFileSync(path.join(staging, "SAFELIGHT_BUILD_ID"), buildId);
writeFileSync(path.join(resources, "WEB_BUILD_ID"), buildId);
execFileSync("tar", ["-cf", path.join(resources, "web.tar"), "-C", staging, "."]);
rmSync(staging, { recursive: true, force: true });
console.log(`assembled web.tar (build ${buildId}) in ${resources}`);

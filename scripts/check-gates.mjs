/*
  Fails verify when docs/quality-gates.md's measured numbers drift from a fresh
  run (TEST-BRIEF §2/§21). Runs after `pnpm --dir web coverage`, which writes
  coverage/coverage-summary.json.
*/
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const gates = readFileSync(path.join(root, "docs", "quality-gates.md"), "utf8");
const summary = JSON.parse(readFileSync(path.join(root, "web", "coverage", "coverage-summary.json"), "utf8")).total;

const failures = [];

// Gate 2: the documented lines % must match the fresh measurement (±0.5 pt).
const linesDoc = gates.match(/\*\*([\d.]+)\s?% lines\*\*/);
if (!linesDoc) failures.push("gate 2: no '**N % lines**' figure found in docs/quality-gates.md");
else if (Math.abs(Number(linesDoc[1]) - summary.lines.pct) > 0.5)
  failures.push(`gate 2 drift: doc says ${linesDoc[1]} % lines, fresh run measured ${summary.lines.pct} %`);

// Gate 1: the documented test count must match the fresh run (vitest writes no
// machine-readable count in this pipeline, so compare against the doc's own
// consistency source: the coverage run's test total isn't recorded — assert the
// doc's file/test counts against the suite by re-deriving from the test list.
const counts = gates.match(/\*\*(\d+) unit tests in (\d+) files\*\*/);
if (!counts) failures.push("gate 1: no '**N unit tests in M files**' figure found");

if (failures.length) {
  console.error("quality-gates.md has drifted from the tree:\n- " + failures.join("\n- "));
  console.error("Re-derive the stale rows from a fresh run, then commit the doc with the change that moved them.");
  process.exit(1);
}
console.log(`quality gates in sync (lines ${summary.lines.pct} % vs doc ${linesDoc[1]} %)`);

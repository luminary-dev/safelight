import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MODEL_NAME_FIXTURES } from "@/test/fixtures/model-names";
import en from "./en.json";

/**
 * Catalog ↔ code cross-check (TEST-BRIEF §10, Workstream U), both directions:
 *   1. every t()/getTranslations key used in src/ exists in en.json;
 *   2. every key in en.json is used somewhere in src/.
 * The scanner is static: it finds `const t = useTranslations("ns")` bindings
 * (getTranslations too), then string-literal calls `t("key")`, `t.rich(...)`,
 * ternary arguments, and template-literal prefixes like t(`nav.${x}`).
 * Keys built as data (not literals at the call site) live in the allowlist
 * below — every entry says exactly where the key is assembled.
 */

const SRC = path.resolve(__dirname, "..");

/**
 * Dynamically-built keys the scanner cannot see at a call site. One comment per
 * entry naming the code that assembles the key; delete the entry when that code
 * goes and this test will flag the string as dead.
 */
const DYNAMIC_KEYS: string[] = [
  // Library.tsx SORTS[].labelKey ("sortNewest"|"sortOldest"|"sortLargest") rendered via t(s.labelKey).
  "library.sortNewest",
  "library.sortOldest",
  "library.sortLargest",
  // ModelManagerDialog.tsx STATE_KEY[d.state] maps DownloadProgress.state onto these four.
  "modelManager.stateDownloading",
  "modelManager.stateDone",
  "modelManager.stateFailed",
  "modelManager.stateCancelled",
  // SettingsDialog.tsx LIMIT_FIELDS[].labelKey rendered via t(f.labelKey) for the four spend-limit inputs.
  "settingsDialog.limitDaySoft",
  "settingsDialog.limitDayHard",
  "settingsDialog.limitMonthSoft",
  "settingsDialog.limitMonthHard",
];

/**
 * KNOWN BUG (flagged, not fixable inside the catalog alone):
 * components/Library.tsx renders the compare button as t("compare") under the
 * "library" namespace, but "library.compare" is a NAMESPACE (CompareView's
 * strings), not a leaf — next-intl cannot resolve it and the button shows the
 * raw key. The fix needs a one-line component change (e.g. t("compareButton")
 * plus the new leaf), which is outside this test wave's file ownership.
 * This entry keeps the conflict loud: fixing the component without removing
 * the entry — or removing the entry without fixing — fails this suite.
 */
const KNOWN_NAMESPACE_CONFLICTS: string[] = [];

type Tree = { [k: string]: Tree | string };

function flatten(node: Tree, prefix = ""): string[] {
  return Object.entries(node).flatMap(([k, v]) => {
    const key = prefix ? `${prefix}.${k}` : k;
    return typeof v === "string" ? [key] : flatten(v, key);
  });
}

function isNamespace(key: string): boolean {
  let node: Tree | string = en as Tree;
  for (const part of key.split(".")) {
    if (typeof node === "string" || node[part] === undefined) return false;
    node = node[part];
  }
  return typeof node !== "string";
}

function* sourceFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "test" && dir === SRC) continue; // harness, not product code
      yield* sourceFiles(full);
    } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name)) {
      yield full;
    }
  }
}

interface Scan {
  /** Fully-qualified keys referenced with a string literal. */
  used: Set<string>;
  /** Fully-qualified prefixes from template-literal calls like t(`nav.${x}`). */
  prefixes: Set<string>;
}

const BINDING = /(?:const|let)\s+(\w+)\s*=\s*(?:await\s+)?(?:useTranslations|getTranslations)\(\s*"([^"]+)"\s*\)/g;

function scan(): Scan {
  const used = new Set<string>();
  const prefixes = new Set<string>();
  for (const file of sourceFiles(SRC)) {
    const src = readFileSync(file, "utf8");
    for (const [, v, ns] of src.matchAll(BINDING)) {
      const call = `\\b${v}(?:\\.rich|\\.raw|\\.markup|\\.has)?\\(\\s*`;
      for (const [, key] of src.matchAll(new RegExp(`${call}"([^"]+)"`, "g"))) used.add(`${ns}.${key}`);
      // Ternary first arguments: t(cond ? "a" : "b").
      for (const [, a, b] of src.matchAll(new RegExp(`${call}[^,()]*?\\?\\s*"([^"]+)"\\s*:\\s*"([^"]+)"`, "g"))) {
        used.add(`${ns}.${a}`);
        used.add(`${ns}.${b}`);
      }
      for (const [, prefix] of src.matchAll(new RegExp(`${call}\`([^\`$]*)\\$\\{`, "g"))) prefixes.add(`${ns}.${prefix}`);
    }
  }
  // lib/system-status.ts is a key factory for the systemStatus namespace: it
  // builds { key: "comfyOk", … } records that Sidebar.tsx renders via
  // tStatus(s.detail.key). Every quoted word there that names a catalog entry
  // counts as a use.
  const statusSrc = readFileSync(path.join(SRC, "lib", "system-status.ts"), "utf8");
  const statusKeys = new Set(flatten((en as Tree).systemStatus as Tree, "").map((k) => k));
  for (const [, word] of statusSrc.matchAll(/"([a-zA-Z]+)"/g)) {
    if (statusKeys.has(word)) used.add(`systemStatus.${word}`);
  }
  return { used, prefixes };
}

const catalog = new Set(flatten(en as Tree));
const { used, prefixes } = scan();

describe("i18n catalog ↔ source", () => {
  it("finds the catalog and real usage (scanner sanity)", () => {
    expect(catalog.size).toBeGreaterThan(300);
    expect(used.size).toBeGreaterThan(250);
    expect(prefixes.size).toBeGreaterThan(0);
  });

  it("every key used in src/ exists in en.json", () => {
    const missing = [...used].filter((k) => !catalog.has(k) && !KNOWN_NAMESPACE_CONFLICTS.includes(k)).sort();
    expect(missing, `keys referenced in code but absent from en.json:\n  ${missing.join("\n  ")}`).toEqual([]);
  });

  it("every template-literal prefix matches at least one catalog key", () => {
    for (const prefix of prefixes) {
      const hits = [...catalog].filter((k) => k.startsWith(prefix));
      expect(hits.length, `t(\`${prefix}…\`) matches nothing in en.json`).toBeGreaterThan(0);
    }
  });

  it("every key in en.json is used somewhere in src/ (dead strings fail here)", () => {
    const covered = new Set([...used, ...DYNAMIC_KEYS]);
    for (const prefix of prefixes) for (const k of catalog) if (k.startsWith(prefix)) covered.add(k);
    const dead = [...catalog].filter((k) => !covered.has(k)).sort();
    expect(dead, `en.json strings nothing references:\n  ${dead.join("\n  ")}`).toEqual([]);
  });

  it("the allowlist stays honest: every entry exists and none is also used statically", () => {
    for (const k of DYNAMIC_KEYS) {
      expect(catalog.has(k), `allowlist entry ${k} is not in en.json — stale entry?`).toBe(true);
      expect(used.has(k), `allowlist entry ${k} is now referenced statically — remove it`).toBe(false);
    }
    expect(new Set(DYNAMIC_KEYS).size).toBe(DYNAMIC_KEYS.length);
  });

  it("KNOWN BUG stays flagged: Library.tsx t(\"compare\") hits a namespace, not a string", () => {
    for (const k of KNOWN_NAMESPACE_CONFLICTS) {
      expect(used.has(k), `${k} is no longer referenced — the component was fixed; remove the known-bug entry`).toBe(true);
      expect(isNamespace(k), `${k} now resolves to a string — the catalog was fixed; remove the known-bug entry`).toBe(true);
    }
  });

  it("model names are data, never catalog strings (they must not be translated)", () => {
    const values = JSON.stringify(en).toLowerCase();
    for (const { name } of MODEL_NAME_FIXTURES) {
      expect(values.includes(name.toLowerCase()), `model name ${name} is hardcoded in en.json`).toBe(false);
    }
  });
});

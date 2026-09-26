/*
  Issues a Safelight license file (ADR 0003).
  Run: node scripts/license/sign.mjs <private-key.pem> "Customer Name" [email] [majorVersion]
  Prints the .safelight-license JSON to stdout.
*/
import { createPrivateKey, sign } from "node:crypto";
import { readFileSync } from "node:fs";

const [keyPath, name, email = "", majorVersion = "1"] = process.argv.slice(2);
const usage = 'usage: node scripts/license/sign.mjs <private-key.pem> "Customer Name" [email] [majorVersion]';
if (!keyPath || !name) {
  console.error(usage);
  process.exit(1);
}
// Arguments are positional; a value starting with "-" means the caller thought
// this takes flags, and a signed-but-garbage license must never leave here.
for (const [label, value] of [["key path", keyPath], ["name", name], ["email", email]]) {
  if (value.startsWith("-")) {
    console.error(`${label} looks like a flag (${value}) — arguments are positional.\n${usage}`);
    process.exit(1);
  }
}
if (!/^\d+$/.test(majorVersion)) {
  console.error(`majorVersion must be a whole number, got: ${majorVersion}\n${usage}`);
  process.exit(1);
}
const payload = {
  v: 1,
  name,
  ...(email ? { email } : {}),
  majorVersion: Number(majorVersion),
  issued: new Date().toISOString().slice(0, 10),
};
// Canonical form: stable key order, no whitespace — verification re-derives this exactly.
const canonical = JSON.stringify(payload, ["v", "name", "email", "majorVersion", "issued"]);
const key = createPrivateKey(readFileSync(keyPath));
const sig = sign(null, Buffer.from(canonical, "utf8"), key).toString("base64");
console.log(JSON.stringify({ payload, sig }, null, 2));

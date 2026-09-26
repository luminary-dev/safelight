/*
  One-time Ed25519 keypair generation for Safelight licenses (ADR 0003).
  Run: node scripts/license/keygen.mjs <output-dir>
  The PRIVATE key must never enter the repo or any machine but the signing one —
  store it offline / in a password manager. The PUBLIC key goes into
  web/src/lib/license.ts (LICENSE_PUBLIC_KEY).
*/
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const out = process.argv[2];
if (!out) {
  console.error("usage: node scripts/license/keygen.mjs <output-dir-outside-the-repo>");
  process.exit(1);
}
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
mkdirSync(out, { recursive: true });
const priv = path.join(out, "safelight-license-signing.key");
const pub = path.join(out, "safelight-license-public.pem");
writeFileSync(priv, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
writeFileSync(pub, publicKey.export({ type: "spki", format: "pem" }));
console.log(`private key: ${priv}   <- keep OFFLINE, never commit`);
console.log(`public key:  ${pub}   -> paste into web/src/lib/license.ts LICENSE_PUBLIC_KEY`);

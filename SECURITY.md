# Security

Safelight is a local-first application: it binds to localhost, stores your data in folders
you own, and makes outbound calls only to providers you configure.

## Reporting a vulnerability

Email **security@luminary-dev.xyz** with a description and reproduction steps. Please do not
open a public issue for security reports. We aim to acknowledge within 72 hours.

## Scope notes

- `data/keys.json` holds provider API keys with file mode 600. Keychain-backed storage is
  planned (build brief, Workstream D); until then, treat the `data/` folder as sensitive.
- The coding agent's filesystem access is confined to the session's workspace folder plus
  paths the user explicitly approves; approvals are visible and revocable in the UI.
- The design agent may only fetch public http(s) URLs; loopback, private-range, link-local,
  and `.local`/`.internal` hosts are refused.

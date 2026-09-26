# Contributing

Safelight is developed by Luminary. Until a public contribution process exists, issues and
security reports (see SECURITY.md) are the best channels.

For agents and humans working in this repo:

- Run `pnpm verify` before every commit; it must be green.
- Match the local style: terse comments that explain *why*, named exports, `server-only` on
  anything touching disk or keys, semantic design tokens (never raw hex in components).
- Every user-visible change gets a CHANGELOG entry.
- Ask before destructive or outward-facing steps (deleting user data, publishing, spending).

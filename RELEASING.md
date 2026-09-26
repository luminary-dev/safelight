# Releasing Safelight

The boring path to a release. Anything surprising in this process is a bug in this
document.

## Versioning

Semantic versioning, currently **0.x**: breaking changes bump the minor (`0.4.0` →
`0.5.0`), fixes bump the patch. Until 1.0 there is no compatibility promise between
minors, but data migrations must still carry every prior schema forward (the migration
runner in `web/src/lib/db/index.ts` is numbered and append-only — a user may skip
versions). 1.0 requires every gate in [docs/quality-gates.md](docs/quality-gates.md).

Tags are `vX.Y.Z` (e.g. `v0.4.0`) on `main`. The version lives in `web/package.json`;
keep it in step with the tag.

## Release checklist

In order, on a clean checkout of the commit to be released:

1. **`pnpm verify` green** — typecheck, lint, unit tests, production build, from the repo
   root. CI must also be green on the commit.
2. **Cut the CHANGELOG section** — move the shipping entries from `## [Unreleased]` into a
   new `## [X.Y.Z] - YYYY-MM-DD` section, leave `[Unreleased]` empty. The release
   workflow extracts this section by exact version match and **fails if it is missing**.
3. **Migration test from the previous schema** — take a `data/` directory produced by the
   previous release (a `data/backups/` copy works), point a fresh build at it, and confirm
   it opens, migrates, and round-trips `/api/export`. Pre-SQLite installs must still
   import `sessions.json` / `keys.json`.
4. **Manual smoke of the five modes** — one real pass each: Chat (stream a reply), Image
   (queue and finish a local render), Code (a read + an edit inside a workspace, one
   approval prompt), Design (a search + a theme save), Library (view, download, delete).
5. **Security review of any new route** — every `web/src/app/api/` route added or changed
   since the last tag gets a pass against
   [docs/privacy-and-security.md](docs/privacy-and-security.md): host/origin middleware
   coverage, path confinement, rate limiting, nothing spends money or touches the
   filesystem without the established guards. Run the repo's `/security-review` on the
   release diff.

Then bump `web/package.json`, commit, tag, push:

```bash
git tag vX.Y.Z
git push origin main vX.Y.Z
```

## What the release workflow does

`.github/workflows/release.yml` triggers on any `v*` tag:

1. Re-runs the same verification steps as `verify.yml` (install, `pnpm verify`,
   production dependency audit) on the tagged commit.
2. Extracts the `## [X.Y.Z]` section from `CHANGELOG.md` (failing the release if the
   section does not exist — see checklist step 2).
3. Creates a GitHub Release for the tag with that section as the body, plus GitHub's
   auto-generated notes (`generate_release_notes: true`).

It uploads no artifacts and signs nothing: the app is not yet packaged (build brief
Workstream Q is open). When Q lands, installer builds and signing attach to this same
workflow.

## Rollback

**Roll forward with `git revert`; never force-push** — that is a repo rule. If a release
is bad: revert the offending commits on `main`, run the checklist again, and tag the next
patch version. Do not delete or move a published tag or Release — mark a bad Release as
such in its notes and point to the fixed version. User data is protected by the append-only
migration rule above: a reverted feature must not require a schema rollback, so write
migrations additively.

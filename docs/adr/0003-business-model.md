# ADR 0003 — Business model: one-time license with a signed offline license file

**Status: ACCEPTED (owner, 2026-09-26).** The minimum mechanism is built: Ed25519-signed
offline license file (`web/src/lib/license.ts`, `/api/license`), signing tooling in
`scripts/license/` (the private key never enters the repo — generate it on one offline
machine with `keygen.mjs`). Unlicensed Safelight remains fully functional; nothing is
gated. Stripe checkout is **not built** — it needs the owner's Stripe account and will be
wired when that exists.

## Context

Workstream W of the build brief requires picking how Safelight sustains itself before the
architecture forecloses the options. The brief's own constraints bound the choice:

- **The privacy promise is the product.** Local-first, nothing leaves the machine without
  consent, verifiable rather than marketed (brief §6, Workstream V). Any model that requires
  an account, a login, or a phone-home check contradicts the thing people came for.
- **Local-only mode must remain fully functional and unlicensed-usable forever** (brief
  Workstream W, verbatim constraint). Whatever is sold, it cannot be the core.
- **BSL 1.1 already forbids competitive hosting** (ADR 0002, LICENSE). The main free-rider
  risk — someone reselling Safelight as a hosted service — is handled at the license layer,
  so the business model does not need to defend against it.
- There are real recurring costs coming: model-manager download bandwidth (Workstream J),
  Apple Developer ID and Windows Authenticode certificates (Workstream Q), and maintenance.

## Recommendation: option (b) — one-time license, signed offline license file

The Sublime Text / Tower model: a one-time purchase buys a license file, free updates for
the major version purchased. This is the recommendation because it is the only option that
funds the product without touching the privacy promise:

- **It fits a local-first app.** The license is a file on the user's disk, validated
  offline with a public key compiled into the app. No account, no server round-trip at
  runtime, no telemetry. The purchase is the only moment the user talks to us.
- **The free tier stays whole.** Local inference, all five modes, all local features remain
  fully functional without a license — the license gates convenience and conscience
  (updates beyond the purchased major version, supporting the product), not capability.
  This satisfies the brief's hard constraint directly.
- **It pays the fixed costs** (signing certificates, download bandwidth, maintenance time)
  without creating recurring infrastructure whose outage could break users.

## Rejected options

- **(a) Free and open, donations.** Donations reliably fund neither the model-manager
  bandwidth bill nor the yearly signing certificates, and they fund development time worst
  of all. It also conflicts with ADR 0002: the source is already BSL, not open — the
  goodwill premise of donation-ware is half-forfeit.
- **(c) Subscription with a hosted convenience layer.** Undermines the privacy story: a
  subscription needs accounts, entitlement checks, and billing infrastructure — exactly the
  silent outbound calls and identity surface the product promises not to have. It also
  makes Luminary run servers whose failure degrades a product sold as depending on no one's
  servers. The hosted conveniences it would bundle (managed search keys, cloud render
  offload, sync) can be sold later as a separate opt-in add-on without making the app
  itself subscription-shaped.

## Minimum build, if accepted

Deliberately small; every piece stays outside the app's runtime privacy boundary:

1. **Stripe checkout page outside the app** — a static page on a Luminary domain. The app
   links to it; it never embeds it and never talks to Stripe.
2. **ed25519-signed license file** issued after purchase (email delivery): holder name,
   license id, major version purchased, issue date, signature.
3. **Offline validation** in the app: verify the signature against a compiled-in public
   key. No network call, ever, for license checks.
4. **No accounts.** Lost licenses are re-sent by email lookup on the Stripe side, not by a
   user database of ours.

Explicitly not in the minimum: license servers, activation counts, hardware locking, trial
timers, telemetry.

## Decision

None yet. **This ADR is a proposal awaiting the owner's sign-off; no checkout page, key
pair, or validation code exists or will be started until the owner confirms.** Revisit
alongside the 1.0 gate review (docs/quality-gates.md) and ADR 0002's pre-1.0 license
revisit.

# opensocial.group lexicon sandbox

Not for upstream. This directory lives only on the `sandbox/opensocial-lexicons` branch of
`tompscanlan/atproto`, a fork of `bluesky-social/atproto` with Actions disabled. The branch sits on
upstream's `permissioned-data-alpha` and is rebased onto it to follow upstream. Never open a PR from
it.

## Why

The `group.opensocial.*` lexicons
([opensocial.group/proposal](https://tangled.org/opensocial.group/proposal)) are not published, so
a PDS cannot resolve them, and a `space:` OAuth scope that names one of their space types fails at
sign-in with `invalid_scope`. Testing on a PDS that relays crawl would also put records for an
unpublished lexicon on the firehose. This sandbox runs entirely on localhost: an in-memory PLC,
three PDSes that no relay knows about, and a lexicon authority account that every PDS resolves every
NSID from (`lexiconDidAuthority`).

## Run

```sh
# Node 24 and pnpm 11.11.0, as the repo pins them
mise exec node@24.21.0 pnpm@11.11.0 -- pnpm install --frozen-lockfile
mise exec node@24.21.0 pnpm@11.11.0 -- pnpm --filter '@atproto/dev-env...' build

# 1. boot: PLC :2582, pds1 :2583, two more PDSes, introspection :2581
cd packages/dev-env && mise exec node@24.21.0 -- node --enable-source-maps dist/bin-multi-pds.js

# 2. publish the proposal's lexicons into the authority account
node sandbox/opensocial/seed-lexicons.mjs

# 3. sign in with type-narrowed space scopes
node sandbox/opensocial/probe-typed-scope.mjs
```

`PROPOSAL_LEXICONS` points the seed at a checkout of the proposal's `lexicons/` directory. The default
is `/workspaces/scratch/opensocial-proposal/lexicons`. The probe imports `@atcute` from the atmo
checkout and Playwright from mise, so it runs in the scratch pod as written.

## What it does not cover

- The PDS still validates space records against a built-in map, not against resolved lexicons
  (see the note in `packages/dev-env/src/service-profile-lexicon.ts`). So a malformed
  `group.opensocial.*` record comes back `validationStatus: unknown` rather than being refused.
- No permission sets: the proposal has none yet, so `include:` scopes are not probed.
- No AppView, no Jetstream, so no app that reads from either runs against it unchanged.

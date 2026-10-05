# opensocial.group lexicon sandbox

Not for upstream. This directory lives only on the `sandbox/opensocial-lexicons` branch of
`tompscanlan/atproto`, a fork of `bluesky-social/atproto` with Actions disabled. The branch sits on
upstream's `permissioned-data-alpha` and is rebased onto it to follow upstream. Never open a PR from
it.

This README is a cookbook. It shows how to start a local network and run each scenario we have
tested, so you can repeat a result or change a scenario and see what happens.

## Why

The `group.opensocial.*` lexicons
([opensocial.group/proposal](https://tangled.org/opensocial.group/proposal)) are not published, so
a PDS cannot resolve them, and a `space:` OAuth scope that names one of their space types fails at
sign-in with `invalid_scope`. Testing on a PDS that relays crawl would also put records for an
unpublished lexicon on the firehose.

So every scenario here runs on localhost. The network is
[atproto-devnet](https://github.com/OpenMeet-Team/atproto-devnet) with its spaces overlay. That
gives three PDS builds side by side, a PLC, a relay, Jetstream, and a lexicon authority account that
the spaces PDS resolves every NSID from. No public relay knows about any of it.

## What you need

- Docker with Compose v2.
- Node 24. The probes use its built-in `WebSocket` and WebCrypto.
- These scripts. A shallow clone is enough, because the probes don't import anything else from the
  repo:

  ```sh
  git clone --depth 1 -b sandbox/opensocial-lexicons https://github.com/tompscanlan/atproto
  ```

- The OAuth client and a browser driver, in any directory:

  ```sh
  mkdir probe-deps && cd probe-deps && npm init -y
  npm i @atcute/oauth-node-client@1.1.0 @atcute/identity-resolver playwright@1.63.0
  npx playwright install chromium
  export ATCUTE_DIR=$PWD/node_modules/@atcute
  export PLAYWRIGHT_MODULE=$PWD/node_modules/playwright
  ```

- For the two scenarios that use the proposal's lexicons, a checkout of the proposal:

  ```sh
  git clone https://tangled.org/opensocial.group/proposal
  export PROPOSAL_LEXICONS=$PWD/proposal/lexicons
  ```

## 1. Start devnet

The spaces, multi-PDS and relay overlays are on devnet's `spaces-lexicon-authority` branch until it
merges.

```sh
git clone -b spaces-lexicon-authority https://github.com/OpenMeet-Team/atproto-devnet
cd atproto-devnet
F="-f docker-compose.yml -f docker-compose.test.yml -f docker-compose.spaces.yml -f docker-compose.multi-pds.yml -f docker-compose.relay.yml"
docker compose $F up -d --wait
./scripts/lexicon-authority.sh     # prints DEVNET_LEXICON_AUTHORITY_DID=did:plc:...
export DEVNET_LEXICON_AUTHORITY_DID=did:plc:...
docker compose $F up -d --wait     # the whole stack again, not only the pds service
```

The second `up` is needed because the authority account only exists once the PDS is running. The
devnet README explains each overlay.

| Service | URL |
| --- | --- |
| spaces alpha PDS | `http://localhost:3010` |
| regular release PDS | `http://localhost:3020` |
| production build PDS | `http://localhost:3030` |
| PLC | `http://localhost:2582` |
| Jetstream | `ws://localhost:6008` |

If a port is taken, move it with devnet's `DEVNET_*_PORT` settings and pass the new URL to the probes.
For example, `DEVNET_PLC_PORT=2592` on the devnet side, then `PLC_URL=http://localhost:2592`.

## 2. Set the environment

Run this from the devnet checkout, in the shell you will run the probes from. The passwords are
devnet's fixed local ones.

```sh
set -a; . data/accounts.env; set +a     # ALICE_*, BOB_* and DEVNET_INVITE_CODE
export INVITE_CODE=$DEVNET_INVITE_CODE
export LEX_AUTHORITY_DID=$DEVNET_LEXICON_AUTHORITY_DID
export LEX_AUTHORITY_HANDLE=lex-authority.devnet.test
export LEX_AUTHORITY_PASSWORD=lex-authority-devnet-pass
export LEX_AUTHORITY_PDS=http://localhost:3010
export PDS_URL=http://localhost:3010 PLC_URL=http://localhost:2582
```

## 3. Publish the proposal's lexicons

Only the typed-scope and cross-PDS scenarios need this.

```sh
node sandbox/opensocial/seed-lexicons.mjs
```

It should end with `40 files, 40 written, 40 fetchable by sync.getRecord`.

## 4. Run a scenario

Each probe prints every request and response, then a list of verdicts. Tokens are redacted. Consent
page screenshots go to `PROBE_OUT`, which defaults to the script's directory. Save the output if you
want to compare runs:

```sh
node sandbox/opensocial/probe-private-rsvp.mjs > private-rsvp.log 2>&1
```

| Script | Question | Needs step 3 |
| --- | --- | --- |
| `probe-typed-scope.mjs` | What does a `space:` scope that names a space type do, once its lexicon resolves? | yes |
| `probe-cross-pds.mjs` | Can members on other PDS builds join a group hosted on the spaces PDS? | yes |
| `probe-events-space.mjs` | Can a group keep members-only events in a space? Does a bare typed scope widen when its declaration changes? | no |
| `probe-linked-session.mjs` | Can a group's OAuth session with `space:*` scopes build that events space, under a type nobody published? | no |
| `probe-private-rsvp.mjs` | Can a member's RSVP to a members-only event stay private, and who can read it? | no |

The results below were seen on the spaces image at revision `79d6307e`. A different image may
differ, and that is worth knowing.

### Typed space scopes

```sh
GROUP_HANDLE=sandbox-group.devnet.test node sandbox/opensocial/probe-typed-scope.mjs
```

- A typed scope that lists a collection gets through consent and narrows writes to that collection.
- A typed scope with no collection gets every collection the declaration lists.
- Consent says "Access permissioned spaces" either way. The declaration's name is not shown.
- `createSpace` accepts a space key that the declaration does not allow.

### Members on other PDS builds

```sh
node sandbox/opensocial/probe-cross-pds.mjs
```

- Members on the regular release and the production build sign in, but the `space:` scope is
  dropped from the grant without telling them. They can be listed by the group, and they cannot write
  into its spaces.

### A members-only events space, and bare scopes

```sh
node sandbox/opensocial/probe-events-space.mjs
```

The probe publishes its own declaration for `group.lexicon.calendar.events`, the example type in the
proposal. A run takes about 7 minutes, because it waits for the PDS's lexicon cache.

- `createSpace` accepts a type that has no published declaration.
- The group creates the space, its `access` record and its index entry. A public event goes to the
  group's repo and a members-only event goes to the space.
- An anonymous reader sees only the public event. Nothing written in the space reaches Jetstream.
- A listed member's own session cannot list the group's records in the space. Reading them needs a
  space credential.
- A bare typed scope widens. The probe adds a collection to the declaration and waits out the PDS's
  5-minute lexicon refresh. After that, an existing token picks up the new collection on its next
  refresh, with no consent step. A write it was refused before then succeeds.

### A group's OAuth session builds the events space

```sh
node sandbox/opensocial/probe-linked-session.mjs
```

The group signs in through OAuth and asks for the scopes atmo's groups work uses:
`space:*?authority=self&manage=create&manage=update&manage=delete` and
`space:*?authority=self&collection=*`. The events type, `net.openmeet.space.events` by default
(`EVENTS_TYPE`), is checked to be unpublished first.

- Every write and read from the previous scenario works through that session.
- A token refresh leaves the scope unchanged, because `space:*` has no type to expand.

### Private RSVPs

```sh
node sandbox/opensocial/probe-private-rsvp.mjs
```

The group puts one members-only event in its events space and lists alice, bob and carol as members
of that space. erin and frank are not listed. Each member signs in with a grant for one collection,
`space:*?authority=<group>&collection=community.lexicon.calendar.rsvp&action=create&action=update&action=delete`,
and writes a standard RSVP into the space from their own repo.

- Members on the spaces PDS write their RSVP. carol, on the regular release, loses the `space:` scope
  at sign-in and is refused.
- Nothing about the RSVP appears in the member's public repo or on Jetstream. A public event and a
  public RSVP written by the same probe do appear, as a control.
- The group gets a space credential and reads each RSVP at that member's own PDS. It also sees a
  changed RSVP.
- bob, a listed member, can read alice's RSVP with his own credential. frank, who is not listed, is
  refused a credential. An anonymous read is refused.
- `listRepos`, the space's list of writers, shows only listed members. An unlisted member's RSVP still
  lands on their PDS, and a reader who asks for it by DID can read it. So a reader should only ask
  about DIDs it knows are members.
- A grant without `action=read_self` cannot read the member's own RSVP back.

## Rerunning and resetting

- The probes reuse their accounts. A `createAccount` 400 on a second run is expected.
- Wait 5 minutes between runs of `probe-events-space.mjs`. The PDS caches the declaration it changes.
- `docker compose $F down -v` resets the network. `data/` outlives it. devnet's init reseeds the
  accounts when `data/` is stale, which gives them new DIDs and a new invite code, so source
  `data/accounts.env` again afterwards.

## Without Docker: dev-env

The typed-scope probe also runs against atproto's in-process network, which builds the PDSes from
this branch. Use it when you want to step through PDS code. This needs a full clone of the branch,
and a fresh shell without the variables from step 2.

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

Without `LEX_AUTHORITY_HANDLE`, the seed reads the authority account from dev-env's introspection
server. Without `PDS_URL`, the probe reads its endpoints from there too.

## What it does not cover

- The PDS still validates space records against a built-in map, not against resolved lexicons (see
  the note in `packages/dev-env/src/service-profile-lexicon.ts`). So a malformed
  `group.opensocial.*` record comes back `validationStatus: unknown` rather than being refused.
- No permission sets. The proposal has none yet, so `include:` scopes are not probed.
- No AppView. Every devnet PDS points its AppView at `https://appview.invalid`.
- The probes call the PDS directly. They don't run an app.

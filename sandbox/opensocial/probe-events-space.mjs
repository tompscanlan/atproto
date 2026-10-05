// probe-events-space.mjs: a group's members-only events space, built the way the atmo spec for
// private events lays it out, under the proposal's own example type (`proposal.md:22`). Then: does
// a bare typed scope widen, for an existing token as well as a new one, when the type's declaration
// gains a collection?
//
// Run against atproto-devnet's spaces overlay only. Every account is a devnet account on localhost;
// nothing reaches a public PDS, PLC or relay.
//
//   L   publish the type's declaration (v1: events and access) into the lexicon authority
//   A0  control: does createSpace accept a type nobody published?
//   A1  createSpace for the events space at key self; a repeat answers SpaceAlreadyExists
//   A2  the space's access/self record; A3 its index entry in members/self
//   B   one public event in the group's repo, one members-only event in the events space
//   X   does the PDS refuse a collection the declaration does not list, for a full-access writer?
//   C   who can list each: anonymous, the group, a listed member, a non-member
//   J   what reaches Jetstream from this run
//   W1  a member's bare typed scope: consent shown, scope granted, and a write it should refuse
//   W2  the declaration gains a collection (v2); wait out the PDS's lexicon refresh interval
//   W3  the W1 token refreshed: scope granted, and the write it refused before
//   W4  a new sign-in with the same bare scope: is consent shown again?
import { createRequire } from 'node:module'
import http from 'node:http'
import path from 'node:path'

const require = createRequire(import.meta.url)
const {
  chromium,
} = require('/home/node/.local/share/mise/installs/npm-playwright/1.63.0/node_modules/playwright')
const ATCUTE =
  '/workspaces/scratch/wt-atmo-events-opensocial/apps/web/node_modules/@atcute'
const { OAuthClient, MemoryStore } = await import(
  `${ATCUTE}/oauth-node-client/dist/index.js`
)
const {
  CompositeDidDocumentResolver,
  LocalActorResolver,
  PlcDidDocumentResolver,
  WellKnownHandleResolver,
} = await import(`${ATCUTE}/identity-resolver/dist/index.js`)

const env = (k, fallback) => {
  const v = process.env[k] ?? fallback
  if (v === undefined) throw new Error(`${k} is required`)
  return v
}
const HOST = env('PDS_URL', 'http://localhost:3010')
const PLC = env('PLC_URL', 'http://localhost:2592')
const JETSTREAM = env('JETSTREAM_URL', 'ws://localhost:6008')
const ALICE_HANDLE = env('ALICE_HANDLE')
const ALICE_PASSWORD = env('ALICE_PASSWORD')
const BOB_HANDLE = env('BOB_HANDLE')
const BOB_PASSWORD = env('BOB_PASSWORD')
const INVITE_CODE = process.env.INVITE_CODE
const GROUP_HANDLE = env('GROUP_HANDLE', 'calendar-group.devnet.test')
const LEX = {
  handle: env('LEX_AUTHORITY_HANDLE'),
  password: env('LEX_AUTHORITY_PASSWORD'),
  did: env('LEX_AUTHORITY_DID'),
}
// The PDS re-fetches a cached lexicon once it is this old (oauth-constants.ts
// LEXICON_REFRESH_FREQUENCY, 5 minutes), plus a margin.
const REFRESH_WAIT_MS = Number(env('REFRESH_WAIT_MS', String(330_000)))

const EVENTS_TYPE = 'group.lexicon.calendar.events'
const UNPUBLISHED_TYPE = 'group.lexicon.calendar.unpublished'
const MEMBERS_TYPE = 'group.opensocial.members'
const EVENT = 'community.lexicon.calendar.event'
const RSVP = 'community.lexicon.calendar.rsvp'
const ACCESS = 'group.opensocial.access'
const SPACE_ENTRY = 'group.opensocial.space'
const MEMBER_LIST = { $type: 'com.atproto.simplespace.defs#memberListPolicy' }
const APP_OPEN = { $type: 'com.atproto.simplespace.defs#open' }
const CALLBACK_PORT = 39419
const REDIRECT = `http://127.0.0.1:${CALLBACK_PORT}/oauth/callback`
const RUN = new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15)
const startedUs = Date.now() * 1000

// Dev passwords are fixed and public, but tokens are not printed either.
const rawLog = console.log
console.log = (...args) =>
  rawLog(
    ...args.map((a) =>
      typeof a === 'string'
        ? a.replace(
            /("(?:token|accessJwt|refreshJwt|credential|access_token|refresh_token)"\s*:\s*")[^"]+"/g,
            '$1<redacted>"',
          )
        : a,
    ),
  )
const log = (s) => console.log(s)
const verdicts = []
const verdict = (id, question, answer) => {
  verdicts.push({ id, question, answer })
  log(`\n### ${id} -> ${answer}\n`)
}
const status = (r) =>
  r.status === 200 ? '200' : `${r.status} ${r.body?.error ?? ''}`.trim()

async function req(label, doFetch, method, nsid, { params, body } = {}) {
  const qs = params ? `?${new URLSearchParams(params)}` : ''
  log(`> ${method} ${nsid}${qs}   (auth: ${label})`)
  if (body) log(`> ${JSON.stringify(body)}`)
  const res = await doFetch(`/xrpc/${nsid}${qs}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let parsed = null
  try {
    parsed = text ? JSON.parse(text) : null
  } catch {
    parsed = text.slice(0, 300)
  }
  log(
    `< HTTP ${res.status} ${typeof parsed === 'string' ? parsed : JSON.stringify(parsed).slice(0, 600)}`,
  )
  return { status: res.status, body: parsed }
}
const anon = (method, nsid, opts) =>
  req('none', (url, init) => fetch(`${HOST}${url}`, init), method, nsid, opts)

async function passwordSession(handle, password, { create } = {}) {
  if (create) {
    const made = await fetch(`${HOST}/xrpc/com.atproto.server.createAccount`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        handle,
        password,
        email: `${handle}@test.com`,
        ...(INVITE_CODE ? { inviteCode: INVITE_CODE } : {}),
      }),
    })
    log(`- createAccount ${handle}: HTTP ${made.status}`)
  }
  const res = await fetch(`${HOST}/xrpc/com.atproto.server.createSession`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier: handle, password }),
  })
  const body = await res.json()
  if (!res.ok) throw new Error(`createSession ${handle}: ${res.status}`)
  log(`- createSession ${handle}: did=${body.did}`)
  return { who: handle.split('.')[0], did: body.did, jwt: body.accessJwt }
}
const asPw = (s, method, nsid, opts) =>
  req(
    `${s.who} password session`,
    (url, init) =>
      fetch(`${HOST}${url}`, {
        ...init,
        headers: { ...init.headers, authorization: `Bearer ${s.jwt}` },
      }),
    method,
    nsid,
    opts,
  )

// ---------- L: the declaration ----------
const declaration = (collections) => ({
  $type: 'com.atproto.lexicon.schema',
  lexicon: 1,
  id: EVENTS_TYPE,
  defs: {
    main: {
      type: 'space',
      description:
        "Sandbox stand-in for the proposal's example calendar space (proposal.md:22). A group's members-only events. Not a published type.",
      key: 'literal:self',
      name: 'Group calendar',
      collections,
    },
  },
})
const lex = await passwordSession(LEX.handle, LEX.password)
const publish = async (collections) => {
  const put = await asPw(lex, 'POST', 'com.atproto.repo.putRecord', {
    body: {
      repo: LEX.did,
      collection: 'com.atproto.lexicon.schema',
      rkey: EVENTS_TYPE,
      record: declaration(collections),
    },
  })
  if (put.status !== 200) throw new Error('publishing the declaration failed')
  log(`- published ${EVENTS_TYPE} with collections ${collections.join(', ')}`)
}
log(`\n## L: publish ${EVENTS_TYPE} v1 (run ${RUN})\n`)
await publish([EVENT, ACCESS])

// ---------- A: provisioning, as the group ----------
const group = await passwordSession(GROUP_HANDLE, 'calendar-group-pass', {
  create: true,
})
const alice = await passwordSession(ALICE_HANDLE, ALICE_PASSWORD)
const bob = await passwordSession(BOB_HANDLE, BOB_PASSWORD)
const GROUP = group.did
const ALICE = alice.did
const EVENTS = `at://${GROUP}/space/${EVENTS_TYPE}/self`
const MEMBERS = `at://${GROUP}/space/${MEMBERS_TYPE}/self`
const createSpace = (spaceType) =>
  asPw(group, 'POST', 'com.atproto.simplespace.createSpace', {
    body: {
      spaceType,
      skey: 'self',
      readPolicy: MEMBER_LIST,
      writePolicy: MEMBER_LIST,
      appAccess: APP_OPEN,
    },
  })
const madeOk = (r) => r.status === 200 || r.body?.error === 'SpaceAlreadyExists'

log('\n## A0: control, a type nobody published\n')
const a0 = await createSpace(UNPUBLISHED_TYPE)
verdict(
  'A0',
  'createSpace refuses a space type whose declaration does not resolve',
  madeOk(a0)
    ? `NO: accepted (${status(a0)}), so the PDS does not look the type up`
    : `YES (${status(a0)})`,
)

log('\n## A1: the events space, and members/self for its index entry\n')
if (!madeOk(await createSpace(MEMBERS_TYPE)))
  throw new Error('members/self failed')
const a1 = await createSpace(EVENTS_TYPE)
const a1again = await createSpace(EVENTS_TYPE)
verdict(
  'A1',
  `createSpace makes ${EVENTS_TYPE}/self, and a repeat is SpaceAlreadyExists`,
  `first ${status(a1)}${a1.body?.uri ? ` ${a1.body.uri}` : ''}; repeat ${status(a1again)}`,
)

log('\n## A2: access/self in the events space\n')
const a2 = await asPw(group, 'POST', 'com.atproto.space.putRecord', {
  body: {
    space: EVENTS,
    repo: GROUP,
    collection: ACCESS,
    rkey: 'self',
    record: { $type: ACCESS, public: false, readRoles: ['member'], grants: [] },
  },
})
verdict('A2', 'the access/self record writes into the events space', status(a2))

log('\n## A3: the index entry in members/self\n')
const a3 = await asPw(group, 'POST', 'com.atproto.space.createRecord', {
  body: {
    space: MEMBERS,
    repo: GROUP,
    collection: SPACE_ENTRY,
    record: {
      $type: SPACE_ENTRY,
      space: EVENTS,
      displayName: 'Calendar',
      createdAt: new Date().toISOString(),
    },
  },
})
verdict('A3', 'the group.opensocial.space index entry writes', status(a3))

// ---------- B: placement ----------
const PUBLIC_NAME = `public event ${RUN}`
const PRIVATE_NAME = `members-only event ${RUN}`
const event = (name) => ({
  $type: EVENT,
  name,
  startsAt: '2026-11-01T18:00:00.000Z',
  mode: 'community.lexicon.calendar.event#inperson',
  status: 'community.lexicon.calendar.event#scheduled',
  createdAt: new Date().toISOString(),
})
log('\n## B: one public event, one members-only event\n')
const b1 = await asPw(group, 'POST', 'com.atproto.repo.createRecord', {
  body: { repo: GROUP, collection: EVENT, record: event(PUBLIC_NAME) },
})
const b2 = await asPw(group, 'POST', 'com.atproto.space.createRecord', {
  body: {
    space: EVENTS,
    repo: GROUP,
    collection: EVENT,
    record: event(PRIVATE_NAME),
  },
})
verdict(
  'B',
  'the public event lands in the repo and the members-only one in the space',
  `repo ${status(b1)} ${b1.body?.uri ?? ''}; space ${status(b2)} ${b2.body?.uri ?? ''}`,
)
const rsvp = (subject) => ({
  $type: RSVP,
  subject: { uri: subject.uri, cid: subject.cid },
  status: 'community.lexicon.calendar.rsvp#going',
  createdAt: new Date().toISOString(),
})

log('\n## X: a collection the v1 declaration does not list, by the group\n')
const x = await asPw(group, 'POST', 'com.atproto.space.createRecord', {
  body: { space: EVENTS, repo: GROUP, collection: RSVP, record: rsvp(b2.body) },
})
verdict(
  'X',
  'a full-access writer is refused a collection the declaration does not list',
  x.status === 200 ? 'NO: written' : `YES (${status(x)})`,
)

// ---------- C: reads ----------
log('\n## C: who can list what\n')
await asPw(group, 'POST', 'com.atproto.simplespace.putMember', {
  body: { space: EVENTS, did: ALICE, read: true, write: true },
})
const names = (r) =>
  (r.body?.records ?? []).map((rec) => rec.value?.name).filter(Boolean)
const listSpace = { space: EVENTS, repo: GROUP, collection: EVENT }
const c1 = await anon('GET', 'com.atproto.repo.listRecords', {
  params: { repo: GROUP, collection: EVENT },
})
const c1names = names(c1)
verdict(
  'C1',
  "an anonymous reader of the group's repo sees the public event and not the members-only one",
  `public ${c1names.includes(PUBLIC_NAME) ? 'seen' : 'NOT seen'}, members-only ${c1names.includes(PRIVATE_NAME) ? 'SEEN' : 'not seen'}`,
)
const c2 = await anon('GET', 'com.atproto.space.listRecords', {
  params: listSpace,
})
verdict('C2', 'an anonymous space.listRecords is refused', status(c2))
const c3 = await asPw(group, 'GET', 'com.atproto.space.listRecords', {
  params: listSpace,
})
verdict(
  'C3',
  "the group's own credential lists the members-only event",
  `${status(c3)}, members-only ${names(c3).includes(PRIVATE_NAME) ? 'seen' : 'NOT seen'}`,
)
const c4 = await asPw(alice, 'GET', 'com.atproto.space.listRecords', {
  params: listSpace,
})
verdict(
  'C4',
  "a listed member's own session lists the group's records in the space",
  `${status(c4)}${c4.status === 200 ? `, members-only ${names(c4).includes(PRIVATE_NAME) ? 'seen' : 'NOT seen'}` : ''}`,
)
const c5 = await asPw(bob, 'GET', 'com.atproto.space.listRecords', {
  params: listSpace,
})
verdict(
  'C5',
  "a non-member's own session lists the group's records in the space",
  `${status(c5)}${c5.status === 200 ? `, members-only ${names(c5).includes(PRIVATE_NAME) ? 'SEEN' : 'not seen'}` : ''}`,
)

// ---------- W: the bare typed scope ----------
const actorResolver = new LocalActorResolver({
  handleResolver: new WellKnownHandleResolver(),
  didDocumentResolver: new CompositeDidDocumentResolver({
    methods: { plc: new PlcDidDocumentResolver({ apiUrl: PLC }) },
  }),
})
const browser = await chromium.launch()

async function oauthFlow(id, scopes) {
  const client = new OAuthClient({
    metadata: { redirect_uris: [REDIRECT], scope: scopes },
    actorResolver,
    stores: {
      sessions: new MemoryStore(),
      states: new MemoryStore({ ttl: 600_000 }),
    },
  })
  // OAuthClient does not pass allowHttp through, and the devnet PDS is plain http.
  client.resolver.protectedResourceResolver.allowHttp = true
  client.resolver.authorizationServerResolver.allowHttp = true
  log(`- [${id}] requested scope: ${scopes.join(' ')}`)
  const auth = await client.authorize({
    target: { type: 'account', identifier: ALICE },
    scope: scopes.join(' '),
  })
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  const p = await ctx.newPage()
  let callbackUrl = null
  let consentShown = false
  const server = http.createServer((rq, rs) => {
    callbackUrl = `http://127.0.0.1:${CALLBACK_PORT}${rq.url}`
    rs.end('ok')
  })
  await new Promise((r) => server.listen(CALLBACK_PORT, '127.0.0.1', r))
  try {
    await p.goto(auth.url.toString(), { waitUntil: 'networkidle', timeout: 60000 })
    if (!callbackUrl) {
      const user = p.locator('input[name=username]')
      if (
        (await user.count()) &&
        (await user.isEditable()) &&
        !(await user.inputValue())
      ) {
        await user.fill(ALICE_HANDLE)
      }
      await p.locator('input[name=password]').fill(ALICE_PASSWORD)
      await p.getByRole('button', { name: 'Sign in' }).click()
      const consentBtn = p
        .getByRole('button', { name: /accept|authorize|allow/i })
        .first()
      for (let i = 0; i < 60 && !callbackUrl; i++) {
        if (await consentBtn.isVisible().catch(() => false)) {
          consentShown = true
          await p.screenshot({
            path: path.join(OUT, `${id}-consent.png`),
            fullPage: true,
          })
          const text = (await p.locator('body').innerText())
            .replace(/\s+/g, ' ')
            .slice(0, 800)
          log(`- [${id}] consent page text: ${text}`)
          await consentBtn.click()
          break
        }
        await p.waitForTimeout(500)
      }
      for (let i = 0; i < 60 && !callbackUrl; i++) await p.waitForTimeout(500)
    }
    if (!callbackUrl) throw new Error(`[${id}] no callback`)
    const params = new URL(callbackUrl).searchParams
    if (params.get('error'))
      throw new Error(
        `[${id}] callback error=${params.get('error')} ${params.get('error_description')}`,
      )
    const { session } = await client.callback(params)
    const info = await session.getTokenInfo(false)
    log(`- [${id}] consent shown: ${consentShown}; granted scope: ${info.scope}`)
    return { session, granted: info.scope, consentShown }
  } finally {
    await ctx.close()
    await new Promise((r) => server.close(r))
  }
}
const OUT =
  process.env.PROBE_OUT ?? path.dirname(new URL(import.meta.url).pathname)
const spaceScopes = (granted) =>
  granted.split(' ').filter((s) => s.startsWith(`space:${EVENTS_TYPE}`))
const aliceRsvp = (id, session) =>
  req(
    `alice OAuth [${id}]`,
    (url, init) => session.handle(url, init),
    'POST',
    'com.atproto.space.createRecord',
    {
      body: { space: EVENTS, repo: ALICE, collection: RSVP, record: rsvp(b2.body) },
    },
  )

const BARE = ['atproto', `space:${EVENTS_TYPE}?authority=${GROUP}`]
let j
try {
  log('\n## W1: a bare typed scope, under the v1 declaration\n')
  const w1 = await oauthFlow('W1', BARE)
  const w1x = await aliceRsvp('W1', w1.session)
  verdict(
    'W1',
    'a bare grant under v1: consent, the scope it carries, and an RSVP write',
    `consent ${w1.consentShown ? 'shown' : 'NOT shown'}; scope ${spaceScopes(w1.granted).join(' ')}; RSVP write ${status(w1x)}`,
  )

  log('\n## W2: the declaration gains community.lexicon.calendar.rsvp\n')
  await publish([EVENT, ACCESS, RSVP])
  log(`- waiting ${REFRESH_WAIT_MS / 1000}s for the PDS's lexicon cache to go stale`)
  await new Promise((r) => setTimeout(r, REFRESH_WAIT_MS))

  log('\n## W3: the W1 token, refreshed\n')
  const w3info = await w1.session.getTokenInfo(true)
  log(`- [W3] refreshed; granted scope: ${w3info.scope}`)
  const w3x = await aliceRsvp('W3', w1.session)
  verdict(
    'W3',
    'the same token after a refresh: the scope it carries, and the RSVP write it was refused',
    `scope ${spaceScopes(w3info.scope).join(' ')}; RSVP write ${status(w3x)}`,
  )

  log('\n## W4: a new sign-in with the same bare scope\n')
  const w4 = await oauthFlow('W4', BARE)
  verdict(
    'W4',
    'a new sign-in with the same bare scope after the declaration widened',
    `consent ${w4.consentShown ? 'shown' : 'NOT shown'}; scope ${spaceScopes(w4.granted).join(' ')}`,
  )
} finally {
  await browser.close()
}

// ---------- J: Jetstream ----------
log('\n## J: what reached Jetstream from this run\n')
const seen = await new Promise((resolve) => {
  const out = []
  const qs = new URLSearchParams({ cursor: String(startedUs - 5_000_000) })
  qs.append('wantedDids', GROUP)
  qs.append('wantedDids', ALICE)
  const ws = new WebSocket(`${JETSTREAM}/subscribe?${qs}`)
  let idle
  const done = () => {
    ws.close()
    resolve(out)
  }
  const bump = () => {
    clearTimeout(idle)
    idle = setTimeout(done, 8000)
  }
  ws.onmessage = (m) => {
    const e = JSON.parse(m.data)
    if (e.kind === 'commit')
      out.push(
        `${e.did === GROUP ? 'group' : 'alice'} ${e.commit.operation} ${e.commit.collection} ${e.commit.record?.name ?? ''}`.trim(),
      )
    bump()
  }
  ws.onerror = () => done()
  bump()
})
for (const s of seen) log(`- ${s}`)
verdict(
  'J',
  'only the public event reaches Jetstream',
  `${seen.length} commits; public event ${seen.some((s) => s.includes(PUBLIC_NAME)) ? 'seen' : 'NOT seen'}; members-only event ${seen.some((s) => s.includes(PRIVATE_NAME)) ? 'SEEN' : 'not seen'}; any space-only collection ${seen.some((s) => /group\.opensocial\.(access|space)|calendar\.rsvp/.test(s)) ? 'SEEN' : 'none'}`,
)

log('\n## verdicts\n')
for (const v of verdicts) log(`- ${v.id}: ${v.question} -> ${v.answer}`)

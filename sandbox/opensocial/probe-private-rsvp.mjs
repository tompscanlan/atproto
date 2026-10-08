// probe-private-rsvp.mjs: a member's RSVP to a members-only event, written by the member into the
// group's events space as a standard community.lexicon.calendar.rsvp. Who can write one, who can
// read one, and does anything reach Jetstream?
//
// Run against atproto-devnet's https devnet, under its scripts/https-run. Every URL comes from the
// devnet's data/devnet.env, and every account is a devnet account on this machine; nothing reaches a
// public PDS, PLC or relay.
//
//   S   the group provisions its members and events spaces and writes a members-only event; the
//       events space lists alice, bob and carol (read and write), and not erin or frank
//   R1  alice (alpha) signs in with an atmo-shaped member grant and writes her RSVP into the space
//   R1p nothing about the RSVP appears in alice's public repo
//   R2  erin (alpha, not listed in the events space) does the same
//   R3  carol (a current release, no spaces) does the same
//   R4  the group, with its own space credential: the writer set, then each RSVP at its author's PDS
//   R5  bob, a listed member, reads alice's RSVP with his own credential
//   R6  frank, not listed, asks for a credential
//   R7  an anonymous read of alice's RSVP
//   R8  alice reads her own RSVP with her OAuth session; R9 she changes it, and the group sees it
//   P   control: a public event, and alice's public RSVP to it, which should reach Jetstream
//   J   what reaches Jetstream from this run
import { createRequire } from 'node:module'
import http from 'node:http'
import path from 'node:path'

import { launchBrowser } from './devnet-browser.mjs'

const require = createRequire(import.meta.url)
const {
  chromium,
} = require(
  process.env.PLAYWRIGHT_MODULE ??
    '/home/node/.local/share/mise/installs/npm-playwright/1.63.0/node_modules/playwright',
)
const ATCUTE =
  process.env.ATCUTE_DIR ??
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
const ALPHA = env('ALPHA_PDS_URL')
const REGULAR = env('REGULAR_PDS_URL')
const PLC = env('PLC_URL')
const JETSTREAM = env('JETSTREAM_URL')
const INVITE_CODE = process.env.INVITE_CODE
const EVENTS_TYPE = env('EVENTS_TYPE', 'net.openmeet.space.events')
const OUT =
  process.env.PROBE_OUT ?? path.dirname(new URL(import.meta.url).pathname)

const MEMBERS_TYPE = 'group.opensocial.members'
const EVENT = 'community.lexicon.calendar.event'
const RSVP = 'community.lexicon.calendar.rsvp'
const ACCESS = 'group.opensocial.access'
const SPACE_ENTRY = 'group.opensocial.space'
const MEMBER_LIST = { $type: 'com.atproto.simplespace.defs#memberListPolicy' }
const APP_OPEN = { $type: 'com.atproto.simplespace.defs#open' }
const CALLBACK_PORT = 39421
const REDIRECT = `http://127.0.0.1:${CALLBACK_PORT}/oauth/callback`
const RUN = new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15)
const startedUs = Date.now() * 1000

// Dev passwords are fixed and public, but tokens and credentials are not printed.
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

async function call(label, base, method, nsid, { params, body, headers } = {}) {
  const qs = params ? `?${new URLSearchParams(params)}` : ''
  log(`> ${method} ${base} ${nsid}${qs}   (auth: ${label})`)
  if (body) log(`> ${JSON.stringify(body)}`)
  const res = await fetch(`${base}/xrpc/${nsid}${qs}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(headers ?? {}),
    },
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

async function account(pds, handle, password, { create } = {}) {
  if (create) {
    const made = await fetch(`${pds}/xrpc/com.atproto.server.createAccount`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        handle,
        password,
        email: `${handle}@devnet.test`,
        ...(INVITE_CODE ? { inviteCode: INVITE_CODE } : {}),
      }),
    })
    log(`- createAccount ${handle} on ${pds}: HTTP ${made.status}`)
  }
  const res = await fetch(`${pds}/xrpc/com.atproto.server.createSession`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier: handle, password }),
  })
  const body = await res.json()
  if (!res.ok) throw new Error(`createSession ${handle}: ${res.status}`)
  log(`- ${handle}: ${body.did} on ${pds}`)
  return { who: handle.split('.')[0], handle, password, pds, did: body.did, jwt: body.accessJwt }
}
const asPw = (s, method, nsid, opts) =>
  call(`${s.who} password session`, s.pds, method, nsid, {
    ...opts,
    headers: { authorization: `Bearer ${s.jwt}` },
  })

// ---------- space credentials (RFC 9421 signatures, as atmo's space-credential.ts) ----------
const b64 = (bytes) => Buffer.from(bytes).toString('base64')
const b58 = (bytes) => {
  const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
  let n = BigInt('0x' + Buffer.from(bytes).toString('hex'))
  let out = ''
  while (n > 0n) {
    out = A[Number(n % 58n)] + out
    n /= 58n
  }
  for (const b of bytes) {
    if (b !== 0) break
    out = '1' + out
  }
  return out
}
async function p256() {
  const pair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign'],
  )
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))
  const compressed = new Uint8Array(33)
  compressed[0] = raw[64] & 1 ? 0x03 : 0x02
  compressed.set(raw.slice(1, 33), 1)
  const keyId = `did:key:z${b58(new Uint8Array([0x80, 0x24, ...compressed]))}`
  const sign = async (data) =>
    new Uint8Array(
      await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, data),
    )
  return { keyId, sign }
}
async function sigHeaders(key, authorization, audience) {
  const params =
    audience === undefined
      ? `("authorization");keyid="${key.keyId}"`
      : '("authorization" "atproto-space-audience")'
  const lines = [`"authorization": ${authorization}`]
  if (audience !== undefined) lines.push(`"atproto-space-audience": ${audience}`)
  lines.push(`"@signature-params": ${params}`)
  const signature = await key.sign(new TextEncoder().encode(lines.join('\n')))
  return {
    authorization,
    ...(audience !== undefined ? { 'atproto-space-audience': audience } : {}),
    'signature-input': `atproto-space=${params}`,
    signature: `atproto-space=:${b64(signature)}:`,
  }
}
// A delegation token from the reader's own PDS, exchanged at the space authority's host.
async function credentialFor(reader, space, authorityHost) {
  const delegated = await asPw(reader, 'GET', 'com.atproto.space.getDelegationToken', {
    params: { space },
  })
  if (delegated.status !== 200) return { refused: `getDelegationToken ${status(delegated)}` }
  const key = await p256()
  const res = await call(`${reader.who} delegation token`, authorityHost, 'POST', 'com.atproto.space.getSpaceCredential', {
    body: { space },
    headers: await sigHeaders(key, `Bearer ${delegated.body.token}`),
  })
  if (res.status !== 200) return { refused: `getSpaceCredential ${status(res)}` }
  return { token: res.body.credential, key, label: `${reader.who} space credential` }
}
// A credential goes out under the Atproto-Space scheme, not Bearer (atmo space-credential.ts).
const withCred = async (cred, base, audience, method, nsid, opts) =>
  call(cred.label, base, method, nsid, {
    ...opts,
    headers: await sigHeaders(cred.key, `Atproto-Space ${cred.token}`, audience),
  })

// ---------- accounts ----------
const group = await account(ALPHA, 'rsvp-group.devnet.test', 'rsvp-group-pass', { create: true })
const alice = await account(ALPHA, env('ALICE_HANDLE'), env('ALICE_PASSWORD'))
const bob = await account(ALPHA, env('BOB_HANDLE'), env('BOB_PASSWORD'))
const erin = await account(ALPHA, 'erin.devnet.test', 'erin-pass', { create: true })
const frank = await account(ALPHA, 'frank.devnet.test', 'frank-pass', { create: true })
const carol = await account(REGULAR, 'carol.regular.devnet.test', 'carol-pass', { create: true })
const GROUP = group.did
const EVENTS = `at://${GROUP}/space/${EVENTS_TYPE}/self`
const MEMBERS = `at://${GROUP}/space/${MEMBERS_TYPE}/self`

// ---------- S: setup ----------
log(`\n## S: provision, one members-only event, list the readers (run ${RUN})\n`)
for (const t of [MEMBERS_TYPE, EVENTS_TYPE]) {
  await asPw(group, 'POST', 'com.atproto.simplespace.createSpace', {
    body: { spaceType: t, skey: 'self', readPolicy: MEMBER_LIST, writePolicy: MEMBER_LIST, appAccess: APP_OPEN },
  })
}
await asPw(group, 'POST', 'com.atproto.space.putRecord', {
  body: {
    space: EVENTS, repo: GROUP, collection: ACCESS, rkey: 'self',
    record: { $type: ACCESS, public: false, readRoles: ['member'], grants: [] },
  },
})
await asPw(group, 'POST', 'com.atproto.space.createRecord', {
  body: {
    space: MEMBERS, repo: GROUP, collection: SPACE_ENTRY,
    record: { $type: SPACE_ENTRY, space: EVENTS, displayName: 'Calendar', createdAt: new Date().toISOString() },
  },
})
const PRIVATE_NAME = `members-only meeting ${RUN}`
const ev = await asPw(group, 'POST', 'com.atproto.space.createRecord', {
  body: {
    space: EVENTS, repo: GROUP, collection: EVENT,
    record: {
      $type: EVENT, name: PRIVATE_NAME, startsAt: '2026-11-01T18:00:00.000Z',
      mode: 'community.lexicon.calendar.event#inperson',
      status: 'community.lexicon.calendar.event#scheduled',
      createdAt: new Date().toISOString(),
    },
  },
})
if (ev.status !== 200) throw new Error('members-only event write failed')
const EVENT_REF = { uri: ev.body.uri, cid: ev.body.cid }
const EVENT_RKEY = ev.body.uri.split('/').pop()
for (const m of [alice, bob, carol]) {
  await asPw(group, 'POST', 'com.atproto.simplespace.putMember', {
    body: { space: EVENTS, did: m.did, read: true, write: true },
  })
}
verdict('S', 'setup', `members-only event ${ev.body.uri}; listed: alice, bob, carol; not listed: erin, frank`)

// ---------- OAuth for the members ----------
const MEMBER_SCOPE = [
  'atproto',
  `space:*?authority=${GROUP}&collection=${RSVP}&action=create&action=update&action=delete`,
]
const actorResolver = new LocalActorResolver({
  handleResolver: new WellKnownHandleResolver(),
  didDocumentResolver: new CompositeDidDocumentResolver({
    methods: { plc: new PlcDidDocumentResolver({ apiUrl: PLC }) },
  }),
})
const browser = await launchBrowser(chromium)
async function oauthFlow(id, who) {
  const client = new OAuthClient({
    metadata: { redirect_uris: [REDIRECT], scope: MEMBER_SCOPE },
    actorResolver,
    stores: { sessions: new MemoryStore(), states: new MemoryStore({ ttl: 600_000 }) },
  })
  const auth = await client.authorize({
    target: { type: 'account', identifier: who.did },
    scope: MEMBER_SCOPE.join(' '),
  })
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  const p = await ctx.newPage()
  let callbackUrl = null
  const server = http.createServer((rq, rs) => {
    callbackUrl = `http://127.0.0.1:${CALLBACK_PORT}${rq.url}`
    rs.end('ok')
  })
  await new Promise((r) => server.listen(CALLBACK_PORT, '127.0.0.1', r))
  try {
    await p.goto(auth.url.toString(), { waitUntil: 'networkidle', timeout: 60000 })
    if (!callbackUrl) {
      const user = p.locator('input[name=username]')
      if ((await user.count()) && (await user.isEditable()) && !(await user.inputValue())) {
        await user.fill(who.handle)
      }
      await p.locator('input[name=password]').fill(who.password)
      await p.getByRole('button', { name: 'Sign in' }).click()
      const consentBtn = p.getByRole('button', { name: /accept|authorize|allow/i }).first()
      for (let i = 0; i < 60 && !callbackUrl; i++) {
        if (await consentBtn.isVisible().catch(() => false)) {
          await p.screenshot({ path: path.join(OUT, `${id}-consent.png`), fullPage: true })
          const text = (await p.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 600)
          log(`- [${id}] consent page text: ${text}`)
          await consentBtn.click()
          break
        }
        await p.waitForTimeout(500)
      }
      for (let i = 0; i < 60 && !callbackUrl; i++) await p.waitForTimeout(500)
    }
    if (!callbackUrl) return { error: 'no callback' }
    const params = new URL(callbackUrl).searchParams
    if (params.get('error')) return { error: `${params.get('error')} ${params.get('error_description')}` }
    const { session } = await client.callback(params)
    const info = await session.getTokenInfo(false)
    log(`- [${id}] granted scope: ${info.scope}`)
    return { session, granted: info.scope }
  } finally {
    await ctx.close()
    await new Promise((r) => server.close(r))
  }
}
// session.handle resolves the PDS itself; wrap it to log like call().
async function viaSession(id, who, session, method, nsid, { params, body } = {}) {
  const qs = params ? `?${new URLSearchParams(params)}` : ''
  log(`> ${method} ${nsid}${qs}   (auth: ${who.who} OAuth [${id}])`)
  if (body) log(`> ${JSON.stringify(body)}`)
  const res = await session.handle(`/xrpc/${nsid}${qs}`, {
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
  log(`< HTTP ${res.status} ${typeof parsed === 'string' ? parsed : JSON.stringify(parsed).slice(0, 600)}`)
  return { status: res.status, body: parsed }
}
const rsvpRecord = (s) => ({
  $type: RSVP,
  subject: EVENT_REF,
  status: `community.lexicon.calendar.rsvp#${s}`,
  createdAt: new Date().toISOString(),
})
const writeRsvp = (id, who, session, s) =>
  viaSession(id, who, session, 'POST', 'com.atproto.space.putRecord', {
    body: { space: EVENTS, repo: who.did, collection: RSVP, rkey: EVENT_RKEY, record: rsvpRecord(s) },
  })

const sessions = {}
try {
  for (const [id, who] of [['R1', alice], ['R2', erin], ['R3', carol]]) {
    log(`\n## ${id}: ${who.handle} RSVPs privately\n`)
    const flow = await oauthFlow(id, who)
    if (!flow.session) {
      verdict(id, `${who.handle} signs in and writes an RSVP into the events space`, `sign-in failed: ${flow.error}`)
      continue
    }
    sessions[who.who] = flow.session
    const w = await writeRsvp(id, who, flow.session, 'going')
    const spaceScope = flow.granted.split(' ').filter((s) => s.startsWith('space:'))
    verdict(
      id,
      `${who.handle} signs in and writes an RSVP into the events space`,
      `scope ${spaceScope.length ? 'granted' : 'DROPPED (atproto only)'}; write ${status(w)}`,
    )
  }
} finally {
  await browser.close()
}

log('\n## R1p: alice public repo\n')
const pub = await call('none', alice.pds, 'GET', 'com.atproto.repo.listRecords', {
  params: { repo: alice.did, collection: RSVP },
})
const pubHits = (pub.body?.records ?? []).filter((r) => r.value?.subject?.uri === EVENT_REF.uri)
verdict('R1p', "alice's public repo holds no RSVP to the members-only event", pubHits.length ? `NO: ${pubHits.length} found` : 'YES, none')

// ---------- R4: the group reads, as atmo would ----------
log('\n## R4: the group reads with its own space credential\n')
const gcred = await credentialFor(group, EVENTS, ALPHA)
let writers = []
let groupSees = {}
if (gcred.refused) {
  verdict('R4', 'the group gets a credential for its events space', `REFUSED: ${gcred.refused}`)
} else {
  const lr = await withCred(gcred, ALPHA, GROUP, 'GET', 'com.atproto.space.listRepos', { params: { space: EVENTS } })
  writers = (lr.body?.repos ?? []).map((r) => r.did)
  const nameOf = (did) => [group, alice, bob, erin, frank, carol].find((a) => a.did === did)?.who ?? did
  for (const m of [alice, erin, carol]) {
    const r = await withCred(gcred, m.pds, m.did, 'GET', 'com.atproto.space.getRecord', {
      params: { space: EVENTS, repo: m.did, collection: RSVP, rkey: EVENT_RKEY },
    })
    groupSees[m.who] = r.status === 200 ? r.body.value.status.split('#')[1] : status(r)
  }
  verdict(
    'R4',
    "the group's credential: the writer set, then each member's RSVP at that member's PDS",
    `listRepos ${status(lr)} [${writers.map(nameOf).join(', ')}]; alice ${groupSees.alice}; erin ${groupSees.erin}; carol ${groupSees.carol}`,
  )
}

log('\n## R5: bob, a listed member, reads alice RSVP\n')
const bcred = await credentialFor(bob, EVENTS, ALPHA)
if (bcred.refused) {
  verdict('R5', "bob reads alice's RSVP with his own credential", `credential REFUSED: ${bcred.refused}`)
} else {
  const r = await withCred(bcred, alice.pds, alice.did, 'GET', 'com.atproto.space.getRecord', {
    params: { space: EVENTS, repo: alice.did, collection: RSVP, rkey: EVENT_RKEY },
  })
  verdict('R5', "bob reads alice's RSVP with his own credential", status(r))
}

log('\n## R6: frank, not listed, asks for a credential\n')
const fcred = await credentialFor(frank, EVENTS, ALPHA)
verdict('R6', 'frank (not listed) is refused a credential', fcred.refused ? `YES (${fcred.refused})` : 'NO: issued')

log('\n## R7: anonymous\n')
const an = await call('none', alice.pds, 'GET', 'com.atproto.space.getRecord', {
  params: { space: EVENTS, repo: alice.did, collection: RSVP, rkey: EVENT_RKEY },
})
verdict('R7', "an anonymous read of alice's RSVP is refused", status(an))

if (sessions.alice) {
  log('\n## R8, R9: alice reads her own RSVP, then changes it\n')
  const own = await viaSession('R8', alice, sessions.alice, 'GET', 'com.atproto.space.getRecord', {
    params: { space: EVENTS, repo: alice.did, collection: RSVP, rkey: EVENT_RKEY },
  })
  verdict('R8', 'alice reads her own RSVP with her OAuth session', `${status(own)}${own.status === 200 ? ` (${own.body.value.status.split('#')[1]})` : ''}`)
  const change = await writeRsvp('R9', alice, sessions.alice, 'notgoing')
  let after = 'not read'
  if (!gcred.refused) {
    const r = await withCred(gcred, alice.pds, alice.did, 'GET', 'com.atproto.space.getRecord', {
      params: { space: EVENTS, repo: alice.did, collection: RSVP, rkey: EVENT_RKEY },
    })
    after = r.status === 200 ? r.body.value.status.split('#')[1] : status(r)
  }
  verdict('R9', 'alice changes her RSVP and the group reads the change', `write ${status(change)}; group now reads ${after}`)
}

// ---------- P: the public control ----------
log('\n## P: a public event and a public RSVP to it\n')
const PUBLIC_NAME = `public meetup ${RUN}`
const pev = await asPw(group, 'POST', 'com.atproto.repo.createRecord', {
  body: {
    repo: GROUP, collection: EVENT,
    record: {
      $type: EVENT, name: PUBLIC_NAME, startsAt: '2026-11-02T18:00:00.000Z',
      mode: 'community.lexicon.calendar.event#inperson',
      status: 'community.lexicon.calendar.event#scheduled',
      createdAt: new Date().toISOString(),
    },
  },
})
const prsvp = await asPw(alice, 'POST', 'com.atproto.repo.createRecord', {
  body: {
    repo: alice.did, collection: RSVP,
    record: { $type: RSVP, subject: { uri: pev.body?.uri, cid: pev.body?.cid }, status: 'community.lexicon.calendar.rsvp#going', createdAt: new Date().toISOString() },
  },
})
verdict('P', 'control: a public event and a public RSVP write', `event ${status(pev)}; RSVP ${status(prsvp)}`)

// ---------- J: Jetstream ----------
log('\n## J: what reached Jetstream from this run\n')
const watched = [group, alice, erin, carol]
const seen = await new Promise((resolve) => {
  const out = []
  const qs = new URLSearchParams({ cursor: String(startedUs - 5_000_000) })
  for (const a of watched) qs.append('wantedDids', a.did)
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
    if (e.kind === 'commit') {
      const who = watched.find((a) => a.did === e.did)?.who ?? e.did
      out.push({ line: `${who} ${e.commit.operation} ${e.commit.collection}`, commit: e.commit })
    }
    bump()
  }
  ws.onerror = () => done()
  bump()
})
// Jetstream's cursor is approximate, so earlier runs' records can show up too. Classify by content.
const isControl = (c) =>
  c.record?.name === PUBLIC_NAME || (pev.body?.uri && c.record?.subject?.uri === pev.body.uri)
const isPrivate = (c) =>
  c.record?.name === PRIVATE_NAME ||
  c.record?.subject?.uri === EVENT_REF.uri ||
  c.collection === ACCESS ||
  c.collection === SPACE_ENTRY
for (const s of seen) log(`- ${s.line}${isControl(s.commit) ? '  [this run, public control]' : isPrivate(s.commit) ? '  [THIS RUN, PRIVATE]' : ''}`)
const control = seen.filter((s) => isControl(s.commit))
const leaked = seen.filter((s) => isPrivate(s.commit))
verdict(
  'J',
  'the public control reaches Jetstream, and nothing from the events space does',
  `${seen.length} commits on the stream; this run's public control: ${control.length} of 2; from the space: ${leaked.length ? `LEAKED ${leaked.map((s) => s.line).join(', ')}` : 'none'}`,
)

log('\n## verdicts\n')
for (const v of verdicts) log(`- ${v.id}: ${v.question} -> ${v.answer}`)

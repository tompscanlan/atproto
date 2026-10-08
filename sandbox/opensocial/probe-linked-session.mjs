// probe-linked-session.mjs: can a group's linked OAuth session, holding exactly the scopes atmo's
// groups branch asks for, provision a members-only events space whose type nobody has published,
// and place events in it? The events-space probe did the same writes with a password session.
//
// Run against atproto-devnet's https devnet, under its scripts/https-run. Every URL comes from the
// devnet's data/devnet.env, and every account is a devnet account on this machine; nothing reaches a
// public PDS, PLC or relay.
//
//   P0  precondition: the events type does not resolve from the lexicon authority
//   S   the group links: sign-in and consent with atmo's group-session scopes
//   L1  members/self, then the events space at key self (a repeat is SpaceAlreadyExists)
//   L2  the events space's access/self record; L3 its index entry in members/self
//   L4  a public event in the group's repo; L5 a members-only event in the events space
//   L6  the linked session lists the members-only event; anonymous readers do not see it
//   L7  the token refreshed, then another members-only write
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
const { OAuthClient, MemoryStore, scope } = await import(
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
const HOST = env('ALPHA_PDS_URL')
const PLC = env('PLC_URL')
const JETSTREAM = env('JETSTREAM_URL')
const INVITE_CODE = process.env.INVITE_CODE
const LEX_DID = env('LEX_AUTHORITY_DID')
const GROUP_HANDLE = env('GROUP_HANDLE', 'linked-group.devnet.test')
const GROUP_PASSWORD = 'linked-group-pass'
const EVENTS_TYPE = env('EVENTS_TYPE', 'net.openmeet.space.events')
const OUT =
  process.env.PROBE_OUT ?? path.dirname(new URL(import.meta.url).pathname)

const MEMBERS_TYPE = 'group.opensocial.members'
const EVENT = 'community.lexicon.calendar.event'
const DECLARATION = 'group.opensocial.declaration'
const ACCESS = 'group.opensocial.access'
const SPACE_ENTRY = 'group.opensocial.space'
const MEMBER_LIST = { $type: 'com.atproto.simplespace.defs#memberListPolicy' }
const APP_OPEN = { $type: 'com.atproto.simplespace.defs#open' }
const CALLBACK_PORT = 39420
const REDIRECT = `http://127.0.0.1:${CALLBACK_PORT}/oauth/callback`
const RUN = new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15)
const startedUs = Date.now() * 1000

// The scope set of atmo-events feat/groups-opensocial afae080,
// apps/web/src/lib/groups/server/linked-session.ts:30-35, built with the same helper.
const GROUP_SESSION_SCOPES = [
  'atproto',
  scope.repo({ collection: [DECLARATION, EVENT] }),
  'space:*?authority=self&manage=create&manage=update&manage=delete',
  'space:*?authority=self&collection=*',
  scope.blob({ accept: ['image/*'] }),
]

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

// ---------- P0 ----------
log(`\n## P0: ${EVENTS_TYPE} is not published (run ${RUN})\n`)
// repo.getRecord, not sync.getRecord: sync answers 200 with a proof of absence.
const p0 = await anon('GET', 'com.atproto.repo.getRecord', {
  params: {
    repo: LEX_DID,
    collection: 'com.atproto.lexicon.schema',
    rkey: EVENTS_TYPE,
  },
})
verdict(
  'P0',
  `the lexicon authority has no declaration for ${EVENTS_TYPE}`,
  p0.status === 200 ? 'NO: it is published, so this run is not the case it means to test' : `YES (${status(p0)})`,
)
if (p0.status === 200) process.exit(2)

// ---------- the group account ----------
const made = await fetch(`${HOST}/xrpc/com.atproto.server.createAccount`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    handle: GROUP_HANDLE,
    password: GROUP_PASSWORD,
    email: `${GROUP_HANDLE}@test.com`,
    ...(INVITE_CODE ? { inviteCode: INVITE_CODE } : {}),
  }),
})
log(`- createAccount ${GROUP_HANDLE}: HTTP ${made.status}`)
const resolved = await anon('GET', 'com.atproto.identity.resolveHandle', {
  params: { handle: GROUP_HANDLE },
})
const GROUP = resolved.body?.did
if (!GROUP) throw new Error('could not resolve the group handle')
const EVENTS = `at://${GROUP}/space/${EVENTS_TYPE}/self`
const MEMBERS = `at://${GROUP}/space/${MEMBERS_TYPE}/self`

// ---------- S: link ----------
const actorResolver = new LocalActorResolver({
  handleResolver: new WellKnownHandleResolver(),
  didDocumentResolver: new CompositeDidDocumentResolver({
    methods: { plc: new PlcDidDocumentResolver({ apiUrl: PLC }) },
  }),
})
const browser = await launchBrowser(chromium)
async function link() {
  const client = new OAuthClient({
    metadata: { redirect_uris: [REDIRECT], scope: GROUP_SESSION_SCOPES },
    actorResolver,
    stores: {
      sessions: new MemoryStore(),
      states: new MemoryStore({ ttl: 600_000 }),
    },
  })
  log(`- requested scope: ${GROUP_SESSION_SCOPES.join(' ')}`)
  const auth = await client.authorize({
    target: { type: 'account', identifier: GROUP },
    scope: GROUP_SESSION_SCOPES.join(' '),
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
      if (
        (await user.count()) &&
        (await user.isEditable()) &&
        !(await user.inputValue())
      ) {
        await user.fill(GROUP_HANDLE)
      }
      await p.locator('input[name=password]').fill(GROUP_PASSWORD)
      await p.getByRole('button', { name: 'Sign in' }).click()
      const consentBtn = p
        .getByRole('button', { name: /accept|authorize|allow/i })
        .first()
      for (let i = 0; i < 60 && !callbackUrl; i++) {
        if (await consentBtn.isVisible().catch(() => false)) {
          await p.screenshot({ path: path.join(OUT, 'S-consent.png'), fullPage: true })
          const text = (await p.locator('body').innerText())
            .replace(/\s+/g, ' ')
            .slice(0, 800)
          log(`- consent page text: ${text}`)
          await consentBtn.click()
          break
        }
        await p.waitForTimeout(500)
      }
      for (let i = 0; i < 60 && !callbackUrl; i++) await p.waitForTimeout(500)
    }
    if (!callbackUrl) {
      const text = (await p.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 400)
      return { error: `no callback; page says: ${text}` }
    }
    const params = new URL(callbackUrl).searchParams
    if (params.get('error'))
      return {
        error: `callback error=${params.get('error')} ${params.get('error_description')}`,
      }
    const { session } = await client.callback(params)
    const info = await session.getTokenInfo(false)
    log(`- granted scope: ${info.scope}`)
    return { session, granted: info.scope }
  } finally {
    await ctx.close()
    await new Promise((r) => server.close(r))
  }
}

let linked
try {
  log('\n## S: the group links with atmo group-session scopes\n')
  linked = await link()
} finally {
  await browser.close()
}
verdict(
  'S',
  "the group signs in and consents with atmo's group-session scopes",
  linked.session ? 'YES' : `NO (${linked.error})`,
)
if (!linked.session) process.exit(1)
const session = linked.session
const asGroup = (method, nsid, opts) =>
  req('group linked OAuth', (url, init) => session.handle(url, init), method, nsid, opts)

// ---------- L: provisioning and placement through the linked session ----------
const createSpace = (spaceType) =>
  asGroup('POST', 'com.atproto.simplespace.createSpace', {
    body: {
      spaceType,
      skey: 'self',
      readPolicy: MEMBER_LIST,
      writePolicy: MEMBER_LIST,
      appAccess: APP_OPEN,
    },
  })
log('\n## L1: members/self, then the events space\n')
const members = await createSpace(MEMBERS_TYPE)
const l1 = await createSpace(EVENTS_TYPE)
const l1again = await createSpace(EVENTS_TYPE)
verdict(
  'L1',
  `the linked session creates ${EVENTS_TYPE}/self (unpublished), and a repeat is SpaceAlreadyExists`,
  `members/self ${status(members)}; events first ${status(l1)}; repeat ${status(l1again)}`,
)

log('\n## L2: access/self in the events space\n')
const l2 = await asGroup('POST', 'com.atproto.space.putRecord', {
  body: {
    space: EVENTS,
    repo: GROUP,
    collection: ACCESS,
    rkey: 'self',
    record: { $type: ACCESS, public: false, readRoles: ['member'], grants: [] },
  },
})
verdict('L2', 'the linked session writes access/self in the events space', status(l2))

log('\n## L3: the index entry in members/self\n')
const l3 = await asGroup('POST', 'com.atproto.space.createRecord', {
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
verdict('L3', 'the linked session writes the index entry', status(l3))

const PUBLIC_NAME = `public event ${RUN}`
const PRIVATE_NAME = `members-only event ${RUN}`
const PRIVATE_AFTER = `members-only event after refresh ${RUN}`
const event = (name) => ({
  $type: EVENT,
  name,
  startsAt: '2026-11-01T18:00:00.000Z',
  mode: 'community.lexicon.calendar.event#inperson',
  status: 'community.lexicon.calendar.event#scheduled',
  createdAt: new Date().toISOString(),
})
const spaceEvent = (name) =>
  asGroup('POST', 'com.atproto.space.createRecord', {
    body: { space: EVENTS, repo: GROUP, collection: EVENT, record: event(name) },
  })
log('\n## L4, L5: one public event, one members-only event\n')
const l4 = await asGroup('POST', 'com.atproto.repo.createRecord', {
  body: { repo: GROUP, collection: EVENT, record: event(PUBLIC_NAME) },
})
verdict('L4', "the linked session writes a public event to the group's repo", status(l4))
const l5 = await spaceEvent(PRIVATE_NAME)
verdict('L5', 'the linked session writes a members-only event into the events space', status(l5))

log('\n## L6: reads\n')
const names = (r) =>
  (r.body?.records ?? []).map((rec) => rec.value?.name).filter(Boolean)
const listSpace = { space: EVENTS, repo: GROUP, collection: EVENT }
const l6 = await asGroup('GET', 'com.atproto.space.listRecords', { params: listSpace })
const l6anonRepo = await anon('GET', 'com.atproto.repo.listRecords', {
  params: { repo: GROUP, collection: EVENT },
})
const l6anonSpace = await anon('GET', 'com.atproto.space.listRecords', {
  params: listSpace,
})
verdict(
  'L6',
  'the linked session reads the members-only event; anonymous readers do not',
  `linked ${status(l6)}, members-only ${names(l6).includes(PRIVATE_NAME) ? 'seen' : 'NOT seen'}; anonymous repo: public ${names(l6anonRepo).includes(PUBLIC_NAME) ? 'seen' : 'NOT seen'}, members-only ${names(l6anonRepo).includes(PRIVATE_NAME) ? 'SEEN' : 'not seen'}; anonymous space ${status(l6anonSpace)}`,
)

log('\n## L7: refresh, then write again\n')
const refreshed = await session.getTokenInfo(true)
log(`- refreshed; granted scope: ${refreshed.scope}`)
const l7 = await spaceEvent(PRIVATE_AFTER)
verdict(
  'L7',
  'after a refresh the token keeps its scope and writes another members-only event',
  `scope ${refreshed.scope === linked.granted ? 'unchanged' : 'CHANGED'}; write ${status(l7)}`,
)

// ---------- J: Jetstream ----------
log('\n## J: what reached Jetstream from this run\n')
const seen = await new Promise((resolve) => {
  const out = []
  const qs = new URLSearchParams({ cursor: String(startedUs - 5_000_000) })
  qs.append('wantedDids', GROUP)
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
        `${e.commit.operation} ${e.commit.collection} ${e.commit.record?.name ?? ''}`.trim(),
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
  `${seen.length} commits; public event ${seen.some((s) => s.includes(PUBLIC_NAME)) ? 'seen' : 'NOT seen'}; members-only events ${seen.some((s) => s.includes('members-only')) ? 'SEEN' : 'not seen'}; access or index entry ${seen.some((s) => /group\.opensocial\.(access|space)/.test(s)) ? 'SEEN' : 'none'}`,
)

log('\n## verdicts\n')
for (const v of verdicts) log(`- ${v.id}: ${v.question} -> ${v.answer}`)

// probe-typed-scope.mjs: once the proposal's lexicons resolve, does a type-narrowed `space:`
// scope get through sign-in, and does it narrow what the session can write?
//
// Run after seed-lexicons.mjs, against bin-multi-pds only. Every account here is a dev-env
// account on localhost with a fixed dev password; nothing reaches a public PDS, PLC or relay.
//
//   T0  control: a scope naming a space type nobody published fails with invalid_scope
//   T1  a typed scope with one collection gets through consent, and its token can write
//       the member's acceptance into the group's members space
//   T2  a bare typed scope (no collection): what consent shows, what the token carries
//   T3  the T1 token cannot write a collection it was not granted
//   K   does the PDS hold createSpace to the declaration's `key: literal:self`?
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

const INTROSPECT = process.env.INTROSPECT_URL ?? 'http://localhost:2581'
const OUT =
  process.env.PROBE_OUT ?? path.dirname(new URL(import.meta.url).pathname)
const MEMBERS_TYPE = 'group.opensocial.members'
const ACC = 'group.opensocial.acceptance'
const MEMBERSHIP = 'group.opensocial.membership'
// `name` in the proposal's members.json, which a typed scope could show at consent
const DECLARED_NAME = 'Group membership and roles'
const POLICY_MEMBER_LIST = 'com.atproto.simplespace.defs#memberListPolicy'
const APP_ACCESS_OPEN = 'com.atproto.simplespace.defs#open'
const CALLBACK_PORT = 39418
const REDIRECT = `http://127.0.0.1:${CALLBACK_PORT}/oauth/callback`

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

const intro = await (await fetch(INTROSPECT)).json()
const HOST = intro.pds.url
const PLC = intro.plc.url
log(`pds1 ${HOST}, plc ${PLC}`)

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
    `< HTTP ${res.status} ${typeof parsed === 'string' ? parsed : JSON.stringify(parsed)}`,
  )
  return { status: res.status, body: parsed }
}

async function passwordSession(handle, password, { create } = {}) {
  if (create) {
    const made = await fetch(`${HOST}/xrpc/com.atproto.server.createAccount`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ handle, password, email: `${handle}@test.com` }),
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

const group = await passwordSession(
  'sandbox-group.test',
  'sandbox-group-pass',
  { create: true },
)
const alice = await passwordSession('alice.test', 'alice-pass')
const GROUP = group.did
const ALICE = alice.did
const MEMBERS = `at://${GROUP}/space/${MEMBERS_TYPE}/self`

// ---------- setup and K ----------
log('\n## setup: the group creates members/self and lists alice as a member\n')
const createSpace = (skey) =>
  asPw(group, 'POST', 'com.atproto.simplespace.createSpace', {
    body: {
      spaceType: MEMBERS_TYPE,
      skey,
      readPolicy: { $type: POLICY_MEMBER_LIST },
      writePolicy: { $type: POLICY_MEMBER_LIST },
      appAccess: { $type: APP_ACCESS_OPEN },
    },
  })
const made = await createSpace('self')
if (made.status !== 200 && made.body?.error !== 'SpaceAlreadyExists') {
  throw new Error('createSpace members/self failed')
}
const off = await createSpace('not-self')
verdict(
  'K',
  "createSpace refuses a skey the declaration's `key: literal:self` does not allow",
  off.status === 200 || off.body?.error === 'SpaceAlreadyExists'
    ? 'NO: accepted, so the declared key is not enforced'
    : `YES (${off.status} ${off.body?.error ?? ''})`,
)
await asPw(group, 'POST', 'com.atproto.simplespace.putMember', {
  body: { space: MEMBERS, did: ALICE, read: true, write: true },
})

// ---------- OAuth ----------
const actorResolver = new LocalActorResolver({
  handleResolver: new WellKnownHandleResolver(),
  didDocumentResolver: new CompositeDidDocumentResolver({
    methods: { plc: new PlcDidDocumentResolver({ apiUrl: PLC }) },
  }),
})
const browser = await chromium.launch()

async function oauthFlow(id, scopes, { shotConsent } = {}) {
  const client = new OAuthClient({
    metadata: { redirect_uris: [REDIRECT], scope: scopes },
    actorResolver,
    stores: {
      sessions: new MemoryStore(),
      states: new MemoryStore({ ttl: 600_000 }),
    },
  })
  // OAuthClient does not pass allowHttp through, and the sandbox PDS is plain http.
  client.resolver.protectedResourceResolver.allowHttp = true
  client.resolver.authorizationServerResolver.allowHttp = true
  log(`- [${id}] requested scope: ${scopes.join(' ')}`)
  let auth
  try {
    auth = await client.authorize({
      target: { type: 'account', identifier: ALICE },
      scope: scopes.join(' '),
    })
  } catch (err) {
    log(`- [${id}] authorize()/PAR FAILED: ${err.name}: ${err.message}`)
    return { error: { step: 'par', message: err.message } }
  }
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 900 },
  })
  const p = await ctx.newPage()
  let callbackUrl = null
  const server = http.createServer((rq, rs) => {
    callbackUrl = `http://127.0.0.1:${CALLBACK_PORT}${rq.url}`
    rs.end('ok')
  })
  await new Promise((r) => server.listen(CALLBACK_PORT, '127.0.0.1', r))
  try {
    await p.goto(auth.url.toString(), {
      waitUntil: 'networkidle',
      timeout: 60000,
    })
    if (!callbackUrl) {
      const pwField = p.locator('input[name=password]')
      if (!(await pwField.count())) {
        const text = (await p.locator('body').innerText())
          .replace(/\s+/g, ' ')
          .slice(0, 400)
        log(`- [${id}] no sign-in form; page says: ${text}`)
        return { error: { step: 'authorize-page', message: text } }
      }
      const user = p.locator('input[name=username]')
      if (
        (await user.count()) &&
        (await user.isEditable()) &&
        !(await user.inputValue())
      ) {
        await user.fill('alice.test')
      }
      await pwField.fill('alice-pass')
      await p.getByRole('button', { name: 'Sign in' }).click()
      const consentBtn = p
        .getByRole('button', { name: /accept|authorize|allow/i })
        .first()
      for (let i = 0; i < 60 && !callbackUrl; i++) {
        if (await consentBtn.isVisible().catch(() => false)) {
          if (shotConsent) {
            await p.screenshot({
              path: path.join(OUT, `${id}-consent.png`),
              fullPage: true,
            })
            const text = (await p.locator('body').innerText())
              .replace(/\s+/g, ' ')
              .slice(0, 1500)
            log(`- [${id}] consent page text: ${text}`)
            const html = await p.content()
            log(
              `- [${id}] declaration name "${DECLARED_NAME}" anywhere in the page: ${html.includes(DECLARED_NAME) ? 'YES' : 'NO'}`,
            )
          }
          await consentBtn.click()
          break
        }
        await p.waitForTimeout(500)
      }
      for (let i = 0; i < 60 && !callbackUrl; i++) await p.waitForTimeout(500)
    }
    if (!callbackUrl) {
      const text = (await p.locator('body').innerText())
        .replace(/\s+/g, ' ')
        .slice(0, 400)
      log(`- [${id}] no callback; page says: ${text}`)
      return { error: { step: 'consent', message: text } }
    }
    const params = new URL(callbackUrl).searchParams
    if (params.get('error')) {
      log(
        `- [${id}] callback error=${params.get('error')} description=${params.get('error_description')}`,
      )
      return {
        error: {
          step: 'callback',
          code: params.get('error'),
          message: params.get('error_description'),
        },
      }
    }
    const { session } = await client.callback(params)
    const info = await session.getTokenInfo(false)
    log(`- [${id}] token issued for ${info.sub}; granted scope: ${info.scope}`)
    return { session, granted: info.scope }
  } finally {
    await ctx.close()
    await new Promise((r) => server.close(r))
  }
}
const asOAuth = (id, session, method, nsid, opts) =>
  req(
    `alice OAuth [${id}]`,
    (url, init) => session.handle(url, init),
    method,
    nsid,
    opts,
  )
const why = (r) =>
  `${r.error.step}: ${r.error.code ?? ''} ${r.error.message ?? ''}`.trim()

try {
  log('\n## T0: control, an unpublished space type\n')
  const t0 = await oauthFlow('T0', [
    'atproto',
    `space:group.opensocial.unpublished?authority=${GROUP}`,
  ])
  verdict(
    'T0',
    'a scope naming an unpublished space type is refused',
    t0.session ? 'NO: it got through' : `YES (${why(t0)})`,
  )

  log('\n## T1: typed scope, one collection\n')
  const t1 = await oauthFlow(
    'T1',
    [
      'atproto',
      `space:${MEMBERS_TYPE}?authority=${GROUP}&skey=self&collection=${ACC}&action=create&action=update&action=delete`,
    ],
    { shotConsent: true },
  )
  verdict(
    'T1',
    'a typed scope naming group.opensocial.members gets through consent',
    t1.session ? 'YES' : `NO (${why(t1)})`,
  )
  if (t1.session) {
    const w = await asOAuth(
      'T1',
      t1.session,
      'POST',
      'com.atproto.space.putRecord',
      {
        body: {
          space: MEMBERS,
          repo: ALICE,
          collection: ACC,
          rkey: 'self',
          record: { $type: ACC, createdAt: new Date().toISOString() },
        },
      },
    )
    verdict(
      'T1w',
      "the T1 token writes alice's acceptance into members/self",
      w.status === 200 ? 'YES' : `NO (${w.status} ${w.body?.error ?? ''})`,
    )

    log('\n## T3: the T1 token and a collection it was not granted\n')
    const x = await asOAuth(
      'T1',
      t1.session,
      'POST',
      'com.atproto.space.createRecord',
      {
        body: {
          space: MEMBERS,
          repo: ALICE,
          collection: MEMBERSHIP,
          rkey: 'probe',
          record: {
            $type: MEMBERSHIP,
            member: ALICE,
            createdAt: new Date().toISOString(),
          },
        },
      },
    )
    verdict(
      'T3',
      'the T1 token is refused a membership write',
      x.status !== 200
        ? `YES (${x.status} ${x.body?.error ?? ''})`
        : 'NO: written',
    )
  }

  log('\n## T2: bare typed scope\n')
  const t2 = await oauthFlow(
    'T2',
    ['atproto', `space:${MEMBERS_TYPE}?authority=${GROUP}`],
    { shotConsent: true },
  )
  verdict(
    'T2',
    'a bare typed scope gets through consent',
    t2.session ? `YES (granted: ${t2.granted})` : `NO (${why(t2)})`,
  )
} finally {
  await browser.close()
}

log('\n## verdicts\n')
for (const v of verdicts) log(`- ${v.id}: ${v.question} -> ${v.answer}`)

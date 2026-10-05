// probe-cross-pds.mjs: can members on other PDS builds join a group hosted on the spaces
// alpha, the way atmo joins them?
//
// Run against atproto-devnet with docker-compose.spaces.yml and docker-compose.multi-pds.yml,
// after seed-lexicons.mjs. The group and alice live on the alpha (:3010), carol on a current
// release (:3020), dave on the production build (:3030). For each member:
//
//   A  the group lists them on its members space (putMember, on the alpha)
//   B  they write their acceptance into the group's space through their own PDS
//   C  they sign in with the typed scope naming group.opensocial.members
//   D  they sign in with atmo's scope today: space:* narrowed to the group and collection
//   Dw the D session writes the acceptance
import { createRequire } from 'node:module'
import http from 'node:http'
import path from 'node:path'

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

const ALPHA = process.env.ALPHA_PDS_URL ?? 'http://localhost:3010'
const PLC = process.env.PLC_URL ?? 'http://localhost:2582'
const INVITE_CODE = process.env.INVITE_CODE
const OUT =
  process.env.PROBE_OUT ?? path.dirname(new URL(import.meta.url).pathname)
const MEMBERS_TYPE = 'group.opensocial.members'
const ACC = 'group.opensocial.acceptance'
const POLICY_MEMBER_LIST = 'com.atproto.simplespace.defs#memberListPolicy'
const APP_ACCESS_OPEN = 'com.atproto.simplespace.defs#open'
const CALLBACK_PORT = 39419
const REDIRECT = `http://127.0.0.1:${CALLBACK_PORT}/oauth/callback`

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
const rows = []

async function req(label, base, doFetch, method, nsid, { params, body } = {}) {
  const qs = params ? `?${new URLSearchParams(params)}` : ''
  log(`> ${method} ${base} ${nsid}${qs}   (auth: ${label})`)
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
const short = (r) =>
  r.status === 200 ? '200' : `${r.status} ${r.body?.error ?? ''}`.trim()

async function account(pds, handle, password, { create, invite } = {}) {
  if (create) {
    const made = await fetch(`${pds}/xrpc/com.atproto.server.createAccount`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        handle,
        password,
        email: `${handle}@devnet.test`,
        ...(invite ? { inviteCode: invite } : {}),
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
  const health = await (await fetch(`${pds}/xrpc/_health`)).json()
  log(`- ${handle}: ${body.did} on ${pds} (${health.version})`)
  return {
    handle,
    password,
    pds,
    version: health.version,
    did: body.did,
    jwt: body.accessJwt,
  }
}
const asPw = (s, method, nsid, opts) =>
  req(
    `${s.handle} password session`,
    s.pds,
    (url, init) =>
      fetch(`${s.pds}${url}`, {
        ...init,
        headers: { ...init.headers, authorization: `Bearer ${s.jwt}` },
      }),
    method,
    nsid,
    opts,
  )

const actorResolver = new LocalActorResolver({
  handleResolver: new WellKnownHandleResolver(),
  didDocumentResolver: new CompositeDidDocumentResolver({
    methods: { plc: new PlcDidDocumentResolver({ apiUrl: PLC }) },
  }),
})

async function oauthFlow(browser, id, who, scopes) {
  const client = new OAuthClient({
    metadata: { redirect_uris: [REDIRECT], scope: scopes },
    actorResolver,
    stores: {
      sessions: new MemoryStore(),
      states: new MemoryStore({ ttl: 600_000 }),
    },
  })
  client.resolver.protectedResourceResolver.allowHttp = true
  client.resolver.authorizationServerResolver.allowHttp = true
  log(`- [${id}] requested scope: ${scopes.join(' ')}`)
  let auth
  try {
    auth = await client.authorize({
      target: { type: 'account', identifier: who.did },
      scope: scopes.join(' '),
    })
  } catch (err) {
    log(`- [${id}] authorize()/PAR FAILED: ${err.name}: ${err.message}`)
    return { error: `par: ${err.message}` }
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
          .slice(0, 300)
        return { error: `authorize page: ${text}` }
      }
      const user = p.locator('input[name=username]')
      if (
        (await user.count()) &&
        (await user.isEditable()) &&
        !(await user.inputValue())
      ) {
        await user.fill(who.handle)
      }
      await pwField.fill(who.password)
      await p.getByRole('button', { name: 'Sign in' }).click()
      const consentBtn = p
        .getByRole('button', { name: /accept|authorize|allow/i })
        .first()
      for (let i = 0; i < 60 && !callbackUrl; i++) {
        if (await consentBtn.isVisible().catch(() => false)) {
          await p.screenshot({
            path: path.join(OUT, `${id}-consent.png`),
            fullPage: true,
          })
          const text = (await p.locator('body').innerText())
            .replace(/\s+/g, ' ')
            .slice(0, 600)
          log(`- [${id}] consent page text: ${text}`)
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
        .slice(0, 300)
      return { error: `no callback: ${text}` }
    }
    const params = new URL(callbackUrl).searchParams
    if (params.get('error')) {
      return {
        error: `${params.get('error')}: ${params.get('error_description')}`,
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
const asOAuth = (id, who, session, method, nsid, opts) =>
  req(
    `${who.handle} OAuth [${id}]`,
    who.pds,
    (url, init) => session.handle(url, init),
    method,
    nsid,
    opts,
  )

// ---------- accounts ----------
const group = await account(
  ALPHA,
  'probe-group.devnet.test',
  'probe-group-pass',
  { create: true, invite: INVITE_CODE },
)
const members = [
  await account(ALPHA, 'alice.devnet.test', 'alice-devnet-pass'),
  await account(
    process.env.REGULAR_PDS_URL ?? 'http://localhost:3020',
    'carol.regular.devnet.test',
    'carol-pass',
    { create: true },
  ),
  await account(
    process.env.PROD_PDS_URL ?? 'http://localhost:3030',
    'dave.prod.devnet.test',
    'dave-pass',
    { create: true },
  ),
]
const GROUP = group.did
const MEMBERS = `at://${GROUP}/space/${MEMBERS_TYPE}/self`

log('\n## setup: the group creates members/self on the alpha\n')
const made = await asPw(group, 'POST', 'com.atproto.simplespace.createSpace', {
  body: {
    spaceType: MEMBERS_TYPE,
    skey: 'self',
    readPolicy: { $type: POLICY_MEMBER_LIST },
    writePolicy: { $type: POLICY_MEMBER_LIST },
    appAccess: { $type: APP_ACCESS_OPEN },
  },
})
if (made.status !== 200 && made.body?.error !== 'SpaceAlreadyExists') {
  throw new Error('createSpace members/self failed')
}

const acceptance = () => ({
  space: MEMBERS,
  collection: ACC,
  rkey: 'self',
  record: { $type: ACC, createdAt: new Date().toISOString() },
})
const browser = await chromium.launch()
try {
  for (const m of members) {
    const tag = m.handle.split('.')[0]
    log(`\n## ${m.handle} (${m.version})\n`)
    const row = { member: `${m.handle} (${m.version})` }
    row.A = short(
      await asPw(group, 'POST', 'com.atproto.simplespace.putMember', {
        body: { space: MEMBERS, did: m.did, read: true, write: true },
      }),
    )
    row.B = short(
      await asPw(m, 'POST', 'com.atproto.space.putRecord', {
        body: { ...acceptance(), repo: m.did },
      }),
    )
    const c = await oauthFlow(browser, `${tag}-C`, m, [
      'atproto',
      `space:${MEMBERS_TYPE}?authority=${GROUP}&skey=self&collection=${ACC}&action=create&action=update&action=delete`,
    ])
    row.C = c.session ? `granted: ${c.granted}` : `refused: ${c.error}`
    const d = await oauthFlow(browser, `${tag}-D`, m, [
      'atproto',
      `space:*?authority=${GROUP}&collection=${ACC}&action=create&action=update&action=delete`,
    ])
    row.D = d.session ? `granted: ${d.granted}` : `refused: ${d.error}`
    if (d.session) {
      row.Dw = short(
        await asOAuth(
          `${tag}-D`,
          m,
          d.session,
          'POST',
          'com.atproto.space.putRecord',
          {
            body: { ...acceptance(), repo: m.did },
          },
        ),
      )
    }
    rows.push(row)
  }
} finally {
  await browser.close()
}

log('\n## results\n')
for (const r of rows) {
  log(`- ${r.member}`)
  for (const k of ['A', 'B', 'C', 'D', 'Dw']) if (r[k]) log(`    ${k}: ${r[k]}`)
}

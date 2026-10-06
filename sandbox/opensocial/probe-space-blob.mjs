// probe-space-blob.mjs: an image for a members-only event. The group uploads a blob and cites it
// only from an event in its calendar space. Who can read the bytes back, does anything public serve
// them, and what happens to a blob nothing cites?
//
// Run against atproto-devnet with the spaces overlay, as atmo's groups e2e fixture group
// (groups-e2e.devnet.test). The probe writes one event under its own rkey and deletes it at the end;
// it never touches the e2e's seed event or the calendar space's member list.
//
//   S   the group signs in through OAuth with atmo's linked-session scopes; the calendar space exists
//   B1  the group uploads two images through that session: A (cited below) and B (cited by nothing)
//   B2  the group writes a members-only event into the calendar space with A as its thumbnail
//   B2p nothing in the group's public repo cites A
//   G1  the group's OAuth session reads A back with space.getBlob (bytes compared)
//   G2  the group's password session does the same (the e2e's stand-in for the OAuth session)
//   G3  the group's own space credential does the same (Atproto-Space)
//   G4  space.listBlobs as the group: A listed, B not
//   P0  control: a public event citing a third image C, so the two public reads below are shown to
//       serve a publicly cited blob (the event is deleted straight after)
//   P1  anonymous com.atproto.sync.getBlob for A
//   P2  anonymous com.atproto.space.getBlob for A
//   P3  anonymous com.atproto.sync.listBlobs for the group: is A's CID listed?
//   P4  alice (alpha, not on the calendar space's member list): space.getBlob with her own session,
//       then a space credential
//   P5  the cdn.bsky.app thumbnail URL atmo builds for a public event's image
//   U1  B, cited by nothing: both getBlob paths, and its row and file in the group's store
//   D1  the group deletes the event: space.getBlob for A, and A's row and file in the store
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import http from 'node:http'
import zlib from 'node:zlib'

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
const ALPHA = env('PDS_URL', 'http://localhost:3010')
const PLC = env('PLC_URL', 'http://localhost:2582')
const PDS_CONTAINER = env('PDS_CONTAINER', 'devnet-spaces-pds-1')
const GROUP_HANDLE = env('GROUP_HANDLE', 'groups-e2e.devnet.test')
const GROUP_PASSWORD = env('E2E_GROUP_PASSWORD')
const CALENDAR_TYPE = env('CALENDAR_TYPE', 'net.openmeet.space.calendar')

const EVENT = 'community.lexicon.calendar.event'
const CALLBACK_PORT = 39422
const REDIRECT = `http://127.0.0.1:${CALLBACK_PORT}/oauth/callback`
const RUN = new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15)
// atmo's groupSessionScopes() (apps/web/src/lib/groups/server/linked-session.ts), written out.
const GROUP_SCOPE = [
  'atproto',
  `repo?collection=group.opensocial.declaration&collection=${EVENT}`,
  'space:*?authority=self&manage=create&manage=update&manage=delete',
  'space:*?authority=self&collection=*',
  'blob?accept=image/*',
]

// Dev passwords are fixed and local, but tokens and credentials are still not printed.
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
const sha = (buf) => createHash('sha256').update(buf).digest('hex').slice(0, 16)

// One request, logged. A non-JSON 200 is a blob: its bytes, type and headers are kept.
async function send(label, url, init) {
  const res = await fetch(url, init)
  const type = res.headers.get('content-type') ?? ''
  if (res.ok && !type.includes('json')) {
    const bytes = Buffer.from(await res.arrayBuffer())
    const hdr = ['content-type', 'content-length', 'content-disposition', 'content-security-policy', 'cache-control', 'x-content-type-options']
      .map((h) => `${h}: ${res.headers.get(h)}`)
      .join(' | ')
    log(`< HTTP ${res.status} <${bytes.length} bytes, sha256 ${sha(bytes)}> ${hdr}`)
    return { status: res.status, bytes, headers: res.headers }
  }
  const text = await res.text()
  let parsed = null
  try {
    parsed = text ? JSON.parse(text) : null
  } catch {
    parsed = text.slice(0, 300)
  }
  log(`< HTTP ${res.status} ${typeof parsed === 'string' ? parsed : JSON.stringify(parsed).slice(0, 600)}`)
  return { status: res.status, body: parsed, headers: res.headers }
}
async function call(label, base, method, nsid, { params, body, headers, raw } = {}) {
  const qs = params ? `?${new URLSearchParams(params)}` : ''
  log(`> ${method} ${base} ${nsid}${qs}   (auth: ${label})`)
  if (body && !raw) log(`> ${JSON.stringify(body)}`)
  return send(label, `${base}/xrpc/${nsid}${qs}`, {
    method,
    headers: {
      ...(body && !raw ? { 'content-type': 'application/json' } : {}),
      ...(headers ?? {}),
    },
    body: raw ?? (body ? JSON.stringify(body) : undefined),
  })
}

async function account(pds, handle, password) {
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
    headers: { authorization: `Bearer ${s.jwt}`, ...(opts?.headers ?? {}) },
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
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign'])
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))
  const compressed = new Uint8Array(33)
  compressed[0] = raw[64] & 1 ? 0x03 : 0x02
  compressed.set(raw.slice(1, 33), 1)
  const keyId = `did:key:z${b58(new Uint8Array([0x80, 0x24, ...compressed]))}`
  const sign = async (data) =>
    new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, data))
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
async function credentialFor(reader, space, authorityHost) {
  const delegated = await asPw(reader, 'GET', 'com.atproto.space.getDelegationToken', { params: { space } })
  if (delegated.status !== 200) return { refused: `getDelegationToken ${status(delegated)}` }
  const key = await p256()
  const res = await call(`${reader.who} delegation token`, authorityHost, 'POST', 'com.atproto.space.getSpaceCredential', {
    body: { space },
    headers: await sigHeaders(key, `Bearer ${delegated.body.token}`),
  })
  if (res.status !== 200) return { refused: `getSpaceCredential ${status(res)}` }
  return { token: res.body.credential, key, label: `${reader.who} space credential` }
}
const withCred = async (cred, base, audience, method, nsid, opts) =>
  call(cred.label, base, method, nsid, {
    ...opts,
    headers: await sigHeaders(cred.key, `Atproto-Space ${cred.token}`, audience),
  })

// ---------- a small PNG whose bytes are unique to this run ----------
function png(seed) {
  const w = 16
  const h = 16
  const raw = Buffer.alloc(h * (1 + w * 3))
  let x = 0
  for (let y = 0; y < h; y++) {
    raw[x++] = 0
    for (let i = 0; i < w; i++) {
      const v = (seed.charCodeAt((y * w + i) % seed.length) * (i + 1) * (y + 1)) & 255
      raw[x++] = v
      raw[x++] = (v * 7) & 255
      raw[x++] = (v * 13) & 255
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(zlib.crc32(td))
    return Buffer.concat([len, td, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('tEXt', Buffer.from(`Comment\0probe-space-blob ${seed}`)),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// ---------- the group's actor store, read-only, inside the PDS container ----------
function storeRows(did, cids) {
  const script = `
const D = require('/app/node_modules/better-sqlite3'); const fs = require('fs'); const path = require('path');
const [did, ...cids] = process.argv.slice(1);
const data = process.env.PDS_DATA_DIRECTORY || '/pds/data';
const blocks = process.env.PDS_BLOBSTORE_DISK_LOCATION || path.join(data, 'blocks');
const tmp = process.env.PDS_BLOBSTORE_DISK_TMP_LOCATION || path.join(blocks, 'tempt');
let file = null;
for (const d of fs.readdirSync(path.join(data, 'actors'))) {
  const c = path.join(data, 'actors', d, did, 'store.sqlite');
  if (fs.existsSync(c)) file = c;
}
const db = new D(file, { readonly: true, fileMustExist: true });
for (const cid of cids) {
  const b = db.prepare('select mimeType, size, tempKey, createdAt from blob where cid = ?').get(cid) ?? null;
  const n = (t) => db.prepare('select count(*) n from ' + t + ' where blobCid = ?').get(cid).n;
  console.log(JSON.stringify({
    cid, blobRow: b && { ...b, tempKey: b.tempKey ? 'set' : null },
    record_blob: n('record_blob'), space_record_blob: n('space_record_blob'),
    storedFile: fs.existsSync(path.join(blocks, did, cid)),
    tempFile: b && b.tempKey ? fs.existsSync(path.join(tmp, did, b.tempKey)) : null,
  }));
}`
  const out = execFileSync('docker', ['exec', PDS_CONTAINER, 'node', '-e', script, did, ...cids], {
    encoding: 'utf8',
  })
  const rows = out.trim().split('\n').map((l) => JSON.parse(l))
  for (const r of rows) log(`- store: ${JSON.stringify(r)}`)
  return Object.fromEntries(rows.map((r) => [r.cid, r]))
}
const rowSummary = (r) =>
  r.blobRow
    ? `row (tempKey ${r.blobRow.tempKey ?? 'null'}), record_blob ${r.record_blob}, space_record_blob ${r.space_record_blob}, stored file ${r.storedFile}, temp file ${r.tempFile}`
    : `no row, stored file ${r.storedFile}`

// ---------- accounts ----------
const group = await account(ALPHA, GROUP_HANDLE, GROUP_PASSWORD)
const alice = await account(ALPHA, env('ALICE_HANDLE'), env('ALICE_PASSWORD'))
const GROUP = group.did
const CALENDAR = `at://${GROUP}/space/${CALENDAR_TYPE}/self`

log(`\n## S: the calendar space, and the group's OAuth session (run ${RUN})\n`)
const space = await asPw(group, 'GET', 'com.atproto.simplespace.getSpace', { params: { space: CALENDAR } })
if (space.status !== 200) throw new Error(`no calendar space at ${CALENDAR}; run the groups e2e once first`)

const actorResolver = new LocalActorResolver({
  handleResolver: new WellKnownHandleResolver(),
  didDocumentResolver: new CompositeDidDocumentResolver({
    methods: { plc: new PlcDidDocumentResolver({ apiUrl: PLC }) },
  }),
})
const browser = await chromium.launch()
async function oauthFlow(id, who) {
  const client = new OAuthClient({
    metadata: { redirect_uris: [REDIRECT], scope: GROUP_SCOPE },
    actorResolver,
    stores: { sessions: new MemoryStore(), states: new MemoryStore({ ttl: 600_000 }) },
  })
  client.resolver.protectedResourceResolver.allowHttp = true
  client.resolver.authorizationServerResolver.allowHttp = true
  const auth = await client.authorize({
    target: { type: 'account', identifier: who.did },
    scope: GROUP_SCOPE.join(' '),
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
async function viaSession(id, session, method, nsid, { params, body, raw, type } = {}) {
  const qs = params ? `?${new URLSearchParams(params)}` : ''
  log(`> ${method} ${nsid}${qs}   (auth: group OAuth [${id}])`)
  if (body) log(`> ${JSON.stringify(body)}`)
  const res = await session.handle(`/xrpc/${nsid}${qs}`, {
    method,
    headers: raw ? { 'content-type': type } : body ? { 'content-type': 'application/json' } : {},
    body: raw ?? (body ? JSON.stringify(body) : undefined),
  })
  const ctype = res.headers.get('content-type') ?? ''
  if (res.ok && !ctype.includes('json')) {
    const bytes = Buffer.from(await res.arrayBuffer())
    log(`< HTTP ${res.status} <${bytes.length} bytes, sha256 ${sha(bytes)}> content-type: ${ctype} | content-disposition: ${res.headers.get('content-disposition')} | cache-control: ${res.headers.get('cache-control')}`)
    return { status: res.status, bytes }
  }
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

let flow
try {
  flow = await oauthFlow('S', group)
} finally {
  await browser.close()
}
if (!flow.session) throw new Error(`group sign-in failed: ${flow.error}`)
const os = flow.session
verdict('S', 'the calendar space exists and the group signs in with atmo scopes', `getSpace 200 (read policy ${space.body?.readPolicy?.$type}); granted: ${flow.granted}`)

// ---------- B1, B2: upload, then cite A only from the space ----------
log('\n## B1: upload A and B through the OAuth session\n')
const bytesA = png(`A ${RUN}`)
const bytesB = png(`B ${RUN}`)
log(`- A: ${bytesA.length} bytes, sha256 ${sha(bytesA)}; B: ${bytesB.length} bytes, sha256 ${sha(bytesB)}`)
const upA = await viaSession('B1', os, 'POST', 'com.atproto.repo.uploadBlob', { raw: bytesA, type: 'image/png' })
const upB = await viaSession('B1', os, 'POST', 'com.atproto.repo.uploadBlob', { raw: bytesB, type: 'image/png' })
if (upA.status !== 200 || upB.status !== 200) throw new Error('uploadBlob failed')
const blobA = upA.body.blob
const blobB = upB.body.blob
const CID_A = blobA.ref.$link
const CID_B = blobB.ref.$link
verdict('B1', 'the group uploads two images with its OAuth session', `A ${CID_A} (${blobA.mimeType}, ${blobA.size}); B ${CID_B}`)

log('\n## B2: a members-only event in the calendar space, A as its thumbnail\n')
const RKEY = `blobspike${RUN.toLowerCase()}`
const record = {
  $type: EVENT,
  name: `members-only image probe ${RUN}`,
  startsAt: '2026-11-01T18:00:00.000Z',
  mode: `${EVENT}#inperson`,
  status: `${EVENT}#scheduled`,
  createdAt: new Date().toISOString(),
  media: [{ role: 'thumbnail', content: blobA, aspect_ratio: { width: 16, height: 16 } }],
}
const put = await viaSession('B2', os, 'POST', 'com.atproto.space.putRecord', {
  body: { space: CALENDAR, repo: GROUP, collection: EVENT, rkey: RKEY, record },
})
verdict('B2', 'the group writes the event into the calendar space citing A', `putRecord ${status(put)} ${put.body?.uri ?? ''}`)
if (put.status !== 200) throw new Error('space write failed')

try {
  log('\n## B2p: the group public repo\n')
  const pub = await call('none', ALPHA, 'GET', 'com.atproto.repo.listRecords', { params: { repo: GROUP, collection: EVENT, limit: '100' } })
  const cites = (pub.body?.records ?? []).filter((r) => JSON.stringify(r.value).includes(CID_A))
  verdict('B2p', "nothing in the group's public repo cites A", cites.length ? `NO: ${cites.map((r) => r.uri).join(', ')}` : `YES, none of ${pub.body?.records?.length ?? '?'} public events`)

  // ---------- G: the group reads A back ----------
  const want = sha(bytesA)
  const same = (r) => (r.status === 200 ? (sha(r.bytes) === want ? '200, bytes match' : `200, BYTES DIFFER (${sha(r.bytes)})`) : status(r))
  const q = { space: CALENDAR, repo: GROUP, cid: CID_A }

  log('\n## G1: the OAuth session reads A\n')
  const g1 = await viaSession('G1', os, 'GET', 'com.atproto.space.getBlob', { params: q })
  verdict('G1', 'the group OAuth session reads A with space.getBlob', same(g1))

  log('\n## G2: the password session reads A\n')
  const g2 = await asPw(group, 'GET', 'com.atproto.space.getBlob', { params: q })
  verdict('G2', 'the group password session reads A with space.getBlob', same(g2))

  log('\n## G3: the group space credential reads A\n')
  const gcred = await credentialFor(group, CALENDAR, ALPHA)
  if (gcred.refused) {
    verdict('G3', 'the group space credential reads A', `credential REFUSED: ${gcred.refused}`)
  } else {
    const g3 = await withCred(gcred, ALPHA, GROUP, 'GET', 'com.atproto.space.getBlob', { params: q })
    const g3b = await call('group space credential as Bearer', ALPHA, 'GET', 'com.atproto.space.getBlob', {
      params: q,
      headers: { authorization: `Bearer ${gcred.token}` },
    })
    verdict('G3', 'the group space credential reads A (Atproto-Space; then the same credential as Bearer)', `Atproto-Space ${same(g3)}; Bearer ${status(g3b)}`)
  }

  log('\n## G4: listBlobs as the group\n')
  const g4 = await viaSession('G4', os, 'GET', 'com.atproto.space.listBlobs', { params: { space: CALENDAR, repo: GROUP } })
  const listed = g4.body?.cids ?? []
  verdict('G4', 'space.listBlobs lists A and not B', `${status(g4)}; A ${listed.includes(CID_A) ? 'listed' : 'NOT listed'}; B ${listed.includes(CID_B) ? 'LISTED' : 'not listed'}; ${listed.length} cids`)

  // ---------- P: public and outside readers ----------
  // P0 is the control: the same two public reads must serve a blob that a PUBLIC record cites,
  // or a refusal of A below says nothing.
  log('\n## P0: control, a public event citing C\n')
  const bytesC = png(`C ${RUN}`)
  const upC = await viaSession('P0', os, 'POST', 'com.atproto.repo.uploadBlob', { raw: bytesC, type: 'image/png' })
  const CID_C = upC.body?.blob?.ref?.$link
  const pubEv = await viaSession('P0', os, 'POST', 'com.atproto.repo.putRecord', {
    body: { repo: GROUP, collection: EVENT, rkey: RKEY, record: { ...record, name: `public control ${RUN}`, media: [{ role: 'thumbnail', content: upC.body.blob, aspect_ratio: { width: 16, height: 16 } }] } },
  })
  try {
    const c1 = await call('none', ALPHA, 'GET', 'com.atproto.sync.getBlob', { params: { did: GROUP, cid: CID_C } })
    const c2 = await call('none', ALPHA, 'GET', 'com.atproto.sync.listBlobs', { params: { did: GROUP, limit: '1000' } })
    verdict('P0', 'control: a public event cites C; anonymous sync.getBlob and sync.listBlobs', `public write ${status(pubEv)}; sync.getBlob ${c1.status === 200 ? (sha(c1.bytes) === sha(bytesC) ? '200, bytes match' : '200, BYTES DIFFER') : status(c1)}; sync.listBlobs ${(c2.body?.cids ?? []).includes(CID_C) ? 'lists C' : 'does NOT list C'}`)
  } finally {
    await viaSession('P0', os, 'POST', 'com.atproto.repo.deleteRecord', { body: { repo: GROUP, collection: EVENT, rkey: RKEY } })
  }

  log('\n## P1: anonymous sync.getBlob\n')
  const p1 = await call('none', ALPHA, 'GET', 'com.atproto.sync.getBlob', { params: { did: GROUP, cid: CID_A } })
  verdict('P1', 'anonymous com.atproto.sync.getBlob for A', status(p1))

  log('\n## P2: anonymous space.getBlob\n')
  const p2 = await call('none', ALPHA, 'GET', 'com.atproto.space.getBlob', { params: q })
  verdict('P2', 'anonymous com.atproto.space.getBlob for A', status(p2))

  log('\n## P3: anonymous sync.listBlobs\n')
  let cursor
  let all = []
  for (let i = 0; i < 20; i++) {
    const r = await call('none', ALPHA, 'GET', 'com.atproto.sync.listBlobs', { params: { did: GROUP, limit: '1000', ...(cursor ? { cursor } : {}) } })
    all = all.concat(r.body?.cids ?? [])
    cursor = r.body?.cursor
    if (!cursor) break
  }
  verdict('P3', "anonymous sync.listBlobs for the group: A's CID listed?", `${all.includes(CID_A) ? 'LISTED' : 'not listed'} (${all.length} public cids)`)

  log('\n## P4: alice, not on the calendar space member list\n')
  const p4a = await asPw(alice, 'GET', 'com.atproto.space.getBlob', { params: q })
  const acred = await credentialFor(alice, CALENDAR, ALPHA)
  verdict('P4', 'alice reads A with her own session, then asks for a credential', `own session ${status(p4a)}; credential ${acred.refused ?? 'GRANTED'}`)

  log('\n## P5: the cdn.bsky.app thumbnail URL\n')
  const cdn = `https://cdn.bsky.app/img/feed_thumbnail/plain/${GROUP}/${CID_A}@webp`
  log(`> GET ${cdn}`)
  const p5 = await fetch(cdn).then(async (r) => ({ status: r.status, text: (await r.text()).slice(0, 200) })).catch((e) => ({ status: 'error', text: String(e) }))
  log(`< ${p5.status} ${p5.text}`)
  verdict('P5', 'the cdn.bsky.app URL atmo builds for a public event image', `${p5.status}`)

  // ---------- U1: B, cited by nothing ----------
  log('\n## U1: B, cited by nothing\n')
  const u1a = await call('none', ALPHA, 'GET', 'com.atproto.sync.getBlob', { params: { did: GROUP, cid: CID_B } })
  const u1b = await viaSession('U1', os, 'GET', 'com.atproto.space.getBlob', { params: { space: CALENDAR, repo: GROUP, cid: CID_B } })
  const rowsBefore = storeRows(GROUP, [CID_A, CID_B])
  verdict('U1', 'B, cited by nothing: sync.getBlob, space.getBlob as the group, and the store', `sync ${status(u1a)}; space ${status(u1b)}; store: ${rowSummary(rowsBefore[CID_B])}`)
  verdict('U1a', 'A while cited by the space event: the store', rowSummary(rowsBefore[CID_A]))
} finally {
  // ---------- D1: delete the event ----------
  log('\n## D1: the group deletes the event\n')
  const del = await viaSession('D1', os, 'POST', 'com.atproto.space.deleteRecord', {
    body: { space: CALENDAR, repo: GROUP, collection: EVENT, rkey: RKEY },
  })
  const after = await viaSession('D1', os, 'GET', 'com.atproto.space.getBlob', { params: { space: CALENDAR, repo: GROUP, cid: CID_A } })
  const rowsAfter = storeRows(GROUP, [CID_A, CID_B])
  verdict('D1', 'after the event is deleted: space.getBlob for A, and the store', `delete ${status(del)}; getBlob ${status(after)}; A: ${rowSummary(rowsAfter[CID_A])}; B: ${rowSummary(rowsAfter[CID_B])}`)
}

log('\n## Verdicts\n')
for (const v of verdicts) log(`- ${v.id}: ${v.question} -> ${v.answer}`)

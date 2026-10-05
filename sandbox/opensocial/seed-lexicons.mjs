// seed-lexicons.mjs: publish the opensocial.group proposal's lexicons into the dev-env lexicon
// authority, then fetch each one back the way the PDS's lexicon resolver does.
//
// Run against `bin-multi-pds` only. Its introspection server hands out the authority account's
// login, and every dev-env PDS resolves every NSID from that account.
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

const INTROSPECT = process.env.INTROSPECT_URL ?? 'http://localhost:2581'
const DIR =
  process.env.PROPOSAL_LEXICONS ??
  '/workspaces/scratch/opensocial-proposal/lexicons'

const walk = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name)
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.json') ? [p] : []
  })

const xrpc = async (base, nsid, { jwt, params, body } = {}) => {
  const qs = params ? `?${new URLSearchParams(params)}` : ''
  const res = await fetch(`${base}/xrpc/${nsid}${qs}`, {
    method: body ? 'POST' : 'GET',
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(jwt ? { authorization: `Bearer ${jwt}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const json = await res.json().catch(() => null)
  return { status: res.status, body: json }
}

let rev = 'unknown'
try {
  rev = execFileSync('git', ['-C', DIR, 'rev-parse', '--short', 'HEAD'])
    .toString()
    .trim()
} catch {}

const intro = await (await fetch(INTROSPECT)).json()
const auth = intro.lexiconAuthority
if (!auth) {
  console.log(`no lexiconAuthority at ${INTROSPECT}; is bin-multi-pds running?`)
  process.exit(2)
}
const pds = intro.pds.url
console.log(`proposal ${DIR} @ ${rev}`)
console.log(`authority ${auth.handle} (${auth.did}) on ${auth.pds}`)

const session = await xrpc(auth.pds, 'com.atproto.server.createSession', {
  body: { identifier: auth.handle, password: auth.password },
})
if (session.status !== 200) {
  console.log(
    `createSession: HTTP ${session.status} ${JSON.stringify(session.body)}`,
  )
  process.exit(3)
}
const jwt = session.body.accessJwt

const files = walk(DIR).sort()
const rows = []
for (const file of files) {
  const doc = JSON.parse(readFileSync(file, 'utf8'))
  const put = await xrpc(auth.pds, 'com.atproto.repo.putRecord', {
    jwt,
    body: {
      repo: auth.did,
      collection: 'com.atproto.lexicon.schema',
      rkey: doc.id,
      record: { $type: 'com.atproto.lexicon.schema', ...doc },
    },
  })
  // The PDS proxies resolveLexicon to an AppView, which the sandbox lacks. Its own lexicon
  // resolver fetches the schema record with sync.getRecord, so check that path instead.
  const resolved = await xrpc(auth.pds, 'com.atproto.sync.getRecord', {
    params: {
      did: auth.did,
      collection: 'com.atproto.lexicon.schema',
      rkey: doc.id,
    },
  })
  rows.push({
    nsid: doc.id,
    put:
      put.status === 200
        ? (put.body.validationStatus ?? 'ok')
        : `HTTP ${put.status} ${put.body?.error ?? ''} ${put.body?.message ?? ''}`.trim(),
    resolve:
      resolved.status === 200
        ? 'ok'
        : `HTTP ${resolved.status} ${resolved.body?.error ?? ''} ${resolved.body?.message ?? ''}`.trim(),
  })
}

const width = Math.max(...rows.map((r) => r.nsid.length))
for (const r of rows) {
  console.log(
    `${r.nsid.padEnd(width)}  put: ${r.put.padEnd(8)}  fetch: ${r.resolve}`,
  )
}
const putOk = rows.filter((r) => !r.put.startsWith('HTTP')).length
const resolveOk = rows.filter((r) => r.resolve === 'ok').length
console.log(
  `\n${files.length} files, ${putOk} written, ${resolveOk} fetchable by sync.getRecord`,
)
process.exit(putOk === files.length && resolveOk === files.length ? 0 : 1)

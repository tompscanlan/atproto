// devnet-browser.mjs: a Chromium for atproto-devnet's https devnet. Under scripts/https-run, Node
// trusts the devnet's CA through NODE_EXTRA_CA_CERTS, but Chromium does not read it, and the hosts
// file https-run makes lists each handle by name, so a handle made after it was written does not
// resolve. Chromium gets two launch args instead:
//
//   --host-resolver-rules              the devnet's names resolve to 127.0.0.1, where its nginx
//                                      answers: the three PDSes and every handle under them (by
//                                      wildcard), plc.directory, and apps under .devnet.internal
//   --ignore-certificate-errors-spki-list
//                                      trust exactly the key of the devnet's leaf certificate, and
//                                      no other certificate error
//
// The leaf is DEVNET_LEAF_FILE, or else leaf.crt beside DEVNET_CA_FILE (both in the devnet's
// data/https/, and devnet.env sets DEVNET_CA_FILE). Nothing here reads env at import time.
import { X509Certificate, createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const DEVNET_NAMES = [
  'alpha.devnet.test',
  'regular.devnet.test',
  'prod.devnet.test',
  '*.devnet.test',
  '*.regular.devnet.test',
  '*.prod.devnet.test',
  'plc.directory',
  '*.devnet.internal',
]

// The base64 SHA-256 of the certificate's DER SubjectPublicKeyInfo, the form Chromium's
// --ignore-certificate-errors-spki-list takes.
export function leafSpki(certPath) {
  const cert = new X509Certificate(readFileSync(certPath))
  return createHash('sha256')
    .update(cert.publicKey.export({ type: 'spki', format: 'der' }))
    .digest('base64')
}

function leafFile() {
  if (process.env.DEVNET_LEAF_FILE) return process.env.DEVNET_LEAF_FILE
  if (process.env.DEVNET_CA_FILE) {
    return path.join(path.dirname(process.env.DEVNET_CA_FILE), 'leaf.crt')
  }
  throw new Error('DEVNET_LEAF_FILE is required')
}

export async function launchBrowser(chromium) {
  const args = [
    `--host-resolver-rules=${DEVNET_NAMES.map((n) => `MAP ${n} 127.0.0.1`).join(', ')}`,
    `--ignore-certificate-errors-spki-list=${leafSpki(leafFile())}`,
  ]
  return chromium.launch({ args })
}

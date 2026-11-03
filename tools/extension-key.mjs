#!/usr/bin/env node
// Generates (once) or reuses the private extension signing key OUTSIDE the repo,
// and prints the public "key" for manifest.json plus the derived extension ID.
//
// Key location: $TRACKLET_KEY_PATH or ~/.tracklet/extension-key.pem
// Usage:  node tools/extension-key.mjs            -> print public key + ID
//         node tools/extension-key.mjs --write    -> also write extension/manifest.key.json
import { generateKeyPairSync, createPrivateKey, createPublicKey, createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const keyPath = process.env.TRACKLET_KEY_PATH ?? join(homedir(), '.tracklet', 'extension-key.pem');
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

if (resolve(keyPath).startsWith(repoRoot)) {
  console.error(`Refusing: key path ${keyPath} is inside the repository.`);
  process.exit(1);
}

let privatePem;
if (existsSync(keyPath)) {
  privatePem = readFileSync(keyPath, 'utf8');
} else {
  mkdirSync(dirname(keyPath), { recursive: true });
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  writeFileSync(keyPath, privatePem, { mode: 0o600 });
  console.error(`Generated new private key at ${keyPath} (keep it private; back it up).`);
}

const spkiDer = createPublicKey(createPrivateKey(privatePem)).export({ type: 'spki', format: 'der' });
const publicKeyB64 = spkiDer.toString('base64');
// Chrome extension ID = first 128 bits of SHA-256(SPKI DER), hex digits mapped 0-f -> a-p.
const id = createHash('sha256').update(spkiDer).digest('hex').slice(0, 32)
  .replace(/[0-9a-f]/g, (c) => String.fromCharCode('a'.charCodeAt(0) + parseInt(c, 16)));

if (process.argv.includes('--write')) {
  writeFileSync(join(repoRoot, 'extension', 'manifest.key.json'),
    JSON.stringify({ key: publicKeyB64, extensionId: id }, null, 2) + '\n');
}
console.log(JSON.stringify({ extensionId: id, keyPath, publicKey: publicKeyB64 }, null, 2));

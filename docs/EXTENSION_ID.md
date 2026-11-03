# Stable extension ID (Q15: local key)

| Item | Value |
|---|---|
| Extension ID | `hhejoehmmjbjahinnpgnfhfakbkhilcd` |
| Public key | `extension/manifest.key.json` → `key` (committed; public by design) |
| Private key | `~/.tracklet/extension-key.pem` (**outside the repo**; never commit, publish or share) |

## How the ID is derived
Chrome derives the ID from the manifest `"key"` (the SPKI DER public key, base64). The ID is the first 128 bits of SHA-256(DER), with hex digits `0–f` mapped to letters `a–p`. `extension/manifest.test.ts` re-derives the ID from the committed key on every test run, so the recorded ID can't drift.

## Keeping the ID stable across builds
- Every build injects `extension/manifest.key.json`'s `key` into `dist/manifest.json` (see `extension/vite.config.ts`). Load `extension/dist` unpacked: the ID stays the same on every machine, every build and every reload.
- The **private** key is only needed to produce a signed `.crx` or to prove ownership later. Unpacked loading and the OAuth Chrome Extension client need only the public key and ID.
- `node tools/extension-key.mjs` reuses the existing private key if it exists. It refuses to write a key inside the repo, and with `--write` it regenerates `manifest.key.json` from it.

## Protecting the private key
- `.gitignore` blocks `*.pem`, `*.key`, `*.p12`, `*.crx` and `extension-key*`. `npm run secret-scan` fails if a private-key block or key-like file is tracked or built.
- Back up `~/.tracklet/extension-key.pem` to a private location, such as a password manager attachment. If it's lost, the ID survives (the public key is committed), but you can't sign a CRX with the same ID.
- If it leaks: generate a new key (delete the PEM and run `node tools/extension-key.mjs --write`). That gives a **new ID**, so the OAuth client's Item ID must be updated.

## OAuth client
Use the ID above as the **Item ID** when creating the Chrome Extension OAuth client (`SETUP_GOOGLE_CLOUD.md` §E-1).

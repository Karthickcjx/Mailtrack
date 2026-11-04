// Static guards for product extension code (Trusted Types safety, no dynamic code, approved scopes only).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = __dirname;
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f) && !f.endsWith('testPlatform.ts') ? [p] : [];
  });
}
const product = files(SRC).map((p) => ({ name: relative(SRC, p).replace(/\\/g, '/'), code: readFileSync(p, 'utf8').replace(/^\s*\/\/.*$/gm, '') }));

describe('static guards (product extension code)', () => {
  it('finds the product sources', () => {
    const names = product.map((f) => f.name);
    for (const n of ['content.ts', 'background.ts', 'messages.ts', 'gmail/native-adapter.ts', 'ui/dashboard.tsx', 'ui/popup.tsx']) expect(names).toContain(n);
  });

  it.each(product)('$name: no HTML string sinks, no dynamic code, no Trusted Types policies', ({ code }) => {
    expect(code).not.toMatch(/\.(innerHTML|outerHTML)\s*=[^=]/);
    expect(code).not.toMatch(/insertAdjacentHTML|document\.write|dangerouslySetInnerHTML|createContextualFragment|DOMParser/);
    expect(code).not.toMatch(/\beval\s*\(|new\s+Function\s*\(|setTimeout\(\s*['"`]|setInterval\(\s*['"`]/);
    expect(code).not.toMatch(/trustedTypes|createPolicy/);
  });

  it.each(product)('$name: no jQuery / gmail.js / InboxSDK / page-world injection', ({ code }) => {
    expect(code).not.toMatch(/from ['"](jquery|gmail-js|@inboxsdk)|require\(['"](jquery|gmail-js)/);
    expect(code).not.toMatch(/world\s*:\s*['"]MAIN|chrome\.scripting|getAccounts/);
  });

  it.each(product)('$name: never logs tokens or full errors', ({ code }) => {
    expect(code).not.toMatch(/console\.(log|info|debug)\(/);
    expect(code).not.toMatch(/console\.\w+\([^)]*\b(token|access_token|session_token|authorization)\b/i);
  });

  it('only the three approved OAuth scopes appear in product code', () => {
    const scopes = new Set(product.flatMap((f) => f.code.match(/https:\/\/www\.googleapis\.com\/auth\/[a-z.]+/g) ?? []));
    for (const s of scopes) expect(['https://www.googleapis.com/auth/userinfo.email', 'https://www.googleapis.com/auth/gmail.send']).toContain(s);
  });

  it('the Gmail content script talks only to the service worker (no network, no storage of tokens)', () => {
    const c = product.find((f) => f.name === 'content.ts')!.code;
    expect(c).not.toMatch(/\bfetch\(|XMLHttpRequest|WebSocket|chrome\.identity|chrome\.storage|navigator\.sendBeacon/);
    expect(c).toMatch(/new NativeDomAdapter\(document, false\)/);   // product mode: untracked rows unmarked
  });

  it('interactive sign-in is reachable only from extension pages', () => {
    const msgs = product.find((f) => f.name === 'messages.ts')!.code;
    const content = /CONTENT_TYPES = new Set\(\[([^\]]*)\]/.exec(msgs)![1]!;
    expect(content).not.toMatch(/signIn|signOut|deleteAll|deleteEmail|putPrefs|whoami/);
  });
});

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { OAUTH_SCOPES } from '../../shared/src/index';

const build = readFileSync(resolve(__dirname, 'build.mjs'), 'utf8');
const popup = readFileSync(resolve(__dirname, 'popup.ts'), 'utf8');

describe('P1 harness guards', () => {
  it('requests exactly the three approved scopes', () => {
    const m = build.match(/scopes:\s*\[([^\]]*)\]/);
    const scopes = [...(m?.[1] ?? '').matchAll(/'([^']+)'/g)].map((x) => x[1]).sort();
    expect(scopes).toEqual([...OAUTH_SCOPES].sort());
  });

  it('never passes a raw token variable to log()', () => {
    // tokeninfo() returns an explicit whitelist of fields (aud, email, scope, …), never the token itself.
    expect(popup).toMatch(/return \{ http: r\.status, aud: j\.aud, email: j\.email,/);
    for (const call of popup.matchAll(/log\(([^;]*)\);/g)) {
      const args = call[1]!.replace(/tokeninfo\(t\)/g, 'TOKENINFO');
      // allowed: t.length + tokeninfo fields; forbidden: the bare token `t` / `token` as a value
      expect(args).not.toMatch(/[,{(:]\s*(t|token)\s*[,})]/);
    }
  });

  it('only requests interactive consent from click handlers', () => {
    // getToken(true…) may appear only inside handler bodies (signin/account), never at module top level
    const topLevel = popup.split('const handlers')[0] ?? '';
    expect(topLevel).not.toMatch(/getToken\(true/);
  });

  it('contains no client secret handling', () => {
    expect(build + popup).not.toMatch(/client_secret|GOCSPX/i);
  });
});

// P1.4 regression (2026-11-03): getAccounts() is documented as "only supported on dev channel"
// (https://developer.chrome.com/docs/extensions/reference/api/identity); on stable Chrome 156 it threw
// "TypeError: chrome.identity.getAccounts is not a function". Only stable members may be used.
describe('P1 harness uses only stable, documented chrome.identity APIs', () => {
  const code = popup.replace(/\/\/.*$/gm, '');
  const html = readFileSync(resolve(__dirname, 'popup.html'), 'utf8');
  const STABLE_IDENTITY = new Set([
    'getAuthToken', 'removeCachedAuthToken', 'clearAllCachedAuthTokens', 'getProfileUserInfo',
    'launchWebAuthFlow', 'getRedirectURL', 'onSignInChanged',
    // types
    'TokenDetails', 'AccountStatus', 'AccountInfo', 'ProfileUserInfo', 'ProfileDetails',
  ]);

  it('every chrome.identity member referenced is on the stable allowlist', () => {
    const used = [...code.matchAll(/chrome\.identity\.(\w+)/g)].map((m) => m[1]!);
    expect(used.length).toBeGreaterThan(0);
    expect(used.filter((u) => !STABLE_IDENTITY.has(u))).toEqual([]);
  });

  it('never calls dev-channel getAccounts, in any form', () => {
    expect(code).not.toMatch(/getAccounts/);
    expect(html).not.toMatch(/getAccounts|id="accounts"/);
  });

  it('never bypasses the chrome.identity typings with a cast', () => {
    expect(code).not.toMatch(/chrome\.identity\s+as\s+unknown/);
    expect(code).not.toMatch(/\(chrome\.identity\s+as\s/);
  });

  it('every popup button has a handler and every handler has a button', () => {
    const buttons = [...html.matchAll(/<button id="([^"]+)"/g)].map((m) => m[1]).sort();
    const handlers = [...popup.matchAll(/^\s+async (\w+)\(\)/gm)].map((m) => m[1]).sort();
    expect(buttons).toEqual(handlers);
  });

  it('P1.4 obtains the account id from getProfileUserInfo (stable) and passes it as { account: { id } }', () => {
    expect(code).toMatch(/getProfileUserInfo\(/);
    expect(code).toMatch(/details\.account = \{ id: accountId \}/);
  });

  it('P3 dry run never reaches the send path; real send goes only through BatchSender', () => {
    const dry = code.slice(code.indexOf('async p3dry()'), code.indexOf('async p3send()'));
    expect(dry.length).toBeGreaterThan(0);
    expect(dry).not.toMatch(/sender\.send|fetch\(|messages\/send/);
    expect(code).not.toMatch(/gmail\.googleapis\.com\/gmail\/v1\/users\/me\/messages\/send/); // URL lives in send.ts only
    expect(code).toMatch(/sender\.send\(/);
  });

  it('spike permissions are unchanged: identity + identity.email only', () => {
    const m = build.match(/permissions:\s*\[([^\]]*)\]/);
    expect([...(m?.[1] ?? '').matchAll(/'([^']+)'/g)].map((x) => x[1])).toEqual(['identity', 'identity.email']);
  });
});

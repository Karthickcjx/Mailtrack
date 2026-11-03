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

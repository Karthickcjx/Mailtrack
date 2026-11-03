import { describe, expect, it } from 'vitest';
import { OAUTH_SCOPES } from './index';

describe('OAUTH_SCOPES', () => {
  it('is limited to the three approved scopes', () => {
    expect([...OAUTH_SCOPES].sort()).toEqual([
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/userinfo.email',
      'openid',
    ]);
  });

  it('contains no restricted Gmail scope', () => {
    const restricted = ['gmail.readonly', 'gmail.metadata', 'gmail.compose', 'gmail.modify', 'gmail.insert', 'mail.google.com'];
    for (const s of OAUTH_SCOPES) for (const r of restricted) expect(s).not.toContain(r);
  });
});

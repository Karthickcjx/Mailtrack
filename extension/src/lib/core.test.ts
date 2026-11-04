import { describe, expect, it } from 'vitest';
import type { TrackingEventDto } from '@tracklet/shared';
import { isConsentError, signOut } from './auth';
import { AuthRequiredError, Backend } from './backend';
import { recipientKey, rememberNotified, notifiedIds } from './localStore';
import { decide, poll, SUMMARY_THRESHOLD } from './notify';
import { testPlatform } from './testPlatform';
import { dryRunPreview, personalise, plan, type ComposeInput } from './trackedSend';

const compose = (o: Partial<ComposeInput> = {}): ComposeInput => ({
  kind: 'new', to: ['a@x.test'], cc: [], bcc: [], subject: 'Hello', html: '<p>Hi <a href="https://example.com/a">a</a></p>', hasAttachments: false, groupConfirmed: false, ...o,
});

describe('plan (pre-flight, nothing sent on failure)', () => {
  it.each([
    [{ kind: 'reply' as const }, /only available for new messages/],
    [{ hasAttachments: true }, /attachments/],
    [{ subject: '  ' }, /subject/],
    [{ to: ['a@x.test', 'b@x.test'] }, /Confirm sending separate copies/],
    [{ to: ['a@x.test'], cc: ['A@X.test'], groupConfirmed: true }, /same address appears twice/],
    [{ to: ['not-an-email'] }, /invalid address/],
    [{ to: [] }, /no recipients/],
  ])('%j is rejected', (o, msg) => {
    const r = plan(compose(o));
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).toMatch(msg);
  });
  it('accepts a confirmed group and keeps field order To → Cc → Bcc', () => {
    const r = plan(compose({ to: ['a@x.test'], cc: ['c@x.test'], bcc: ['b@x.test'], groupConfirmed: true }));
    expect(r.ok && r.plan.recipients.map((x) => x.field)).toEqual(['to', 'cc', 'bcc']);
  });
});

describe('personalise / dry run', () => {
  const reg = { recipient_id: 'R', recipient_key: 'K', pixel_url: 'https://t.test/o/PIX.gif', links: [{ index: 0, click_url: 'https://t.test/c/CLK' }] };
  it('rewrites links to the recipient\'s click URL, puts the pixel first, and adds the disclosure', () => {
    const out = personalise('<p><a href="https://example.com/a">a</a> <a href="mailto:x@y.z">m</a></p>', reg, { disclosure_enabled: true, disclosure_text: 'Uses <tracking>' });
    expect(out.html.startsWith('<img src="https://t.test/o/PIX.gif"')).toBe(true);
    expect(out.html).toContain('href="https://t.test/c/CLK"');
    expect(out.html).toContain('href="mailto:x@y.z"');
    expect(out.html).toContain('Uses &lt;tracking&gt;');
    expect(out.html).not.toContain('https://example.com/a');
    expect(out.text).toContain('https://t.test/c/CLK');
    expect(out.text).not.toContain('PIX.gif');
  });
  it('dry run uses placeholder URLs and needs no backend or Gmail', () => {
    const d = dryRunPreview(compose(), { disclosure_enabled: false, disclosure_text: null });
    expect(d.ok && d.copies[0]!.html).toContain('https://tracking.invalid/');
  });
});

describe('recipient keys', () => {
  it('are 43-char base64url, case-insensitive, and secret-dependent (no address recoverable)', async () => {
    const a = await recipientKey('secret-1', 'Ana@Example.test');
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await recipientKey('secret-1', ' ana@example.test ')).toBe(a);
    expect(await recipientKey('secret-2', 'ana@example.test')).not.toBe(a);
    expect(a).not.toMatch(/ana|example/i);
  });
});

describe('auth + backend session', () => {
  it('recognises Chrome consent errors', () => {
    expect(isConsentError(new Error('OAuth2 not granted or revoked.'))).toBe(true);
    expect(isConsentError(new Error('The user did not approve access.'))).toBe(true);
    expect(isConsentError(new Error('network down'))).toBe(false);
  });
  it('session exchange never prompts; consent error → AuthRequiredError', async () => {
    const p = testPlatform({ tokenError: new Error('OAuth2 not granted or revoked.') });
    await expect(new Backend(p, 'https://b.test').ensureSession()).rejects.toBeInstanceOf(AuthRequiredError);
    expect(p.interactiveCalls).toBe(0);
  });
  it('backend 401 refreshes the session once, then succeeds; the Google token is never sent to the data endpoints', async () => {
    let sessions = 0, dataCalls = 0;
    const p = testPlatform({ routes: (url) => {
      if (url.endsWith('/v1/auth/session')) { sessions++; return { status: 200, body: { session_token: `S${sessions}`, expires_at: Date.UTC(2027, 0, 1), user: { id: 'U', email: 'me@x.test' } } }; }
      dataCalls++;
      return dataCalls === 1 ? { status: 401, body: { error: 'unauthorized' } } : { status: 200, body: { ok: true } };
    } });
    const b = new Backend(p, 'https://b.test');
    expect(await b.request('GET', '/v1/preferences')).toEqual({ ok: true });
    expect(sessions).toBe(2);
    const data = p.calls.filter((c) => !c.url.endsWith('/v1/auth/session'));
    expect(data.map((c) => c.headers?.authorization)).toEqual(['Bearer S1', 'Bearer S2']);
    expect(JSON.stringify(data)).not.toContain('ya29.');
  });
  it('sign-out revokes at Google, clears Chrome tokens and the backend session', async () => {
    const p = testPlatform({ routes: (url) => (url.includes('/revoke') ? { status: 200 } : { status: 404 }) });
    await p.session.set('backendSession', { token: 'S', expiresAt: 9e15, userId: 'U', email: 'e' });
    expect(await signOut(p)).toEqual({ revoked: true });
    expect(p.removed).toEqual(['ya29.UNIT', '*']);
    expect(await p.session.get('backendSession')).toBeUndefined();
  });
});

describe('notifications', () => {
  const ev = (id: string, o: Partial<TrackingEventDto> = {}): TrackingEventDto => ({ id, type: 'open', email_id: 'E', recipient_id: 'R', link_index: null, classification: 'proxy_open', counted: true, occurred_at: 0, ua_family: null, country: null, notify: true, ...o });
  const meta = new Map([['E', { emailId: 'E', subject: 'Proposal', createdAt: 0, recipients: [{ recipientId: 'R', address: 'ana@x.test', field: 'to' as const }], links: [{ index: 0, url: 'https://example.com/p' }] }]]);
  it('one note per new notify event, using LOCAL subject/address; already-notified and notify:false skipped', () => {
    const { notes, ids } = decide([ev('1'), ev('2', { notify: false }), ev('3', { type: 'click', link_index: 0 })], new Set(['1']), meta);
    expect(ids).toEqual(['3']);
    expect(notes).toEqual([{ id: 'tracklet:3', title: 'Link clicked', message: 'ana@x.test clicked example.com in "Proposal"' }]);
  });
  it(`collapses more than ${SUMMARY_THRESHOLD} events into one summary`, () => {
    const { notes, ids } = decide(Array.from({ length: 7 }, (_, i) => ev(String(i), i < 2 ? { type: 'click' } : {})), new Set(), meta);
    expect(notes).toHaveLength(1);
    expect(notes[0]!.message).toBe('5 likely opens and 2 clicks since you were away.');
    expect(ids).toHaveLength(7);
  });
  it('bounded notified-id memory', async () => {
    const p = testPlatform();
    await rememberNotified(p, Array.from({ length: 600 }, (_, i) => String(i)));
    expect((await notifiedIds(p)).length).toBe(500);
  });
  it('poll shows a single sign-in notice while auth is required (no repeats)', async () => {
    const p = testPlatform({ tokenError: new Error('OAuth2 not granted or revoked.') });
    const shown: string[] = [];
    const b = new Backend(p, 'https://b.test');
    expect((await poll(p, b, async (n) => { shown.push(n.id); })).authRequired).toBe(true);
    await poll(p, b, async (n) => { shown.push(n.id); });
    expect(shown).toEqual(['tracklet:auth']);
  });
});

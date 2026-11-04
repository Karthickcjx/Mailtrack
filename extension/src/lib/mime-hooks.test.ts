import { describe, expect, it, vi } from 'vitest';
import { buildMime, encodeHeaderWord, formatAddress, toRaw } from './mime';
import { BatchSender, type BatchInput, type SendDeps } from './send';

const base = {
  from: { email: 'a@example.test', name: 'Sender A' }, to: { email: 'b@example.test' }, subject: 'Résumé ✓ 測試',
  html: '<p>Hi <a href="https://example.com/x?y=1#z">link</a></p>', text: 'Hi link https://example.com/x?y=1#z',
  messageId: '<01JTEST@tracklet.invalid>', boundary: 'BOUNDARY', date: new Date(Date.UTC(2026, 10, 4, 12, 0, 0)),
};

describe('browser-native MIME builder', () => {
  it('has a single To, RFC 2047 subject, RFC 5322 Date, CRLF and <= 998-char lines', () => {
    const m = buildMime(base);
    expect(m).toContain('To: <b@example.test>\r\n');
    expect(m).toContain('Date: Wed, 04 Nov 2026 12:00:00 +0000\r\n');
    expect(m).not.toMatch(/^(Cc|Bcc):/m);
    expect(m.split('\r\n\r\n')[0]).not.toMatch(/[^\r]\n/);
    for (const line of m.split('\r\n')) expect(line.length).toBeLessThanOrEqual(998);
    const enc = encodeHeaderWord(base.subject);
    expect(enc.split(/\r\n /).map((w) => Buffer.from(w.slice(10, -2), 'base64').toString('utf8')).join('')).toBe(base.subject);
  });
  it('base64url raw equals Node Buffer encoding (parity), incl. a >300 KB message', () => {
    const big = buildMime({ ...base, html: `<p>${'é'.repeat(150_000)}</p>` });
    expect(toRaw(big)).toBe(Buffer.from(big, 'utf8').toString('base64url'));
  });
  it('rejects header injection and invalid addresses', () => {
    expect(() => buildMime({ ...base, subject: 'x\r\nBcc: e@x.test' })).toThrow();
    expect(() => formatAddress({ email: 'b@x.test>\r\nBcc: e@x' })).toThrow();
    expect(() => formatAddress({ email: 'no-at-sign' })).toThrow();
  });
});

describe('BatchSender hooks (backend status reporting)', () => {
  const ok = (n: number) => ({ status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ id: `m${n}`, threadId: 't1' }) });
  const deps = (replies: object[]): SendDeps => ({
    fetch: vi.fn(async () => replies.shift() as never),
    getToken: async () => 'ya29.HOOK-TEST', invalidateToken: async () => {}, sleep: async () => {}, newMessageId: (() => { let i = 0; return () => `<h${++i}@t.invalid>`; })(),
  });
  const input = (hooks: BatchInput['hooks'], recipients = ['a@x.test', 'b@x.test']): BatchInput => ({
    from: { email: 'me@x.test' }, recipients, subject: 'S', html: (i) => `<p>${i}</p>`, text: (i) => `${i}`, ...(hooks ? { hooks } : {}),
  });

  it('calls beforeSend before each first attempt and afterResult after each settled copy', async () => {
    const calls: string[] = [];
    const d = deps([ok(1), ok(2)]);
    const r = await new BatchSender(d).send(input({
      beforeSend: async (i) => { calls.push(`before${i}`); },
      afterResult: async (i, res) => { calls.push(`after${i}:${res.status}`); },
    }));
    expect(r.ok).toBe(true);
    expect(calls).toEqual(['before0', 'after0:sent', 'before1', 'after1:sent']);
  });

  it('a failing beforeSend stops the batch BEFORE that copy is sent', async () => {
    const d = deps([ok(1), ok(2)]);
    const r = await new BatchSender(d).send(input({ beforeSend: async (i) => { if (i === 1) throw new Error('backend down'); } }));
    expect(r.ok).toBe(false);
    expect(r.results.map((x) => x.status)).toEqual(['sent', 'skipped']);
    expect(d.fetch).toHaveBeenCalledTimes(1);
  });

  it('afterResult runs for failures too, and its own errors never cause a resend', async () => {
    const seen: string[] = [];
    const d = deps([{ status: 400, headers: { get: () => null }, text: async () => '{"error":{"message":"bad"}}' }]);
    const r = await new BatchSender(d).send(input({ afterResult: async (_i, res) => { seen.push(res.status); throw new Error('patch failed'); } }));
    expect(seen).toEqual(['failed']);
    expect(r.results[0]!.hookError).toContain('patch failed');
    expect(d.fetch).toHaveBeenCalledTimes(1);
  });
});

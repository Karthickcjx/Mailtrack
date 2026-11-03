import { describe, expect, it } from 'vitest';
import { normalizeRecipients, threadIdFromAttrs, toComposeKind } from './map';

describe('P2 gmail.js mapping (offline)', () => {
  it('maps compose types', () => {
    expect(toComposeKind('compose')).toBe('new');
    expect(toComposeKind('reply')).toBe('reply');
    expect(toComposeKind('forward')).toBe('forward');
    expect(toComposeKind(undefined)).toBe('unknown');
  });

  it('normalizes, lower-cases and de-duplicates recipients across fields', () => {
    const r = normalizeRecipients({ to: ['A@Example.test', 'b@example.test'], cc: ['a@example.test', 'c@example.test'], bcc: ['bad-address', ''] });
    expect(r.to).toEqual([{ email: 'a@example.test' }, { email: 'b@example.test' }]);
    expect(r.cc).toEqual([{ email: 'c@example.test' }]);
    expect(r.bcc).toEqual([]);
    expect(r.invalid).toEqual(['bad-address']);
  });

  it('tolerates unexpected shapes', () => {
    expect(normalizeRecipients(null)).toEqual({ to: [], cc: [], bcc: [], invalid: [] });
    expect(normalizeRecipients({ to: 'x' })).toEqual({ to: [], cc: [], bcc: [], invalid: [] });
  });

  it('extracts thread ids from row attributes', () => {
    expect(threadIdFromAttrs({ legacy: '18F2A9C1D0E3B4A5' })).toBe('18f2a9c1d0e3b4a5');
    expect(threadIdFromAttrs({ threadId: '#thread-f:1793691002000123456' })).toBe('1793691002000123456');
    expect(threadIdFromAttrs({ legacy: 'nope', threadId: null })).toBeNull();
  });
});

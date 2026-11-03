import { describe, expect, it } from 'vitest';
import { emailsInText } from './native-adapter';
import { normalizeRecipients } from './map';

describe('emailsInText (uncommitted recipient text, P2 round 7)', () => {
  it('extracts comma/semicolon/space separated and display-name addresses', () => {
    expect(emailsInText('p2-to1@example.com,p2-to2@example.com,')).toEqual(['p2-to1@example.com', 'p2-to2@example.com']);
    expect(emailsInText('A <a@x.test>; "B" <b@y.test>  c@z.test')).toEqual(['a@x.test', 'b@y.test', 'c@z.test']);
  });
  it('returns nothing for empty or partial input, and normalizeRecipients rejects fragments', () => {
    expect(emailsInText('')).toEqual([]);
    expect(emailsInText('p2-to')).toEqual([]);
    expect(normalizeRecipients({ to: emailsInText('half@typed') }).to).toEqual([]);
  });
});

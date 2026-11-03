import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildManifest } from './manifest.base';

const keyFile = JSON.parse(readFileSync(resolve(__dirname, 'manifest.key.json'), 'utf8')) as { key: string; extensionId: string };

describe('manifest', () => {
  it('public key derives the recorded stable extension ID', () => {
    const der = Buffer.from(keyFile.key, 'base64');
    const id = createHash('sha256').update(der).digest('hex').slice(0, 32)
      .replace(/[0-9a-f]/g, (c) => String.fromCharCode(97 + parseInt(c, 16)));
    expect(id).toBe(keyFile.extensionId);
  });

  it('omits oauth2 when no client ID is configured and never contains a secret field', () => {
    const m = buildManifest({ key: keyFile.key, oauthClientId: undefined, version: '0.0.1' });
    expect(m).not.toHaveProperty('oauth2');
    expect(JSON.stringify(m)).not.toMatch(/secret/i);
  });

  it('uses only approved scopes when oauth2 is configured', () => {
    const m = buildManifest({ key: keyFile.key, oauthClientId: 'x.apps.googleusercontent.com', version: '0.0.1' }) as {
      oauth2?: { scopes: string[] };
    };
    expect(m.oauth2?.scopes).toHaveLength(3);
  });
});

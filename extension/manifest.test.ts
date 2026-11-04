import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { apiHostPattern, buildManifest } from './manifest.base';

const keyFile = JSON.parse(readFileSync(resolve(__dirname, 'manifest.key.json'), 'utf8')) as { key: string; extensionId: string };
const base = { key: keyFile.key, version: '0.1.0', apiBase: 'http://127.0.0.1:8787' };

describe('manifest', () => {
  it('public key derives the recorded stable extension ID', () => {
    const der = Buffer.from(keyFile.key, 'base64');
    const id = createHash('sha256').update(der).digest('hex').slice(0, 32)
      .replace(/[0-9a-f]/g, (c) => String.fromCharCode(97 + parseInt(c, 16)));
    expect(id).toBe(keyFile.extensionId);
    expect(id).toBe('hhejoehmmjbjahinnpgnfhfakbkhilcd');
  });

  it('omits oauth2 when no client ID is configured and never contains a secret field', () => {
    const m = buildManifest({ ...base, oauthClientId: undefined });
    expect(m).not.toHaveProperty('oauth2');
    expect(JSON.stringify(m)).not.toMatch(/secret/i);
  });

  it('uses exactly the three approved scopes', () => {
    const m = buildManifest({ ...base, oauthClientId: 'x.apps.googleusercontent.com' }) as { oauth2?: { scopes: string[] } };
    expect(m.oauth2?.scopes).toEqual(['openid', 'https://www.googleapis.com/auth/userinfo.email', 'https://www.googleapis.com/auth/gmail.send']);
  });

  it('requests only the minimal permission set', () => {
    const m = buildManifest({ ...base, oauthClientId: undefined });
    expect(m.permissions.sort()).toEqual(['alarms', 'identity', 'notifications', 'storage']);
    expect(m.host_permissions).toEqual(['https://gmail.googleapis.com/*', 'https://oauth2.googleapis.com/*', 'http://127.0.0.1/*']);
    expect(m.content_scripts).toEqual([{ matches: ['https://mail.google.com/*'], js: ['content.js'], run_at: 'document_idle', all_frames: false }]);
    expect(JSON.stringify(m)).not.toMatch(/<all_urls>|"tabs"|"scripting"|"webRequest|"cookies"|"history"|gmail\.readonly|gmail\.modify|mail\.google\.com\/\*"\]\s*,\s*"world"/);
    expect(m.content_security_policy.extension_pages).toBe("script-src 'self'; object-src 'self'");
  });

  it('API host must be https except on loopback, and a bare origin', () => {
    expect(apiHostPattern('https://api.example.com')).toBe('https://api.example.com/*');
    expect(apiHostPattern('http://localhost:8787')).toBe('http://localhost/*');
    expect(() => apiHostPattern('http://api.example.com')).toThrow();
    expect(() => apiHostPattern('https://api.example.com/v1')).toThrow();
    expect(() => apiHostPattern('https://u:p@api.example.com')).toThrow();
  });
});

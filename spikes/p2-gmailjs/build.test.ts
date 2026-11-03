// Build reproducibility and identity for both P2 variants.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const dir = __dirname;
const buildInfo = (v: string) => {
  execFileSync(process.execPath, [resolve(dir, 'build.mjs'), v], { stdio: 'ignore' });
  return {
    info: JSON.parse(readFileSync(resolve(dir, `dist-${v}/build-info.json`), 'utf8')) as { buildId: string; pageSha256: string; sinks: number; versions: Record<string, string>; variant: string },
    manifest: JSON.parse(readFileSync(resolve(dir, `dist-${v}/manifest.json`), 'utf8')) as { permissions: string[]; content_scripts: { world: string; run_at: string }[]; host_permissions?: unknown },
    page: readFileSync(resolve(dir, `dist-${v}/page.js`), 'utf8'),
  };
};

describe('P2 builds are independently reproducible and identifiable', () => {
  for (const v of ['native', 'gmailjs'] as const) {
    it(`${v}: two consecutive builds produce identical buildId and page.js hash`, () => {
      const a = buildInfo(v);
      const b = buildInfo(v);
      expect(b.info.buildId).toBe(a.info.buildId);
      expect(b.info.pageSha256).toBe(a.info.pageSha256);
      expect(a.info.buildId).toMatch(new RegExp(`^${v}-[0-9a-f]{12}$`));
      expect(a.page).toContain(a.info.buildId);              // embedded, shown in panel/report
    }, 120_000);
  }

  it('variants differ and have the expected isolation, permissions and run_at', () => {
    const n = buildInfo('native');
    const g = buildInfo('gmailjs');
    expect(n.info.buildId).not.toBe(g.info.buildId);
    expect(n.info.sinks).toBe(0);
    expect(n.info.versions).not.toHaveProperty('jquery');
    expect(n.page).not.toMatch(/jQuery|gmail\.js|GmailFactory/);
    expect(g.info.versions).toMatchObject({ 'gmail-js': '1.1.16', jquery: '4.0.0' });
    for (const m of [n.manifest, g.manifest]) {
      expect(m.permissions).toEqual([]);
      expect(m.host_permissions).toBeUndefined();
      expect(m.content_scripts[0]!.world).toBe('MAIN');
    }
    expect(n.manifest.content_scripts[0]!.run_at).toBe('document_idle');
    expect(g.manifest.content_scripts[0]!.run_at).toBe('document_start');
  }, 120_000);
});

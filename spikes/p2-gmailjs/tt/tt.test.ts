// P2.10 Trusted Types compatibility + panel injection tests.
// Runs the built harness in headless Chrome under a STRICT TT CSP (`require-trusted-types-for 'script'; trusted-types 'none'`).
// Skipped automatically if Chrome is not installed.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
// @ts-ignore -- plain ESM helper
import { findChrome, runTT } from './run-tt.mjs';

const dir = resolve(__dirname, '..');
const chrome = findChrome();
const d = chrome ? describe : describe.skip;

const extGmail = resolve(__dirname, '../../../extension/src/gmail');

describe('P2 static: no HTML sinks or TT policies in our UI code', () => {
  const files = [
    resolve(extGmail, 'native-adapter.ts'), resolve(extGmail, 'adapter.ts'), resolve(extGmail, 'map.ts'),
    resolve(dir, 'panel.ts'), resolve(dir, 'harness.ts'), resolve(dir, 'gmailjs-adapter.ts'),
  ];
  for (const f of files) {
    it(`${f.split(/[\\/]/).slice(-2).join('/')} has no HTML sink assignment, insertAdjacentHTML, document.write or createPolicy`, () => {
      const src = readFileSync(f, 'utf8').replace(/\/\/.*$/gm, '');
      expect(src).not.toMatch(/\.(innerHTML|outerHTML)\s*=(?!=)/);
      expect(src).not.toMatch(/insertAdjacentHTML|document\.write|createPolicy|\.html\(/);
    });
  }
});

describe('D12 isolation: gmail.js / jQuery stay out of the main extension', () => {
  it('no extension source imports gmail-js or jquery', () => {
    let out = '';
    try {
      out = execFileSync('git', ['grep', '--untracked', '-lE', "from ['\"](gmail-js|jquery)['\"]|require\\(['\"](gmail-js|jquery)", '--', 'extension', 'shared', 'backend'],
        { cwd: resolve(__dirname, '../../..'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch (e) {
      if ((e as { status?: number }).status !== 1) throw e;   // 1 = no matches = pass
    }
    expect(out).toBe('');
  });
  it('extension/package.json does not depend on gmail-js or jquery', () => {
    const pkg = JSON.parse(readFileSync(resolve(__dirname, '../../../extension/package.json'), 'utf8'));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    expect(Object.keys(deps)).not.toContain('gmail-js');
    expect(Object.keys(deps)).not.toContain('jquery');
  });
});

d('P2.10 under strict Trusted Types (headless Chrome)', () => {
  beforeAll(() => {
    for (const a of ['native', 'gmailjs']) execFileSync(process.execPath, [resolve(dir, 'build.mjs'), a], { stdio: 'ignore' });
  }, 120_000);

  it('native adapter: no violations, no errors, panel injected, compose detected, fields read, rows marked', async () => {
    const r = await runTT(resolve(dir, 'dist-native/page.js'), 'compose');
    expect(r.violations).toEqual([]);
    expect(r.errors).toEqual([]);
    const p = r.probe;
    expect(p.panelPresent).toBe(true);
    expect(p.panelLines).toBeGreaterThan(0);
    // both composes (initial inline reply + late popup) get both buttons, text only
    expect(p.buttons.filter((b: { compose: string }) => b.compose === 'popup')).toHaveLength(2);
    expect(p.buttons.filter((b: { compose: string }) => b.compose === 'inline-reply')).toHaveLength(2);
    const ids = p.report.results.map((x: { id: string }) => x.id);
    expect(ids).toContain('P2.9 load');
    const detected = p.report.results.filter((x: { id: string }) => x.id === 'P2.5 compose-detected').map((x: { detail: { kind: string } }) => x.detail.kind).sort();
    expect(detected).toEqual(['new', 'reply']);
    const reads = p.report.results.filter((x: { id: string }) => x.id === 'P2.6 read-fields').map((x: { detail: unknown }) => x.detail);
    const popup = reads.find((x: { kind: string }) => x.kind === 'new');
    // report() redacts local parts (a***@) — assert on the redacted, de-duplicated shape
    expect(popup).toMatchObject({ to: ['a***@example.test', 'b***@example.test'], cc: ['c***@example.test'], bcc: ['d***@example.test'],
      subject: 'P2 Résumé ✓ 測試', htmlHasSignatureDiv: true, hasAttachments: true });
    expect(p.marks).toEqual([
      { id: '18f2a9c1d0e3b4a5', text: '✓' },
      { id: '1793691002000123456', text: '✓' },
    ]);
    expect(p.report.ttViolations).toEqual([]);
  }, 120_000);

  it('real gmail.js 1.1.16 + jQuery 4: adapter constructs, ready() resolves via observe.on("load"), observers register', async () => {
    const { build } = await import('esbuild');
    const out = resolve(__dirname, '.out/gmailjs-init.js');
    await build({ entryPoints: [resolve(__dirname, 'gmailjs-init-entry.ts')], bundle: true, format: 'iife', outfile: out, platform: 'browser', target: 'chrome120', logLevel: 'silent' });
    const r = await runTT(out, 'gmail-shell');
    expect(r.violations).toEqual([]);
    expect(r.errors).toEqual([]);
    expect(r.probe).toMatchObject({ constructed: true, ready: true, composeRegistered: true, viewThreadRegistered: true, errors: [] });
  }, 120_000);

  it('gmail.js + jQuery 4 bundle loads without TT violations or uncaught errors', async () => {
    const r = await runTT(resolve(dir, 'dist-gmailjs/page.js'), 'blank');
    expect(r.violations).toEqual([]);
    expect(r.errors).toEqual([]);
  }, 120_000);
});

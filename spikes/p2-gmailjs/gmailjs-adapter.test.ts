// P2 round 4 regressions: gmail.js initialization + observer registration.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

// jQuery 4 throws on import without a window; these unit tests inject a fake gmail.js, so the real
// libraries are never constructed here. The real libraries are exercised in headless Chrome (tt/tt.test.ts).
vi.mock('jquery', () => ({ default: () => { throw new Error('jquery must not be used in unit tests'); } }));
vi.mock('gmail-js', () => ({ default: { Gmail: function () { throw new Error('real gmail.js must not be constructed in unit tests'); } } }));

import { GmailJsAdapter, type GmailJsApi } from './gmailjs-adapter';

type Handler = (...args: unknown[]) => unknown;

/** Strict fake of the verified gmail.js 1.1.16 surface: touching any other member (e.g. observe.on_load) throws. */
function strictFake() {
  const handlers = new Map<string, Handler>();
  const offs: (string | undefined)[] = [];
  const observe = { on: (a: string, cb: Handler) => { handlers.set(a, cb); }, off: (a?: string) => { offs.push(a); } };
  const strict = <T extends object>(o: T, path: string): T => new Proxy(o, {
    get(t, p) {
      if (typeof p === 'symbol' || p === 'then') return (t as Record<PropertyKey, unknown>)[p];
      if (!(p in t)) throw new Error(`unexpected gmail.js member: ${path}.${String(p)}`);
      return (t as Record<string, unknown>)[p];
    },
  });
  const gmail = strict({ observe: strict(observe, 'observe'), new: { get: { thread_id: () => '18f2a9c1d0e3b4a5' } } }, 'gmail') as GmailJsApi;
  const marks = { setThreadMarks: () => {}, dispose: () => {}, rowStats: { rows: 0, withId: 0, totalMarks: 0 } };
  return { gmail, handlers, offs, marks };
}

describe('GmailJsAdapter initialization (gmail.js 1.1.16 verified API)', () => {
  it('ready() registers the documented "load" event via observe.on and resolves when it fires', async () => {
    const f = strictFake();
    const a = new GmailJsAdapter({ gmail: f.gmail, marks: f.marks });
    let resolved = false;
    const p = a.ready().then(() => { resolved = true; });
    expect([...f.handlers.keys()]).toEqual(['load']);
    await Promise.resolve();
    expect(resolved).toBe(false);          // must wait for gmail.js to fire 'load'
    f.handlers.get('load')!();
    await p;
    expect(resolved).toBe(true);
  });

  it('ready() never calls the non-existent observe.on_load (strict fake would throw)', async () => {
    const f = strictFake();
    const a = new GmailJsAdapter({ gmail: f.gmail, marks: f.marks });
    const p = a.ready();
    f.handlers.get('load')!();
    await expect(p).resolves.toBeUndefined();
  });

  it('ready() rejects with a clear error when the gmail.js API does not match', async () => {
    const a = new GmailJsAdapter({ gmail: { observe: {} } as unknown as GmailJsApi, marks: strictFake().marks });
    await expect(a.ready()).rejects.toThrow('gmail.js API mismatch: observe.on is not a function');
  });
});

describe('GmailJsAdapter observer registration', () => {
  it('onCompose registers "compose" and maps (compose, type) to a ComposeHandle', () => {
    const f = strictFake();
    const a = new GmailJsAdapter({ gmail: f.gmail, marks: f.marks });
    const seen: { kind: string; id: string; subject: string; to: string[] }[] = [];
    const off = a.onCompose((c) => { const s = c.snapshot(); seen.push({ kind: c.kind, id: c.composeId, subject: s.subject, to: s.to.map((x) => x.email) }); });
    expect(f.handlers.has('compose')).toBe(true);
    const fakeCompose = {
      $el: [undefined], id: () => 'c1', subject: () => 'Hi', body: () => '<p>x</p>', attachments: () => [],
      recipients: () => ({ to: ['A@x.test'], cc: [], bcc: [] }), close: () => {},
    };
    f.handlers.get('compose')!(fakeCompose, 'reply');
    expect(seen).toEqual([{ kind: 'reply', id: 'c1', subject: 'Hi', to: ['a@x.test'] }]);
    off();
    expect(f.offs).toContain('compose');
  });

  it('onThreadViewed registers "view_thread" and reads new.get.thread_id()', () => {
    const f = strictFake();
    const a = new GmailJsAdapter({ gmail: f.gmail, marks: f.marks });
    const ids: string[] = [];
    a.onThreadViewed((id) => ids.push(id));
    expect(f.handlers.has('view_thread')).toBe(true);
    f.handlers.get('view_thread')!({});
    expect(ids).toEqual(['18f2a9c1d0e3b4a5']);
  });
});

describe('gmail.js API contract (installed package)', () => {
  const root = resolve(__dirname, '../../node_modules/gmail-js');
  const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { version: string };
  const src = readFileSync(resolve(root, 'src/gmail.js'), 'utf8');
  const dts = readFileSync(resolve(root, 'src/gmail.d.ts'), 'utf8');
  const adapterSrc = readFileSync(resolve(__dirname, 'gmailjs-adapter.ts'), 'utf8').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

  it('is the pinned version 1.1.16', () => expect(pkg.version).toBe('1.1.16'));
  it('declares the events the adapter uses', () => {
    for (const ev of ['load', 'compose', 'view_thread']) expect(dts).toContain(`on(action: "${ev}"`);
  });
  it('implements "load" inside observe.on / on_dom and has no on_load', () => {
    expect(src).toMatch(/else if\(action === "load"\)/);
    expect(src).not.toMatch(/on_load/);
    expect(dts).not.toMatch(/on_load/);
  });
  it('adapter code does not reference on_load', () => expect(adapterSrc).not.toMatch(/on_load/));
});

// SPIKE P1 + P3 (throwaway). Every action is triggered by an explicit button click.
// Tokens are never displayed or logged in full: only length + tokeninfo fields.
import { buildMime, insertPixelAtTop, toRaw } from '../p3-mime/mime';

const out = document.getElementById('out') as HTMLPreElement;
const log = (label: string, data: unknown) => {
  out.textContent = `[${new Date().toISOString()}] ${label}\n${JSON.stringify(data, null, 2)}\n\n` + out.textContent;
};

async function getToken(interactive: boolean, accountId?: string): Promise<string> {
  const details: chrome.identity.TokenDetails = { interactive };
  if (accountId) details.account = { id: accountId };
  const res = await chrome.identity.getAuthToken(details);
  if (!res.token) throw new Error('no token');
  return res.token;
}

async function tokeninfo(token: string) {
  const r = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(token)}`);
  const j = (await r.json()) as Record<string, string>;
  return { http: r.status, aud: j.aud, email: j.email, email_verified: j.email_verified, scope: j.scope, expires_in: j.expires_in, sub_present: Boolean(j.sub) };
}

const handlers: Record<string, () => Promise<void>> = {
  // P1.2 — interactive consent, only on click
  async signin() { const t = await getToken(true); log('P1.2 interactive token', { length: t.length, ...(await tokeninfo(t)) }); },
  // P1.3 / P1.5 — silent
  async silent() {
    const t0 = performance.now(); const t = await getToken(false);
    log('P1.3 silent token', { ms: Math.round(performance.now() - t0), length: t.length, ...(await tokeninfo(t)) });
  },
  // P1.4 — explicit account via STABLE APIs only.
  // chrome.identity.getAccounts() is "only supported on dev channel" (official docs) and must not be used.
  // Supported source of an account ID: getProfileUserInfo().id (primary account of the profile, needs
  // identity.email), passed as getAuthToken({ account: { id } }). A manually entered ID is also accepted.
  async account() {
    const typed = (document.getElementById('acct') as HTMLInputElement).value.trim();
    const profile = await chrome.identity.getProfileUserInfo({ accountStatus: 'ANY' as chrome.identity.AccountStatus });
    const id = typed || profile.id;
    if (!id) { log('P1.4 no account id', { reason: 'profile has no primary account (or identity.email missing) and no id entered' }); return; }
    const t = await getToken(true, id);
    const info = await tokeninfo(t);
    log('P1.4 token for account', { source: typed ? 'manual id' : 'getProfileUserInfo().id', idLength: id.length,
      tokenEmailMatchesProfileEmail: Boolean(profile.email) && info.email === profile.email, ...info });
  },
  async profile() { log('profile user info (Chrome profile)', await chrome.identity.getProfileUserInfo({ accountStatus: 'ANY' as chrome.identity.AccountStatus })); },
  // P1.5 — drop cache, then silent again
  async clear() { const t = await getToken(false); await chrome.identity.removeCachedAuthToken({ token: t }); log('P1.5 cached token removed', { ok: true }); },
  // P1.7 — revoke (server side) for the revocation test
  async revoke() {
    const t = await getToken(false);
    const r = await fetch('https://oauth2.googleapis.com/revoke', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `token=${encodeURIComponent(t)}` });
    await chrome.identity.removeCachedAuthToken({ token: t });
    log('P1.7 revoke', { http: r.status });
  },
  // P3.2 — 3 single-recipient copies to YOUR test addresses (typed manually). No tracking server involved.
  async p3send() {
    const raw = (document.getElementById('rcpts') as HTMLInputElement).value.split(',').map((s) => s.trim()).filter(Boolean);
    if (raw.length < 1 || raw.length > 3) throw new Error('enter 1-3 of YOUR OWN test addresses');
    if (!confirm(`Send ${raw.length} test copies to:\n${raw.join('\n')}\n\nOnly use your own test accounts.`)) return;
    const t = await getToken(false);
    const info = await tokeninfo(t);
    const firstId = `<${crypto.randomUUID()}@tracklet.invalid>`;
    let threadId: string | undefined;
    const results: unknown[] = [];
    for (const [i, to] of raw.entries()) {
      const html = insertPixelAtTop('<p>P3 spike copy ' + (i + 1) + ' — <a href="https://example.com/?q=1#frag">example link</a></p>', 'https://example.com/p3-no-tracking.gif');
      const mime = buildMime({
        from: { email: info.email! }, to: { email: to }, subject: 'P3 spike Résumé ✓ 測試',
        html, text: `P3 spike copy ${i + 1} — example link https://example.com/?q=1#frag`,
        messageId: i === 0 ? firstId : `<${crypto.randomUUID()}@tracklet.invalid>`,
        ...(i > 0 ? { inReplyTo: firstId } : {}),
      });
      const body: Record<string, string> = { raw: toRaw(mime) };
      if (threadId) body.threadId = threadId;
      const t0 = performance.now();
      const r = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
        method: 'POST', headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      const j = (await r.json()) as { id?: string; threadId?: string; error?: unknown };
      if (i === 0 && j.threadId) threadId = j.threadId;
      results.push({ copy: i + 1, http: r.status, ms: Math.round(performance.now() - t0), id: j.id, threadId: j.threadId, error: j.error });
      await new Promise((res) => setTimeout(res, 1000));
    }
    log('P3.2 send results', { firstMessageId: firstId, results });
  },
};

for (const [id, fn] of Object.entries(handlers)) {
  document.getElementById(id)?.addEventListener('click', () => fn().catch((e) => log(`${id} ERROR`, String(e))));
}
log('ready', { extensionId: chrome.runtime.id });

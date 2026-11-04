// Tracklet service worker. Holds tokens; handles sends, polling, notifications and data requests.
import { isUlid, type Preferences } from '@tracklet/shared';
import { interactiveToken, signOut } from './lib/auth';
import { AuthRequiredError, Backend, BackendError } from './lib/backend';
import { logLine, toReply } from './lib/reply';
import { googleIdentity } from './lib/whoami';
import { deleteMeta, loadMeta } from './lib/localStore';
import { poll, type Note } from './lib/notify';
import { chromePlatform } from './lib/platform';
import { BatchSender } from './lib/send';
import { dryRunPreview, trackedSend } from './lib/trackedSend';
import { isAllowed, senderKind, type ContentMessage, type PageMessage, type Reply } from './messages';

declare const __API_BASE__: string;

const ALARM = 'tracklet-poll';
const p = chromePlatform();
const backend = new Backend(p, __API_BASE__);
const sender = new BatchSender({
  fetch: (url, init) => fetch(url, init),
  getToken: (interactive) => p.getAuthToken(interactive),
  invalidateToken: (token) => p.removeCachedAuthToken(token),
  sleep: (ms) => p.sleep(ms),
  newMessageId: () => `<${crypto.randomUUID()}@tracklet.invalid>`,
});

async function ensureAlarm() {
  if (!(await chrome.alarms.get(ALARM))) await chrome.alarms.create(ALARM, { periodInMinutes: 1, delayInMinutes: 0.1 });
}
chrome.runtime.onInstalled.addListener(() => { void ensureAlarm(); });
chrome.runtime.onStartup.addListener(() => { void ensureAlarm(); });
void ensureAlarm();   // service worker restarts: recreate if missing (C-g)

const show = async (n: Note) => {
  await chrome.notifications.create(n.id, { type: 'basic', iconUrl: chrome.runtime.getURL('icon128.png'), title: n.title, message: n.message, priority: 0 });
};
let polling = false;
async function runPoll() {
  if (polling) return;   // never overlap (alarm + manual)
  polling = true;
  try { return await poll(p, backend, show); } finally { polling = false; }
}
chrome.alarms.onAlarm.addListener((a) => { if (a.name === ALARM) void runPoll(); });
chrome.notifications.onClicked.addListener((id) => {
  if (id.startsWith('tracklet:')) void chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
  void chrome.notifications.clear(id);
});

async function prefs(): Promise<Preferences> { return backend.request<Preferences>('GET', '/v1/preferences'); }

async function handle(msg: ContentMessage | PageMessage): Promise<unknown> {
  switch (msg.type) {
    case 'send': {
      const s = await backend.ensureSession();
      return trackedSend(p, backend, sender, msg.compose, s.email, await prefs());
    }
    case 'dryRun': return dryRunPreview(msg.compose, await prefs().catch(() => ({ disclosure_enabled: false, disclosure_text: null })));
    case 'threadViewed':
      if (!/^[A-Za-z0-9]{1,64}$/.test(msg.threadId)) return null;
      return backend.request('POST', '/v1/views', { gmail_thread_id: msg.threadId });
    case 'threadStatus': {
      const ids = (Array.isArray(msg.ids) ? msg.ids : []).filter((x) => /^[A-Za-z0-9]{1,64}$/.test(x)).slice(0, 50);
      return ids.length ? backend.request('GET', `/v1/threads/status?ids=${ids.join(',')}`) : {};
    }
    case 'authStatus':
      try { const s = await backend.ensureSession(); return { signedIn: true, email: s.email }; }
      catch (e) { if (e instanceof AuthRequiredError) return { signedIn: false }; throw e; }
    case 'signIn': {
      await interactiveToken(p);   // only reachable from an explicit click in an extension page
      const s = await backend.ensureSession(true);
      await p.local.remove('authNoticeShown');
      return { signedIn: true, email: s.email };
    }
    case 'signOut': return signOut(p);
    case 'dashboard': return backend.request('GET', `/v1/dashboard?range=${['7d', '30d', '90d'].includes(msg.range) ? msg.range : '30d'}`);
    case 'emails': {
      const q = new URLSearchParams({ limit: '25', filter: msg.filter ?? 'all', ...(msg.cursor && isUlid(msg.cursor) ? { cursor: msg.cursor } : {}) });
      const r = await backend.request<{ items: { email_id: string }[]; next_cursor: string | null }>('GET', `/v1/emails?${q}`);
      const items = await Promise.all(r.items.map(async (i) => ({ ...i, local: (await loadMeta(p, i.email_id)) ?? null })));
      return { ...r, items };
    }
    case 'email': {
      if (!isUlid(msg.emailId)) throw new BackendError(404, 'not_found');
      const d = await backend.request('GET', `/v1/emails/${msg.emailId}?include_suspected=${msg.includeSuspected}`);
      return { ...(d as object), local: (await loadMeta(p, msg.emailId)) ?? null };
    }
    case 'deleteEmail':
      if (!isUlid(msg.emailId)) throw new BackendError(404, 'not_found');
      await backend.request('DELETE', `/v1/emails/${msg.emailId}`);
      await deleteMeta(p, msg.emailId);
      return null;
    case 'deleteAll': {
      await backend.request('DELETE', '/v1/me/data');
      const all = await chrome.storage.local.get(null);
      await chrome.storage.local.remove(Object.keys(all).filter((k) => k.startsWith('meta:') || k === 'eventCursor' || k === 'notifiedEventIds'));
      return null;
    }
    case 'getPrefs': return prefs();
    case 'putPrefs': return backend.request('PUT', '/v1/preferences', msg.prefs);
    case 'pollNow': return runPoll();
    case 'whoami': return googleIdentity(p, chrome.runtime.getManifest().oauth2?.client_id);
  }
}

chrome.runtime.onMessage.addListener((msg: { type?: unknown }, s, sendResponse) => {
  const kind = senderKind(s, chrome.runtime.id, chrome.runtime.getURL(''));
  if (!isAllowed(kind, msg?.type)) { sendResponse({ ok: false, error: 'forbidden', message: 'Not allowed.' } satisfies Reply); return false; }
  const type = String(msg.type);
  handle(msg as ContentMessage | PageMessage).then((data) => sendResponse({ ok: true, data } satisfies Reply), (e) => {
    const reply = toReply(e, { type });
    // Redacted (no tokens, addresses or query strings) so the service-worker console names the real cause.
    if (reply.ok === false && reply.error !== 'auth_required') console.warn(`[tracklet] ${type} failed: ${logLine(e)}`);
    sendResponse(reply);
  });
  return true;   // async response
});

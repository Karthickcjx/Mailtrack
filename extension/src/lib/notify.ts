// Notification decisions (pure) + poller. Dedupe: per event id (persisted, bounded) and Chrome notification
// ids `tracklet:<eventId>`; bursts collapse into one summary; the cursor is persisted so service-worker
// restarts neither lose nor repeat events.
import type { TrackingEventDto } from '@tracklet/shared';
import { AuthRequiredError, type Backend } from './backend';
import { loadMeta, notifiedIds, rememberNotified, type LocalMeta } from './localStore';
import type { Platform } from './platform';

export interface Note { id: string; title: string; message: string }
export const SUMMARY_THRESHOLD = 5;

export function describe(e: TrackingEventDto, meta: LocalMeta | undefined): Note {
  const who = meta?.recipients.find((r) => r.recipientId === e.recipient_id)?.address ?? 'A recipient';
  const subject = meta?.subject ? `"${meta.subject.slice(0, 80)}"` : 'your tracked email';
  const proxy = e.classification === 'proxy_open' ? ' (via image proxy)' : '';
  if (e.type === 'click') {
    const url = meta?.links.find((l) => l.index === e.link_index)?.url;
    return { id: `tracklet:${e.id}`, title: 'Link clicked', message: `${who} clicked ${url ? new URL(url).host : 'a link'} in ${subject}` };
  }
  return { id: `tracklet:${e.id}`, title: 'Email likely opened', message: `${who} likely opened ${subject}${proxy}` };
}

export function decide(events: TrackingEventDto[], already: Set<string>, metas: Map<string, LocalMeta | undefined>): { notes: Note[]; ids: string[] } {
  const fresh = events.filter((e) => e.notify && !already.has(e.id));
  if (fresh.length > SUMMARY_THRESHOLD) {
    const opens = fresh.filter((e) => e.type !== 'click').length;
    const clicks = fresh.length - opens;
    return { notes: [{ id: `tracklet:summary:${fresh[fresh.length - 1]!.id}`, title: 'Tracklet activity',
      message: `${opens} likely open${opens === 1 ? '' : 's'} and ${clicks} click${clicks === 1 ? '' : 's'} since you were away.` }], ids: fresh.map((e) => e.id) };
  }
  return { notes: fresh.map((e) => describe(e, metas.get(e.email_id))), ids: fresh.map((e) => e.id) };
}

export interface PollResult { events: number; notified: number; authRequired: boolean; error?: string }

export async function poll(p: Platform, backend: Backend, show: (n: Note) => Promise<void>, maxPages = 5): Promise<PollResult> {
  let cursor = await p.local.get<string>('eventCursor');
  const all: TrackingEventDto[] = [];
  try {
    for (let page = 0; page < maxPages; page++) {
      const r = await backend.request<{ events: TrackingEventDto[]; next_cursor: string | null; more: boolean }>(
        'GET', `/v1/events${cursor ? `?since=${encodeURIComponent(cursor)}` : ''}`);
      all.push(...r.events);
      if (r.next_cursor) cursor = r.next_cursor;
      if (!r.more) break;
    }
  } catch (e) {
    if (e instanceof AuthRequiredError) {
      if (!(await p.local.get<boolean>('authNoticeShown'))) {
        await show({ id: 'tracklet:auth', title: 'Tracklet needs you to sign in', message: 'Open the Tracklet popup and click Sign in to resume tracking notifications.' });
        await p.local.set('authNoticeShown', true);
      }
      return { events: 0, notified: 0, authRequired: true };
    }
    return { events: 0, notified: 0, authRequired: false, error: e instanceof Error ? e.name : 'error' };
  }
  await p.local.remove('authNoticeShown');
  const metas = new Map<string, LocalMeta | undefined>();
  for (const id of new Set(all.map((e) => e.email_id))) metas.set(id, await loadMeta(p, id));
  const { notes, ids } = decide(all, new Set(await notifiedIds(p)), metas);
  // Persist BEFORE showing: a crash between the two can lose a notification but can never duplicate one.
  await rememberNotified(p, ids);
  if (cursor) await p.local.set('eventCursor', cursor);
  for (const n of notes) await show(n);
  return { events: all.length, notified: notes.length, authRequired: false };
}

// Tracklet dashboard (extension page). Rendered with React (JSX text only — no raw HTML insertion).
import { StrictMode, useCallback, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ACCURACY_NOTE, type Preferences } from '@tracklet/shared';
import type { LocalMeta } from '../lib/localStore';
import { CLASS_LABEL, fmtRelative, fmtTime, rpc, RpcError } from './rpc';
import './styles.css';

type Range = '7d' | '30d' | '90d';
type Filter = 'all' | 'opened' | 'unopened' | 'clicked';
interface Dash { totals: { emails_sent: number; recipients: number; sent_recipients: number; opened_recipients: number; clicks: number; clicked_recipients: number; open_rate: number | null; click_rate: number | null; suspected_events: number }; accuracy_note: string }
interface Item { email_id: string; subject: string | null; mode: string; status: string; created_at: number; sent_at: number | null; recipients: number; opened_recipients: number; clicks: number; last_activity_at: number | null; local: LocalMeta | null }
interface Detail {
  email_id: string; subject: string | null; status: string; created_at: number; sent_at: number | null;
  totals: { recipients: number; sent_recipients: number; opened_recipients: number; opens: number; clicks: number; suspected_events: number };
  recipients: { recipient_id: string; address: string | null; original_field: string; send_status: string; send_error: string | null; open_count: number; first_open_at: number | null; last_open_at: number | null; click_count: number; status_label: string }[];
  links: { index: number; url: string; clicks: number; unique_recipients: number }[];
  events: { id: string; type: string; recipient_id: string; link_index: number | null; classification: string; counted: boolean; occurred_at: number; ua_family: string | null; country: string | null }[];
  local: LocalMeta | null;
}

const pct = (x: number | null) => (x === null ? '—' : `${Math.round(x * 100)}%`);
const subjectOf = (i: { subject: string | null; local: LocalMeta | null }) => i.local?.subject || i.subject || '(subject stored only on the device that sent it)';

const LABEL_TONE: Record<string, [string, string]> = {
  clicked: ['Clicked', 'good'], likely_opened: ['Likely opened', 'good'], sent: ['Sent', 'info'],
  suspected_only: ['Only automated activity', 'muted'], not_sent: ['Not sent', 'bad'],
};
const STATUS_TONE: Record<string, string> = { sent: 'info', partial: 'warn', failed: 'bad', pending: 'muted', sending: 'muted' };

function Badge({ text, tone }: { text: string; tone: string }) { return <span className={`badge tone-${tone}`}>{text}</span>; }
function ErrorBox({ e, onRetry }: { e: unknown; onRetry?: () => void }) {
  const auth = e instanceof RpcError && e.code === 'auth_required';
  return (
    <div className="err">
      {auth ? 'You are signed out. Sign in from the Tracklet toolbar popup or the Settings tab.' : e instanceof Error ? e.message : 'Something went wrong.'}
      {onRetry && <> <button onClick={onRetry}>Retry</button></>}
    </div>
  );
}
function useAsync<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [state, set] = useState<{ loading: boolean; data?: T; error?: unknown }>({ loading: true });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const run = useCallback(() => { set((s) => ({ ...s, loading: true, error: undefined })); fn().then((data) => set({ loading: false, data }), (error) => set({ loading: false, error })); }, deps);
  useEffect(run, [run]);
  return { ...state, reload: run };
}

function Overview({ onOpen }: { onOpen: (id: string) => void }) {
  const [range, setRange] = useState<Range>('30d');
  const [filter, setFilter] = useState<Filter>('all');
  const [q, setQ] = useState('');
  const dash = useAsync(() => rpc<Dash>({ type: 'dashboard', range }), [range]);
  const [items, setItems] = useState<Item[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [listState, setListState] = useState<{ loading: boolean; error?: unknown }>({ loading: true });

  const load = useCallback(async (reset: boolean, c: string | null) => {
    setListState({ loading: true });
    try {
      const r = await rpc<{ items: Item[]; next_cursor: string | null }>({ type: 'emails', filter, ...(c && !reset ? { cursor: c } : {}) });
      setItems((prev) => (reset ? r.items : [...prev, ...r.items]));
      setCursor(r.next_cursor);
      setListState({ loading: false });
    } catch (error) { setListState({ loading: false, error }); }
  }, [filter]);
  useEffect(() => { void load(true, null); }, [load]);

  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return items;
    return items.filter((i) => subjectOf(i).toLowerCase().includes(s) || (i.local?.recipients ?? []).some((r) => r.address.toLowerCase().includes(s)));
  }, [items, q]);

  const t = dash.data?.totals;
  return (
    <>
      <div className="toolbar">
        <div className="tabs">{(['7d', '30d', '90d'] as Range[]).map((r) => <button key={r} className={r === range ? 'on' : ''} onClick={() => setRange(r)}>{r === '7d' ? '7 days' : r === '30d' ? '30 days' : '90 days'}</button>)}</div>
      </div>
      {dash.error ? <ErrorBox e={dash.error} onRetry={dash.reload} /> : (
        <div className="cards">
          {[
            ['Emails tracked', t?.emails_sent], ['Recipients sent', t?.sent_recipients],
            ['Likely opened', t ? `${t.opened_recipients} · ${pct(t.open_rate)}` : undefined],
            ['Clicked', t ? `${t.clicked_recipients} · ${pct(t.click_rate)}` : undefined],
            ['Suspected automated', t?.suspected_events],
          ].map(([k, v]) => <div key={String(k)} className="panel card"><div className="k">{k}</div><div className="v">{dash.loading ? <span className="spin" /> : String(v ?? '—')}</div></div>)}
        </div>
      )}
      <div className="notice">{dash.data?.accuracy_note ?? ACCURACY_NOTE}</div>

      <div className="panel">
        <div className="toolbar">
          <input placeholder="Search subject or recipient (on this device)" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search" />
          <select value={filter} onChange={(e) => setFilter(e.target.value as Filter)} aria-label="Filter">
            <option value="all">All</option><option value="opened">Opened</option><option value="unopened">Not opened</option><option value="clicked">Clicked</option>
          </select>
          <button onClick={() => { dash.reload(); void load(true, null); }}>Refresh</button>
        </div>
        {listState.error ? <ErrorBox e={listState.error} onRetry={() => void load(true, null)} /> : null}
        {!listState.loading && !listState.error && shown.length === 0 ? (
          <div className="empty">{items.length ? 'No messages match your search.' : 'No tracked emails yet. In Gmail, write a new message and click “Send tracked”.'}</div>
        ) : (
          <table>
            <thead><tr><th>Subject</th><th>Status</th><th>Opened</th><th>Clicks</th><th>Last activity</th><th>Sent</th></tr></thead>
            <tbody>
              {shown.map((i) => (
                <tr key={i.email_id} className="row" onClick={() => onOpen(i.email_id)} tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter') onOpen(i.email_id); }}>
                  <td><div>{subjectOf(i)}</div><div className="muted small">{i.local?.recipients.map((r) => r.address).join(', ') || `${i.recipients} recipient(s)`}</div></td>
                  <td><Badge text={i.status} tone={STATUS_TONE[i.status] ?? 'muted'} /></td>
                  <td>{i.opened_recipients}/{i.recipients}</td>
                  <td>{i.clicks}</td>
                  <td>{fmtRelative(i.last_activity_at)}</td>
                  <td className="muted small">{fmtTime(i.sent_at ?? i.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div style={{ marginTop: 12, textAlign: 'center' }}>
          {listState.loading ? <span className="spin" /> : cursor ? <button onClick={() => void load(false, cursor)}>Load more</button> : null}
        </div>
      </div>
    </>
  );
}

function EmailDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const [suspected, setSuspected] = useState(false);
  const d = useAsync(() => rpc<Detail>({ type: 'email', emailId: id, includeSuspected: suspected }), [id, suspected]);
  const [deleting, setDeleting] = useState(false);
  const addr = (rid: string) => d.data?.local?.recipients.find((r) => r.recipientId === rid)?.address ?? d.data?.recipients.find((r) => r.recipient_id === rid)?.address ?? 'Recipient';
  const del = async () => {
    if (!window.confirm('Delete this message’s tracking data from Tracklet (server and this device)? Links in the sent email will stop redirecting.')) return;
    setDeleting(true);
    try { await rpc({ type: 'deleteEmail', emailId: id }); onBack(); } catch (e) { setDeleting(false); window.alert(e instanceof Error ? e.message : 'Delete failed'); }
  };
  if (d.loading && !d.data) return <div className="empty"><span className="spin" /></div>;
  if (d.error) return <><button onClick={onBack}>← Back</button><div style={{ height: 12 }} /><ErrorBox e={d.error} onRetry={d.reload} /></>;
  const x = d.data!;
  return (
    <>
      <div className="toolbar"><button onClick={onBack}>← Back</button><div className="spacer" /><button className="danger" disabled={deleting} onClick={() => void del()}>Delete tracking data</button></div>
      <div className="panel" style={{ marginBottom: 16 }}>
        <h2 style={{ margin: '0 0 4px', fontSize: 18 }}>{subjectOf(x)}</h2>
        <div className="muted small">Sent {fmtTime(x.sent_at ?? x.created_at)} · <Badge text={x.status} tone={STATUS_TONE[x.status] ?? 'muted'} /></div>
      </div>
      <div className="cards">
        {[['Recipients sent', `${x.totals.sent_recipients}/${x.totals.recipients}`], ['Likely opened', x.totals.opened_recipients], ['Opens', x.totals.opens], ['Clicks', x.totals.clicks], ['Suspected automated', x.totals.suspected_events]]
          .map(([k, v]) => <div key={String(k)} className="panel card"><div className="k">{k}</div><div className="v">{String(v)}</div></div>)}
      </div>
      <div className="grid2">
        <div className="panel">
          <h3 style={{ marginTop: 0 }}>Recipients</h3>
          <table><thead><tr><th>Recipient</th><th>Status</th><th>Opens</th><th>Clicks</th></tr></thead>
            <tbody>{x.recipients.map((r) => {
              const [text, tone] = LABEL_TONE[r.status_label] ?? [r.status_label, 'muted'];
              return (
                <tr key={r.recipient_id}>
                  <td>{addr(r.recipient_id)}<div className="muted small">{r.original_field.toUpperCase()}{r.send_error ? ` · ${r.send_error}` : ''}</div></td>
                  <td><Badge text={text} tone={tone} />{r.last_open_at ? <div className="muted small">last {fmtRelative(r.last_open_at)}</div> : null}</td>
                  <td>{r.open_count}</td><td>{r.click_count}</td>
                </tr>
              );
            })}</tbody>
          </table>
        </div>
        <div className="panel">
          <h3 style={{ marginTop: 0 }}>Links</h3>
          {x.links.length === 0 ? <div className="muted">No tracked links in this message.</div> : (
            <table><thead><tr><th>Link</th><th>Clicks</th><th>People</th></tr></thead>
              <tbody>{x.links.map((l) => <tr key={l.index}><td style={{ wordBreak: 'break-all' }}>{l.url}</td><td>{l.clicks}</td><td>{l.unique_recipients}</td></tr>)}</tbody>
            </table>
          )}
        </div>
      </div>
      <div className="panel" style={{ marginTop: 16 }}>
        <div className="toolbar"><h3 style={{ margin: 0 }}>Activity</h3><div className="spacer" />
          <label className="small"><input type="checkbox" checked={suspected} onChange={(e) => setSuspected(e.target.checked)} /> Show suspected automated events</label>
        </div>
        {x.events.length === 0 ? <div className="empty">No activity yet.</div> : (
          <table><thead><tr><th>When</th><th>Event</th><th>Recipient</th><th>Assessment</th><th>Client</th></tr></thead>
            <tbody>{x.events.map((e) => {
              const c = CLASS_LABEL[e.classification] ?? { text: e.classification, tone: 'muted' as const };
              return (
                <tr key={e.id}>
                  <td className="small">{fmtTime(e.occurred_at)}</td>
                  <td>{e.type === 'click' ? `Click (link ${(e.link_index ?? 0) + 1})` : e.type === 'implied_open' ? 'Open (implied by click)' : 'Open'}</td>
                  <td>{addr(e.recipient_id)}</td>
                  <td><Badge text={c.text} tone={c.tone} /></td>
                  <td className="muted small">{[e.ua_family, e.country].filter(Boolean).join(' · ') || '—'}</td>
                </tr>
              );
            })}</tbody>
          </table>
        )}
        <p className="muted small">{ACCURACY_NOTE}</p>
      </div>
    </>
  );
}

const minToHHMM = (m: number | null) => (m === null ? '' : `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`);
const hhmmToMin = (s: string) => { const m = /^(\d{2}):(\d{2})$/.exec(s); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };

function Settings({ onSignedOut }: { onSignedOut: () => void }) {
  const p = useAsync(() => rpc<Preferences>({ type: 'getPrefs' }), []);
  const [draft, setDraft] = useState<Preferences | null>(null);
  const [msg, setMsg] = useState('');
  useEffect(() => { if (p.data) setDraft(p.data); }, [p.data]);
  if (p.loading && !draft) return <div className="empty"><span className="spin" /></div>;
  if (p.error) return <ErrorBox e={p.error} onRetry={p.reload} />;
  if (!draft) return null;
  const set = <K extends keyof Preferences>(k: K, v: Preferences[K]) => setDraft({ ...draft, [k]: v });
  const save = async () => {
    setMsg('Saving…');
    try { setDraft(await rpc<Preferences>({ type: 'putPrefs', prefs: draft })); setMsg('Saved.'); } catch (e) { setMsg(e instanceof Error ? e.message : 'Save failed'); }
  };
  const toggle = (k: 'notify_open' | 'notify_click' | 'notify_first_only' | 'include_suspected' | 'disclosure_enabled', label: string, help?: string) => (
    <div className="field"><div>{label}{help && <div className="muted small">{help}</div>}</div><input type="checkbox" checked={draft[k]} onChange={(e) => set(k, e.target.checked)} /></div>
  );
  return (
    <div className="grid2">
      <div className="panel">
        <h3 style={{ marginTop: 0 }}>Notifications</h3>
        {toggle('notify_open', 'Notify on opens')}
        {toggle('notify_click', 'Notify on link clicks')}
        {toggle('notify_first_only', 'Only the first open per recipient')}
        {toggle('include_suspected', 'Include suspected automated events', 'Scanner / prefetch loads are hidden by default because they are usually not a person.')}
        <div className="field"><div>Quiet hours <div className="muted small">No notifications in this window ({draft.timezone}).</div></div>
          <div><input type="time" value={minToHHMM(draft.quiet_start_min)} onChange={(e) => set('quiet_start_min', hhmmToMin(e.target.value))} aria-label="Quiet hours start" /> – <input type="time" value={minToHHMM(draft.quiet_end_min)} onChange={(e) => set('quiet_end_min', hhmmToMin(e.target.value))} aria-label="Quiet hours end" /></div></div>
        <h3>Disclosure</h3>
        {toggle('disclosure_enabled', 'Add a tracking disclosure line to tracked emails')}
        <div className="field"><input style={{ flex: 1 }} maxLength={200} placeholder="This email uses open and click tracking." value={draft.disclosure_text ?? ''} onChange={(e) => set('disclosure_text', e.target.value || null)} aria-label="Disclosure text" /></div>
        <div className="toolbar" style={{ marginTop: 12 }}><button className="primary" onClick={() => void save()}>Save settings</button><span className="muted small">{msg}</span></div>
      </div>
      <div className="panel">
        <h3 style={{ marginTop: 0 }}>Privacy</h3>
        <p className="muted small">Subjects and recipient addresses are kept only in this browser profile. The Tracklet server stores opaque per-recipient keys, link URLs, and event times. IP addresses are stored only as a salted hash that changes monthly.</p>
        <div className="field"><div>Sign out<div className="muted small">Revokes Tracklet’s Google access token and clears the session.</div></div>
          <button onClick={async () => { await rpc({ type: 'signOut' }).catch(() => undefined); onSignedOut(); }}>Sign out</button></div>
        <div className="field"><div>Delete all data<div className="muted small">Removes every tracked email, event and link from the server and this device. Links in sent emails will stop redirecting. Cannot be undone.</div></div>
          <button className="danger" onClick={async () => {
            if (!window.confirm('Delete ALL Tracklet data from the server and this device? This cannot be undone.')) return;
            try { await rpc({ type: 'deleteAll' }); window.alert('All Tracklet data was deleted.'); } catch (e) { window.alert(e instanceof Error ? e.message : 'Delete failed'); }
          }}>Delete all</button></div>
      </div>
    </div>
  );
}

function App() {
  const [view, setView] = useState<{ tab: 'overview' | 'settings'; email?: string }>({ tab: 'overview' });
  const auth = useAsync(() => rpc<{ signedIn: boolean; email?: string }>({ type: 'authStatus' }), []);
  const [signInErr, setSignInErr] = useState<unknown>(null);
  const signIn = async () => { setSignInErr(null); try { await rpc({ type: 'signIn' }); auth.reload(); } catch (e) { setSignInErr(e); } };
  return (
    <div className="wrap">
      <div className="top">
        <div className="brand">Track<span>let</span></div>
        <div className="tabs">
          <button className={view.tab === 'overview' ? 'on' : ''} onClick={() => setView({ tab: 'overview' })}>Overview</button>
          <button className={view.tab === 'settings' ? 'on' : ''} onClick={() => setView({ tab: 'settings' })}>Settings</button>
        </div>
        <div className="spacer" />
        <span className="muted small">{auth.data?.signedIn ? auth.data.email : ''}</span>
      </div>
      {auth.loading && !auth.data ? <div className="empty"><span className="spin" /></div>
        : auth.error ? <ErrorBox e={auth.error} onRetry={auth.reload} />
        : !auth.data?.signedIn ? (
          <div className="panel empty">
            <p>Sign in with Google to see your tracked emails.</p>
            <p className="small">Tracklet asks only for your email address and permission to send mail. It cannot read your inbox.</p>
            <button className="primary" onClick={() => void signIn()}>Sign in with Google</button>
            {signInErr ? <div style={{ marginTop: 12 }}><ErrorBox e={signInErr} /></div> : null}
          </div>
        ) : view.tab === 'settings' ? <Settings onSignedOut={auth.reload} />
        : view.email ? <EmailDetail id={view.email} onBack={() => setView({ tab: 'overview' })} />
        : <Overview onOpen={(id) => setView({ tab: 'overview', email: id })} />}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);

// Tracklet toolbar popup. Sign-in must start here (a user gesture in an extension page), never from Gmail.
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { GoogleIdentity } from '../lib/whoami';
import { rpc, RpcError } from './rpc';
import './styles.css';

interface Dash { totals: { emails_sent: number; opened_recipients: number; sent_recipients: number; clicked_recipients: number } }

function Popup() {
  const [auth, setAuth] = useState<{ signedIn: boolean; email?: string } | null>(null);
  const [dash, setDash] = useState<Dash | null>(null);
  const [err, setErr] = useState('');
  const [errCode, setErrCode] = useState('');
  const [who, setWho] = useState<GoogleIdentity | null>(null);
  const fail = (e: unknown, fallback: string) => { setErr(e instanceof Error ? e.message : fallback); setErrCode(e instanceof RpcError ? e.code : ''); };
  const [busy, setBusy] = useState(false);
  const refresh = async () => {
    setErr(''); setErrCode('');
    try {
      const a = await rpc<{ signedIn: boolean; email?: string }>({ type: 'authStatus' });
      setAuth(a);
      if (a.signedIn) setDash(await rpc<Dash>({ type: 'dashboard', range: '7d' }));
    } catch (e) { fail(e, 'Could not reach Tracklet.'); setAuth((x) => x ?? { signedIn: false }); }
  };
  useEffect(() => { void refresh(); }, []);
  const act = async (fn: () => Promise<unknown>) => { setBusy(true); setErr(''); setErrCode(''); try { await fn(); await refresh(); } catch (e) { fail(e, 'Failed'); } finally { setBusy(false); } };
  const t = dash?.totals;
  return (
    <div className="popup">
      <div className="top" style={{ marginBottom: 12 }}><div className="brand">Track<span>let</span></div></div>
      {err && <div className="err small" role="alert">{err} <button disabled={busy} onClick={() => void act(async () => undefined)}>Retry</button></div>}
      {errCode === 'forbidden' && (
        <div className="panel small" style={{ marginBottom: 12 }}>
          {!who ? (
            <button disabled={busy} onClick={() => void rpc<GoogleIdentity>({ type: 'whoami' }).then(setWho, (e) => fail(e, 'Failed'))}>Show my Google account ID</button>
          ) : (
            <>
              <div>Add this exact value to <code>ALLOWED_GOOGLE_SUBS</code> on the backend:</div>
              <code style={{ display: 'block', margin: '6px 0', padding: 6, background: 'var(--bg)', userSelect: 'all', wordBreak: 'break-all' }}>{who.sub}</code>
              <div className="muted">Account: {who.email ?? '—'}{who.emailVerified ? '' : ' (email not verified)'}</div>
              {!who.clientIdMatches && <div className="err" style={{ marginTop: 6 }}>This token was issued for a different OAuth client than this build's. The backend will reject it.</div>}
            </>
          )}
        </div>
      )}
      {!auth ? <span className="spin" /> : !auth.signedIn ? (
        <>
          <p className="small">Sign in with Google to send tracked emails from Gmail. Tracklet can send mail as you but cannot read your inbox.</p>
          <button className="primary" disabled={busy} onClick={() => void act(() => rpc({ type: 'signIn' }))}>Sign in with Google</button>
        </>
      ) : (
        <>
          <div className="muted small" style={{ marginBottom: 8 }}>{auth.email}</div>
          <div className="cards" style={{ gridTemplateColumns: '1fr 1fr 1fr' }}>
            {[['Sent', t?.emails_sent], ['Opened', t?.opened_recipients], ['Clicked', t?.clicked_recipients]].map(([k, v]) => (
              <div key={String(k)} className="panel card" style={{ padding: 10 }}><div className="k">{k}</div><div className="v" style={{ fontSize: 20 }}>{v ?? '—'}</div></div>
            ))}
          </div>
          <div className="muted small" style={{ marginBottom: 12 }}>Last 7 days. Opens are estimates.</div>
          <div className="toolbar">
            <button className="primary" onClick={() => void chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') })}>Open dashboard</button>
            <button disabled={busy} onClick={() => void act(() => rpc({ type: 'pollNow' }))}>Check now</button>
            <button disabled={busy} onClick={() => void act(() => rpc({ type: 'signOut' }))}>Sign out</button>
          </div>
        </>
      )}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<StrictMode><Popup /></StrictMode>);

// Test entry: constructs the REAL gmail.js 1.1.16 (+ jQuery 4.0.0) adapter and records init/registration.
import { GmailJsAdapter } from '../gmailjs-adapter';

const state: Record<string, unknown> = { constructed: false, ready: false, composeRegistered: false, viewThreadRegistered: false, errors: [] as string[] };
(window as unknown as { __ttProbe: () => unknown }).__ttProbe = () => state;
try {
  const a = new GmailJsAdapter();
  state.constructed = true;
  const t0 = performance.now();
  a.ready()
    .then(() => {
      state.ready = true;
      state.readyMs = Math.round(performance.now() - t0);
      try { a.onCompose(() => {}); state.composeRegistered = true; } catch (e) { (state.errors as string[]).push(`compose: ${String(e)}`); }
      try { a.onThreadViewed(() => {}); state.viewThreadRegistered = true; } catch (e) { (state.errors as string[]).push(`view_thread: ${String(e)}`); }
    })
    .catch((e) => { (state.errors as string[]).push(`ready: ${String(e)}`); });
} catch (e) { (state.errors as string[]).push(`construct: ${String(e)}`); }

// Probe used with the jQuery-only bundle: did jQuery initialise, and do common jQuery HTML operations work?
window.__ttProbe = () => {
  const $ = window.jQuery;
  const r = { jqueryDefined: typeof $ === 'function' };
  if (!r.jqueryDefined) return r;
  try { $('<span>x</span>'); r.parseHtmlString = 'ok'; } catch (e) { r.parseHtmlString = String(e).slice(0, 120); }
  try { $(document.createElement('div')).html('<b>x</b>'); r.htmlSetter = 'ok'; } catch (e) { r.htmlSetter = String(e).slice(0, 120); }
  try { const d = document.createElement('div'); $(d).text('<b>x</b>'); r.textSetter = d.textContent === '<b>x</b>' ? 'ok' : 'mismatch'; } catch (e) { r.textSetter = String(e).slice(0, 120); }
  return r;
};

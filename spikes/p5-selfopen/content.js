// SPIKE P5 (throwaway): neutralise our own pixel in the sender's Gmail view, and report views.
// Configure TUNNEL_HOST via chrome.storage.local {tunnelHost: "xxxx.trycloudflare.com"} from the extension's options console.
(async () => {
  const { tunnelHost } = await chrome.storage.local.get('tunnelHost');
  if (!tunnelHost) { console.warn('[P5] set chrome.storage.local.tunnelHost first'); return; }
  const PLACEHOLDER = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
  const stats = { neutralised: 0, seenAfterLoad: 0 };

  const refersToUs = (src) => {
    if (!src) return false;
    if (src.includes(tunnelHost)) return true;                    // direct or "#https://host/..." proxied form
    try { return decodeURIComponent(src).includes(tunnelHost); } catch { return false; }
  };

  const handle = (img) => {
    if (!(img instanceof HTMLImageElement) || img.dataset.p5 === '1') return;
    if (!refersToUs(img.getAttribute('src'))) return;
    img.dataset.p5 = '1';
    if (img.complete && img.naturalWidth > 0) stats.seenAfterLoad++;  // too late: already loaded
    img.setAttribute('data-p5-original', img.getAttribute('src'));
    img.src = PLACEHOLDER;
    stats.neutralised++;
    const m = location.hash.match(/#[^/]+\/([A-Za-z0-9]+)$/);       // thread id from Gmail URL, if present
    fetch(`https://${tunnelHost}/view`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ at: Date.now(), thread: m?.[1] ?? null, original: img.dataset.p5Original?.slice(0, 300), stats }) }).catch(() => {});
    console.info('[P5] neutralised', stats, img.dataset.p5Original);
  };

  new MutationObserver((muts) => {
    for (const mu of muts) {
      if (mu.type === 'attributes') handle(mu.target);
      for (const n of mu.addedNodes) {
        if (n instanceof HTMLImageElement) handle(n);
        else if (n instanceof Element) n.querySelectorAll('img').forEach(handle);
      }
    }
  }).observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['src'] });
  document.querySelectorAll('img').forEach(handle);
})();

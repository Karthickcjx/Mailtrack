// HTML rewriting for tracked sends, done on strings (no DOM): the service worker has no DOMParser,
// and DOMParser.parseFromString is a Trusted Types sink inside Gmail. Only the href attribute of
// <a> start tags is touched; everything else is copied byte-for-byte.
import { validateTargetUrl } from './url';

export interface FoundLink { index: number; url: string }

const A_TAG = /<a\b[^>]*>/gi;
const HREF = /(\shref\s*=\s*)("([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i;

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'" };
export function decodeAttr(v: string): string {
  return v.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+|#39);/gi, (m, e: string) => {
    const k = e.toLowerCase();
    if (k in NAMED) return NAMED[k]!;
    if (k.startsWith('#x')) { const n = parseInt(k.slice(2), 16); return Number.isFinite(n) ? String.fromCodePoint(n) : m; }
    if (k.startsWith('#')) { const n = parseInt(k.slice(1), 10); return Number.isFinite(n) ? String.fromCodePoint(n) : m; }
    return m;
  });
}
export function encodeAttr(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Trackable links in document order. Non-http(s) links (mailto:, tel:, #, javascript:) are skipped. */
export function extractLinks(html: string): FoundLink[] {
  const out: FoundLink[] = [];
  for (const m of html.matchAll(A_TAG)) {
    const h = m[0].match(HREF);
    if (!h) continue;
    const v = validateTargetUrl(decodeAttr(h[3] ?? h[4] ?? h[5] ?? ''));
    if (v.ok) out.push({ index: out.length, url: v.url });
  }
  return out;
}

/**
 * Replace the href of each trackable link, in the same order as extractLinks().
 * `replacement(index)` returns the new URL, or null to leave that link untouched.
 */
export function rewriteLinks(html: string, replacement: (index: number) => string | null): string {
  let index = 0;
  return html.replace(A_TAG, (tag) => {
    const h = tag.match(HREF);
    if (!h) return tag;
    const v = validateTargetUrl(decodeAttr(h[3] ?? h[4] ?? h[5] ?? ''));
    if (!v.ok) return tag;
    const next = replacement(index++);
    if (next === null) return tag;
    return tag.replace(HREF, (_all, prefix: string) => `${prefix}"${encodeAttr(next)}"`);
  });
}

/** The tracking pixel goes at the START of the body: Gmail clips messages over ~102 KB (D17). */
export function insertPixelAtTop(html: string, pixelUrl: string): string {
  const img = `<img src="${encodeAttr(pixelUrl)}" width="1" height="1" alt="" style="display:block;border:0;width:1px;height:1px">`;
  return /<body[^>]*>/i.test(html) ? html.replace(/<body[^>]*>/i, (m) => m + img) : img + html;
}

/** Plain-text alternative from HTML (best effort; links kept as "text (url)"). */
export function htmlToText(html: string): string {
  return decodeAttr(
    html
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
      .replace(/<a\b[^>]*href\s*=\s*("([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a>/gi, (_m, _q, d, s, inner: string) => {
        const text = inner.replace(/<[^>]+>/g, '').trim();
        const url = decodeAttr(d ?? s ?? '');
        return text && text !== url ? `${text} (${url})` : url;
      })
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
      .replace(/<[^>]+>/g, ''),
  ).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

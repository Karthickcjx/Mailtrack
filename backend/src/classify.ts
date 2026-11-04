// Event classification (ARCHITECTURE §5.2). Pure function so the rules are unit-testable.
// Opens are never proof that a human read the message; these labels only express likelihood.
import type { Classification, EventType } from '@tracklet/shared';

export const CLASSIFIER_VERSION = 1;
export const OPEN_GRACE_MS = 15_000;
export const CLICK_GRACE_MS = 5_000;
export const DEDUPE_MS = 60_000;
export const SELF_VIEW_WINDOW_MS = 90_000;
export const CLICK_BURST_MS = 2_000;

const SCANNER_UA = /(bot|crawl|spider|scan|preview|safelinks|barracuda|proofpoint|mimecast|symantec|trendmicro|fortinet|sophos|zscaler|headless|python-requests|curl\/|wget|go-http-client|okhttp|java\/)/i;
const SCANNER_ASN = new Set<number>([
  // Large hosting/cloud ASNs commonly used by link scanners. A hint, not proof.
  8075, // Microsoft
  16509, 14618, // Amazon
  396982, // Google Cloud
  13335, // Cloudflare
]);

export function uaFamily(ua: string): string {
  if (!ua) return 'Unknown';
  if (/GoogleImageProxy/i.test(ua)) return 'GoogleImageProxy';
  if (/YahooMailProxy/i.test(ua)) return 'YahooMailProxy';
  if (SCANNER_UA.test(ua)) return 'Scanner';
  if (/Outlook|Microsoft Office/i.test(ua)) return 'Outlook';
  if (/Thunderbird/i.test(ua)) return 'Thunderbird';
  if (/Edg\//.test(ua)) return 'Edge';
  if (/Chrome\//.test(ua)) return 'Chrome';
  if (/Firefox\//.test(ua)) return 'Firefox';
  if (/Safari\//.test(ua)) return 'Safari';
  if (/AppleWebKit/.test(ua)) return 'AppleMail';
  return 'Other';
}

export interface Signals {
  type: Exclude<EventType, 'implied_open'>;
  method: string;
  ua: string;
  asn: number | null;
  msSinceSend: number | null;
  selfViewNearby: boolean;
  duplicateRecent: boolean;
  otherLinkClickedRecently: boolean;
}

export function classify(s: Signals): Classification {
  const fam = uaFamily(s.ua);
  if (s.selfViewNearby && s.type === 'open') return 'self_suspected';
  if (s.method === 'HEAD') return s.type === 'open' ? 'prefetch_suspected' : 'scanner_suspected';
  if (s.msSinceSend !== null && s.msSinceSend >= 0) {
    if (s.type === 'open' && s.msSinceSend < OPEN_GRACE_MS) return 'prefetch_suspected';
    if (s.type === 'click' && s.msSinceSend < CLICK_GRACE_MS) return 'scanner_suspected';
  }
  if (s.type === 'click' && s.otherLinkClickedRecently) return 'scanner_suspected';
  if (fam === 'Scanner' || (s.type === 'click' && s.asn !== null && SCANNER_ASN.has(s.asn) && fam !== 'Chrome' && fam !== 'Edge' && fam !== 'Firefox' && fam !== 'Safari')) {
    return s.type === 'open' ? 'prefetch_suspected' : 'scanner_suspected';
  }
  if (s.duplicateRecent) return 'duplicate';
  if (s.type === 'open' && (fam === 'GoogleImageProxy' || fam === 'YahooMailProxy')) return 'proxy_open';
  return 'human_likely';
}

export const isCounted = (c: Classification) => c === 'human_likely' || c === 'proxy_open';

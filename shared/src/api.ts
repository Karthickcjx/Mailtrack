// Wire types shared by the extension and the backend (docs/design/API_SPEC.md rev 2).

export type OriginalField = 'to' | 'cc' | 'bcc';
export type EmailMode = 'single' | 'individual_group';
export type SendStatus = 'pending' | 'sending' | 'sent' | 'failed';
export type EmailStatus = 'pending' | 'sending' | 'sent' | 'partial' | 'failed';
export type EventType = 'open' | 'click' | 'implied_open';
export type Classification = 'human_likely' | 'proxy_open' | 'prefetch_suspected' | 'scanner_suspected' | 'self_suspected' | 'duplicate';
export type StatusLabel = 'not_sent' | 'sent' | 'likely_opened' | 'clicked' | 'suspected_only';

export const LIMITS = {
  maxRecipients: 20,
  maxLinks: 50,
  maxSubject: 998,
  maxBodyBytes: 64 * 1024,
  maxEventsPerTokenPerDay: 100,
  apiRequestsPerMinute: 120,
  registrationsPerHour: 100,
} as const;

export interface RegisterRecipient { recipient_key: string; original_field: OriginalField; address: string | null }
export interface RegisterLink { index: number; url: string }
export interface RegisterEmailRequest {
  client_request_id: string;
  mode: EmailMode;
  subject: string | null;
  track_opens: boolean;
  track_clicks: boolean;
  disclosure_added: boolean;
  recipients: RegisterRecipient[];
  links: RegisterLink[];
}
export interface RegisteredRecipient {
  recipient_id: string;
  recipient_key: string;
  pixel_url: string | null;
  links: { index: number; click_url: string }[];
}
export interface RegisterEmailResponse { email_id: string; recipients: RegisteredRecipient[] }

export interface PatchRecipientRequest {
  send_status: 'sending' | 'sent' | 'failed';
  gmail_message_id?: string;
  gmail_thread_id?: string;
  sent_at?: number;
  send_error?: string;
}

export interface TrackingEventDto {
  id: string;
  type: EventType;
  email_id: string;
  recipient_id: string;
  link_index: number | null;
  classification: Classification;
  counted: boolean;
  occurred_at: number;
  ua_family: string | null;
  country: string | null;
  notify: boolean;
}

export interface Preferences {
  notify_open: boolean;
  notify_click: boolean;
  notify_first_only: boolean;
  include_suspected: boolean;
  quiet_start_min: number | null;
  quiet_end_min: number | null;
  timezone: string;
  store_subjects: boolean;
  store_addresses: boolean;
  disclosure_enabled: boolean;
  disclosure_text: string | null;
}

export const ACCURACY_NOTE =
  'Opens are estimates. Images may be blocked (missed opens), pre-loaded by privacy features or security scanners (false opens), cached by proxies (missed repeat opens), or loaded when a message is forwarded (attributed to the original recipient).';

/** Google tokeninfo endpoint. The backend's allowlist compares its `sub` field; the extension's "Show my Google account ID" reads the same field. */
export const GOOGLE_TOKENINFO_URL = 'https://oauth2.googleapis.com/tokeninfo';

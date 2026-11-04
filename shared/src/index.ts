// Shared constants and helpers used by both the extension and the backend.
export * from './api';
export * from './html';
export * from './ids';
export * from './url';

/** The only OAuth scopes the product may request (OPEN_QUESTIONS Q14). */
export const OAUTH_SCOPES = [
  'openid',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/gmail.send',
] as const;

export const API_VERSION = 'v1';

export interface HealthResponse {
  status: 'ok';
  service: 'tracklet-backend';
  version: string;
}

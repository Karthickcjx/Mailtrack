import { describe, expect, it } from 'vitest';
import { app } from '../src/index';

describe('GET /health', () => {
  it('returns ok with no-store', async () => {
    const res = await app.request('/health', {}, { APP_VERSION: '0.0.1' } as never);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ status: 'ok', service: 'tracklet-backend', version: '0.0.1' });
  });

  it('returns JSON 404 for unknown routes', async () => {
    const res = await app.request('/nope');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
  });
});

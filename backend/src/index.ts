import { Hono } from 'hono';
import type { HealthResponse } from '@tracklet/shared';

export interface Env {
  DB: D1Database;
  APP_VERSION: string;
}

export const app = new Hono<{ Bindings: Env }>();

app.get('/health', (c) => {
  const body: HealthResponse = { status: 'ok', service: 'tracklet-backend', version: c.env?.APP_VERSION ?? 'dev' };
  return c.json(body, 200, { 'Cache-Control': 'no-store' });
});

// Phase 0 only: confirms the local D1 schema is reachable. Not part of the public API.
app.get('/health/db', async (c) => {
  const row = await c.env.DB.prepare("SELECT count(*) AS tables FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name <> 'd1_migrations'").first<{ tables: number }>();
  return c.json({ status: 'ok', tables: row?.tables ?? 0 });
});

app.notFound((c) => c.json({ error: 'not_found' }, 404));

export default app;

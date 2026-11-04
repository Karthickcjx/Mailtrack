import { createApp, runRetention, type Env } from './app';

export type { Env } from './app';

export const app = createApp({
  googleFetch: (url) => fetch(url),
  now: () => Date.now(),
});

export default {
  fetch: app.fetch,
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runRetention(env.DB, Date.now()));
  },
} satisfies ExportedHandler<Env>;

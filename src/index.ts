import feeds from '../feeds.json' with { type: 'json' };
import { loadConfig } from './config.ts';
import { runRelay } from './runner.ts';

export interface WorkerEnv {
  DB: D1Database;
  WEBHOOKS?: string;
}

export default {
  scheduled(_event, env, ctx) {
    ctx.waitUntil(
      Promise.resolve()
        .then(() => runRelay(loadConfig(feeds, env.WEBHOOKS), env.DB))
        .catch(() => {
          console.error(
            JSON.stringify({
              event: 'relay_failed',
              reason:
                'Check configuration, database migration, and D1 availability',
            }),
          );
          throw new Error('Scheduled relay failed');
        }),
    );
  },
  fetch() {
    return new Response('Not found', { status: 404 });
  },
} satisfies ExportedHandler<WorkerEnv>;

import { loadConfig } from './config.ts';
import { ConfigurationError, readFeeds } from './config-store.ts';
import { runRelay } from './runner.ts';

export interface WorkerEnv {
  DB: D1Database;
  WEBHOOKS?: string;
}

export default {
  scheduled(_event, env, ctx) {
    ctx.waitUntil(
      readFeeds(env.DB)
        .then((feeds) => runRelay(loadConfig(feeds, env.WEBHOOKS), env.DB))
        .catch((error: unknown) => {
          console.error(
            JSON.stringify({
              event: 'relay_failed',
              reason:
                error instanceof ConfigurationError
                  ? error.message
                  : 'Check configuration, database migration, and D1 availability',
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

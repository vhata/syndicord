import { handleAdmin } from './admin.ts';
import type { AdminEnv } from './admin.ts';
import { readRelayConfiguration } from './admin-store.ts';
import { ConfigurationError } from './config-store.ts';
import { runRelay } from './runner.ts';

export type WorkerEnv = AdminEnv;

export default {
  scheduled(_event, env, ctx) {
    ctx.waitUntil(
      readRelayConfiguration(env)
        .then((config) => runRelay(config, env.DB))
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
  async fetch(request, env) {
    return (
      (await handleAdmin(request, env)) ??
      new Response('Not found', { status: 404 })
    );
  },
} satisfies ExportedHandler<WorkerEnv>;

import { bindings, defineConfig, triggers } from 'cf/config';

const workerName = process.env.SYNDICORD_WORKER_NAME ?? 'syndicord';

export default defineConfig({
  worker: {
    name: workerName,
    compatibilityDate: '2026-11-18',
    entrypoint: './src/index.ts',
    env: {
      DB: bindings.d1({
        name: workerName,
        id:
          process.env.SYNDICORD_DATABASE_ID ??
          '00000000-0000-4000-8000-000000000001',
      }),
      // Runtime secrets are supplied by the operator and preserved on deploy.
      // Declaring bindings.secret() makes them mandatory and filters .dev.vars,
      // which would prevent installations without web administration from running.
    },
    triggers: [triggers.scheduled({ schedule: '* * * * *' })],
    // OAuth callbacks contain one-time codes; keep them out of request logs.
    observability: { enabled: true, redactQueryString: true },
    workersDev: true,
    previewUrls: false,
  },
});

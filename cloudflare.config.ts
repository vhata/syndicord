import { bindings, defineConfig, triggers } from 'cf/config';

export default defineConfig({
  worker: {
    name: 'syndicord',
    compatibilityDate: '2026-11-18',
    entrypoint: './src/index.ts',
    env: {
      DB: bindings.d1({
        name: 'syndicord',
        id:
          process.env.SYNDICORD_DATABASE_ID ??
          '00000000-0000-4000-8000-000000000001',
      }),
      WEBHOOKS: bindings.secret(),
    },
    triggers: [triggers.scheduled({ schedule: '* * * * *' })],
    observability: { enabled: true },
    workersDev: false,
    previewUrls: false,
  },
});

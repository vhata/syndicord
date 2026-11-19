import { defineConfig } from 'cf/config';

export default defineConfig({
  worker: {
    name: 'syndicord',
    compatibilityDate: '2026-11-18',
    workersDev: false,
    previewUrls: false,
  },
});

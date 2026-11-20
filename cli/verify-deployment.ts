import { setTimeout as delay } from 'node:timers/promises';

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const CHECKS = 6;
const RETRY_DELAY_MS = 2_000;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

// Deployment history can lag a successful upload. Retry only these reads,
// never the upload or migrations, and keep checking the latest deployment.
export async function verifyDeployment(
  read: (args: string[]) => unknown | Promise<unknown>,
  worker: string,
  message: string,
  wait: (milliseconds: number) => Promise<void> = delay,
): Promise<string> {
  let observation = '';
  for (let attempt = 0; attempt < CHECKS; attempt++) {
    if (attempt > 0) await wait(RETRY_DELAY_MS);
    observation = 'Cloudflare metadata could not be read';
    try {
      const history = record(
        await read(['workers', 'deployments', 'list', '--worker', worker]),
      );
      const latest = Array.isArray(history?.deployments)
        ? record(history.deployments[0])
        : null;
      const versions = latest?.versions;
      const active =
        Array.isArray(versions) && versions.length === 1
          ? record(versions[0])
          : null;
      const versionId = active?.version_id;
      if (
        active?.percentage !== 100 ||
        typeof versionId !== 'string' ||
        !UUID.test(versionId)
      ) {
        observation = 'no single Worker version serving 100% of traffic';
        continue;
      }
      // Only validated IDs enter diagnostics; remote annotations and response
      // bodies can contain private data and must not be echoed.
      observation = `Worker version ${versionId} could not be read`;
      const version = record(
        await read([
          'workers',
          'versions',
          'get',
          versionId,
          '--worker',
          worker,
        ]),
      );
      if (record(version?.annotations)?.['workers/message'] === message)
        return versionId;
      observation = `Worker version ${versionId} has a different or missing deployment annotation`;
    } catch {
      // Do not expose command errors or raw API responses in diagnostics.
    }
  }
  throw new Error(
    `Upload finished but the active Worker version could not be verified after ${CHECKS} checks. Last observation: ${observation}. Inspect Cloudflare before retrying; the upload and applied migrations have not been rolled back.`,
  );
}

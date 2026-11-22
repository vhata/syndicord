import { AdminError } from './admin-store.ts';
import { DISCORD_ID } from './admin-policy.ts';
import { validateWebhooks } from './config.ts';
import { record } from './catalog-document.ts';
import type { Fetcher } from './types.ts';

export class WebhookVerificationError extends AdminError {
  retryAfterMs: number | null = null;
  global = false;
}

function seconds(value: unknown): number | null {
  if (
    (typeof value !== 'number' && typeof value !== 'string') ||
    (typeof value === 'string' && !value.trim())
  )
    return null;
  const delay = Number(value) * 1000;
  return Number.isFinite(delay) && delay >= 0 && delay <= 24 * 60 * 60_000
    ? Math.ceil(delay)
    : null;
}

function headerDelay(headers: Headers): number {
  const retry = headers.get('Retry-After');
  const timestamp = retry ? Date.parse(retry) : NaN;
  return Math.max(
    1000,
    seconds(retry) ??
      (Number.isFinite(timestamp)
        ? Math.min(24 * 60 * 60_000, Math.max(0, timestamp - Date.now()))
        : 0),
    seconds(headers.get('X-RateLimit-Reset-After')) ?? 0,
  );
}

async function responseJson(response: Response, signal: AbortSignal) {
  if (!response.body) throw new Error();
  const reader = response.body.getReader();
  const cancel = () => void reader.cancel().catch(() => {});
  signal.addEventListener('abort', cancel, { once: true });
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
  let size = 0;
  let text = '';
  try {
    while (true) {
      signal.throwIfAborted();
      const part = await reader.read();
      signal.throwIfAborted();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 64 * 1024) throw new Error();
      text += decoder.decode(part.value, { stream: true });
    }
    return JSON.parse(text + decoder.decode()) as unknown;
  } finally {
    signal.removeEventListener('abort', cancel);
    cancel();
    reader.releaseLock();
  }
}

/** Inspect an incoming webhook without executing it or exposing its token. */
export async function verifyWebhook(
  value: string,
  fetcher: Fetcher = fetch,
): Promise<{ url: string; guildId: string; channelId: string }> {
  let url: URL;
  try {
    url = new URL(validateWebhooks({ destination: value }).destination!);
  } catch {
    throw new WebhookVerificationError('Provide a valid Discord webhook URL.');
  }
  if (url.search)
    throw new WebhookVerificationError(
      'Scoped destinations require a channel webhook without thread_id. Ask the operator to use a channel destination before initializing the catalog.',
    );
  const parts = url.pathname.split('/');
  const webhookId = parts.at(-2)!;
  const token = parts.at(-1)!;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rateLimit: WebhookVerificationError | undefined;
  const inspect = async () => {
    const response = await fetcher(
      `https://discord.com/api/v10/webhooks/${webhookId}/${token}`,
      { method: 'GET', redirect: 'manual', signal: controller.signal },
    );
    controller.signal.throwIfAborted();
    if (response.status === 429) {
      rateLimit = new WebhookVerificationError(
        'Discord is limiting webhook verification. Wait before trying again.',
        429,
      );
      rateLimit.retryAfterMs = headerDelay(response.headers);
      rateLimit.global =
        response.headers.get('X-RateLimit-Global') === 'true' ||
        response.headers.get('X-RateLimit-Scope') === 'global';
      try {
        const body = await responseJson(response, controller.signal);
        if (record(body)) {
          rateLimit.retryAfterMs = Math.max(
            rateLimit.retryAfterMs,
            seconds(body.retry_after) ?? 0,
          );
          rateLimit.global ||= body.global === true;
        }
      } catch {
        // Valid rate-limit headers remain authoritative for malformed bodies.
      }
      throw rateLimit;
    }
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      throw new WebhookVerificationError(
        'Discord could not verify this webhook. Check that it exists and try again.',
        response.status >= 500 ||
          (response.status >= 300 && response.status < 400)
          ? 503
          : 400,
      );
    }
    const body = await responseJson(response, controller.signal);
    if (
      !record(body) ||
      body.id !== webhookId ||
      body.type !== 1 ||
      typeof body.guild_id !== 'string' ||
      !DISCORD_ID.test(body.guild_id) ||
      typeof body.channel_id !== 'string' ||
      !DISCORD_ID.test(body.channel_id)
    )
      throw new WebhookVerificationError(
        'Discord returned an invalid channel webhook. Use an incoming webhook for an authorized server channel.',
        400,
      );
    return {
      url: url.href,
      guildId: body.guild_id,
      channelId: body.channel_id,
    };
  };
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error());
      }, 6000);
    });
    return await Promise.race([inspect(), timeout]);
  } catch (error) {
    if (rateLimit) throw rateLimit;
    if (error instanceof WebhookVerificationError) throw error;
    throw new WebhookVerificationError(
      'Discord webhook verification is unavailable. Try again shortly.',
      503,
    );
  } finally {
    clearTimeout(timer);
  }
}

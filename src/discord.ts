import type { FeedEntry, Fetcher } from './types.ts';

const REQUEST_TIMEOUT_MS = 6_000;
const MAX_RESPONSE_BYTES = 64 * 1_024;

export type SendResult =
  | { ok: true; cooldownMs: number }
  | {
      ok: false;
      retryAfterMs: number | null;
      global: boolean;
      status: number | null;
      reason:
        'rate_limited' | 'http_error' | 'network_error' | 'invalid_response';
    };

interface DiscordEmbed {
  title: string;
  description?: string;
  url?: string;
  timestamp?: string;
}

function displayText(value: string, maximum: number): string {
  const escaped = value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/@/g, '@\u200b')
    .replace(/</g, '‹')
    .replace(/>/g, '›')
    .replace(/[\\`*_{}[\]()#+.!|~\-]/g, '\\$&')
    .trim();
  if (escaped.length <= maximum) return escaped;
  return (
    escaped
      .slice(0, maximum - 1)
      .replace(/[\ud800-\udbff]$/, '')
      .replace(/\\$/, '') + '…'
  );
}

function messageLink(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      url.href.length <= 2_048
      ? url.href
      : null;
  } catch {
    return null;
  }
}

export function buildMessage(
  entry: FeedEntry,
  feedUrl: string,
): {
  embeds: DiscordEmbed[];
  allowed_mentions: { parse: string[] };
} {
  const embed: DiscordEmbed = {
    title: displayText(entry.title || 'Untitled', 256) || 'Untitled',
  };
  const description = displayText(entry.description, 3_000);
  if (description) embed.description = description;
  const url = messageLink(entry.link) ?? messageLink(feedUrl);
  if (url) embed.url = url;
  if (entry.publishedAt && Number.isFinite(Date.parse(entry.publishedAt))) {
    embed.timestamp = new Date(entry.publishedAt).toISOString();
  }
  return { embeds: [embed], allowed_mentions: { parse: [] } };
}

function seconds(value: unknown): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && !value.trim()) return null;
  const parsed = Number(value);
  const milliseconds = Math.ceil(parsed * 1_000);
  return Number.isFinite(parsed) &&
    parsed >= 0 &&
    Number.isSafeInteger(milliseconds) &&
    milliseconds <= Number.MAX_SAFE_INTEGER - Date.now()
    ? milliseconds
    : null;
}

function headerDelay(headers: Headers): number | null {
  const retryAfter = headers.get('Retry-After');
  let retryMs = seconds(retryAfter);
  if (retryMs === null && retryAfter) {
    const timestamp = Date.parse(retryAfter);
    if (Number.isFinite(timestamp) && timestamp > Date.now())
      retryMs = timestamp - Date.now();
  }
  const resetMs = seconds(headers.get('X-RateLimit-Reset-After'));
  const values = [retryMs, resetMs].filter(
    (value): value is number => value !== null,
  );
  return values.length ? Math.max(...values) : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

async function responseJson(
  response: Response,
  signal: AbortSignal,
): Promise<unknown> {
  if (!response.body) throw new Error('Missing response body');
  const reader = response.body.getReader();
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener('abort', cancel, { once: true });
  let complete = false;
  try {
    const advertisedLength = Number(response.headers.get('Content-Length'));
    if (advertisedLength > MAX_RESPONSE_BYTES)
      throw new Error('Response body is too large');
    const decoder = new TextDecoder();
    let bytes = 0;
    let body = '';
    while (true) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES)
        throw new Error('Response body is too large');
      body += decoder.decode(chunk.value, { stream: true });
    }
    complete = true;
    return JSON.parse(body + decoder.decode());
  } finally {
    signal.removeEventListener('abort', cancel);
    if (!complete) cancel();
    reader.releaseLock();
  }
}

export async function sendDiscord(
  webhook: string,
  entry: FeedEntry,
  feedUrl: string,
  fetcher: Fetcher = fetch,
): Promise<SendResult> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let status: number | null = null;
  let rateLimit: Extract<SendResult, { ok: false }> | null = null;

  const request = async (): Promise<SendResult> => {
    let url: URL;
    try {
      url = new URL(webhook);
      if (
        url.protocol !== 'https:' ||
        url.port ||
        url.username ||
        url.password ||
        ![
          'discord.com',
          'discordapp.com',
          'canary.discord.com',
          'ptb.discord.com',
        ].includes(url.hostname) ||
        !/^\/api(?:\/v\d+)?\/webhooks\/\d+\/[A-Za-z0-9._-]+$/.test(url.pathname)
      ) {
        throw new Error('Invalid webhook');
      }
    } catch {
      return {
        ok: false,
        reason: 'http_error',
        status: null,
        retryAfterMs: null,
        global: false,
      };
    }
    url.searchParams.set('wait', 'true');
    const response = await fetcher(url.href, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildMessage(entry, feedUrl)),
      redirect: 'error',
      signal: controller.signal,
    });
    controller.signal.throwIfAborted();
    status = response.status;
    const delay = headerDelay(response.headers);
    if (status === 429) {
      rateLimit = {
        ok: false,
        reason: 'rate_limited',
        status,
        retryAfterMs: Math.max(1_000, delay ?? 0),
        global:
          response.headers.get('X-RateLimit-Global') === 'true' ||
          response.headers.get('X-RateLimit-Scope') === 'global',
      };
      let body: Record<string, unknown> | null = null;
      try {
        body = record(await responseJson(response, controller.signal));
      } catch {
        /* Headers still govern a malformed error response. */
      }
      rateLimit.retryAfterMs = Math.max(
        rateLimit.retryAfterMs ?? 1_000,
        seconds(body?.retry_after) ?? 0,
      );
      rateLimit.global ||= body?.global === true;
      return rateLimit;
    }
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      return {
        ok: false,
        reason: 'http_error',
        status,
        retryAfterMs: delay,
        global: false,
      };
    }

    try {
      const body = record(await responseJson(response, controller.signal));
      if (typeof body?.id !== 'string' || !/^\d{1,20}$/.test(body.id)) {
        return {
          ok: false,
          reason: 'invalid_response',
          status,
          retryAfterMs: null,
          global: false,
        };
      }
    } catch {
      if (controller.signal.aborted) throw new Error('Request timed out');
      return {
        ok: false,
        reason: 'invalid_response',
        status,
        retryAfterMs: null,
        global: false,
      };
    }
    return {
      ok: true,
      cooldownMs:
        response.headers.get('X-RateLimit-Remaining') === '0'
          ? Math.max(1_000, delay ?? 0)
          : 0,
    };
  };

  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error('Request timed out'));
      }, REQUEST_TIMEOUT_MS);
    });
    return await Promise.race([request(), timeout]);
  } catch {
    return (
      rateLimit ?? {
        ok: false,
        reason: 'network_error',
        status,
        retryAfterMs: null,
        global: false,
      }
    );
  } finally {
    clearTimeout(timer);
  }
}

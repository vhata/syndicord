import type { FeedEntry, Fetcher } from './types.ts';

const REQUEST_TIMEOUT_MS = 6_000;
const MAX_RESPONSE_BYTES = 64 * 1_024;
const MAX_EXCERPT_LENGTH = 700;

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
  color: number;
  author: { name: string; url?: string };
  title: string;
  description?: string;
  url?: string;
  timestamp?: string;
  footer: { text: string };
}

function clipText(value: string, maximum: number, markdown = true): string {
  const clipped = value.slice(0, maximum).replace(/[\ud800-\udbff]$/, '');
  const escapes = markdown ? (clipped.match(/\\+$/)?.[0].length ?? 0) : 0;
  return escapes % 2 ? clipped.slice(0, -1) : clipped;
}

function displayText(value: string, maximum: number, markdown = true): string {
  let escaped = value
    // oxlint-disable-next-line no-control-regex -- Strip non-printing controls before sending untrusted feed text.
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/@/g, '@\u200b')
    .replace(/</g, '‹')
    .replace(/>/g, '›');
  escaped = markdown
    ? escaped.replace(/[\\`*_{}[\]()#+.!|~-]/g, '\\$&').trim()
    : escaped.replace(/\s+/gu, ' ').trim();
  if (escaped.length <= maximum) return escaped;
  return clipText(escaped, maximum - 1, markdown) + '…';
}

function excerpt(entry: FeedEntry): string {
  const paragraphs = entry.description
    .replace(/\r\n?/g, '\n')
    .split(/\n\s*\n/u)
    .map((paragraph) => paragraph.replace(/\s+/gu, ' ').trim())
    .filter(Boolean);
  const heading = entry.title.replace(/\s+/gu, ' ').trim();
  // Only remove a complete heading, never a title that begins a sentence.
  while (paragraphs[0] === heading) paragraphs.shift();
  const selected = paragraphs.slice(0, 3).join('\n\n');
  const escaped = displayText(selected, MAX_EXCERPT_LENGTH + 1);
  const omitted = paragraphs.length > 3 || escaped.length > MAX_EXCERPT_LENGTH;
  if (!omitted) return escaped;
  let shortened = escaped.slice(0, MAX_EXCERPT_LENGTH - 1);
  const boundary = shortened.lastIndexOf(' ');
  if (boundary >= MAX_EXCERPT_LENGTH * 0.75) {
    shortened = shortened.slice(0, boundary);
  }
  shortened = shortened.trimEnd().replace(/(?:\\[.,;:]|[.,;:…])$/, '');
  return clipText(shortened, shortened.length) + '…';
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

function publicEntryLink(entry: FeedEntry, source: URL | null): string | null {
  // Older queued entries have no provenance, including the final feed URL
  // after redirects. Their resolved identity link cannot safely be published.
  const link = messageLink(entry.presentationLink ?? null);
  if (!link || !source) return link;
  const target = new URL(link);
  if (target.origin !== source.origin) return link;
  // A fragment must not bypass the existing configured-feed-URL fallback.
  const sourceWithoutFragment = new URL(source);
  sourceWithoutFragment.hash = '';
  const targetWithoutFragment = new URL(target);
  targetWithoutFragment.hash = '';
  if (targetWithoutFragment.href === sourceWithoutFragment.href) return null;

  return link;
}

export function buildMessage(
  entry: FeedEntry,
  feedUrl: string,
): {
  embeds: DiscordEmbed[];
  allowed_mentions: { parse: string[] };
} {
  const configuredFeedUrl = messageLink(feedUrl);
  const source = configuredFeedUrl ? new URL(configuredFeedUrl) : null;
  // Feed paths and query strings can grant access. Link to the public origin
  // without changing the full URL used for polling and delivery identity.
  const sourceUrl = source ? source.origin + '/' : null;
  const sourceHost = source?.hostname ?? '';
  const sourceName = displayText(sourceHost, 200, false);
  const feedTitle = displayText(
    entry.feedTitle || sourceHost || 'Feed update',
    256,
    false,
  );
  const embed: DiscordEmbed = {
    color: 0x0f9d92,
    author: { name: feedTitle || sourceName || 'Feed update' },
    title: displayText(entry.title || 'Untitled', 256) || 'Untitled',
    footer: { text: sourceName ? `syndicord · ${sourceName}` : 'syndicord' },
  };
  if (sourceUrl) embed.author.url = sourceUrl;
  const description = excerpt(entry);
  if (description) embed.description = description;
  const url = publicEntryLink(entry, source) ?? sourceUrl;
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
      redirect: 'manual',
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

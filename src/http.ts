import { feedUrl } from './config.ts';
import type { Fetcher } from './types.ts';

export const MAX_FEED_BYTES = 256 * 1024;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

export class FeedFetchError extends Error {
  readonly reason:
    'timeout' | 'network' | 'http' | 'redirect' | 'too_large' | 'encoding';

  constructor(
    reason:
      'timeout' | 'network' | 'http' | 'redirect' | 'too_large' | 'encoding',
  ) {
    super(`Feed fetch failed: ${reason}`);
    this.reason = reason;
    this.name = 'FeedFetchError';
  }
}

export async function fetchFeed(
  initialUrl: string,
  fetcher: Fetcher = fetch,
  timeoutMs = 6000,
): Promise<{ text: string; url: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response | undefined;
  try {
    let url = feedUrl(initialUrl);
    for (let redirects = 0; ; redirects++) {
      response = await fetcher(url, {
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          Accept:
            'application/rss+xml, application/atom+xml, application/xml, text/xml',
          'User-Agent': 'syndicord',
        },
      });
      if (!REDIRECTS.has(response.status)) break;
      await response.body?.cancel();
      const location = response.headers.get('location');
      if (redirects >= 3 || !location) throw new FeedFetchError('redirect');
      let next: string;
      try {
        next = feedUrl(new URL(location, url).href);
      } catch {
        throw new FeedFetchError('redirect');
      }
      if (url.startsWith('https:') && next.startsWith('http:'))
        throw new FeedFetchError('redirect');
      url = next;
    }
    if (!response.ok) throw new FeedFetchError('http');
    const length = Number(response.headers.get('content-length'));
    if (length > MAX_FEED_BYTES) throw new FeedFetchError('too_large');
    if (!response.body) return { text: '', url };
    const reader = response.body.getReader();
    const abort = () => {
      void reader.cancel().catch(() => {});
    };
    controller.signal.addEventListener('abort', abort, { once: true });
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        if (controller.signal.aborted) throw new FeedFetchError('timeout');
        const part = await reader.read();
        if (controller.signal.aborted) throw new FeedFetchError('timeout');
        if (part.done) break;
        size += part.value.byteLength;
        if (size > MAX_FEED_BYTES) throw new FeedFetchError('too_large');
        chunks.push(part.value);
      }
    } finally {
      controller.signal.removeEventListener('abort', abort);
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    try {
      return {
        text: new TextDecoder('utf-8', {
          fatal: true,
          ignoreBOM: false,
        }).decode(bytes),
        url,
      };
    } catch {
      throw new FeedFetchError('encoding');
    }
  } catch (error) {
    if (controller.signal.aborted) throw new FeedFetchError('timeout');
    if (error instanceof FeedFetchError) throw error;
    throw new FeedFetchError('network');
  } finally {
    clearTimeout(timer);
    if (response?.body && !response.body.locked)
      await response.body.cancel().catch(() => {});
  }
}

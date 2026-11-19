import { decodeHTMLStrict } from 'entities';
import { XMLValidator } from 'fast-xml-parser';
import { parseFeed } from 'feedsmith';
import type { AtomFeed } from 'feedsmith';
import type { FeedEntry, ParsedFeed } from './types.ts';

const MAX_ENTRIES = 200;
const MAX_ID_LENGTH = 2_048;
const MAX_LINK_LENGTH = 2_048;
const MAX_TITLE_LENGTH = 512;
const MAX_DESCRIPTION_LENGTH = 4_000;

function text(value: string | undefined, html = true): string {
  let result = value ?? '';
  if (html) {
    result = result
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
      .replace(
        /<\/?(?:p|div|li|ul|ol|blockquote|br|hr|h[1-6]|tr|td)\b[^>]*>/gi,
        ' ',
      )
      .replace(/<\/?[a-z][^>]*>/gi, '');
  }
  return decodeHTMLStrict(result)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

function atomText(value: AtomFeed.Text | AtomFeed.Content | undefined): string {
  return text(value?.value, value?.type === 'html' || value?.type === 'xhtml');
}

function truncate(value: string, maximum: number): string {
  if (value.length <= maximum) return value;
  // Avoid leaving half of a surrogate pair at the end of a stored string.
  return value.slice(0, maximum).replace(/[\ud800-\udbff]$/, '');
}

function safeLink(value: string | undefined, base: string): string | null {
  if (!value?.trim()) return null;
  try {
    const url = new URL(value, base);
    if (
      !['https:', 'http:'].includes(url.protocol) ||
      url.username ||
      url.password
    ) {
      return null;
    }
    return url.href.length <= MAX_LINK_LENGTH ? url.href : null;
  } catch {
    return null;
  }
}

function date(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

interface Candidate {
  id?: string | undefined;
  title: string;
  description: string;
  link: string | null;
  publishedAt: string | null;
}

async function normalize(candidate: Candidate): Promise<FeedEntry | null> {
  const stableId = candidate.id?.trim();
  if (stableId && stableId.length > MAX_ID_LENGTH) {
    throw new Error('Feed entry ID exceeds the supported length');
  }
  if (
    !stableId &&
    !candidate.link &&
    !candidate.title &&
    !candidate.description
  ) {
    return null;
  }

  let id = stableId
    ? `id:${stableId}`
    : candidate.link
      ? `link:${candidate.link}`
      : '';
  if (!id) {
    // Hash before display truncation so entries with a common prefix stay distinct.
    const content = JSON.stringify([
      candidate.title,
      candidate.description,
      candidate.publishedAt,
    ]);
    const digest = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(content),
    );
    id = `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
  }

  return {
    id,
    title: truncate(candidate.title || 'Untitled', MAX_TITLE_LENGTH),
    link: candidate.link,
    description: truncate(candidate.description, MAX_DESCRIPTION_LENGTH),
    publishedAt: candidate.publishedAt,
  };
}

export async function parseFeedDocument(
  xml: string,
  feedUrl: string,
): Promise<ParsedFeed> {
  const base = safeLink(feedUrl, feedUrl);
  if (!base)
    throw new Error(
      'Feed URL must be an HTTP or HTTPS URL without credentials',
    );
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(xml)) {
    throw new Error('Feed document declarations are not supported');
  }
  if (XMLValidator.validate(xml) !== true)
    throw new Error('Feed XML is malformed');

  let parsed: ReturnType<typeof parseFeed>;
  try {
    parsed = parseFeed(xml, { maxItems: MAX_ENTRIES + 1 });
  } catch {
    throw new Error('Feed document is invalid');
  }

  let title: string;
  let candidates: Candidate[];
  if (parsed.format === 'rss') {
    const feedBase = safeLink(parsed.feed.xml?.base, base) ?? base;
    title = text(parsed.feed.title);
    candidates = (parsed.feed.items ?? []).map((item) => {
      const itemBase = safeLink(item.xml?.base, feedBase) ?? feedBase;
      return {
        id: item.guid?.value,
        title: text(item.title),
        description: text(item.description || item.content?.encoded),
        link:
          safeLink(item.link, itemBase) ??
          (item.guid?.isPermaLink === false ||
          !/^https?:\/\//i.test(item.guid?.value ?? '')
            ? null
            : safeLink(item.guid?.value, itemBase)),
        publishedAt: date(item.pubDate ?? item.dc?.dates?.[0]),
      };
    });
  } else if (parsed.format === 'atom') {
    const feedBase = safeLink(parsed.feed.xml?.base, base) ?? base;
    title = atomText(parsed.feed.title);
    candidates = (parsed.feed.entries ?? []).map((entry) => {
      const entryBase = safeLink(entry.xml?.base, feedBase) ?? feedBase;
      const links = (entry.links ?? []).filter(
        (link) => !link.rel || link.rel === 'alternate',
      );
      return {
        id: entry.id,
        title: atomText(entry.title),
        description: atomText(entry.summary ?? entry.content),
        link:
          links.map((link) => safeLink(link.href, entryBase)).find(Boolean) ??
          null,
        publishedAt: date(entry.published ?? entry.updated),
      };
    });
  } else {
    throw new Error('Only RSS and Atom feeds are supported');
  }

  if (candidates.length > MAX_ENTRIES)
    throw new Error('Feed contains too many entries');
  const entries: FeedEntry[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const entry = await normalize(candidate);
    if (!entry || seen.has(entry.id)) continue;
    seen.add(entry.id);
    entries.push(entry);
  }
  return { title: truncate(title, MAX_TITLE_LENGTH), entries };
}

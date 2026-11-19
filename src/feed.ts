import { decodeHTMLStrict, decodeXML } from 'entities';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
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
  return (html ? decodeHTMLStrict(result) : result)
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

function resolveBase(value: string | undefined, parent: string): string {
  if (!value) return parent;
  const base = safeLink(value, parent);
  if (!base) throw new Error('Feed contains an invalid XML base URL');
  return base;
}

interface XmlNode {
  [key: string]: XmlNode[] | Record<string, string> | string | undefined;
  ':@'?: Record<string, string>;
}

interface XmlElement {
  name: string;
  namespace: string;
  namespaces: Record<string, string>;
  attributes: Record<string, string>;
  children: XmlNode[];
}

function element(
  node: XmlNode,
  parentNamespaces: Record<string, string>,
): XmlElement | null {
  const tag = Object.keys(node).find(
    (key) => key !== ':@' && !key.startsWith('#') && !key.startsWith('?'),
  );
  if (!tag) return null;
  const namespaces: Record<string, string> = Object.assign(
    Object.create(null),
    parentNamespaces,
  );
  const attributes = node[':@'] ?? {};
  for (const [name, value] of Object.entries(attributes)) {
    if (name === 'xmlns') namespaces[''] = decodeXML(value);
    else if (name.startsWith('xmlns:'))
      namespaces[name.slice(6)] = decodeXML(value);
  }
  const colon = tag.indexOf(':');
  const prefix = colon === -1 ? '' : tag.slice(0, colon);
  return {
    name: colon === -1 ? tag : tag.slice(colon + 1),
    namespace: namespaces[prefix] ?? '',
    namespaces,
    attributes,
    children: Array.isArray(node[tag]) ? (node[tag] as XmlNode[]) : [],
  };
}

// Feedsmith retains feed/entry XML bases but drops them from link objects.
// Read that metadata only when needed, preserving namespace scope and order.
function atomLinksWithBases(
  xml: string,
  markup: string,
  feedBase: string,
  count: number,
): (string | null)[] | null {
  if (!/\bxml:base\s*=/i.test(markup)) return null;
  const nodes = new XMLParser({
    preserveOrder: true,
    ignoreAttributes: false,
    attributeNamePrefix: '',
    parseTagValue: false,
    parseAttributeValue: false,
    processEntities: false,
    ignoreDeclaration: true,
    ignorePiTags: true,
  }).parse(xml) as XmlNode[];
  const feed = nodes
    .map((node) => element(node, {}))
    .find((node) => node?.name === 'feed');
  if (!feed) throw new Error('Atom link metadata is invalid');
  const entries = feed.children
    .map((node) => element(node, feed.namespaces))
    .filter(
      (node): node is XmlElement =>
        node?.name === 'entry' && node.namespace === feed.namespace,
    );
  if (entries.length !== count)
    throw new Error('Atom entry metadata is inconsistent');
  return entries.map((entry) => {
    const entryBase = resolveBase(
      entry.attributes['xml:base']
        ? decodeXML(entry.attributes['xml:base'])
        : undefined,
      feedBase,
    );
    for (const child of entry.children) {
      const link = element(child, entry.namespaces);
      if (link?.name !== 'link' || link.namespace !== feed.namespace) continue;
      const rel = link.attributes.rel
        ? decodeXML(link.attributes.rel)
        : undefined;
      if (rel && rel !== 'alternate') continue;
      const base = resolveBase(
        link.attributes['xml:base']
          ? decodeXML(link.attributes['xml:base'])
          : undefined,
        entryBase,
      );
      const href = link.attributes.href
        ? decodeXML(link.attributes.href)
        : undefined;
      const resolved = safeLink(href, base);
      if (resolved) return resolved;
    }
    return null;
  });
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
  const markup = xml.replace(/<!\[CDATA\[[\s\S]*?\]\]>|<!--[\s\S]*?-->/g, '');
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(markup)) {
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
    const feedBase = resolveBase(parsed.feed.xml?.base, base);
    title = text(parsed.feed.title, false);
    candidates = (parsed.feed.items ?? []).map((item) => {
      const itemBase = resolveBase(item.xml?.base, feedBase);
      return {
        id: item.guid?.value,
        title: text(item.title, false),
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
    const feedBase = resolveBase(parsed.feed.xml?.base, base);
    title = atomText(parsed.feed.title);
    const entries = parsed.feed.entries ?? [];
    if (entries.length > MAX_ENTRIES)
      throw new Error('Feed contains too many entries');
    const linksWithBases = atomLinksWithBases(
      xml,
      markup,
      feedBase,
      entries.length,
    );
    candidates = entries.map((entry, index) => {
      const entryBase = resolveBase(entry.xml?.base, feedBase);
      const links = (entry.links ?? []).filter(
        (link) => !link.rel || link.rel === 'alternate',
      );
      return {
        id: entry.id,
        title: atomText(entry.title),
        description: atomText(entry.summary ?? entry.content),
        link: linksWithBases
          ? (linksWithBases[index] ?? null)
          : (links
              .map((link) => safeLink(link.href, entryBase))
              .find(Boolean) ?? null),
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

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

function stripComments(value: string): string {
  const parts: string[] = [];
  let cursor = 0;
  for (let start = value.indexOf('<!--'); start !== -1;) {
    const end = value.indexOf('-->', start + 4);
    // Later openings cannot close either; retain the unfinished suffix.
    if (end === -1) break;
    parts.push(value.slice(cursor, start), ' ');
    cursor = end + 3;
    start = value.indexOf('<!--', cursor);
  }
  return parts.join('') + value.slice(cursor);
}

function stripScriptsAndStyles(value: string): string {
  const parts: string[] = [];
  const opening = /<(script|style)\b/gi;
  // Each closing-tag search moves forward only. An unmatched opening must
  // not cause the remainder to be searched again at every later opening.
  const closing = (pattern: RegExp) => {
    let next = pattern.exec(value);
    return (after: number): number | null => {
      while (next && next.index < after) next = pattern.exec(value);
      return next ? next.index + next[0].length : null;
    };
  };
  const scriptEnd = closing(/<\/script\s*>/gi);
  const styleEnd = closing(/<\/style\s*>/gi);
  let cursor = 0;
  let tagEnd = -1;
  for (let match = opening.exec(value); match; match = opening.exec(value)) {
    // Several overlapping openings can share one '>'. Cache that search too.
    if (tagEnd < opening.lastIndex)
      tagEnd = value.indexOf('>', opening.lastIndex);
    if (tagEnd === -1) break;
    const end = (match[1]!.toLowerCase() === 'script' ? scriptEnd : styleEnd)(
      tagEnd + 1,
    );
    if (end === null) continue;
    parts.push(value.slice(cursor, match.index), ' ');
    cursor = end;
    opening.lastIndex = end;
  }
  return parts.join('') + value.slice(cursor);
}

function replaceTags(
  value: string,
  opening: RegExp,
  replacement: string,
): string {
  const parts: string[] = [];
  let cursor = 0;
  for (let match = opening.exec(value); match; match = opening.exec(value)) {
    const end = value.indexOf('>', opening.lastIndex);
    if (end === -1) break;
    parts.push(value.slice(cursor, match.index), replacement);
    cursor = end + 1;
    opening.lastIndex = cursor;
  }
  return parts.join('') + value.slice(cursor);
}

function text(
  value: string | undefined,
  html = true,
  paragraphs = false,
): string {
  let result = value ?? '';
  if (html) {
    // Preserve the replacement order, including malformed markup: this text
    // also contributes to stored fallback identities for entries without IDs.
    result = stripScriptsAndStyles(stripComments(result));
    result = replaceTags(
      result,
      /<\/?(?:p|div|li|ul|ol|blockquote|br|hr|h[1-6]|tr|td)\b/gi,
      paragraphs ? '\n\n' : ' ',
    );
    result = replaceTags(result, /<\/?[a-z]/gi, '');
  }
  result = (html ? decodeHTMLStrict(result) : result)
    // oxlint-disable-next-line no-control-regex -- Strip non-printing controls from untrusted feed text.
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  if (!paragraphs) return result.replace(/\s+/gu, ' ').trim();
  return result
    .replace(/\r\n?/g, '\n')
    .split(/\n\s*\n/u)
    .map((paragraph) => paragraph.replace(/\s+/gu, ' ').trim())
    .filter(Boolean)
    .join('\n\n');
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

interface LinkBase {
  identity: string;
  public: string;
}

interface EntryLink {
  link: string;
  presentationLink: string | null;
}

function entryLink(
  value: string | undefined,
  base: LinkBase,
): EntryLink | null {
  const link = safeLink(value, base.identity);
  if (!link) return null;
  // Keep the existing identity URL. Only publish URLs that do not need any
  // path or query inherited from the private configured feed URL.
  return {
    link,
    presentationLink: link === safeLink(value, base.public) ? link : null,
  };
}

function resolveBase(value: string | undefined, parent: LinkBase): LinkBase {
  if (!value) return parent;
  const identity = safeLink(value, parent.identity);
  const publicBase = safeLink(value, parent.public);
  if (!identity || !publicBase)
    throw new Error('Feed contains an invalid XML base URL');
  return { identity, public: publicBase };
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
  feedBase: LinkBase,
  count: number,
): (EntryLink | null)[] | null {
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
      const resolved = entryLink(href, base);
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
  presentationLink: string | null;
  publishedAt: string | null;
  identityDescription?: string;
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
      candidate.identityDescription ?? candidate.description,
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
    presentationLink: candidate.presentationLink,
    description: truncate(candidate.description, MAX_DESCRIPTION_LENGTH),
    publishedAt: candidate.publishedAt,
  };
}

export async function parseFeedDocument(
  xml: string,
  feedUrl: string,
): Promise<ParsedFeed> {
  const configuredBase = safeLink(feedUrl, feedUrl);
  if (!configuredBase)
    throw new Error(
      'Feed URL must be an HTTP or HTTPS URL without credentials',
    );
  const base: LinkBase = {
    identity: configuredBase,
    public: new URL(configuredBase).origin + '/',
  };
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
      const link =
        entryLink(item.link, itemBase) ??
        (item.guid?.isPermaLink === false ||
        !/^https?:\/\//i.test(item.guid?.value ?? '')
          ? null
          : entryLink(item.guid?.value, itemBase));
      const description = item.description || item.content?.encoded;
      return {
        id: item.guid?.value,
        title: text(item.title, false),
        description: text(description, true, true),
        // Display changes must not make existing fingerprinted entries new.
        ...(!item.guid?.value?.trim() && !link
          ? { identityDescription: text(description) }
          : {}),
        link: link?.link ?? null,
        presentationLink: link?.presentationLink ?? null,
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
      const link = linksWithBases
        ? (linksWithBases[index] ?? null)
        : (links.map((link) => entryLink(link.href, entryBase)).find(Boolean) ??
          null);
      const description = entry.summary ?? entry.content;
      const html =
        description?.type === 'html' || description?.type === 'xhtml';
      return {
        id: entry.id,
        title: atomText(entry.title),
        description: text(description?.value, html, true),
        ...(!entry.id?.trim() && !link
          ? { identityDescription: atomText(description) }
          : {}),
        link: link?.link ?? null,
        presentationLink: link?.presentationLink ?? null,
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
  const feedTitle = truncate(title, MAX_TITLE_LENGTH);
  for (const candidate of candidates) {
    const entry = await normalize(candidate);
    if (!entry || seen.has(entry.id)) continue;
    if (feedTitle) entry.feedTitle = feedTitle;
    seen.add(entry.id);
    entries.push(entry);
  }
  return { title: feedTitle, entries };
}

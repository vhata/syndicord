import { relative } from 'node:path';
import { parseFragment } from 'parse5';
import { pageLink, root } from './site.mjs';

function rewriteHtml(html, source, base) {
  const document = parseFragment(html, { sourceCodeLocationInfo: true });
  const replacements = [];
  function visit(node) {
    for (const attribute of node.attrs || []) {
      if (!['href', 'src'].includes(attribute.name)) continue;
      const location = node.sourceCodeLocation?.attrs?.[attribute.name];
      if (!location) continue;
      const href =
        attribute.name === 'href'
          ? pageLink(source, attribute.value, base)
          : /^(?:[a-z][a-z\d+.-]*:|\/|\.)/i.test(attribute.value)
            ? attribute.value
            : `./${attribute.value}`;
      replacements.push([
        location.startOffset,
        location.endOffset,
        `${attribute.name}="${href.replaceAll('&', '&amp;').replaceAll('"', '&quot;')}"`,
      ]);
    }
    for (const child of node.childNodes || []) visit(child);
  }
  visit(document);
  for (const [start, end, replacement] of replacements.sort(
    (a, b) => b[0] - a[0],
  )) {
    html = html.slice(0, start) + replacement + html.slice(end);
  }
  return html;
}

export function repositoryMarkdown(md, base) {
  md.core.ruler.after('inline', 'repository-links', (state) => {
    const source = relative(
      root,
      state.env.realPath || state.env.path,
    ).replaceAll('\\', '/');
    for (const token of state.tokens) {
      for (const child of token.children || []) {
        if (child.type === 'link_open')
          child.attrSet('href', pageLink(source, child.attrGet('href')));
        if (child.type === 'html_inline')
          child.content = rewriteHtml(child.content, source, base);
      }
      if (token.type === 'html_block')
        token.content = rewriteHtml(token.content, source, base);
    }
    if (source !== 'README.md') return;
    // The README remains the homepage's entire content. These wrappers only
    // provide layout hooks; no marketing prose is extracted or copied.
    const html = (content) => {
      const token = new state.Token('html_block', '', 0);
      token.content = content;
      return token;
    };
    const wrapped = [
      html('<section class="home-intro"><div class="home-hero">'),
    ];
    let hero = true;
    let intro = true;
    let section = false;
    for (const token of state.tokens) {
      if (hero && token.type !== 'html_block') {
        wrapped.push(html('</div><div class="home-summary">'));
        hero = false;
      }
      if (token.type === 'heading_open' && token.tag === 'h2') {
        wrapped.push(html(intro ? '</div></section>' : '</section>'));
        intro = false;
        section = true;
        wrapped.push(html('<section class="home-section">'));
      }
      wrapped.push(token);
    }
    wrapped.push(html(section ? '</section>' : '</div></section>'));
    state.tokens = wrapped;
  });
}

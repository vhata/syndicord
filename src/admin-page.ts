import { scopedContent, scopedScript } from './scoped-admin-page.ts';

const script = String.raw`
(() => {
  const byId = (id) => document.getElementById(id);
  const feedForm = byId('feed-form');
  const webhookForm = byId('webhook-form');
  const feedUrl = byId('feed-url');
  const webhookName = byId('webhook-name');
  const webhookUrl = byId('webhook-url');
  let config = null;
  let busy = false;
  let stale = false;
  let editor = null;
  let editingFeed = null;
  let editingWebhook = null;

  function node(tag, className, text) {
    const result = document.createElement(tag);
    if (className) result.className = className;
    if (text !== undefined) result.textContent = text;
    return result;
  }

  function announce(message, error = false) {
    const target = byId('notice');
    target.textContent = message;
    target.className = error ? 'notice error' : 'notice';
    target.setAttribute('role', error ? 'alert' : 'status');
  }

  function updateControls() {
    document.querySelectorAll('[data-open]').forEach((button) => {
      button.disabled = busy || stale || !config || editor !== null ||
        (button.dataset.open === 'feed' && config.destinations.length === 0);
    });
    document.querySelectorAll('[data-remove]').forEach((button) => {
      button.disabled = busy || stale || !config || editor !== null || button.dataset.used === 'true';
    });
    for (const form of [feedForm, webhookForm]) {
      form.querySelectorAll('input, button').forEach((control) => {
        control.disabled = busy || (control.type === 'submit' && stale);
      });
    }
    if (config) {
      byId('feed-empty').hidden = config.feeds.length !== 0 || editor === 'feed';
      byId('webhook-empty').hidden = config.destinations.length !== 0 || editor === 'webhook';
    }
    webhookName.readOnly = editingWebhook !== null;
    byId('reload').disabled = busy;
    byId('reload').hidden = !stale && config !== null;
    byId('workspace').setAttribute('aria-busy', String(busy));
  }

  function action(label, className, handler, attributes = {}) {
    const button = node('button', className, label);
    button.type = 'button';
    for (const [key, value] of Object.entries(attributes)) button.setAttribute(key, value);
    button.addEventListener('click', handler);
    return button;
  }

  function closeEditor() {
    feedForm.hidden = true;
    webhookForm.hidden = true;
    feedForm.reset();
    webhookForm.reset();
    editor = null;
    editingFeed = null;
    editingWebhook = null;
    updateControls();
  }

  function render() {
    const pairCount = config.feeds.reduce((total, feed) => total + feed.destinations.length, 0);
    byId('route-count').textContent = String(pairCount);
    byId('route-limit').textContent = config.maxRoutes === null
      ? 'routes' : 'of ' + config.maxRoutes + ' routes';
    byId('feed-total').textContent = String(config.feeds.length);
    byId('webhook-total').textContent = String(config.destinations.length);
    byId('feed-empty-copy').textContent = config.destinations.length
      ? 'Add an RSS or Atom feed and select its destinations.'
      : 'Add a webhook before adding a feed.';
    byId('pause-note').hidden = config.feeds.length !== 0;
    const feeds = byId('feed-list');
    feeds.replaceChildren();
    config.feeds.forEach((feed, index) => {
      const item = node('li', 'feed-row');
      const content = node('div', 'row-content');
      const title = node('h3', 'feed-title', new URL(feed.url).hostname);
      const url = node('p', 'feed-address', feed.url);
      const destinations = node('div', 'destinations');
      destinations.setAttribute('aria-label', 'Routes to');
      for (const name of feed.destinations) destinations.append(node('span', 'destination-tag', '# ' + name));
      content.append(title, url, destinations);
      const controls = node('div', 'row-actions');
      controls.append(
        action('Edit', 'button small secondary', () => openFeed(index), {
          'data-open': 'feed', 'aria-label': 'Edit feed ' + feed.url,
        }),
        action('Remove', 'text-button danger', () => removeFeed(index), {
          'data-remove': 'feed', 'aria-label': 'Remove feed ' + feed.url,
        }),
      );
      item.append(content, controls);
      feeds.append(item);
    });
    const webhooks = byId('webhook-list');
    webhooks.replaceChildren();
    for (const name of config.destinations) {
      const count = config.feeds.filter((feed) => feed.destinations.includes(name)).length;
      const item = node('li', 'webhook-row');
      const content = node('div', 'row-content');
      content.append(node('h3', 'webhook-title', '# ' + name));
      content.append(node('p', 'muted small-copy', count + (count === 1 ? ' feed' : ' feeds')));
      const controls = node('div', 'row-actions');
      controls.append(
        action('Change URL', 'text-button', () => openWebhook(name), {
          'data-open': 'webhook', 'aria-label': 'Change URL for ' + name,
        }),
        action('Remove', 'text-button danger', () => removeWebhook(name), {
          'data-remove': 'webhook', 'data-used': String(count > 0),
          'aria-label': 'Remove webhook ' + name,
          'title': count ? 'Remove this destination from its feed routes first.' : 'Remove webhook',
        }),
      );
      item.append(content, controls);
      webhooks.append(item);
    }
    byId('loading').hidden = true;
    byId('workspace').hidden = false;
    byId('route-usage').hidden = false;
    updateControls();
  }

  function openFeed(index = null) {
    if (busy || stale || editor || !config || !config.destinations.length) return;
    editor = 'feed';
    editingFeed = index;
    const feed = index === null ? null : config.feeds[index];
    byId('feed-form-title').textContent = feed ? 'Edit feed' : 'Add feed';
    byId('save-feed').textContent = feed ? 'Save feed' : 'Add feed';
    feedUrl.value = feed ? feed.url : '';
    const choices = byId('destination-choices');
    choices.replaceChildren();
    for (const name of config.destinations) {
      const label = node('label', 'destination-choice');
      const checkbox = node('input');
      checkbox.type = 'checkbox';
      checkbox.name = 'destination';
      checkbox.value = name;
      checkbox.checked = feed ? feed.destinations.includes(name) : config.destinations.length === 1;
      label.append(checkbox, node('span', '', '# ' + name));
      choices.append(label);
    }
    feedForm.hidden = false;
    announce('');
    updateControls();
    feedUrl.focus();
  }

  function openWebhook(name = null) {
    if (busy || stale || editor || !config) return;
    editor = 'webhook';
    editingWebhook = name;
    webhookName.value = name || '';
    webhookUrl.value = '';
    byId('webhook-form-title').textContent = name ? 'Change webhook URL' : 'Add webhook';
    byId('save-webhook').textContent = name ? 'Save URL' : 'Add webhook';
    byId('name-help').textContent = name
      ? 'The name cannot be changed. Existing routes use this name.'
      : 'Start with a letter. Use up to 64 letters, numbers, underscores or hyphens.';
    webhookForm.hidden = false;
    announce('');
    updateControls();
    (name ? webhookUrl : webhookName).focus();
  }

  async function responseConfig(response) {
    let result;
    try { result = await response.json(); } catch { result = null; }
    if (!response.ok) {
      if (response.status === 409) {
        stale = true;
        throw new Error('Configuration changed in another tab or tool. Your form is still here. Copy any changes you want to keep, then reload before saving.');
      }
      if (response.status === 401 || response.status === 403) {
        stale = true;
        byId('access-link').hidden = false;
        throw new Error(result && typeof result.error === 'string' ? result.error : 'Your editing access could not be verified. Review your access or sign in again.');
      }
      throw new Error(result && typeof result.error === 'string' ? result.error : 'Could not save or load configuration. Please try again.');
    }
    if (!result || !Array.isArray(result.feeds) || !Array.isArray(result.destinations) ||
        typeof result.revision !== 'string' ||
        (result.maxRoutes !== null && !Number.isInteger(result.maxRoutes))) {
      throw new Error('The server returned an unexpected response. Reload and try again.');
    }
    return result;
  }

  async function load() {
    if (busy) return;
    if (editor && !window.confirm('Reload configuration and discard the unsaved form?')) return;
    busy = true;
    updateControls();
    announce('Loading configuration…');
    try {
      const next = await responseConfig(await fetch('/admin/api/config', {
        headers: { Accept: 'application/json' }, cache: 'no-store', credentials: 'same-origin',
      }));
      config = next;
      stale = false;
      closeEditor();
      render();
      announce('');
    } catch (error) {
      byId('loading').textContent = 'Configuration could not be loaded.';
      announce(error.message, true);
    } finally {
      busy = false;
      updateControls();
    }
  }

  async function save(feeds, webhooks, message, focusId) {
    if (busy || stale || !config) return;
    const count = feeds.reduce((total, feed) => total + feed.destinations.length, 0);
    if (config.maxRoutes !== null && count > config.maxRoutes) {
      announce('This would use ' + count + ' routes. You can connect up to ' + config.maxRoutes + ' feed and destination pairs.', true);
      return;
    }
    busy = true;
    updateControls();
    announce('Saving changes…');
    try {
      config = await responseConfig(await fetch('/admin/api/config', {
        method: 'PUT', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ revision: config.revision, feeds, webhooks }),
      }));
      closeEditor();
      render();
      announce(message + ' Changes apply on the next scheduled poll.');
      byId(focusId).focus();
    } catch (error) {
      announce(error.message, true);
    } finally {
      busy = false;
      updateControls();
    }
  }

  function removeFeed(index) {
    if (!window.confirm('Remove this feed and all of its routes? Future delivery attempts will stop.')) return;
    save(config.feeds.filter((_, current) => current !== index), {}, 'Feed removed.', 'feeds-heading');
  }

  function removeWebhook(name) {
    if (!window.confirm('Remove webhook “' + name + '”? It will no longer be available for routing.')) return;
    save(config.feeds, { [name]: null }, 'Webhook removed.', 'webhooks-heading');
  }

  feedForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const destinations = [...byId('destination-choices').querySelectorAll('input:checked')].map((input) => input.value);
    if (!destinations.length) {
      announce('Choose at least one destination for this feed.', true);
      byId('destination-choices').querySelector('input').focus();
      return;
    }
    const feed = { url: feedUrl.value.trim(), destinations };
    const feeds = config.feeds.map((current, index) => index === editingFeed ? feed : current);
    if (editingFeed === null) feeds.push(feed);
    save(feeds, {}, editingFeed === null ? 'Feed added.' : 'Feed updated.', 'feeds-heading');
  });
  webhookForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const name = webhookName.value.trim();
    if (editingWebhook === null && config.destinations.includes(name)) {
      announce('That destination name already exists. Use Change URL to update its webhook.', true);
      webhookName.focus();
      return;
    }
    save(config.feeds, { [name]: webhookUrl.value.trim() }, editingWebhook === null ? 'Webhook added.' : 'Webhook URL updated.', 'webhooks-heading');
  });
  byId('add-feed').addEventListener('click', () => openFeed());
  byId('add-webhook').addEventListener('click', () => openWebhook());
  byId('cancel-feed').addEventListener('click', () => {
    closeEditor();
    byId('add-feed').focus();
  });
  byId('cancel-webhook').addEventListener('click', () => {
    closeEditor();
    byId('add-webhook').focus();
  });
  byId('reload').addEventListener('click', load);
  window.addEventListener('beforeunload', (event) => {
    if (editor) {
      event.preventDefault();
      event.returnValue = '';
    }
  });
  load();
})();
`;

export interface AdminIdentity {
  id: string;
  name: string;
  permissions?: { mode: 'legacy' | 'scoped' };
}

export interface AdminBranding {
  name?: string | undefined;
  headerColor?: string | undefined;
}

function branding(options: AdminBranding) {
  const name = options.name?.trim().slice(0, 80) || '';
  const color = /^#[0-9a-f]{6}$/i.test(options.headerColor ?? '')
    ? options.headerColor!
    : '#233c37';
  // Choose black or white by relative luminance, keeping header text readable
  // even when an operator selects a very light or saturated background.
  const channels = [1, 3, 5].map((offset) => {
    const value = parseInt(color.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  const luminance =
    channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
  return {
    name: escapeHtml(name),
    title: escapeHtml(name ? `${name} · syndicord` : 'syndicord'),
    color,
    foreground: luminance > 0.179 ? '#000000' : '#ffffff',
  };
}

const brandMark = `<svg viewBox="0 0 256 256" aria-hidden="true"><path fill="currentColor" d="M64 28h128a36 36 0 0 1 36 36v104a36 36 0 0 1-36 36h-28l-44 28v-28H64a36 36 0 0 1-36-36V64a36 36 0 0 1 36-36Z"/><g fill="none" stroke="var(--header)" stroke-linecap="round" stroke-width="18"><path d="M80 76a84 84 0 0 1 84 84"/><path d="M80 116a44 44 0 0 1 44 44"/></g><circle cx="80" cy="160" r="12" fill="var(--header)"/></svg>`;

function brandLabel(brand: ReturnType<typeof branding>): string {
  return `${brandMark}<span>syndicord</span>${brand.name ? `<span class="installation-name">${brand.name}</span>` : ''}`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll("'", '&#39;');
}

export function renderAdminPage(
  nonce: string,
  user: AdminIdentity,
  options: AdminBranding = {},
): string {
  const safeNonce = escapeHtml(nonce);
  const brand = branding(options);
  const scoped = user.permissions?.mode === 'scoped';
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light">
  <title>Feeds and webhooks · ${brand.title}</title>
  <style nonce="${safeNonce}">
    :root { color-scheme: light; --ink: #202c2b; --muted: #596562; --paper: #f5f6f5; --panel: #ffffff; --line: #dce1df; --accent: #176d61; --danger: #a23c35; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; font-synthesis: none; }
    * { box-sizing: border-box; }
    [hidden] { display: none !important; }
    body { margin: 0; color: var(--ink); background: var(--paper); font-size: 14px; line-height: 1.5; }
    button, input, select { font: inherit; }
    button { cursor: pointer; }
    button:disabled { cursor: not-allowed; opacity: .5; }
    :focus-visible { outline: 3px solid #176d61; outline-offset: 3px; }
    h1, h2, h3, p { margin: 0; }
    .skip-link { position: absolute; top: -60px; left: 20px; z-index: 5; padding: 10px; background: white; color: var(--ink); }
    .skip-link:focus { top: 12px; }
    .topbar { --header: ${brand.color}; background: var(--header); color: ${brand.foreground}; }
    .topbar :focus-visible { outline-color: currentColor; }
    .topbar-inner { max-width: 1160px; margin: auto; padding: 16px 28px; display: flex; align-items: center; justify-content: space-between; gap: 24px; }
    .brand { display: flex; align-items: center; gap: 10px; font-size: 19px; font-weight: 650; min-width: 0; }
    .installation-name { border-left: 1px solid currentColor; padding-left: 12px; font-size: 14px; font-weight: 500; overflow-wrap: anywhere; min-width: 0; }
    .brand svg { width: 28px; height: 28px; flex-shrink: 0; }
    .account { display: flex; gap: 16px; align-items: center; justify-content: flex-end; font-size: 12px; }
    .account p { overflow-wrap: anywhere; }
    .account form { margin: 0; flex-shrink: 0; }
    .account button { background: transparent; border: 1px solid currentColor; border-radius: 5px; color: inherit; padding: 8px 12px; }
    main { max-width: 1160px; margin: auto; padding: 30px 28px; }
    .page-heading { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 8px 20px; margin-bottom: 20px; }
    h1 { font-size: 26px; line-height: 1.25; font-weight: 650; letter-spacing: -.6px; }
    .route-usage { color: var(--muted); font-size: 13px; }
    .feedback { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; }
    .notice:not(:empty), .feedback .button:not([hidden]) { margin-bottom: 16px; }
    .notice { font-size: 13px; color: var(--accent); }
    .notice.error { color: var(--danger); }
    .grid { display: grid; grid-template-columns: minmax(0, 1.25fr) minmax(0, 1fr); gap: 20px; align-items: start; }
    .panel { border: 1px solid var(--line); background: var(--panel); border-radius: 8px; }
    .panel-header { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; padding: 18px 20px; }
    .section-title { display: flex; align-items: baseline; gap: 8px; }
    h2 { font-size: 17px; font-weight: 650; }
    .count { color: var(--muted); font-size: 13px; }
    .button { display: inline-flex; align-items: center; justify-content: center; border: 1px solid var(--accent); background: var(--accent); color: white; border-radius: 5px; padding: 8px 12px; min-height: 38px; font-size: 13px; font-weight: 600; text-decoration: none; }
    .button:hover:not(:disabled) { background: #11564c; border-color: #11564c; }
    .button.secondary { background: transparent; border-color: #bfc9c4; color: var(--ink); }
    .button.secondary:hover:not(:disabled) { background: #f0f3f1; }
    .button.small { min-height: 34px; padding: 5px 11px; }
    .text-button { border: 0; padding: 7px 0; min-height: 34px; background: transparent; color: var(--accent); font-size: 13px; text-align: left; }
    .text-button:hover:not(:disabled) { text-decoration: underline; }
    .text-button.danger { color: var(--danger); }
    .empty { padding: 22px 20px; border-top: 1px solid var(--line); }
    .empty h3 { font-size: 14px; font-weight: 600; }
    .empty p { margin-top: 4px; color: var(--muted); font-size: 13px; }
    .rows { list-style: none; margin: 0; padding: 0; }
    .feed-row, .webhook-row { padding: 18px 20px; border-top: 1px solid var(--line); display: flex; gap: 16px; align-items: flex-start; }
    .row-content { min-width: 0; flex: 1; }
    .feed-title, .webhook-title { font-size: 14px; font-weight: 650; overflow-wrap: anywhere; }
    .feed-address { margin-top: 4px; color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }
    .destinations { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
    .destination-tag { padding: 2px 7px; background: #f0f3f1; color: #41534b; border-radius: 4px; font-size: 12px; overflow-wrap: anywhere; max-width: 100%; }
    .row-actions { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; flex-shrink: 0; }
    .muted { color: var(--muted); }
    .small-copy { font-size: 12px; margin-top: 4px; }
    .panel-footnote { padding: 12px 20px; border-top: 1px solid var(--line); font-size: 12px; color: var(--muted); }
    .editor { padding: 20px; background: #f8faf9; border-top: 1px solid var(--line); border-radius: 0 0 8px 8px; }
    .editor h3 { font-size: 16px; font-weight: 650; }
    .field { margin-top: 18px; }
    .field-label, legend { display: block; font-size: 13px; font-weight: 600; margin-bottom: 6px; }
    select, input[type="url"], input[type="text"], input[type="password"] { display: block; width: 100%; min-width: 0; background: white; color: var(--ink); border: 1px solid #aebbb4; border-radius: 5px; padding: 10px; font-size: 16px; }
    input[readonly] { background: #edf1ee; color: var(--muted); }
    input::placeholder { color: #6a756f; }
    .field-help { font-size: 12px; color: var(--muted); margin-top: 6px; }
    fieldset { min-width: 0; margin: 18px 0 0; padding: 0; border: 0; }
    .destination-choices { display: flex; flex-wrap: wrap; gap: 8px; }
    .destination-choice { display: flex; align-items: flex-start; gap: 8px; padding: 9px 10px; background: white; border: 1px solid #bfc9c4; border-radius: 5px; font-size: 13px; max-width: 100%; cursor: pointer; }
    .destination-choice span { overflow-wrap: anywhere; }
    input[type="checkbox"] { accent-color: var(--accent); width: 16px; height: 16px; flex-shrink: 0; margin: 2px 0 0; }
    .form-actions { display: flex; flex-wrap: wrap; gap: 16px; margin-top: 20px; align-items: center; }
    .operations-note { margin-top: 20px; font-size: 12px; color: var(--muted); }
    #loading { padding: 20px 0; color: var(--muted); }
    noscript { display: block; padding: 20px; border: 1px solid var(--line); color: var(--danger); }
    @media (max-width: 800px) { .grid { grid-template-columns: minmax(0, 1fr); } }
    @media (max-width: 560px) { .topbar-inner { padding: 16px; flex-wrap: wrap; gap: 14px; } .account { width: 100%; justify-content: space-between; } main { padding: 24px 16px; } h1 { font-size: 23px; } .panel-header, .feed-row, .webhook-row, .editor { padding: 16px; } .panel-footnote { padding: 12px 16px; } }
  </style>
</head>
<body>
  <a class="skip-link" href="#main">Skip to configuration</a>
  <header class="topbar">
    <div class="topbar-inner">
      <div class="brand">
        ${brandLabel(brand)}
      </div>
      <div class="account"><p>Signed in as <strong>${escapeHtml(user.name)}</strong><br><span>Discord ID ${escapeHtml(user.id)}</span></p><form action="/admin/auth/logout" method="post"><button type="submit">Sign out</button></form></div>
    </div>
  </header>
  <main id="main">
    <div class="page-heading"><h1>Feeds and webhooks</h1><p class="route-usage" id="route-usage" hidden><span id="route-count">0</span> <span id="route-limit">routes</span></p></div>
    <div class="feedback">
      <p id="notice" class="notice" role="status" aria-live="polite" aria-atomic="true"></p>
      <button id="reload" class="button small secondary" type="button">Reload configuration</button>
      <a id="access-link" class="button small secondary" href="/admin" hidden>Review access or sign in</a>
    </div>
    <noscript>Enable JavaScript to manage your feeds, webhooks, and routing.</noscript>
    <p id="loading">Loading configuration…</p>
    ${
      scoped
        ? scopedContent
        : `    <div id="workspace" hidden>
      <div class="grid">
        <section class="panel" aria-labelledby="feeds-heading">
          <div class="panel-header">
            <div class="section-title"><h2 id="feeds-heading" tabindex="-1">Feeds</h2><span class="count" id="feed-total">0</span></div>
            <button id="add-feed" class="button" type="button" data-open="feed" disabled>Add feed</button>
          </div>
          <div class="empty" id="feed-empty" hidden><h3>No feeds</h3><p id="feed-empty-copy"></p></div>
          <ul id="feed-list" class="rows" aria-label="Configured feeds"></ul>
          <form id="feed-form" class="editor" hidden aria-labelledby="feed-form-title">
            <h3 id="feed-form-title">Add feed</h3>
            <div class="field"><label class="field-label" for="feed-url">Feed URL</label><input id="feed-url" type="url" placeholder="https://example.com/feed.xml" required maxlength="2048" autocomplete="off" autocapitalize="none" spellcheck="false" aria-describedby="feed-url-help"><p class="field-help" id="feed-url-help">The direct RSS or Atom feed address.</p></div>
            <fieldset><legend>Destinations</legend><div id="destination-choices" class="destination-choices"></div><p class="field-help">Choose one or more destinations. Each selection uses one route.</p></fieldset>
            <div class="form-actions"><button class="button" type="submit" id="save-feed">Add feed</button><button class="text-button" type="button" id="cancel-feed">Cancel</button></div>
          </form>
          <p class="panel-footnote" id="pause-note" hidden>Polling and delivery are paused.</p>
        </section>
        <section class="panel" aria-labelledby="webhooks-heading">
          <div class="panel-header">
            <div class="section-title"><h2 id="webhooks-heading" tabindex="-1">Webhooks</h2><span class="count" id="webhook-total">0</span></div>
            <button id="add-webhook" class="button secondary" type="button" data-open="webhook" disabled>Add webhook</button>
          </div>
          <div class="empty" id="webhook-empty" hidden><h3>No webhooks</h3><p>Add a Discord webhook for each destination channel.</p></div>
          <ul id="webhook-list" class="rows" aria-label="Configured webhooks"></ul>
          <form id="webhook-form" class="editor" hidden aria-labelledby="webhook-form-title">
            <h3 id="webhook-form-title">Add webhook</h3>
            <div class="field"><label class="field-label" for="webhook-name">Destination name</label><input id="webhook-name" type="text" placeholder="updates" required pattern="[A-Za-z][A-Za-z0-9_\\-]{0,63}" maxlength="64" autocomplete="off" autocapitalize="none" spellcheck="false" aria-describedby="name-help"><p class="field-help" id="name-help"></p></div>
            <div class="field"><label class="field-label" for="webhook-url">Discord webhook URL</label><input id="webhook-url" type="password" placeholder="https://discord.com/api/webhooks/…" required maxlength="2048" autocomplete="new-password" autocapitalize="none" spellcheck="false" aria-describedby="webhook-url-help"><p class="field-help" id="webhook-url-help">Copy it from Discord: Channel settings → Integrations → Webhooks. Saved URLs stay hidden.</p></div>
            <div class="form-actions"><button class="button" type="submit" id="save-webhook">Add webhook</button><button class="text-button" type="button" id="cancel-webhook">Cancel</button></div>
          </form>
          <p class="panel-footnote">Remove a webhook from its feeds before deleting it.</p>
        </section>
      </div>
      <p class="operations-note">One feed is checked each minute. Changes apply on the next poll. New routes only deliver entries found after their first check.</p>
    </div>`
    }

  </main>
  <script nonce="${safeNonce}">${scoped ? scopedScript : script}</script>
</body>
</html>`;
}

export function renderAccessPage(
  nonce: string,
  options: {
    title: string;
    message: string;
    user?: AdminIdentity | undefined;
    allowLogin: boolean;
    showLogout?: boolean;
    retry?: boolean;
  },
  appearance: AdminBranding = {},
): string {
  const brand = branding(appearance);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light">
  <title>${escapeHtml(options.title)} · ${brand.title}</title>
  <style nonce="${escapeHtml(nonce)}">
    :root { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #202c2b; background: #f5f6f5; line-height: 1.5; }
    * { box-sizing: border-box; }
    body { margin: 0; }
    header { --header: ${brand.color}; display: flex; align-items: center; gap: 10px; padding: 16px max(16px, calc((100% - 1104px) / 2)); background: var(--header); color: ${brand.foreground}; font-size: 19px; font-weight: 650; }
    header svg { width: 28px; height: 28px; flex-shrink: 0; }
    .installation-name { border-left: 1px solid currentColor; padding-left: 12px; font-size: 14px; font-weight: 500; overflow-wrap: anywhere; min-width: 0; }
    main { max-width: 650px; margin: 40px auto; padding: 32px; }
    h1 { font-size: 26px; letter-spacing: -.6px; line-height: 1.2; }
    p { margin: 18px 0; overflow-wrap: anywhere; }
    .account { padding: 14px 18px; border: 1px solid #cbd9cb; border-radius: 8px; background: #fffefa; }
    .actions { display: flex; flex-wrap: wrap; gap: 12px; margin: 26px 0; }
    form { margin: 0; }
    .button { display: inline-flex; align-items: center; justify-content: center; min-height: 44px; padding: 10px 16px; background: #176d61; color: white; border: 1px solid #176d61; border-radius: 7px; font: inherit; font-weight: 600; text-decoration: none; cursor: pointer; }
    .button.secondary { background: transparent; color: #202c2b; border-color: #aab8ad; }
    .button:hover { background: #11564c; color: white; }
    :focus-visible { outline: 3px solid #176d61; outline-offset: 4px; }
    .help { color: #5e6a67; font-size: 13px; }
    @media (max-width: 560px) { main { margin: 35px auto; padding: 24px; } }
  </style>
</head>
<body>
  <header>${brandLabel(brand)}</header>
  <main>
    <h1>${escapeHtml(options.title)}</h1>
    ${options.user ? `<p class="account">Signed in as <strong>${escapeHtml(options.user.name)}</strong><br>Discord ID ${escapeHtml(options.user.id)}</p>` : ''}
    <p role="status">${escapeHtml(options.message)}</p>
    <div class="actions">
      ${options.allowLogin ? `<a class="button" href="/admin/auth/login">${options.retry ? 'Try Discord sign-in again' : 'Sign in with Discord'}</a>` : ''}
      ${options.showLogout ? '<form action="/admin/auth/logout" method="post"><button class="button secondary" type="submit">Sign out</button></form>' : ''}
    </div>
    ${options.allowLogin ? '<p class="help">Access requires a Discord server role configured by this installation’s operator. Signing in does not join a server or assign roles.</p><p class="help">To use another account, switch accounts in Discord, then try signing in again. Ask your server administrator about invitations and access.</p>' : ''}
  </main>
</body>
</html>`;
}

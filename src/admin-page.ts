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
    byId('feed-count').textContent = String(config.feeds.length);
    byId('webhook-count').textContent = String(config.destinations.length);
    byId('route-count').textContent = String(pairCount);
    byId('route-limit').textContent = String(config.maxRoutes);
    byId('feed-total').textContent = String(config.feeds.length);
    byId('webhook-total').textContent = String(config.destinations.length);
    byId('feed-empty').hidden = config.feeds.length !== 0;
    byId('webhook-empty').hidden = config.destinations.length !== 0;
    byId('feed-empty-copy').textContent = config.destinations.length
      ? 'Add an RSS or Atom feed, then choose the channels it should reach.'
      : 'Start by adding a Discord webhook. Then connect your first feed to it.';
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
      content.append(node('p', 'muted small-copy', count ? count + (count === 1 ? ' feed connected' : ' feeds connected') : 'Ready to connect'));
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
    updateControls();
  }

  function openFeed(index = null) {
    if (busy || stale || editor || !config || !config.destinations.length) return;
    editor = 'feed';
    editingFeed = index;
    const feed = index === null ? null : config.feeds[index];
    byId('feed-form-title').textContent = feed ? 'Edit feed & routing' : 'Add a feed';
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
    byId('webhook-form-title').textContent = name ? 'Change webhook URL' : 'Add a webhook';
    byId('save-webhook').textContent = name ? 'Save URL' : 'Add webhook';
    byId('name-help').textContent = name
      ? 'The destination name stays the same, so existing routes keep working.'
      : 'A short label for this channel. Start with a letter; use letters, numbers, underscores or hyphens.';
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
        typeof result.revision !== 'string' || !Number.isInteger(result.maxRoutes)) {
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
      announce('Configuration is up to date.');
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
    if (count > config.maxRoutes) {
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
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll("'", '&#39;');
}

export function renderAdminPage(nonce: string, user: AdminIdentity): string {
  const safeNonce = escapeHtml(nonce);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light">
  <title>syndicord · Feeds & routing</title>
  <style nonce="${safeNonce}">
    :root { color-scheme: light; --ink: #202c2b; --muted: #5e6a67; --paper: #f6f5f0; --panel: #fffefa; --line: #dadfd7; --accent: #176d61; --accent-soft: #e8f1e9; --danger: #a23c35; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; font-synthesis: none; }
    * { box-sizing: border-box; }
    [hidden] { display: none !important; }
    body { margin: 0; color: var(--ink); background: var(--paper); font-size: 15px; line-height: 1.55; }
    button, input { font: inherit; }
    button { cursor: pointer; }
    button:disabled { cursor: not-allowed; opacity: .46; }
    :focus-visible { outline: 3px solid #bd8149; outline-offset: 4px; }
    h1, h2, h3, p { margin: 0; }
    .skip-link { position: absolute; top: -60px; left: 20px; z-index: 5; padding: 10px; background: white; color: var(--ink); }
    .skip-link:focus { top: 12px; }
    .topbar { background: #233c37; color: #fffefa; }
    .topbar-inner { max-width: 1200px; margin: auto; padding: 19px 36px; display: flex; align-items: center; justify-content: space-between; gap: 16px; }
    .brand { display: flex; align-items: center; gap: 11px; font-size: 22px; font-weight: 750; letter-spacing: -.8px; }
    .brand svg { width: 34px; height: 34px; }
    .account { display: flex; gap: 12px; flex-wrap: wrap; align-items: center; justify-content: flex-end; font-size: 12px; }
    .account p { overflow-wrap: anywhere; }
    .account form { margin: 0; }
    .account button { background: transparent; border: 1px solid #9bb9aa; border-radius: 6px; color: inherit; padding: 6px 10px; }
    .workspace-label { color: #d5e3d8; font-size: 12px; letter-spacing: .12em; text-transform: uppercase; }
    main { max-width: 1200px; margin: auto; padding: 48px 36px 32px; }
    .eyebrow { color: var(--accent); font-size: 11px; font-weight: 750; letter-spacing: .17em; text-transform: uppercase; }
    h1 { margin-top: 9px; font-size: clamp(29px, 4vw, 42px); line-height: 1.14; font-weight: 650; letter-spacing: -1.5px; }
    .intro { max-width: 590px; color: var(--muted); margin-top: 14px; font-size: 16px; }
    .overview { display: flex; align-items: center; justify-content: space-between; gap: 24px; margin-top: 30px; padding: 20px 0; border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); }
    .stats { display: flex; gap: 34px; }
    .stat { display: flex; align-items: baseline; gap: 9px; }
    .stat strong { font-size: 27px; font-weight: 550; letter-spacing: -.8px; }
    .stat > span { color: var(--muted); font-size: 13px; }
    .poll-note { max-width: 245px; font-size: 12px; color: var(--muted); }
    .feedback { min-height: 67px; display: flex; gap: 14px; align-items: center; padding: 14px 0; }
    .notice { font-size: 13px; color: var(--accent); }
    .notice.error { color: var(--danger); }
    .feedback .button { flex-shrink: 0; }
    .grid { margin-top: 26px; display: grid; grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr); gap: 24px; align-items: start; }
    .panel { border: 1px solid var(--line); background: var(--panel); border-radius: 14px; overflow: hidden; box-shadow: 0 3px 0 #203c3410; }
    .panel-header { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 16px; padding: 23px 24px 20px; }
    .section-title { display: flex; align-items: center; gap: 9px; flex-wrap: wrap; }
    h2 { font-size: 18px; font-weight: 650; letter-spacing: -.4px; }
    .count { background: #eef0e9; color: var(--muted); border-radius: 6px; min-width: 24px; padding: 1px 6px; text-align: center; font-size: 12px; }
    .panel-subtitle { color: var(--muted); font-size: 12px; margin-top: 4px; }
    .button { display: inline-flex; align-items: center; justify-content: center; gap: 5px; border: 1px solid var(--accent); background: var(--accent); color: white; border-radius: 7px; padding: 8px 12px; min-height: 38px; font-size: 13px; font-weight: 600; white-space: nowrap; }
    .button:hover:not(:disabled) { background: #11564c; border-color: #11564c; }
    .button.secondary { background: transparent; border-color: #c4cdc3; color: var(--ink); }
    .button.secondary:hover:not(:disabled) { background: #edf0e8; }
    .button.small { min-height: 32px; padding: 4px 11px; font-size: 12px; }
    .text-button { border: 0; padding: 5px 0; background: transparent; color: var(--accent); font-size: 12px; font-weight: 550; text-align: left; }
    .text-button:hover:not(:disabled) { text-decoration: underline; }
    .text-button.danger { color: var(--danger); }
    .empty { padding: 37px 28px 43px; border-top: 1px solid var(--line); text-align: center; }
    .empty-symbol { display: inline-grid; place-items: center; width: 46px; height: 46px; border: 1px solid #cbd9cb; border-radius: 12px; color: var(--accent); margin-bottom: 15px; font-size: 24px; font-weight: 400; background: #edf3e9; }
    .empty h3 { font-size: 16px; font-weight: 600; }
    .empty p { max-width: 330px; margin: 8px auto 0; color: var(--muted); font-size: 13px; }
    .rows { list-style: none; margin: 0; padding: 0; }
    .feed-row, .webhook-row { padding: 20px 24px; border-top: 1px solid var(--line); display: flex; gap: 20px; align-items: flex-start; }
    .row-content { min-width: 0; flex: 1; }
    .feed-title, .webhook-title { font-size: 14px; font-weight: 650; overflow-wrap: anywhere; }
    .feed-address { margin-top: 5px; color: var(--muted); font-size: 12px; overflow-wrap: anywhere; line-height: 1.5; }
    .destinations { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 13px; }
    .destination-tag { display: inline-block; padding: 3px 8px; background: var(--accent-soft); color: #295e4f; border-radius: 5px; font-size: 11px; font-weight: 550; overflow-wrap: anywhere; max-width: 100%; }
    .row-actions { display: flex; flex-direction: column; align-items: flex-start; gap: 4px; flex-shrink: 0; }
    .muted { color: var(--muted); }
    .small-copy { font-size: 12px; margin-top: 3px; }
    .panel-footnote { padding: 14px 24px; border-top: 1px solid var(--line); background: #fafaf4; font-size: 11px; line-height: 1.6; color: var(--muted); }
    .editor { padding: 23px 24px 24px; background: #eef3eb; border-top: 1px solid #d0ddcc; }
    .editor h3 { font-size: 16px; margin-bottom: 19px; font-weight: 650; }
    .field { margin-top: 17px; }
    .field-label, legend { display: block; font-size: 12px; font-weight: 650; margin-bottom: 7px; }
    input[type="url"], input[type="text"], input[type="password"] { display: block; width: 100%; min-width: 0; background: #fffefa; color: var(--ink); border: 1px solid #b5c3b5; border-radius: 6px; padding: 10px 11px; font-size: 14px; }
    input[readonly] { background: #e4ebe1; color: #566054; }
    input::placeholder { color: #7b847b; }
    .field-help { font-size: 11px; color: #52624f; margin-top: 7px; line-height: 1.6; }
    fieldset { min-width: 0; margin: 19px 0 0; padding: 0; border: 0; }
    .destination-choices { display: flex; flex-wrap: wrap; gap: 8px; }
    .destination-choice { display: flex; align-items: flex-start; gap: 8px; padding: 8px 10px; background: #fffefa; border: 1px solid #cbd7c6; border-radius: 6px; font-size: 12px; max-width: 100%; cursor: pointer; }
    .destination-choice span { overflow-wrap: anywhere; }
    input[type="checkbox"] { accent-color: var(--accent); width: 15px; height: 15px; flex-shrink: 0; margin: 2px 0 0; }
    .form-actions { display: flex; gap: 12px; margin-top: 23px; align-items: center; }
    .form-actions .text-button { font-size: 13px; padding: 8px; }
    .how-it-works { margin-top: 27px; border-left: 2px solid #b9c9b8; padding-left: 15px; max-width: 700px; font-size: 12px; color: var(--muted); }
    .how-it-works strong { color: var(--ink); font-weight: 600; }
    footer { margin-top: 44px; display: flex; justify-content: space-between; gap: 18px; color: #68776e; font-size: 11px; }
    #loading { padding: 28px 0; color: var(--muted); }
    noscript { display: block; padding: 20px; border: 1px solid var(--line); color: var(--danger); }
    @media (max-width: 900px) { .grid { grid-template-columns: minmax(0, 1fr); } .poll-note { max-width: 215px; } }
    @media (max-width: 560px) { .topbar-inner { padding: 16px 20px; } .workspace-label { font-size: 10px; } main { padding: 31px 20px 25px; } h1 { letter-spacing: -1px; } .intro { font-size: 14px; } .overview { display: block; margin-top: 24px; padding: 15px 0; } .stats { justify-content: space-between; gap: 12px; } .stat { display: block; } .stat > span { display: block; font-size: 11px; } .poll-note { margin-top: 14px; max-width: none; font-size: 11px; } .feedback { flex-wrap: wrap; gap: 8px; } .panel-header { padding: 20px 18px 17px; gap: 9px; } h2 { font-size: 16px; } .panel-header .button { padding: 7px 9px; font-size: 12px; } .feed-row, .webhook-row { padding: 18px; gap: 13px; } .editor { padding: 20px 18px; } .panel-footnote { padding: 12px 18px; } footer { flex-direction: column; gap: 3px; } }
    @media (prefers-reduced-motion: no-preference) { button { transition: background-color .15s ease, opacity .15s ease; } }
  </style>
</head>
<body>
  <a class="skip-link" href="#main">Skip to configuration</a>
  <header class="topbar">
    <div class="topbar-inner">
      <div class="brand">
        <svg viewBox="0 0 256 256" aria-hidden="true"><path fill="#77baa0" d="M64 28h128a36 36 0 0 1 36 36v104a36 36 0 0 1-36 36h-28l-44 28v-28H64a36 36 0 0 1-36-36V64a36 36 0 0 1 36-36Z"/><g fill="none" stroke="#233c37" stroke-linecap="round" stroke-width="18"><path d="M80 76a84 84 0 0 1 84 84"/><path d="M80 116a44 44 0 0 1 44 44"/></g><circle cx="80" cy="160" r="12" fill="#233c37"/></svg>
        <span>syndicord</span>
      </div>
      <div class="account"><p>Signed in as <strong>${escapeHtml(user.name)}</strong><br><span>Discord ID ${escapeHtml(user.id)}</span></p><form action="/admin/auth/logout" method="post"><button type="submit">Sign out</button></form></div>
    </div>
  </header>
  <main id="main">
    <p class="eyebrow">Feeds & routing</p>
    <h1>From feed to channel.</h1>
    <p class="intro">Bring the updates you follow into Discord. Add your feeds, connect your webhooks, and choose where each story goes.</p>
    <div class="feedback">
      <p id="notice" class="notice" role="status" aria-live="polite" aria-atomic="true"></p>
      <button id="reload" class="button small secondary" type="button">Reload configuration</button>
      <a id="access-link" class="button small secondary" href="/admin" hidden>Review access or sign in</a>
    </div>
    <noscript>Enable JavaScript to manage your feeds, webhooks, and routing.</noscript>
    <p id="loading">Loading configuration…</p>
    <div id="workspace" hidden>
      <div class="overview">
        <div class="stats" aria-label="Configuration summary">
          <div class="stat"><strong id="feed-count">0</strong><span>feeds</span></div>
          <div class="stat"><strong id="webhook-count">0</strong><span>webhooks</span></div>
          <div class="stat"><strong id="route-count">0</strong><span>of <span id="route-limit">20</span> routes</span></div>
        </div>
        <p class="poll-note">One feed is checked each minute. Saved changes apply on the next poll.</p>
      </div>
      <div class="grid">
        <section class="panel" aria-labelledby="feeds-heading">
          <div class="panel-header">
            <div><div class="section-title"><h2 id="feeds-heading" tabindex="-1">Feeds & routing</h2><span class="count" id="feed-total">0</span></div><p class="panel-subtitle">What to follow, and where it goes.</p></div>
            <button id="add-feed" class="button" type="button" data-open="feed" disabled><span aria-hidden="true">+</span> Add feed</button>
          </div>
          <div class="empty" id="feed-empty" hidden><span class="empty-symbol" aria-hidden="true">↗</span><h3>Your next discovery starts here</h3><p id="feed-empty-copy"></p></div>
          <ul id="feed-list" class="rows" aria-label="Configured feeds"></ul>
          <form id="feed-form" class="editor" hidden aria-labelledby="feed-form-title">
            <h3 id="feed-form-title">Add a feed</h3>
            <div class="field"><label class="field-label" for="feed-url">Feed URL</label><input id="feed-url" type="url" placeholder="https://example.com/feed.xml" required maxlength="2048" autocomplete="off" autocapitalize="none" spellcheck="false" aria-describedby="feed-url-help"><p class="field-help" id="feed-url-help">The direct RSS or Atom feed address.</p></div>
            <fieldset><legend>Send updates to</legend><div id="destination-choices" class="destination-choices"></div><p class="field-help">Choose one or more destinations. Each selection uses one route.</p></fieldset>
            <div class="form-actions"><button class="button" type="submit" id="save-feed">Add feed</button><button class="text-button" type="button" id="cancel-feed">Cancel</button></div>
          </form>
          <p class="panel-footnote" id="pause-note" hidden>No feeds configured. Polling and delivery are paused.</p>
        </section>
        <section class="panel" aria-labelledby="webhooks-heading">
          <div class="panel-header">
            <div><div class="section-title"><h2 id="webhooks-heading" tabindex="-1">Webhooks</h2><span class="count" id="webhook-total">0</span></div><p class="panel-subtitle">Your Discord destinations.</p></div>
            <button id="add-webhook" class="button secondary" type="button" data-open="webhook" disabled><span aria-hidden="true">+</span> Add webhook</button>
          </div>
          <div class="empty" id="webhook-empty" hidden><span class="empty-symbol" aria-hidden="true">#</span><h3>Give your feeds a home</h3><p>Add a Discord webhook for each channel you want to send updates to.</p></div>
          <ul id="webhook-list" class="rows" aria-label="Configured webhooks"></ul>
          <form id="webhook-form" class="editor" hidden aria-labelledby="webhook-form-title">
            <h3 id="webhook-form-title">Add a webhook</h3>
            <div class="field"><label class="field-label" for="webhook-name">Destination name</label><input id="webhook-name" type="text" placeholder="updates" required pattern="[A-Za-z][A-Za-z0-9_\\-]{0,63}" maxlength="64" autocomplete="off" autocapitalize="none" spellcheck="false" aria-describedby="name-help"><p class="field-help" id="name-help"></p></div>
            <div class="field"><label class="field-label" for="webhook-url">Discord webhook URL</label><input id="webhook-url" type="password" placeholder="https://discord.com/api/webhooks/…" required maxlength="2048" autocomplete="new-password" autocapitalize="none" spellcheck="false" aria-describedby="webhook-url-help"><p class="field-help" id="webhook-url-help">Copy it from Discord: Channel settings → Integrations → Webhooks. Saved URLs stay hidden.</p></div>
            <div class="form-actions"><button class="button" type="submit" id="save-webhook">Add webhook</button><button class="text-button" type="button" id="cancel-webhook">Cancel</button></div>
          </form>
          <p class="panel-footnote">A destination can receive several feeds. To remove one, disconnect it from its feeds first.</p>
        </section>
      </div>
      <p class="how-it-works"><strong>Fresh starts, without the backlog.</strong> A new feed or route starts with a quiet first check. Only entries discovered after that are sent to Discord.</p>
    </div>
    <footer><span>syndicord · Your feeds. In the conversation.</span><span>RSS & Atom → Discord</span></footer>
  </main>
  <script nonce="${safeNonce}">${script}</script>
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
): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light">
  <title>${escapeHtml(options.title)} · syndicord</title>
  <style nonce="${escapeHtml(nonce)}">
    :root { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #202c2b; background: #f6f5f0; line-height: 1.55; }
    * { box-sizing: border-box; }
    body { margin: 0; }
    header { padding: 20px max(24px, calc((100% - 1128px) / 2)); background: #233c37; color: #fffefa; font-size: 23px; font-weight: 750; }
    main { max-width: 650px; margin: 80px auto; padding: 32px; }
    h1 { font-size: clamp(27px, 5vw, 36px); letter-spacing: -1px; line-height: 1.2; }
    p { margin: 18px 0; overflow-wrap: anywhere; }
    .account { padding: 14px 18px; border: 1px solid #cbd9cb; border-radius: 8px; background: #fffefa; }
    .actions { display: flex; flex-wrap: wrap; gap: 12px; margin: 26px 0; }
    form { margin: 0; }
    .button { display: inline-flex; align-items: center; justify-content: center; min-height: 44px; padding: 10px 16px; background: #176d61; color: white; border: 1px solid #176d61; border-radius: 7px; font: inherit; font-weight: 600; text-decoration: none; cursor: pointer; }
    .button.secondary { background: transparent; color: #202c2b; border-color: #aab8ad; }
    .button:hover { background: #11564c; color: white; }
    :focus-visible { outline: 3px solid #bd8149; outline-offset: 4px; }
    .help { color: #5e6a67; font-size: 13px; }
    @media (max-width: 560px) { main { margin: 35px auto; padding: 24px; } }
  </style>
</head>
<body>
  <header>syndicord</header>
  <main>
    <h1>${escapeHtml(options.title)}</h1>
    ${options.user ? `<p class="account">Signed in as <strong>${escapeHtml(options.user.name)}</strong><br>Discord ID ${escapeHtml(options.user.id)}</p>` : ''}
    <p role="status">${escapeHtml(options.message)}</p>
    <div class="actions">
      ${options.allowLogin ? `<a class="button" href="/admin/auth/login">${options.retry ? 'Try Discord sign-in again' : 'Sign in with Discord'}</a>` : ''}
      ${options.showLogout ? '<form action="/admin/auth/logout" method="post"><button class="button secondary" type="submit">Sign out</button></form>' : ''}
    </div>
    ${options.allowLogin ? '<p class="help">Access requires membership in this installation’s configured Discord server and its required role. Signing in does not join a server or assign roles.</p><p class="help">To use another account, switch accounts in Discord, then try signing in again. Ask your server administrator about invitations and access.</p>' : ''}
  </main>
</body>
</html>`;
}

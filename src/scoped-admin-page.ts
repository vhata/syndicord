export const scopedContent = `
    <div id="workspace" hidden>
      <section class="panel" id="initialize-panel" hidden>
        <div class="panel-header"><h2>Initialize the catalog</h2></div>
        <div class="editor"><p>Verify saved webhooks and import the existing feeds and subscriptions. This keeps existing subscriptions unchanged and sends no Discord messages. If verification fails, the existing configuration remains in place.</p><div class="form-actions"><button id="initialize-catalog" class="button" type="button">Verify and initialize catalog</button></div></div>
      </section>
      <div class="grid" id="catalog-panels" hidden>
        <section class="panel" aria-labelledby="feeds-heading">
          <div class="panel-header"><div class="section-title"><h2 id="feeds-heading" tabindex="-1">Feed catalog</h2><span class="count" id="feed-total">0</span></div><button id="add-feed" class="button" type="button" disabled>Add feed</button></div>
          <div class="empty" id="feed-empty" hidden><h3>No feeds</h3><p>Feed administrators can add an RSS or Atom feed without subscribing a destination.</p></div>
          <ul id="feed-list" class="rows" aria-label="Shared feed catalog"></ul>
          <form id="feed-form" class="editor" hidden aria-labelledby="feed-form-title">
            <h3 id="feed-form-title">Add feed</h3>
            <div class="field"><label class="field-label" for="feed-label">Feed label</label><input id="feed-label" type="text" required maxlength="100" autocomplete="off"></div>
            <div class="field" id="feed-url-field"><label class="field-label" for="feed-url">Feed URL</label><input id="feed-url" type="url" required maxlength="2048" autocomplete="off" autocapitalize="none" spellcheck="false"><p class="field-help">The source stays private. To replace a source, add a new feed, then explicitly update each destination's subscription.</p></div>
            <div class="form-actions"><button id="save-feed" class="button" type="submit">Add feed</button><button id="cancel-feed" class="text-button" type="button">Cancel</button></div>
          </form>
          <p class="panel-footnote">Feed sources cannot be changed. Only feeds without subscriptions can be deleted.</p>
        </section>
        <section class="panel" aria-labelledby="webhooks-heading">
          <div class="panel-header"><div class="section-title"><h2 id="webhooks-heading" tabindex="-1">Your destinations</h2><span class="count" id="webhook-total">0</span></div><button id="add-webhook" class="button secondary" type="button" disabled>Register webhook</button></div>
          <div class="empty" id="webhook-empty" hidden><h3>No destinations</h3><p>Register a webhook for a channel your Discord roles authorize you to manage.</p></div>
          <ul id="webhook-list" class="rows" aria-label="Authorized destinations"></ul>
          <form id="webhook-form" class="editor" hidden aria-labelledby="webhook-form-title">
            <h3 id="webhook-form-title">Register webhook</h3>
            <div class="field" id="webhook-label-field"><label class="field-label" for="webhook-label">Destination label</label><input id="webhook-label" type="text" required maxlength="100" autocomplete="off"></div>
            <div class="field" id="webhook-url-field"><label class="field-label" for="webhook-url">Discord webhook URL</label><input id="webhook-url" type="password" required maxlength="2048" autocomplete="new-password" autocapitalize="none" spellcheck="false"><p class="field-help">Copy from Discord: Channel settings → Integrations → Webhooks. Discord verifies the actual server and channel before activation. Rotation must keep the same channel; moving requires a new destination.</p></div>
            <div class="form-actions"><button id="save-webhook" class="button" type="submit">Register webhook</button><button id="cancel-webhook" class="text-button" type="button">Cancel</button></div>
          </form>
          <p class="panel-footnote">Only your authorized destinations are shown. Remove their subscriptions before deleting them.</p>
        </section>
        <section class="panel" aria-labelledby="subscriptions-heading">
          <div class="panel-header"><div class="section-title"><h2 id="subscriptions-heading" tabindex="-1">Your subscriptions</h2><span class="count" id="subscription-total">0</span></div><button id="add-subscription" class="button secondary" type="button" disabled>Subscribe</button></div>
          <div class="empty" id="subscription-empty" hidden><h3>No subscriptions</h3><p>Choose a shared feed and one of your destinations.</p></div>
          <ul id="subscription-list" class="rows" aria-label="Authorized subscriptions"></ul>
          <form id="subscription-form" class="editor" hidden aria-labelledby="subscription-form-title">
            <h3 id="subscription-form-title">Subscribe a destination</h3>
            <div class="field"><label class="field-label" for="subscription-feed">Feed</label><select id="subscription-feed" required></select></div>
            <div class="field"><label class="field-label" for="subscription-destination">Destination</label><select id="subscription-destination" required></select></div>
            <div class="form-actions"><button id="save-subscription" class="button" type="submit">Subscribe</button><button id="cancel-subscription" class="text-button" type="button">Cancel</button></div>
          </form>
        </section>
      </div>
      <p class="operations-note" id="catalog-help">Your Discord roles determine which feeds and destinations you can manage. Existing subscriptions keep running when a role is removed. New subscriptions only deliver entries found after their first check.</p>
    </div>`;

export const scopedScript = String.raw`
(() => {
  const byId = (id) => document.getElementById(id);
  const forms = ['feed', 'webhook', 'subscription'];
  let config = null;
  let busy = false;
  let stale = false;
  let editor = null;
  let editing = null;

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
    const locked = busy || stale || !config || editor !== null;
    document.querySelectorAll('[data-action]').forEach((button) => { button.disabled = locked; });
    byId('initialize-catalog').disabled = locked;
    byId('add-feed').disabled = locked || !config?.permissions.addFeeds;
    byId('add-feed').hidden = config ? !config.permissions.addFeeds : true;
    byId('add-webhook').disabled = locked || !config?.permissions.channels.length;
    byId('add-webhook').hidden = config ? !config.permissions.channels.length : true;
    byId('add-subscription').disabled = locked || !config?.feeds.length || !config?.destinations.length;
    byId('add-subscription').hidden = config ? !config.permissions.channels.length : true;
    for (const form of forms) byId(form + '-form').querySelectorAll('input, select, button').forEach((control) => {
      control.disabled = busy || (control.type === 'submit' && stale);
    });
    byId('reload').disabled = busy;
    byId('reload').hidden = !stale && config !== null;
    byId('workspace').setAttribute('aria-busy', String(busy));
  }
  function action(label, handler, ariaLabel, danger = false) {
    const button = node('button', danger ? 'text-button danger' : 'text-button', label);
    button.type = 'button';
    button.setAttribute('data-action', '');
    button.setAttribute('aria-label', ariaLabel);
    button.addEventListener('click', () => {
      if (!busy && !stale && !editor) handler();
    });
    return button;
  }
  function closeEditor() {
    for (const form of forms) {
      byId(form + '-form').hidden = true;
      byId(form + '-form').reset();
    }
    editor = null;
    editing = null;
    updateControls();
  }
  function row(title, detail, controls) {
    const item = node('li', 'feed-row');
    const content = node('div', 'row-content');
    content.append(node('h3', 'feed-title', title), node('p', 'feed-address', detail));
    const buttons = node('div', 'row-actions');
    buttons.append(...controls);
    item.append(content, buttons);
    return item;
  }
  function render() {
    byId('initialize-panel').hidden = config.initialized;
    byId('catalog-panels').hidden = !config.initialized;
    byId('route-usage').hidden = !config.initialized;
    byId('route-count').textContent = String(config.subscriptions.length);
    byId('route-limit').textContent = 'visible subscriptions';
    byId('feed-total').textContent = String(config.feeds.length);
    byId('webhook-total').textContent = String(config.destinations.length);
    byId('subscription-total').textContent = String(config.subscriptions.length);
    byId('feed-empty').hidden = config.feeds.length !== 0;
    byId('webhook-empty').hidden = config.destinations.length !== 0;
    byId('subscription-empty').hidden = config.subscriptions.length !== 0;
    byId('feed-list').replaceChildren();
    for (const feed of config.feeds) {
      const controls = config.permissions.addFeeds ? [
        action('Rename', () => openFeed(feed), 'Rename feed ' + feed.label),
        action('Delete', () => {
          if (window.confirm('Delete “' + feed.label + '”? Only feeds without any subscriptions can be deleted.'))
            save({ type: 'feed.delete', id: feed.id }, 'Feed deleted.', 'feeds-heading');
        }, 'Delete feed ' + feed.label, true),
      ] : [];
      byId('feed-list').append(row(feed.label, 'Feed ID ' + feed.id, controls));
    }
    byId('webhook-list').replaceChildren();
    for (const destination of config.destinations) {
      const controls = [
        action('Rename', () => openWebhook('rename', destination), 'Rename destination ' + destination.label),
        action('Rotate webhook', () => openWebhook('rotate', destination), 'Rotate webhook for ' + destination.label),
        action('Delete', () => {
          if (window.confirm('Delete destination “' + destination.label + '”? Remove its subscriptions first.'))
            save({ type: 'destination.delete', id: destination.id }, 'Destination deleted.', 'webhooks-heading');
        }, 'Delete destination ' + destination.label, true),
      ];
      byId('webhook-list').append(row(destination.label, 'Server ' + destination.guildId + ' · Channel ' + destination.channelId + ' · ID ' + destination.id, controls));
    }
    byId('subscription-list').replaceChildren();
    for (const subscription of config.subscriptions) {
      const feed = config.feeds.find((item) => item.id === subscription.feedId);
      const destination = config.destinations.find((item) => item.id === subscription.destinationId);
      const title = (feed?.label || subscription.feedId) + ' → ' + (destination?.label || subscription.destinationId);
      byId('subscription-list').append(row(title, '', [action('Unsubscribe', () => {
        if (window.confirm('Remove subscription “' + title + '”? Future delivery attempts to this destination will stop.'))
          save({ type: 'subscription.remove', feedId: subscription.feedId, destinationId: subscription.destinationId }, 'Subscription removed.', 'subscriptions-heading');
      }, 'Remove subscription ' + title, true)]));
    }
    byId('loading').hidden = true;
    byId('workspace').hidden = false;
    updateControls();
  }
  function openFeed(feed = null) {
    if (busy || stale || editor || !config?.permissions.addFeeds) return;
    editor = 'feed'; editing = feed;
    byId('feed-form-title').textContent = feed ? 'Rename feed' : 'Add feed';
    byId('save-feed').textContent = feed ? 'Save label' : 'Add feed';
    byId('feed-label').value = feed?.label || '';
    byId('feed-url').value = '';
    byId('feed-url').required = !feed;
    byId('feed-url-field').hidden = Boolean(feed);
    byId('feed-form').hidden = false;
    announce(''); updateControls(); byId('feed-label').focus();
  }
  function openWebhook(kind = 'create', destination = null) {
    if (busy || stale || editor || !config?.permissions.channels.length) return;
    editor = 'webhook'; editing = { kind, destination };
    byId('webhook-label').value = destination?.label || '';
    byId('webhook-url').value = '';
    byId('webhook-label-field').hidden = kind === 'rotate';
    byId('webhook-label').required = kind !== 'rotate';
    byId('webhook-url-field').hidden = kind === 'rename';
    byId('webhook-url').required = kind !== 'rename';
    const title = kind === 'rename' ? 'Rename destination' : kind === 'rotate' ? 'Rotate webhook' : 'Register webhook';
    byId('webhook-form-title').textContent = title; byId('save-webhook').textContent = title;
    byId('webhook-form').hidden = false;
    announce(''); updateControls(); byId(kind === 'rotate' ? 'webhook-url' : 'webhook-label').focus();
  }
  function openSubscription() {
    if (busy || stale || editor || !config?.feeds.length || !config?.destinations.length) return;
    editor = 'subscription'; editing = null;
    for (const [id, choices] of [['subscription-feed', config.feeds], ['subscription-destination', config.destinations]]) {
      byId(id).replaceChildren();
      for (const choice of choices) {
        const option = node('option', '', choice.label + ' (' + choice.id + ')');
        option.value = choice.id; byId(id).append(option);
      }
      byId(id).value = choices[0].id;
    }
    byId('subscription-form').hidden = false;
    announce(''); updateControls(); byId('subscription-feed').focus();
  }
  async function responseConfig(response) {
    let result;
    try { result = await response.json(); } catch { result = null; }
    if (!response.ok) {
      if (response.status === 409) {
        stale = true;
        throw new Error('Configuration changed in another tab or tool. Your form is still here. Copy changes you want to keep, then reload before saving.');
      }
      if (response.status === 401 || response.status === 403) {
        stale = true; byId('access-link').hidden = false;
      }
      if (response.status >= 500) stale = true;
      throw new Error(result && typeof result.error === 'string' ? result.error : 'The change could not be confirmed. Reload and inspect the catalog before retrying.');
    }
    if (!result || result.mode !== 'scoped' || typeof result.initialized !== 'boolean' || typeof result.revision !== 'string' || !Array.isArray(result.feeds) || !Array.isArray(result.destinations) || !Array.isArray(result.subscriptions) || !result.permissions || typeof result.permissions.addFeeds !== 'boolean' || !Array.isArray(result.permissions.channels)) {
      stale = true;
      throw new Error('The server returned an unexpected response. Reload and inspect the catalog before retrying.');
    }
    return result;
  }
  async function load() {
    if (busy || (editor && !window.confirm('Reload configuration and discard the unsaved form?'))) return;
    busy = true; updateControls(); announce('Loading catalog…');
    try {
      config = await responseConfig(await fetch('/admin/api/catalog', { headers: { Accept: 'application/json' }, cache: 'no-store', credentials: 'same-origin' }));
      stale = false; byId('access-link').hidden = true; closeEditor(); render(); announce('');
    } catch (error) {
      byId('loading').textContent = 'The catalog could not be loaded.'; announce(error.message, true);
    } finally { busy = false; updateControls(); }
  }
  async function save(operation, message, focusId) {
    if (busy || stale || !config) return;
    busy = true; updateControls(); announce('Saving changes…');
    try {
      let response;
      try {
        response = await fetch('/admin/api/catalog', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ revision: config.revision, operation }) });
      } catch {
        stale = true;
        throw new Error('The change could not be confirmed. Reload and inspect the catalog before retrying; it was not retried.');
      }
      config = await responseConfig(response); closeEditor(); render(); announce(message); byId(focusId).focus();
    } catch (error) { announce(error.message, true); }
    finally { busy = false; updateControls(); }
  }
  byId('feed-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const label = byId('feed-label').value.trim();
    const operation = editing ? { type: 'feed.rename', id: editing.id, label } : { type: 'feed.create', label, url: byId('feed-url').value.trim() };
    save(operation, editing ? 'Feed renamed. Its source and subscriptions are unchanged.' : 'Feed added. Subscribe destinations separately.', 'feeds-heading');
  });
  byId('webhook-form').addEventListener('submit', (event) => {
    event.preventDefault();
    if (!editing) return;
    const label = byId('webhook-label').value.trim();
    const webhookUrl = byId('webhook-url').value.trim();
    const operation = editing.kind === 'create' ? { type: 'destination.create', label, webhookUrl } : editing.kind === 'rename' ? { type: 'destination.rename', id: editing.destination.id, label } : { type: 'destination.rotate', id: editing.destination.id, webhookUrl };
    save(operation, editing.kind === 'create' ? 'Webhook verified and destination registered.' : editing.kind === 'rename' ? 'Destination renamed. Subscriptions are unchanged.' : 'Webhook verified and rotated for the same channel.', 'webhooks-heading');
  });
  byId('subscription-form').addEventListener('submit', (event) => {
    event.preventDefault();
    save({ type: 'subscription.add', feedId: byId('subscription-feed').value, destinationId: byId('subscription-destination').value }, 'Destination subscribed to the selected feed.', 'subscriptions-heading');
  });
  byId('initialize-catalog').addEventListener('click', () => save({ type: 'initialize' }, 'Catalog initialized. Existing subscriptions are unchanged.', 'feeds-heading'));
  byId('add-feed').addEventListener('click', () => openFeed());
  byId('add-webhook').addEventListener('click', () => openWebhook());
  byId('add-subscription').addEventListener('click', openSubscription);
  for (const form of forms) byId('cancel-' + form).addEventListener('click', () => {
    closeEditor(); byId('add-' + form).focus();
  });
  byId('reload').addEventListener('click', load);
  window.addEventListener('beforeunload', (event) => {
    if (editor) { event.preventDefault(); event.returnValue = ''; }
  });
  load();
})();
`;

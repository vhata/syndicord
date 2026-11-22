import assert from 'node:assert/strict';
import test from 'node:test';
import { renderAccessPage, renderAdminPage } from '../src/admin-page.ts';

test('installation branding is escaped and shared by the editor and access pages', () => {
  const appearance = {
    name: '  Community </span><script>alert(1)</script>  ',
    headerColor: '#E6F2FF',
  };
  const pages = [
    renderAdminPage('nonce', { id: '123', name: 'Admin' }, appearance),
    renderAccessPage(
      'nonce',
      {
        title: 'Sign in',
        message: 'Sign in to manage configuration.',
        allowLogin: true,
      },
      appearance,
    ),
  ];
  for (const page of pages) {
    assert.match(
      page,
      /Community &lt;\/span&gt;&lt;script&gt;alert\(1\)&lt;\/script&gt;/,
    );
    assert.match(page, /<title>[^<]*Community [^<]* · syndicord<\/title>/);
    assert.match(
      page,
      /--header: #E6F2FF;[^}]*background: var\(--header\); color: #000000/,
    );
    assert.doesNotMatch(page, /<script>alert|<img /);
  }
});

test('branding defaults and invalid CSS values keep a readable header', () => {
  for (const headerColor of [
    undefined,
    '',
    'red',
    '#fff',
    '#123456;',
    '</style><script>alert(1)</script>',
  ]) {
    const page = renderAdminPage(
      'nonce',
      { id: '123', name: 'Admin' },
      { name: '  ', headerColor },
    );
    assert.match(page, /<title>Feeds and webhooks · syndicord<\/title>/);
    assert.doesNotMatch(page, /<span class="installation-name">|<script>alert/);
    assert.match(
      page,
      /--header: #233c37;[^}]*background: var\(--header\); color: #ffffff/,
    );
  }
  for (const [headerColor, foreground] of [
    ['#000000', '#ffffff'],
    ['#ffffff', '#000000'],
    ['#ff0000', '#000000'],
    ['#0000ff', '#ffffff'],
  ]) {
    const page = renderAccessPage(
      'nonce',
      { title: 'Sign in', message: '', allowLogin: true },
      { headerColor },
    );
    assert.ok(page.includes(`--header: ${headerColor};`));
    assert.ok(
      page.includes(`background: var(--header); color: ${foreground};`),
    );
  }
  const bounded = renderAdminPage(
    'nonce',
    { id: '123', name: 'Admin' },
    { name: 'a'.repeat(81) },
  );
  assert.match(bounded, /<span class="installation-name">a{80}<\/span>/);
  assert.doesNotMatch(bounded, /a{81}/);
});

test('sign-in and denied-access pages provide account recovery without rendering the editor', () => {
  const signedOut = renderAccessPage('nonce', {
    title: 'Sign in to syndicord',
    message: 'Sign in to manage configuration.',
    allowLogin: true,
  });
  assert.match(
    signedOut,
    /href="\/admin\/auth\/login">Sign in with Discord<\/a>/,
  );
  assert.doesNotMatch(signedOut, /id="feed-form"|id="webhook-form"|<script/);
  assert.match(signedOut, /does not join a server or assign roles/);
  const denied = renderAccessPage('nonce', {
    title: 'Your account does not have access',
    message: 'Ask a server administrator for the required role.',
    user: { id: '123', name: 'Test admin' },
    allowLogin: true,
    showLogout: true,
    retry: true,
  });
  assert.match(denied, /Signed in as <strong>Test admin<\/strong>/);
  assert.match(denied, /action="\/admin\/auth\/logout" method="post"/);
  assert.match(denied, /switch accounts in Discord/);
  assert.doesNotMatch(denied, /id="feed-form"|id="webhook-form"|<script/);
});

test('identity and authentication error text cannot introduce HTML or scripts', () => {
  const user = {
    id: '123<svg onload="alert(1)">',
    name: '</strong><script>alert(1)</script>',
  };
  const editor = renderAdminPage('nonce" injected="value', user);
  const access = renderAccessPage('nonce" injected="value', {
    title: '<img src=x onerror=alert(1)>',
    message: '<script>alert(2)</script>',
    user,
    allowLogin: false,
  });
  for (const page of [editor, access]) {
    assert.doesNotMatch(
      page,
      /<script>alert|<svg onload|nonce="nonce" injected=/,
    );
    assert.match(page, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.match(page, /nonce="nonce&quot; injected=&quot;value"/);
  }
  assert.doesNotMatch(access, /<img src=x|<script>alert\(2\)/);
  assert.match(access, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

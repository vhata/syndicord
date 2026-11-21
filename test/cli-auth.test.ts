import assert from 'node:assert/strict';
import {
  chmod,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { login, logout, readSession } from '../cli/auth.ts';
import { runCli } from '../cli/index.ts';
import type { AdminFetch } from '../cli/admin.ts';

const origin = 'https://relay.example';
const token = 'application-session-'.padEnd(43, 'a');
const secret = 'polling-secret-'.padEnd(43, 's');
const requestId = 'request-'.padEnd(43, 'r');
const user = { id: '123456789012345678', name: 'Relay administrator' };
const started = {
  requestId,
  secret,
  verificationUri: `${origin}/admin/auth/cli?request=${requestId}`,
  userCode: 'ABCD-1234',
  expiresIn: 600,
  interval: 2,
};

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'syndicord-auth-'));
  const env = { SYNDICORD_ADMIN_URL: origin, XDG_CONFIG_HOME: directory };
  let clock = Date.now();
  const progress: string[] = [];
  const opened: string[] = [];
  const waits: number[] = [];
  const calls: { url: string; init: RequestInit }[] = [];
  const dependencies = {
    now: () => clock,
    wait: async (ms: number) => {
      waits.push(ms);
      clock += ms;
    },
    progress: (message: string) => {
      progress.push(message);
    },
    openBrowser: async (url: string) => {
      opened.push(url);
    },
    fetcher: async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      if (url.endsWith('/start')) return Response.json(started);
      return Response.json({ token, user, expiresAt: clock + 60_000 });
    },
  };
  return {
    directory,
    env,
    dependencies,
    progress,
    opened,
    waits,
    calls,
    dispose: () => rm(directory, { recursive: true, force: true }),
  };
}

test('browser-assisted login keeps tokens private and persists a per-installation session with private permissions', async () => {
  const f = await fixture();
  try {
    const result = await login(f.env, f.dependencies);
    assert.match(result, /Signed in as "Relay administrator"/);
    assert.deepEqual(f.opened, [started.verificationUri]);
    assert.match(f.progress.join('\n'), /ABCD-1234/);
    assert.doesNotMatch(
      JSON.stringify([result, f.progress, f.opened]),
      /application-session-|polling-secret-/,
    );
    assert.deepEqual(f.waits, [2000]);
    for (const { url, init } of f.calls) {
      assert.equal(init.method, 'POST');
      assert.equal(init.redirect, 'error');
      assert.ok(init.signal);
      assert.equal(
        new Headers(init.headers).get('content-type'),
        'application/json',
      );
      assert.doesNotMatch(url, /application-session-|polling-secret-/);
    }
    assert.deepEqual(JSON.parse(String(f.calls[1]!.init.body)), {
      requestId,
      secret,
    });
    assert.equal((await readSession(f.env)).token, token);
    const files = await readdir(join(f.directory, 'syndicord'));
    assert.equal(files.length, 1);
    assert.equal(
      (await stat(join(f.directory, 'syndicord'))).mode & 0o777,
      0o700,
    );
    assert.equal(
      (await stat(join(f.directory, 'syndicord', files[0]!))).mode & 0o777,
      0o600,
    );
    await assert.rejects(
      readSession({ ...f.env, SYNDICORD_ADMIN_URL: 'https://other.example' }),
      /Run syndicord login/,
    );
    const file = join(f.directory, 'syndicord', files[0]!);
    const stored = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(stored.origin, origin);
    assert.equal(stored.token, token);
    assert.equal(stored.secret, undefined);
    stored.expiresAt = Date.now() - 1;
    await writeFile(file, JSON.stringify(stored));
    await assert.rejects(readSession(f.env), /Run syndicord login/);
  } finally {
    await f.dispose();
  }
});

test('login polls pending requests, respects rate limits and falls back to a printable verification URL', async () => {
  const f = await fixture();
  let polls = 0;
  try {
    const result = await login(f.env, {
      ...f.dependencies,
      openBrowser: async () => {
        throw new Error('private opener diagnostic');
      },
      fetcher: async (url, init) => {
        if (url.endsWith('/start')) return Response.json(started);
        if (polls++ === 0)
          return Response.json({ status: 'pending' }, { status: 202 });
        if (polls === 2)
          return new Response('private-provider-diagnostic', {
            status: 429,
            headers: { 'Retry-After': '7' },
          });
        return f.dependencies.fetcher(url, init);
      },
    });
    assert.match(result, /Signed in/);
    assert.deepEqual(f.waits, [2000, 2000, 7000]);
    assert.match(
      f.progress.join('\n'),
      /Could not open a browser automatically/,
    );
    assert.doesNotMatch(f.progress.join('\n'), /private opener/);
  } finally {
    await f.dispose();
  }
});

test('browser login has a bounded deadline even when requests stay pending or rate limited', async () => {
  for (const status of [202, 429]) {
    const f = await fixture();
    try {
      await assert.rejects(
        login(f.env, {
          ...f.dependencies,
          fetcher: async (url) =>
            url.endsWith('/start')
              ? Response.json({ ...started, expiresIn: 5 })
              : status === 202
                ? Response.json({ status: 'pending' }, { status })
                : new Response(null, {
                    status,
                    headers: { 'Retry-After': '999999999' },
                  }),
        }),
        /timed out/,
      );
      assert.equal(
        f.waits.reduce((a, b) => a + b, 0),
        5000,
      );
      await assert.rejects(readSession(f.env), /Run syndicord login/);
    } finally {
      await f.dispose();
    }
  }
});

test('denied access, invalid requests, disabled administration and provider errors never save a session or echo bodies', async () => {
  for (const status of [400, 401, 403, 404, 410, 500, 503]) {
    const f = await fixture();
    try {
      await assert.rejects(
        login(f.env, {
          ...f.dependencies,
          fetcher: async (url) =>
            url.endsWith('/start')
              ? Response.json(started)
              : new Response('private-token-and-provider-body', { status }),
        }),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.doesNotMatch(error.message, /private-token/);
          if (status === 403) assert.match(error.message, /server.*role/);
          return true;
        },
      );
      await assert.rejects(readSession(f.env), /Run syndicord login/);
    } finally {
      await f.dispose();
    }
  }
});

test('verification URLs and all credentials are validated before opening a browser or saving a session', async () => {
  for (const changes of [
    {
      verificationUri: `https://evil.example/admin/auth/cli?request=${requestId}`,
    },
    {
      verificationUri: `${origin}/admin/auth/cli?request=${requestId}&redirect=evil`,
    },
    { verificationUri: `${origin}/admin/auth/login?request=${requestId}` },
    {
      verificationUri: `https://user:password@relay.example/admin/auth/cli?request=${requestId}`,
    },
    { userCode: '\u001b[2J' },
    { expiresIn: 601 },
    { interval: 0 },
    { secret: 'short' },
  ]) {
    const f = await fixture();
    try {
      await assert.rejects(
        login(f.env, {
          ...f.dependencies,
          fetcher: async () => Response.json({ ...started, ...changes }),
        }),
        /invalid response/,
      );
      assert.deepEqual(f.opened, []);
      assert.deepEqual(f.progress, []);
      await assert.rejects(readSession(f.env), /Run syndicord login/);
    } finally {
      await f.dispose();
    }
  }
  for (const invalid of [
    { token: 'short', user, expiresAt: Date.now() + 60_000 },
    { token, user, expiresAt: Date.now() - 1 },
    { token, user, expiresAt: Date.now() + 10 * 60 * 60 * 1000 },
    { token, user: { id: 'bad', name: 'N' }, expiresAt: Date.now() + 60_000 },
  ]) {
    const f = await fixture();
    try {
      await assert.rejects(
        login(f.env, {
          ...f.dependencies,
          fetcher: async (url) =>
            Response.json(url.endsWith('/start') ? started : invalid),
        }),
        /invalid response/,
      );
      await assert.rejects(readSession(f.env), /Run syndicord login/);
    } finally {
      await f.dispose();
    }
  }
});

test('logout invalidates the server session before removing local credentials and keeps other origins signed in', async () => {
  const f = await fixture();
  try {
    await login(f.env, f.dependencies);
    let invalidated = false;
    const output = await logout(f.env, async (url, init) => {
      assert.equal(url, `${origin}/admin/auth/logout`);
      assert.equal(init.method, 'POST');
      assert.equal(init.redirect, 'error');
      assert.equal(
        new Headers(init.headers).get('authorization'),
        `Bearer ${token}`,
      );
      assert.deepEqual(JSON.parse(String(init.body)), {});
      assert.equal((await readSession(f.env)).token, token);
      invalidated = true;
      return new Response(null, { status: 204 });
    });
    assert.ok(invalidated);
    assert.match(output, /Signed out/);
    await assert.rejects(readSession(f.env), /Run syndicord login/);
    assert.match(
      await logout(f.env, async () => {
        throw new Error('must not fetch');
      }),
      /No active CLI session/,
    );
  } finally {
    await f.dispose();
  }
});

test('failed logout retains the credential so the user can retry invalidation', async () => {
  const f = await fixture();
  try {
    await login(f.env, f.dependencies);
    await assert.rejects(
      logout(f.env, async () => new Response('private-error', { status: 503 })),
      /retained.*retry/,
    );
    assert.equal((await readSession(f.env)).token, token);
    await assert.rejects(
      logout(f.env, async () => {
        throw new Error('private-error');
      }),
      /Cannot complete/,
    );
    assert.equal((await readSession(f.env)).token, token);
    await logout(f.env, async () => new Response(null, { status: 401 }));
    await assert.rejects(readSession(f.env), /Run syndicord login/);
  } finally {
    await f.dispose();
  }
});

test('CLI authentication commands need no Cloudflare credentials and configuration rejects missing or expired sessions before fetching', async () => {
  const f = await fixture();
  const cf = async () => {
    throw new Error('must not invoke Cloudflare');
  };
  try {
    const missing = await runCli(['feeds', 'get'], f.env, {
      cf,
      adminFetch: cf,
    });
    assert.equal(missing.code, 2);
    assert.match(missing.stderr, /Run syndicord login/);
    const signed = await runCli(['login'], f.env, {
      cf,
      adminFetch: f.dependencies.fetcher,
      auth: f.dependencies,
    });
    assert.equal(signed.code, 0, signed.stderr);
    assert.match(signed.stdout, /Signed in/);
    const out = await runCli(['logout'], f.env, {
      cf,
      adminFetch: async () => new Response(null, { status: 204 }),
    });
    assert.equal(out.code, 0, out.stderr);
    for (const args of [
      ['login', 'extra'],
      ['logout', '--local'],
    ]) {
      const invalid = await runCli(args, f.env, { cf, adminFetch: cf });
      assert.equal(invalid.code, 2);
      assert.match(invalid.stderr, /Expected syndicord/);
    }
  } finally {
    await f.dispose();
  }
});

test('unsafe local credential permissions and mismatched stored origins fail closed', async () => {
  const f = await fixture();
  try {
    await login(f.env, f.dependencies);
    const files = await readdir(join(f.directory, 'syndicord'));
    const file = join(f.directory, 'syndicord', files[0]!);
    await chmod(file, 0o644);
    await assert.rejects(readSession(f.env), /private CLI session/);
    await chmod(file, 0o600);
    const saved = JSON.parse(await readFile(file, 'utf8'));
    await writeFile(
      file,
      JSON.stringify({ ...saved, origin: 'https://other.example' }),
    );
    await assert.rejects(readSession(f.env), /private CLI session/);
  } finally {
    await f.dispose();
  }
});

test('authentication errors and oversized response bodies never leak into output', async () => {
  const f = await fixture();
  const fetchers: AdminFetch[] = [
    async () => {
      throw new Error('private-token');
    },
    async () => new Response('private-token'),
    async () => new Response('x'.repeat(128 * 1024 + 1)),
    async () =>
      new Response('private-token', {
        status: 302,
        headers: { Location: 'https://evil.example' },
      }),
  ];
  try {
    for (const fetcher of fetchers) {
      const result = await runCli(['login'], f.env, {
        adminFetch: fetcher,
        auth: f.dependencies,
      });
      assert.equal(result.code, 2);
      assert.doesNotMatch(JSON.stringify(result), /private-token|evil.example/);
    }
  } finally {
    await f.dispose();
  }
});

test('headless login prints the browser approval URL without launching a browser', async () => {
  const f = await fixture();
  try {
    const result = await runCli(['login', '--no-browser'], f.env, {
      adminFetch: f.dependencies.fetcher,
      auth: f.dependencies,
    });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(f.opened, []);
    assert.ok(f.progress.includes(`Open ${started.verificationUri}`));
  } finally {
    await f.dispose();
  }
});

test('login network requests and response bodies are bounded by a deadline', async (t) => {
  const f = await fixture();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const stalled = login(f.env, {
      ...f.dependencies,
      fetcher: async (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal!.addEventListener(
            'abort',
            () => reject(new Error('private-network-error')),
            { once: true },
          );
        }),
    });
    const rejected = assert.rejects(
      stalled,
      /Cannot complete administration authentication/,
    );
    t.mock.timers.tick(10_000);
    await rejected;
    let cancelled = false;
    const stalledBody = login(f.env, {
      ...f.dependencies,
      fetcher: async () =>
        new Response(
          new ReadableStream({
            cancel() {
              cancelled = true;
            },
          }),
        ),
    });
    const rejectedBody = assert.rejects(
      stalledBody,
      /Cannot complete administration authentication/,
    );
    await Promise.resolve();
    t.mock.timers.tick(10_000);
    await rejectedBody;
    assert.ok(cancelled);
    await assert.rejects(readSession(f.env), /Run syndicord login/);
  } finally {
    await f.dispose();
  }
});

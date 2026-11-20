import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyDeployment } from '../cli/verify-deployment.ts';

const version = '87654321-4321-4321-4321-cba987654321';
const otherVersion = '11111111-4321-4321-4321-cba987654321';
const message = 'syndicord commit ' + 'a'.repeat(40);
const history = {
  deployments: [{ versions: [{ version_id: version, percentage: 100 }] }],
};

test('verification tolerates a transient read error and delayed version annotations', async () => {
  const waits: number[] = [];
  let checks = 0;
  const actual = await verifyDeployment(
    async (args) => {
      assert.equal(args.at(-1), 'installation-two');
      if (args[1] === 'deployments') {
        if (++checks === 1) throw new Error('PRIVATE_REMOTE_DIAGNOSTIC');
        return history;
      }
      assert.deepEqual(args.slice(0, 4), [
        'workers',
        'versions',
        'get',
        version,
      ]);
      return {
        annotations: { 'workers/message': checks === 2 ? undefined : message },
      };
    },
    'installation-two',
    message,
    async (ms) => {
      waits.push(ms);
    },
  );
  assert.equal(actual, version);
  assert.equal(checks, 3);
  assert.deepEqual(waits, [2_000, 2_000]);
});

test('verification never accepts an older matching deployment or exposes the active annotation', async () => {
  const reads: string[][] = [];
  const waits: number[] = [];
  await assert.rejects(
    verifyDeployment(
      (args) => {
        reads.push(args);
        if (args[1] === 'deployments')
          return {
            deployments: [
              { versions: [{ version_id: otherVersion, percentage: 100 }] },
              ...history.deployments,
            ],
          };
        return {
          annotations: {
            'workers/message':
              args[3] === version ? message : 'PRIVATE_REMOTE_DIAGNOSTIC',
          },
        };
      },
      'syndicord',
      message,
      async (ms) => {
        waits.push(ms);
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /after 6 checks/);
      assert.match(error.message, new RegExp(otherVersion));
      assert.doesNotMatch(error.message, /PRIVATE_REMOTE_DIAGNOSTIC/);
      return true;
    },
  );
  assert.equal(reads.length, 12);
  assert.ok(
    reads.every((args) => args[1] !== 'versions' || args[3] === otherVersion),
  );
  assert.deepEqual(waits, Array(5).fill(2_000));
});

test('persistent unreadable history, split traffic, and malformed version IDs fail within the retry bound', async () => {
  for (const response of [
    null,
    [],
    { deployments: [] },
    { deployments: [{ versions: [{ version_id: version, percentage: 50 }] }] },
    {
      deployments: [
        {
          versions: [
            { version_id: version, percentage: 100 },
            { version_id: otherVersion, percentage: 0 },
          ],
        },
      ],
    },
    {
      deployments: [
        {
          versions: [
            { version_id: 'PRIVATE_REMOTE_DIAGNOSTIC', percentage: 100 },
          ],
        },
      ],
    },
    new Error('PRIVATE_REMOTE_DIAGNOSTIC'),
  ]) {
    let reads = 0;
    const waits: number[] = [];
    await assert.rejects(
      verifyDeployment(
        (args) => {
          assert.equal(args[1], 'deployments');
          reads++;
          if (response instanceof Error) throw response;
          return response;
        },
        'syndicord',
        message,
        async (ms) => {
          waits.push(ms);
        },
      ),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /after 6 checks/);
        assert.doesNotMatch(error.message, /PRIVATE_REMOTE_DIAGNOSTIC/);
        return true;
      },
    );
    assert.equal(reads, 6);
    assert.deepEqual(waits, Array(5).fill(2_000));
  }
});

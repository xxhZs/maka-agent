import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { HostExtensionUiStateStore } from '../server/extension-ui-state-store.js';

test('UI state is isolated by Entry identity and survives restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-extension-ui-state-'));
  try {
    const first = new HostExtensionUiStateStore(root);
    await first.set('desktop-ui', 'entry-a', 'status', 'ready-a');
    await first.set('desktop-ui', 'entry-b', 'status', 'ready-b');
    assert.deepEqual(await first.get('desktop-ui', 'entry-a', 'status'), {
      found: true,
      value: 'ready-a',
    });
    assert.deepEqual(await first.get('desktop-ui', 'entry-b', 'status'), {
      found: true,
      value: 'ready-b',
    });

    const restarted = new HostExtensionUiStateStore(root);
    assert.deepEqual(await restarted.get('desktop-ui', 'entry-a', 'status'), {
      found: true,
      value: 'ready-a',
    });
    await restarted.clear('desktop-ui', 'entry-a');
    assert.deepEqual(await restarted.get('desktop-ui', 'entry-b', 'status'), {
      found: true,
      value: 'ready-b',
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('UI state changes wake ordered revision subscribers without polling', async () => {
  const store = new HostExtensionUiStateStore();
  const waiting = store.nextChanges('desktop-ui', 'entry-a', 0, 1_000);
  await store.set('desktop-ui', 'entry-a', 'status', { phase: 'running' });
  assert.deepEqual(await waiting, {
    sequence: 1,
    changes: [
      {
        sequence: 1,
        kind: 'set',
        key: 'status',
        value: { phase: 'running' },
      },
    ],
  });
  await store.delete('desktop-ui', 'entry-a', 'status');
  assert.deepEqual(await store.nextChanges('desktop-ui', 'entry-a', 1, 0), {
    sequence: 2,
    changes: [{ sequence: 2, kind: 'delete', key: 'status' }],
  });
});

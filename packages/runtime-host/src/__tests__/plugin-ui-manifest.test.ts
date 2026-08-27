import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeUiPackageManifest } from '../server/plugin-ui-manifest.js';

test('UI manifest preserves native contribution metadata and explicit Client capabilities', () => {
  const manifest = decodeUiPackageManifest({
    schemaVersion: 1,
    id: 'dev.maka.native-ui-test',
    ui: {
      contributions: [{
        id: 'issues',
        surface: 'app.slot',
        slot: 'client.route.issues',
        title: 'Issue Board',
        description: 'Project issues',
        order: 20,
        priority: 5,
        document: 'documents/issues.html',
      }],
      permissions: {
        network: false,
        hostState: true,
        clientCapabilities: ['navigation', 'notifications', 'artifactRead'],
      },
    },
  });

  assert.deepEqual(manifest.ui[0], {
    id: 'issues',
    surface: 'app.slot',
    slot: 'client.route.issues',
    slots: [],
    priority: 5,
    title: 'Issue Board',
    description: 'Project issues',
    order: 20,
    document: 'documents/issues.html',
  });
  assert.deepEqual(manifest.permissions.clientCapabilities, [
    'navigation',
    'notifications',
    'artifactRead',
  ]);
});

test('UI manifest rejects duplicate or unknown Client capabilities', () => {
  const value = (capabilities: string[]) => ({
    schemaVersion: 1,
    id: 'dev.maka.native-ui-test',
    ui: {
      contributions: [{
        id: 'issues',
        surface: 'app.slot',
        slot: 'client.route.issues',
        priority: 0,
        document: 'documents/issues.html',
      }],
      permissions: { network: false, clientCapabilities: capabilities },
    },
  });
  assert.throws(() => decodeUiPackageManifest(value(['navigation', 'navigation'])), /capabilities/u);
  assert.throws(() => decodeUiPackageManifest(value(['shell'])), /capabilities/u);
});

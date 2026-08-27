import assert from 'node:assert/strict';
import { test } from 'node:test';
import { requireMakaUiSdk, uiPoint } from '../extension-ui-sdk.js';

test('UI SDK generates stable native contribution point names', () => {
  assert.equal(uiPoint({ kind: 'route', id: 'Issue Board' }), 'client.route.issue-board');
  assert.equal(
    uiPoint({ kind: 'conversation.node', messageType: 'tool_result' }),
    'conversation.node.tool-result',
  );
  assert.equal(
    uiPoint({ kind: 'tool.result', toolName: 'GitHub Search' }),
    'tool.result.github-search',
  );
  assert.equal(
    uiPoint({ kind: 'artifact.renderer', artifactKind: 'image' }),
    'artifact.renderer.image',
  );
});

test('UI SDK compatibility check rejects an older bridge', () => {
  assert.throws(() => requireMakaUiSdk({ getState() {} }), /incompatible/u);
});

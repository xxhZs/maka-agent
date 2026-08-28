import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createClientPluginRequestHandler } from '../client-plugin-protocol.js';

const contribution = {
  entryId: 'entry-one',
  extensionId: 'dev.maka.fixture',
  generation: 3,
  id: 'dev.maka.fixture',
  bundle: 'window.__MakaModuleLoader__.load({id:"dev.maka.fixture",factory:()=>({})});',
  bundleSha256: 'a'.repeat(64),
  inject: [],
  external: [],
  tools: [],
} as const;

test('private Client protocol serves only the exact active bundle generation', async () => {
  const handler = createClientPluginRequestHandler(() => ({
    request: async () => ({
      scopeId: 'desktop-ui',
      digest: 'fixture',
      contributions: [contribution],
    }),
  }));
  const response = await handler(new Request(urlFor(contribution.bundleSha256)));
  assert.equal(response.status, 200);
  assert.equal(await response.text(), contribution.bundle);
  assert.match(response.headers.get('content-type') ?? '', /text\/javascript/u);

  const stale = await handler(new Request(urlFor('b'.repeat(64))));
  assert.equal(stale.status, 404);
});

test('private Client protocol rejects open or malformed identities', async () => {
  const handler = createClientPluginRequestHandler(() => null);
  assert.equal((await handler(new Request(`${urlFor(contribution.bundleSha256)}&extra=1`))).status, 400);
  assert.equal((await handler(new Request('maka-client-plugin://bundle/v1'))).status, 400);
  assert.equal(
    (await handler(new Request(urlFor(contribution.bundleSha256), { method: 'POST' }))).status,
    405,
  );
});

function urlFor(bundleSha256: string): string {
  const url = new URL('maka-client-plugin://bundle/v1');
  url.searchParams.set('scopeId', 'desktop-ui');
  url.searchParams.set('entryId', contribution.entryId);
  url.searchParams.set('extensionId', contribution.extensionId);
  url.searchParams.set('generation', String(contribution.generation));
  url.searchParams.set('id', contribution.id);
  url.searchParams.set('bundleSha256', bundleSha256);
  return url.toString();
}

import assert from 'node:assert/strict';
import test from 'node:test';
import { Context } from '../plugin-kernel.js';
import { PluginWebService, type MakaWebCapability } from '../plugin-web-service.js';

function capability(marker: string): MakaWebCapability {
  return {
    async search() {
      return { ok: false, reason: 'not_configured', message: marker };
    },
    async fetch() {
      return marker;
    },
  };
}

test('web providers are scoped to their owner Fiber and wrap the Host capability', async () => {
  const root = new Context();
  new PluginWebService(root);
  const base = capability('base');
  const wrapped = capability('wrapped');
  const fiber = root.plugin({
    name: 'fixture-web',
    inject: ['web'],
    apply(ctx: Context) {
      ctx.web.register({
        id: 'fixture.web',
        priority: 100,
        create: (received) => {
          assert.equal(received, base);
          return wrapped;
        },
      });
    },
  });
  await fiber;

  assert.equal(root.web.resolve(base), wrapped);
  assert.deepEqual(
    root.web.inspect().map(({ id }) => id),
    ['fixture.web'],
  );

  await fiber.dispose();
  assert.equal(root.web.resolve(base), base);
  await root.fiber.dispose();
});

test('web search and fetch providers are selected independently and reject ambiguity', async () => {
  const root = new Context();
  new PluginWebService(root);
  const first = root.plugin({
    name: 'fixture-web-operations',
    inject: ['web'],
    apply(ctx: Context) {
      ctx.web.registerSearchProvider({
        id: 'search-one',
        async search() {
          return { ok: false, reason: 'not_configured', message: 'search-one' };
        },
      });
      ctx.web.registerFetchProvider({ id: 'fetch-one', fetch: async () => 'fetch-one' });
    },
  });
  await first;
  const resolved = root.web.resolve(capability('base'));
  const firstSearch = await resolved.search({ query: 'q', limit: 1, sessionId: 's' });
  assert.equal(firstSearch.ok ? undefined : firstSearch.message, 'search-one');
  assert.equal(await resolved.fetch({ url: 'https://example.com', sessionId: 's' }), 'fetch-one');

  const second = root.plugin({
    name: 'fixture-web-ambiguous',
    inject: ['web'],
    apply(ctx: Context) {
      ctx.web.registerSearchProvider({
        id: 'search-two',
        async search() {
          return { ok: false, reason: 'not_configured', message: 'search-two' };
        },
      });
    },
  });
  await second;
  assert.throws(
    () => resolved.search({ query: 'q', limit: 1, sessionId: 's' }),
    /Multiple Web search providers/u,
  );
  const selected = root
    .intercept('web', { searchProvider: 'search-two' })
    .web.resolve(capability('base'));
  const secondSearch = await selected.search({ query: 'q', limit: 1, sessionId: 's' });
  assert.equal(secondSearch.ok ? undefined : secondSearch.message, 'search-two');
  await root.fiber.dispose();
});

import assert from 'node:assert/strict';
import test from 'node:test';
import type { LanguageModelV4 } from '@ai-sdk/provider';
import type { ModelFactoryInput } from '../model-factory.js';
import { Context } from '../plugin-kernel.js';
import { PluginLlmService } from '../plugin-llm-service.js';

test('LLM adapters are scoped to their owner Fiber and override the built-in route', async () => {
  const root = new Context();
  new PluginLlmService(root);
  const marker = { specificationVersion: 'v4' } as LanguageModelV4;
  const plugin = {
    name: 'fixture-llm',
    inject: ['llm'],
    apply(ctx: Context) {
      ctx.llm.register({
        id: 'fixture.llm',
        priority: 100,
        supports: () => true,
        create: () => marker,
      });
    },
  };
  const fiber = root.plugin(plugin);
  await fiber;

  const input = {
    connection: { providerType: 'fixture' },
    apiKey: 'test',
    modelId: 'fixture-model',
  } as unknown as ModelFactoryInput;
  assert.equal(root.llm.create(input).specificationVersion, marker.specificationVersion);
  assert.deepEqual(
    root.llm.inspect().map(({ id, ownerFiberName }) => ({ id, ownerFiberName })),
    [
      { id: 'fixture.llm', ownerFiberName: 'fixture-llm' },
      { id: 'maka.builtin', ownerFiberName: 'root' },
    ],
  );
  assert.deepEqual(
    root
      .inspectServices()
      .find(({ name }) => name === 'llm')
      ?.registrations.map(({ id, fiberName, realm }) => [id, fiberName, realm.id]),
    [
      ['maka.builtin', 'root', 'app'],
      ['fixture.llm', 'fixture-llm', 'app'],
    ],
  );

  await fiber.dispose();
  assert.deepEqual(
    root.llm.inspect().map(({ id }) => id),
    ['maka.builtin'],
  );
  await root.fiber.dispose();
});

test('LLM provider discovery, model resolution, and retry policy use the selected scoped adapter', async () => {
  const root = new Context();
  new PluginLlmService(root);
  const marker = { specificationVersion: 'v4' } as LanguageModelV4;
  const fiber = root.plugin({
    name: 'discoverable-llm',
    inject: ['llm'],
    apply(ctx: Context) {
      ctx.llm.register({
        id: 'fixture.discovery',
        providers: ['fixture-provider'],
        create: () => marker,
        providerInfo: () => ({
          id: 'fixture-provider',
          adapterId: 'fixture.discovery',
          label: 'Fixture Provider',
        }),
        listModels: async () => [{ id: 'fixture-model', contextWindow: 32_000 }],
        resolveModel: async (provider, model) => ({
          provider,
          id: model,
          contextWindow: 32_000,
          defaultMaxTokens: 4_096,
          reasoningEfforts: ['low', 'high'],
        }),
        retryPolicy: () => ({ maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1_000 }),
      });
    },
  });
  await fiber;

  assert.deepEqual(
    root.llm.listProviders().find(({ id }) => id === 'fixture-provider'),
    { id: 'fixture-provider', adapterId: 'fixture.discovery', label: 'Fixture Provider' },
  );
  assert.deepEqual(await root.llm.listModels('fixture-provider'), [
    { id: 'fixture-model', contextWindow: 32_000 },
  ]);
  assert.deepEqual(await root.llm.resolveModel('fixture-provider', 'fixture-model'), {
    provider: 'fixture-provider',
    id: 'fixture-model',
    contextWindow: 32_000,
    defaultMaxTokens: 4_096,
    reasoningEfforts: ['low', 'high'],
  });
  assert.deepEqual(root.llm.retryPolicy('fixture-provider'), {
    maxAttempts: 3,
    baseDelayMs: 100,
    maxDelayMs: 1_000,
  });
  await root.fiber.dispose();
});

test('LLM calls pass through the scoped llm/generate and llm/stream waterfalls', async () => {
  const root = new Context();
  new PluginLlmService(root);
  const observed: string[] = [];
  root.on('llm/generate', (_call, next) => {
    observed.push('generate');
    return (next as () => unknown)();
  });
  root.on('llm/stream', (_call, next) => {
    observed.push('stream');
    return (next as () => unknown)();
  });
  const model = {
    specificationVersion: 'v4',
    provider: 'fixture',
    modelId: 'model',
    supportedUrls: {},
    doGenerate: async () => ({ marker: 'generate' }),
    doStream: async () => ({ marker: 'stream' }),
  } as unknown as LanguageModelV4;
  const fiber = root.plugin({
    name: 'intercepted-llm',
    inject: ['llm'],
    apply(ctx: Context) {
      ctx.llm.register({
        id: 'fixture.intercepted',
        priority: 100,
        providers: ['fixture'],
        create: () => model,
      });
    },
  });
  await fiber;
  const resolved = root.llm.create({
    connection: { providerType: 'fixture' },
    apiKey: 'test',
    modelId: 'model',
  } as unknown as ModelFactoryInput);
  await resolved.doGenerate({} as never);
  await resolved.doStream({} as never);
  assert.deepEqual(observed, ['generate', 'stream']);
  await root.fiber.dispose();
});

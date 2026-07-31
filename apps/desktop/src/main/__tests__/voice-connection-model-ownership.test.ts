import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createDefaultSettings,
  type AppSettings,
  type LlmConnection,
} from '@maka/core';
import { repairVoiceConnectionModelOwnership } from '../voice-connection-model-ownership.js';

function settings(input: {
  recognition?: { connectionSlug: string; model: string };
  realtime?: { connectionSlug: string; model: string };
}): AppSettings {
  const defaults = createDefaultSettings();
  return {
    ...defaults,
    voice: {
      recognition: {
        ...defaults.voice.recognition,
        ...input.recognition,
      },
      realtime: {
        ...defaults.voice.realtime,
        ...input.realtime,
      },
    },
  };
}

function connection(
  slug: string,
  defaultModel: string,
  enabledModelIds: string[],
): LlmConnection {
  return {
    slug,
    name: slug,
    providerType: 'openai-compatible',
    defaultModel,
    enabledModelIds,
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  };
}

function harness(input: {
  settings: AppSettings;
  connections: LlmConnection[];
  defaultSlug: string | null;
}) {
  const connections = new Map(
    input.connections.map((item) => [item.slug, structuredClone(item)]),
  );
  let defaultSlug = input.defaultSlug;
  const updates: Array<{ slug: string; patch: Partial<LlmConnection> }> = [];
  return {
    connections,
    updates,
    defaultSlug: () => defaultSlug,
    deps: {
      settingsStore: { get: async () => input.settings },
      connectionStore: {
        get: async (slug: string) => connections.get(slug) ?? null,
        getDefault: async () => defaultSlug,
        update: async (slug: string, patch: Partial<LlmConnection>) => {
          const current = connections.get(slug);
          if (!current) throw new Error(`missing ${slug}`);
          const next = { ...current, ...patch, updatedAt: current.updatedAt + 1 };
          connections.set(slug, next);
          updates.push({ slug, patch });
          return next;
        },
        setDefault: async (slug: string | null) => {
          defaultSlug = slug;
        },
      },
    },
  };
}

describe('Voice connection model ownership repair', () => {
  it('removes legacy ASR and realtime ids without changing a chat execution model', async () => {
    const test = harness({
      settings: settings({
        recognition: { connectionSlug: 'shared', model: 'custom-asr' },
        realtime: { connectionSlug: 'shared', model: 'gpt-realtime' },
      }),
      connections: [
        connection('shared', 'gpt-5.5', [
          'gpt-5.5',
          'custom-asr',
          'gpt-realtime',
        ]),
      ],
      defaultSlug: 'shared',
    });

    assert.deepEqual(await repairVoiceConnectionModelOwnership(test.deps as never), {
      changedConnections: ['shared'],
      clearedDefaultConnection: false,
    });
    assert.equal(test.connections.get('shared')?.defaultModel, 'gpt-5.5');
    assert.deepEqual(test.connections.get('shared')?.enabledModelIds, ['gpt-5.5']);
    assert.equal(test.defaultSlug(), 'shared');
  });

  it('clears a legacy Voice model that became the conversation default', async () => {
    const test = harness({
      settings: settings({
        recognition: { connectionSlug: 'voice-only', model: 'custom-asr' },
      }),
      connections: [
        connection('voice-only', 'custom-asr', ['custom-asr']),
      ],
      defaultSlug: 'voice-only',
    });

    assert.deepEqual(await repairVoiceConnectionModelOwnership(test.deps as never), {
      changedConnections: ['voice-only'],
      clearedDefaultConnection: true,
    });
    assert.equal(test.connections.get('voice-only')?.defaultModel, '');
    assert.deepEqual(test.connections.get('voice-only')?.enabledModelIds, []);
    assert.equal(test.defaultSlug(), null);
  });

  it('is idempotent for already separated Voice settings', async () => {
    const test = harness({
      settings: settings({
        recognition: { connectionSlug: 'voice-only', model: 'custom-asr' },
      }),
      connections: [
        connection('voice-only', '', []),
      ],
      defaultSlug: null,
    });

    assert.deepEqual(await repairVoiceConnectionModelOwnership(test.deps as never), {
      changedConnections: [],
      clearedDefaultConnection: false,
    });
    assert.deepEqual(test.updates, []);
  });
});

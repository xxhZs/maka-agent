import { connectionEnabledModelIds } from '@maka/core';
import type { ConnectionStore, SettingsStore } from '@maka/storage';

export interface VoiceConnectionOwnershipRepair {
  changedConnections: string[];
  clearedDefaultConnection: boolean;
}

/**
 * Repair configurations written by the first Voice settings implementation.
 *
 * That implementation reused `Connection.defaultModel` for ASR configuration,
 * which made recognition/realtime models eligible for ordinary conversation
 * execution. Voice settings are now the authority for those model ids. Keep
 * the shared connection for endpoint/credential ownership, but remove its
 * Voice-owned ids from the chat-default/enabled-model fields.
 */
export async function repairVoiceConnectionModelOwnership(deps: {
  settingsStore: Pick<SettingsStore, 'get'>;
  connectionStore: Pick<
    ConnectionStore,
    'get' | 'getDefault' | 'update' | 'setDefault'
  >;
}): Promise<VoiceConnectionOwnershipRepair> {
  const settings = await deps.settingsStore.get();
  const modelsByConnection = new Map<string, Set<string>>();
  addVoiceModel(
    modelsByConnection,
    settings.voice.recognition.connectionSlug,
    settings.voice.recognition.model,
  );
  addVoiceModel(
    modelsByConnection,
    settings.voice.realtime.connectionSlug,
    settings.voice.realtime.model,
  );

  const changedConnections: string[] = [];
  let clearedDefaultConnection = false;
  let defaultSlug = await deps.connectionStore.getDefault();

  for (const [slug, voiceModels] of modelsByConnection) {
    const connection = await deps.connectionStore.get(slug);
    if (!connection) continue;
    const currentEnabled = connectionEnabledModelIds(connection);
    const nextEnabled = currentEnabled.filter((model) => !voiceModels.has(model));
    const clearsConversationDefault = voiceModels.has(connection.defaultModel);
    if (
      !clearsConversationDefault &&
      nextEnabled.length === currentEnabled.length
    ) {
      continue;
    }

    await deps.connectionStore.update(slug, {
      ...(clearsConversationDefault ? { defaultModel: '' } : {}),
      enabledModelIds: nextEnabled,
    });
    changedConnections.push(slug);

    if (clearsConversationDefault && defaultSlug === slug) {
      await deps.connectionStore.setDefault(null);
      defaultSlug = null;
      clearedDefaultConnection = true;
    }
  }

  return { changedConnections, clearedDefaultConnection };
}

function addVoiceModel(
  modelsByConnection: Map<string, Set<string>>,
  connectionSlug: string,
  model: string,
): void {
  const slug = connectionSlug.trim();
  const modelId = model.trim();
  if (!slug || !modelId) return;
  const models = modelsByConnection.get(slug) ?? new Set<string>();
  models.add(modelId);
  modelsByConnection.set(slug, models);
}

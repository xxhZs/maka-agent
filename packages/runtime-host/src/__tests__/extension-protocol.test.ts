import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  decodeExtensionCompositionMutateInput,
  decodeExtensionCompositionQueryResult,
  decodeExtensionContractQueryResult,
  decodeExtensionConfigurationMutateInput,
  decodeExtensionClientToolInvokeInput,
  decodeExtensionPackageExportInput,
  decodeExtensionUiSnapshotResult,
  decodeToolPackageInstallInput,
  decodeToolPackageUninstallInput,
} from '../protocol/extension.js';
import { operationAllowsRemoteOwner } from '../protocol/operations.js';

test('Extension control protocol strictly decodes catalog and lifecycle mutations', () => {
  assert.deepEqual(
    decodeExtensionCompositionMutateInput({
      kind: 'enable',
      entryId: 'weather-entry',
      scopeId: 'session:1',
      extensionId: 'dev.maka.weather',
    }),
    {
      kind: 'enable',
      entryId: 'weather-entry',
      scopeId: 'session:1',
      extensionId: 'dev.maka.weather',
    },
  );
  assert.deepEqual(
    decodeExtensionContractQueryResult({
      packages: [
        {
          extensionId: 'dev.maka.weather',
          displayName: 'Weather',
          description: '',
          dependencies: [{ id: 'dev.maka.http' }],
          configuration: {
            properties: {
              apiKey: { type: 'string', secret: true },
            },
            required: ['apiKey'],
          },
          contributions: [
            { kind: 'ui', id: 'dev.maka.weather' },
            { kind: 'hook', id: 'policy', event: 'PreToolUse', mode: 'gate' },
            {
              kind: 'event',
              id: 'dev.maka.weather.changed',
              event: 'dev.maka.weather.changed',
              description: 'Weather changed.',
            },
            {
              kind: 'listener',
              id: 'refresh',
              event: 'dev.maka.weather.changed',
            },
          ],
        },
      ],
    }).packages[0]?.contributions[0]?.id,
    'dev.maka.weather',
  );
  assert.equal(
    decodeExtensionContractQueryResult({
      packages: [
        {
          extensionId: 'dev.maka.policy',
          displayName: 'Policy',
          description: '',
          dependencies: [],
          configuration: { properties: {}, required: [] },
          contributions: [{ kind: 'hook', id: 'policy', event: 'PreToolUse', mode: 'gate' }],
        },
      ],
    }).packages[0]?.contributions[0]?.event,
    'PreToolUse',
  );
  assert.equal(
    decodeExtensionContractQueryResult({
      packages: [
        {
          extensionId: 'dev.maka.events',
          displayName: 'Events',
          description: '',
          dependencies: [],
          configuration: { properties: {}, required: [] },
          contributions: [
            {
              kind: 'listener',
              id: 'observe',
              event: 'dev.maka.events.changed',
            },
          ],
        },
      ],
    }).packages[0]?.contributions[0]?.event,
    'dev.maka.events.changed',
  );
  assert.deepEqual(
    decodeExtensionConfigurationMutateInput({
      entryId: 'weather-entry',
      configuration: { apiKey: 'secret', retries: 3 },
    }),
    { entryId: 'weather-entry', configuration: { apiKey: 'secret', retries: 3 } },
  );
  assert.deepEqual(
    decodeExtensionPackageExportInput({
      extensionId: 'dev.maka.weather',
      targetPath: '/tmp/weather.maka-extension',
    }),
    {
      extensionId: 'dev.maka.weather',
      targetPath: '/tmp/weather.maka-extension',
    },
  );
  assert.deepEqual(
    decodeExtensionUiSnapshotResult({
      scopeId: 'desktop-ui',
      digest: 'sha256-demo',
      contributions: [
        {
          entryId: 'ui-entry',
          extensionId: 'dev.maka.appearance',
          generation: 2,
          id: 'dev.maka.appearance',
          bundle: 'appearance bundle',
          bundleSha256: 'demo',
          inject: [],
          external: ['dev.maka.theme'],
          tools: ['theme_preview'],
        },
        {
          entryId: 'legacy-overlay-entry',
          extensionId: 'dev.maka.legacy-overlay',
          generation: 1,
          id: 'dev.maka.legacy-overlay',
          bundle: 'legacy bundle',
          bundleSha256: 'legacy-demo',
          inject: ['dev.maka.appearance'],
          external: [],
          tools: [],
        },
      ],
    }),
    {
      scopeId: 'desktop-ui',
      digest: 'sha256-demo',
      contributions: [
        {
          entryId: 'ui-entry',
          extensionId: 'dev.maka.appearance',
          generation: 2,
          id: 'dev.maka.appearance',
          bundle: 'appearance bundle',
          bundleSha256: 'demo',
          inject: [],
          external: ['dev.maka.theme'],
          tools: ['theme_preview'],
        },
        {
          entryId: 'legacy-overlay-entry',
          extensionId: 'dev.maka.legacy-overlay',
          generation: 1,
          id: 'dev.maka.legacy-overlay',
          bundle: 'legacy bundle',
          bundleSha256: 'legacy-demo',
          inject: ['dev.maka.appearance'],
          external: [],
          tools: [],
        },
      ],
    },
  );
  assert.deepEqual(
    decodeExtensionCompositionQueryResult({
      extensions: [
        {
          extensionId: 'dev.maka.weather',
          toolNames: ['Weather'],
          uiContributionIds: [],
          eventContributionIds: [],
        },
      ],
      entries: [
        {
          entryId: 'weather-entry',
          scopeId: 'session:1',
          extensionId: 'dev.maka.weather',
          generation: 2,
          enabled: true,
          status: 'active',
          error: null,
        },
      ],
    }),
    {
      extensions: [
        {
          extensionId: 'dev.maka.weather',
          toolNames: ['Weather'],
          uiContributionIds: [],
          eventContributionIds: [],
        },
      ],
      entries: [
        {
          entryId: 'weather-entry',
          scopeId: 'session:1',
          extensionId: 'dev.maka.weather',
          generation: 2,
          enabled: true,
          status: 'active',
          error: null,
        },
      ],
    },
  );

  assert.throws(
    () =>
      decodeExtensionCompositionMutateInput({
        kind: 'enable',
        entryId: 'weather-entry',
        scopeId: 'session-1',
        extensionId: 'weather',
        modulePath: '/tmp/untrusted.mjs',
      }),
    /Unknown extension enable input field/,
  );
  assert.throws(
    () =>
      decodeExtensionCompositionMutateInput({
        kind: 'reload',
        entryId: 'weather-entry',
        extra: true,
      }),
    /Unknown extension reload input field/,
  );
  assert.deepEqual(decodeToolPackageInstallInput({ sourcePath: '/tmp/weather-tool' }), {
    sourcePath: '/tmp/weather-tool',
  });
  assert.deepEqual(
    decodeToolPackageUninstallInput({
      extensionId: 'weather',
    }),
    { extensionId: 'weather' },
  );
  assert.deepEqual(
    decodeExtensionClientToolInvokeInput({
      entryId: 'desktop-entry',
      extensionId: 'dev.maka.canvas',
      generation: 2,
      id: 'dev.maka.canvas',
      sessionId: 'session-one',
      toolName: 'designer_get',
      args: {},
    }),
    {
      entryId: 'desktop-entry',
      extensionId: 'dev.maka.canvas',
      generation: 2,
      id: 'dev.maka.canvas',
      sessionId: 'session-one',
      toolName: 'designer_get',
      args: {},
    },
  );
  assert.throws(
    () => decodeToolPackageInstallInput({ sourcePath: '/tmp/weather-tool', source: 'inline' }),
    /Unknown Tool package install input field/u,
  );
  assert.equal(operationAllowsRemoteOwner('extension.composition.query'), false);
  assert.equal(operationAllowsRemoteOwner('extension.composition.mutate'), false);
  assert.equal(operationAllowsRemoteOwner('extension.ui.snapshot'), false);
  assert.equal(operationAllowsRemoteOwner('extension.client.tool.invoke'), false);
  assert.equal(operationAllowsRemoteOwner('extension.package.install'), false);
  assert.equal(operationAllowsRemoteOwner('extension.package.uninstall'), false);
  assert.equal(operationAllowsRemoteOwner('extension.package.export'), false);
  assert.equal(operationAllowsRemoteOwner('extension.configuration.mutate'), false);
});

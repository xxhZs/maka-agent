import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { EXTENSION_UI_AGENT_RPC_METHOD } from '../protocol/index.js';
import { HostExtensionController } from '../server/extension-controller.js';
import {
  InstalledPluginPackageLoader,
  StaticTrustedToolExtensionLoader,
} from '../server/extension-loader.js';
import { HostExtensionRuntime } from '../server/extension-runtime.js';
import { HostPluginCompositionStore } from '../server/plugin-composition-store.js';
import { PluginPackageStore } from '../server/plugin-package-store.js';
import type { ConnectionContext } from '../server/operation-dispatcher.js';

const connection: ConnectionContext = {
  hostEpoch: 'ui-agent-bridge-test',
  connectionId: 'local-owner',
  surface: 'desktop',
  principal: 'local_os_user',
  acquireResidency: () => ({ release: () => undefined }),
};

test('admitted workspace UI Agent bridge invokes the shared Host Agent Runtime', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-ui-agent-bridge-'));
  const source = join(root, 'source');
  const control = join(root, 'control');
  const packages = new PluginPackageStore(control);
  const runtime = new HostExtensionRuntime();
  const controller = new HostExtensionController(
    runtime,
    new InstalledPluginPackageLoader(new StaticTrustedToolExtensionLoader(), packages),
    new HostPluginCompositionStore(control),
    () => assert.fail('UI Agent bridge failures must not drain the Host'),
    undefined,
    packages,
  );
  const calls: unknown[] = [];
  controller.registerAgentProvider({
    invoke: async (method, input, context) => {
      calls.push({ method, input, extensionId: context.callerExtensionId, cwd: context.cwd });
      return [{ id: 'agent-1' }];
    },
    observe: () => () => undefined,
  });

  try {
    await writeUiPackage(source, true, 'workspace.main');
    await controller.recover();
    const installed = await controller.handlers['extension.package.install'](
      { sourcePath: source },
      connection,
    );
    assert.equal(installed.ok, true, JSON.stringify(installed));
    const enabled = await controller.handlers['extension.composition.mutate'](
      {
        kind: 'enable',
        entryId: 'dashboard-entry',
        scopeId: 'desktop-ui',
        extensionId: 'dev.maka.dashboard',
      },
      connection,
    );
    assert.equal(enabled.ok, true, JSON.stringify(enabled));
    const generation = enabled.ok ? enabled.result.entry?.generation : undefined;
    assert.equal(typeof generation, 'number');

    const result = await controller.handlers['extension.ui.rpc.invoke'](
      {
        scopeId: 'desktop-ui',
        entryId: 'dashboard-entry',
        extensionId: 'dev.maka.dashboard',
        generation: generation!,
        method: EXTENSION_UI_AGENT_RPC_METHOD,
        args: { method: 'list', input: {} },
      },
      connection,
    );
    assert.deepEqual(result, { ok: true, result: { value: [{ id: 'agent-1' }] } });
    assert.deepEqual(calls, [
      {
        method: 'list',
        input: {},
        extensionId: 'dev.maka.dashboard',
        cwd: join(packages.root, 'dev.maka.dashboard'),
      },
    ]);
  } finally {
    await runtime.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test('UI Agent bridge requires the existing Session access permission', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-ui-agent-denied-'));
  const source = join(root, 'source');
  const control = join(root, 'control');
  const packages = new PluginPackageStore(control);
  const runtime = new HostExtensionRuntime();
  const controller = new HostExtensionController(
    runtime,
    new InstalledPluginPackageLoader(new StaticTrustedToolExtensionLoader(), packages),
    new HostPluginCompositionStore(control),
    () => assert.fail('denied UI Agent requests must not drain the Host'),
    undefined,
    packages,
  );
  controller.registerAgentProvider({
    invoke: async () => assert.fail('denied UI request reached the Agent Runtime'),
    observe: () => () => undefined,
  });

  try {
    await writeUiPackage(source, false);
    await controller.recover();
    const installed = await controller.handlers['extension.package.install'](
      { sourcePath: source },
      connection,
    );
    assert.equal(installed.ok, true, JSON.stringify(installed));
    const enabled = await controller.handlers['extension.composition.mutate'](
      {
        kind: 'enable',
        entryId: 'dashboard-entry',
        scopeId: 'desktop-ui',
        extensionId: 'dev.maka.dashboard',
      },
      connection,
    );
    assert.equal(enabled.ok, true, JSON.stringify(enabled));
    const generation = enabled.ok ? enabled.result.entry?.generation : undefined;
    assert.equal(typeof generation, 'number');
    const result = await controller.handlers['extension.ui.rpc.invoke'](
      {
        scopeId: 'desktop-ui',
        entryId: 'dashboard-entry',
        extensionId: 'dev.maka.dashboard',
        generation: generation!,
        method: EXTENSION_UI_AGENT_RPC_METHOD,
        args: { method: 'list', input: {} },
      },
      connection,
    );
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.error.code, 'invalid_request');
    assert.match(!result.ok ? result.error.message : '', /Session access permission/u);
  } finally {
    await runtime.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

async function writeUiPackage(
  source: string,
  sessionAccess: boolean,
  slot?: 'workspace.main',
): Promise<void> {
  await mkdir(source, { recursive: true });
  await writeFile(join(source, 'dashboard.html'), '<!doctype html><main>Dashboard</main>');
  await writeFile(
    join(source, 'maka.extension.json'),
    JSON.stringify({
      schemaVersion: 1,
      id: 'dev.maka.dashboard',
      ui: {
        contributions: [
          {
            id: 'dashboard',
            surface: slot ? 'app.slot' : 'app.root',
            ...(slot ? { slot } : {}),
            priority: 10,
            document: 'dashboard.html',
          },
        ],
        permissions: { network: false, hostState: false, sessionAccess },
      },
    }),
  );
}

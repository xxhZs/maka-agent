import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { MakaTool } from '@maka/runtime/tool-runtime';
import { Context } from '@maka/runtime/plugin-kernel';
import { PluginSystemPromptService } from '@maka/runtime/plugin-system-prompt-service';
import { HostExtensionController } from '../server/extension-controller.js';
import {
  InstalledPluginPackageLoader,
  StaticTrustedToolExtensionLoader,
} from '../server/extension-loader.js';
import { HostExtensionRuntime } from '../server/extension-runtime.js';
import { HostPluginCompositionStore } from '../server/plugin-composition-store.js';
import { PluginPackageStore } from '../server/plugin-package-store.js';
import { InProcessPackageActivation } from '../server/in-process-package-runtime.js';
import type { ConnectionContext } from '../server/operation-dispatcher.js';

const connection: ConnectionContext = {
  hostEpoch: 'tool-package-system-test',
  connectionId: 'local-owner',
  surface: 'desktop',
  principal: 'local_os_user',
  acquireResidency: () => ({ release: () => undefined }),
};

test('real Tool package installs, runs in process, updates, drains, and uninstalls', {
  timeout: 60_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-tool-package-'));
  const control = join(root, 'control');
  const workspace = join(root, 'workspace');
  await mkdir(workspace, { recursive: true });
  const packageV1 = await createPackage(root, 'v1', 21);
  const packageV2 = await createPackage(root, 'v2', 27);
  const packageStore = new PluginPackageStore(control);
  const loader = new InstalledPluginPackageLoader(
    new StaticTrustedToolExtensionLoader(),
    packageStore,
  );
  const runtime = new HostExtensionRuntime();
  const controller = new HostExtensionController(
    runtime,
    loader,
    new HostPluginCompositionStore(control),
    () => assert.fail('deterministic Tool package failures must not drain the Host'),
  );

  try {
    await controller.recover();
    const installedV1 = await controller.handlers['extension.package.install'](
      { sourcePath: packageV1 },
      connection,
    );
    assert.equal(installedV1.ok, true);
    assert.deepEqual(installedV1.ok && installedV1.result.toolNames, ['Weather']);

    const enabled = await controller.handlers['extension.composition.mutate'](
      {
        kind: 'enable',
        entryId: 'weather-entry',
        scopeId: 'session-1',
        extensionId: 'weather',
      },
      connection,
    );
    assert.equal(enabled.ok, true, JSON.stringify(enabled));
    assert.equal(enabled.ok && enabled.result.entry?.status, 'active');
    assert.deepEqual(await invoke(runtime, workspace, 'v1'), {
      label: 'v1',
      temperature: 21,
      location: 'Shanghai',
    });
    assert.equal(await readFile(join(workspace, 'weather-v1.txt'), 'utf8'), 'Shanghai\n');

    let startedSlow: (() => void) | undefined;
    const slowStarted = new Promise<void>((resolve) => {
      startedSlow = resolve;
    });
    const oldTool = runtime.resolveTools('session-1', []).find(({ name }) => name === 'Weather');
    assert.ok(oldTool);
    const oldInvocation = oldTool.impl(
      { location: 'Ningbo', delayMs: 500 },
      {
        ...invocationContext(workspace),
        toolCallId: 'slow-old-call',
        emitOutput: () => startedSlow?.(),
      },
    );
    await slowStarted;
    const installedV2 = await controller.handlers['extension.package.install'](
      { sourcePath: packageV2 },
      connection,
    );
    assert.equal(installedV2.ok, true);
    const firstGeneration = runtime.inspect('weather-entry').current?.generation ?? 0;
    const upgradeTask = controller.handlers['extension.composition.mutate'](
      { kind: 'reload', entryId: 'weather-entry' },
      connection,
    );
    await waitForGeneration(runtime, firstGeneration);
    assert.deepEqual(await invoke(runtime, workspace, 'v2-during-drain', 'v2'), {
      label: 'v2',
      temperature: 27,
      location: 'Shanghai',
    });
    assert.deepEqual(await oldInvocation, {
      label: 'v1',
      temperature: 21,
      location: 'Ningbo',
    });
    const upgraded = await upgradeTask;
    assert.equal(upgraded.ok, true);
    assert.deepEqual(await invoke(runtime, workspace, 'v2'), {
      label: 'v2',
      temperature: 27,
      location: 'Shanghai',
    });

    const retained = await controller.handlers['extension.package.uninstall'](
      { extensionId: 'weather' },
      connection,
    );
    assert.equal(retained.ok, false);
    assert.equal(!retained.ok && retained.error.code, 'operation_conflict');

    assert.deepEqual(
      await controller.handlers['extension.composition.mutate'](
        { kind: 'remove', entryId: 'weather-entry' },
        connection,
      ),
      { ok: true, result: { entry: null } },
    );
    assert.deepEqual(
      await controller.handlers['extension.package.uninstall'](
        { extensionId: 'weather' },
        connection,
      ),
      { ok: true, result: {} },
    );
    assert.deepEqual(await packageStore.list(), []);
    assert.deepEqual(await controller.handlers['extension.composition.query']({}, connection), {
      ok: true,
      result: { extensions: [], entries: [] },
    });
  } finally {
    await runtime.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test('Tool package install rejects traversal, unknown fields, and missing entries', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-tool-package-invalid-'));
  const source = join(root, 'source');
  const store = new PluginPackageStore(join(root, 'control'));
  try {
    await mkdir(source, { recursive: true });
    await writeFile(
      join(source, 'maka.extension.json'),
      JSON.stringify({
        schemaVersion: 1,
        id: 'invalid',
        runtime: {
          entry: '../escape.mjs',
          tools: [toolManifest()],
          events: [],
          listeners: [],
          services: [],
          timers: [],
          permissions: { workspace: 'none', network: false },
        },
      }),
    );
    await assert.rejects(store.install(source), /entry is invalid/u);

    await writeFile(
      join(source, 'maka.extension.json'),
      JSON.stringify({
        schemaVersion: 1,
        id: 'invalid',
        runtime: {
          entry: 'dist/missing.mjs',
          tools: [toolManifest()],
          events: [],
          listeners: [],
          services: [],
          timers: [],
          permissions: { workspace: 'none', network: false },
          unexpected: true,
        },
      }),
    );
    await assert.rejects(store.install(source), /unknown fields/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Tool package Store resolves the current Extension directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-tool-package-corrupt-'));
  const source = await createPackage(root, 'sealed', 42);
  const store = new PluginPackageStore(join(root, 'control'));
  try {
    const installed = await store.install(source);
    assert.ok(installed.toolManifest);
    await writeFile(
      join(installed.root, installed.toolManifest.entry),
      'export default {};\n',
      'utf8',
    );
    assert.equal((await store.load(installed.extensionId)).extensionId, installed.extensionId);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('trusted Tool activation shares in-process state, host network, and cancellation', {
  timeout: 30_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-tool-in-process-'));
  const source = join(root, 'source');
  const store = new PluginPackageStore(join(root, 'control'));
  let networkRequests = 0;
  const server = createServer((_request, response) => {
    networkRequests += 1;
    response.end('trusted-host-network');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  try {
    process.env.MAKA_TEST_PLUGIN_SECRET = 'visible-to-trusted-plugin';
    await createTrustedPackage(source, `http://127.0.0.1:${address.port}/allowed`);
    const sealed = await store.install(source);
    const installed = await store.loadTool(sealed.extensionId);
    const activation = new InProcessPackageActivation(installed);
    try {
      await activation.healthCheck(installed.manifest.tools.map(({ handler }) => handler));
      const tools = new Map(activation.tools().map((tool) => [tool.name, tool]));
      const context = invocationContext(root);

      assert.deepEqual(await tools.get('Identity')?.impl({}, context), {
        pid: process.pid,
        secret: 'visible-to-trusted-plugin',
      });
      assert.deepEqual(await tools.get('Counter')?.impl({}, context), { value: 1 });
      assert.deepEqual(await tools.get('Counter')?.impl({}, context), { value: 2 });
      assert.deepEqual(await tools.get('Network')?.impl({}, context), {
        body: 'trusted-host-network',
      });
      assert.equal(networkRequests, 1);

      const abort = new AbortController();
      const hanging = tools.get('Hang')?.impl({}, { ...context, abortSignal: abort.signal });
      setTimeout(() => abort.abort(new Error('test abort')), 50).unref();
      await assert.rejects(async () => await hanging, /test abort|aborted/u);
    } finally {
      await activation.dispose();
    }
  } finally {
    delete process.env.MAKA_TEST_PLUGIN_SECRET;
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(root, { recursive: true, force: true });
  }
});

test('Host Agent Runtime is injected independently from Extension contributions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-tool-agent-runtime-'));
  const source = join(root, 'source');
  const store = new PluginPackageStore(join(root, 'control'));
  try {
    await createAgentRuntimePackage(source);
    const sealed = await store.install(source);
    const installed = await store.loadTool(sealed.extensionId);
    const calls: unknown[] = [];
    const activation = new InProcessPackageActivation(
      installed,
      Object.freeze({}),
      undefined,
      undefined,
      {
        invoke: async (method, input, context) => {
          calls.push({ kind: method, input, extensionId: context.callerExtensionId });
          if (method === 'run') {
            return { sessionId: 'agent-session', turnId: 'agent-turn', runId: 'agent-run' };
          }
          if (method === 'create' || method === 'resume' || method === 'get') {
            return {
              id: 'owned-agent',
              sessionId: 'owned-agent',
              ownerExtensionId: context.callerExtensionId,
              root: true,
            };
          }
          if (method === 'list' || method === 'catalog' || method === 'roots') {
            return [{ id: 'owned-agent' }];
          }
          if (method === 'stop') return { status: 'cancelled' };
          return { method };
        },
        observe: () => () => undefined,
      },
    );
    try {
      const tool = activation.tools().find(({ name }) => name === 'AgentControl');
      assert.ok(tool);
      assert.deepEqual(await tool.impl({ action: 'run' }, invocationContext(root)), {
        sessionId: 'agent-session',
        turnId: 'agent-turn',
        runId: 'agent-run',
      });
      assert.deepEqual(await tool.impl({ action: 'stop' }, invocationContext(root)), {
        status: 'cancelled',
      });
      const surface = activation.tools().find(({ name }) => name === 'AgentSurface');
      assert.ok(surface);
      assert.deepEqual(await surface.impl({}, invocationContext(root)), {
        create: 'owned-agent',
        resume: 'owned-agent',
        get: 'owned-agent',
        list: [{ id: 'owned-agent' }],
        catalog: [{ id: 'owned-agent' }],
        roots: [{ id: 'owned-agent' }],
        initiator: 'fault-session',
        requiredInitiator: 'fault-turn',
      });
      assert.deepEqual(calls.slice(0, 2), [
        {
          kind: 'run',
          input: { prompt: 'Review the workspace', maxSteps: 4 },
          extensionId: 'agent-runtime-test',
        },
        {
          kind: 'stop',
          input: { sessionId: 'agent-session', turnId: 'agent-turn', runId: 'agent-run' },
          extensionId: 'agent-runtime-test',
        },
      ]);
      assert.deepEqual(
        calls.slice(2).map((call) => (call as { kind: string }).kind),
        [
          'create',
          'resume',
          'get',
          'agent.followup',
          'agent.steer',
          'agent.cancel',
          'agent.whenIdle',
          'agent.retract',
          'agent.receipt',
          'agent.status',
          'agent.session',
          'agent.options',
          'agent.inbox',
          'agent.events',
          'agent.result',
          'agent.artifacts',
          'agent.usage',
          'agent.transcript',
          'list',
          'catalog',
          'roots',
        ],
      );
    } finally {
      await activation.dispose();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('trusted package activate() receives the scoped Context and owns Service cleanup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-tool-context-'));
  const source = join(root, 'source');
  const store = new PluginPackageStore(join(root, 'control'));
  try {
    await createContextActivationPackage(source);
    const sealed = await store.install(source);
    const installed = await store.loadTool(sealed.extensionId);
    const context = new Context();
    new PluginSystemPromptService(context);
    const activation = new InProcessPackageActivation(
      installed,
      Object.freeze({}),
      undefined,
      undefined,
      undefined,
      context,
    );
    await activation.healthCheck(installed.manifest.tools.map(({ handler }) => handler));
    assert.deepEqual(
      await context.systemPrompt.render('system', {
        sessionId: 'session-1',
        turnId: 'turn-1',
        cwd: root,
      }),
      ['activated:session-1'],
    );
    await activation.dispose();
    assert.deepEqual(context.systemPrompt.inspect(), []);
    await context.fiber.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function createPackage(root: string, label: string, temperature: number): Promise<string> {
  const source = join(root, `source-${label}`);
  await mkdir(join(source, 'dist'), { recursive: true });
  await writeFile(
    join(source, 'maka.extension.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        id: 'weather',
        runtime: {
          entry: 'dist/index.mjs',
          tools: [toolManifest()],
          events: [],
          listeners: [],
          services: [],
          timers: [],
          permissions: { workspace: 'write', network: false },
        },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    join(source, 'dist', 'index.mjs'),
    `import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
export default {
  Weather: async (args, context) => {
    context.emitOutput('stdout', 'weather:${label}');
    if (args.delayMs) await new Promise((resolve) => setTimeout(resolve, args.delayMs));
    await appendFile(join(context.cwd, 'weather-${label}.txt'), args.location + '\\n', 'utf8');
    return { label: ${JSON.stringify(label)}, temperature: ${temperature}, location: args.location };
  },
};
`,
  );
  return source;
}

function toolManifest(): Record<string, unknown> {
  return {
    name: 'Weather',
    description: 'Read the test weather',
    handler: 'Weather',
    inputSchema: {
      type: 'object',
      properties: {
        location: { type: 'string' },
        delayMs: { type: 'number', minimum: 0, maximum: 10_000 },
      },
      required: ['location'],
      additionalProperties: false,
    },
    displayName: 'Weather',
    category: 'file_write',
    recoveryMode: 'never_auto_retry',
  };
}

async function createTrustedPackage(source: string, allowedUrl: string): Promise<void> {
  await mkdir(join(source, 'dist'), { recursive: true });
  const declaration = (name: string): Record<string, unknown> => ({
    name,
    description: `Exercise ${name}`,
    handler: name,
    inputSchema: { type: 'object', additionalProperties: true },
    category: 'shell_unsafe',
    recoveryMode: 'never_auto_retry',
  });
  await writeFile(
    join(source, 'maka.extension.json'),
    JSON.stringify({
      schemaVersion: 1,
      id: 'trusted-runtime',
      runtime: {
        entry: 'dist/index.mjs',
        tools: ['Identity', 'Counter', 'Network', 'Hang'].map(declaration),
        events: [],
        listeners: [],
        services: [],
        timers: [],
        permissions: { workspace: 'none', network: true },
      },
    }),
  );
  await writeFile(
    join(source, 'dist', 'index.mjs'),
    `let calls = 0;
export default {
  Identity: () => ({ pid: process.pid, secret: process.env.MAKA_TEST_PLUGIN_SECRET }),
  Counter: () => ({ value: ++calls }),
  Network: async () => ({ body: await (await fetch(${JSON.stringify(allowedUrl)})).text() }),
  Hang: async (_args, context) => await new Promise((_resolve, reject) => context.abortSignal.addEventListener('abort', () => reject(context.abortSignal.reason), { once: true })),
};
`,
  );
}

async function createAgentRuntimePackage(source: string): Promise<void> {
  await mkdir(join(source, 'dist'), { recursive: true });
  await writeFile(
    join(source, 'maka.extension.json'),
    JSON.stringify({
      schemaVersion: 1,
      id: 'agent-runtime-test',
      runtime: {
        entry: 'dist/index.mjs',
        tools: [
          {
            name: 'AgentControl',
            description: 'Exercise the Host Agent Runtime',
            handler: 'AgentControl',
            inputSchema: { type: 'object', additionalProperties: true },
            recoveryMode: 'never_auto_retry',
          },
          {
            name: 'AgentSurface',
            description: 'Exercise the complete Host Agent control surface',
            handler: 'AgentSurface',
            inputSchema: { type: 'object', additionalProperties: true },
            recoveryMode: 'never_auto_retry',
          },
        ],
        events: [],
        listeners: [],
        services: [],
        timers: [],
        permissions: { workspace: 'none', network: false },
      },
    }),
  );
  await writeFile(
    join(source, 'dist', 'index.mjs'),
    `export default {
  AgentControl: (args, context) => args.action === 'run'
    ? context.agents.run({ prompt: 'Review the workspace', maxSteps: 4 })
    : context.agents.stop({ sessionId: 'agent-session', turnId: 'agent-turn', runId: 'agent-run' }),
  AgentSurface: async (_args, context) => {
    const created = await context.agents.create({ id: 'owned-agent', prompt: 'create' });
    const resumed = await context.agents.resume({ sessionId: 'owned-agent' });
    const found = await context.agents.get('owned-agent');
    const stopObserving = created.observe(() => undefined);
    await created.followup({ content: 'followup', messageId: 'followup-1' });
    await created.steer('steer');
    await created.cancel();
    await created.whenIdle();
    await created.retract({ retractId: 'retract-1' });
    await created.receipt({ messageId: 'followup-1' });
    await created.status();
    await created.session();
    await created.options();
    await created.inbox();
    await created.events();
    await created.result();
    await created.artifacts();
    await created.usage();
    await created.transcript();
    stopObserving();
    return {
      create: created.id,
      resume: resumed.id,
      get: found?.id,
      list: await context.agents.list(),
      catalog: await context.agents.catalog(),
      roots: await context.agents.roots(),
      initiator: context.agents.currentInitiator().sessionId,
      requiredInitiator: context.agents.requireInitiator().turnId,
    };
  },
};
`,
  );
}

async function createContextActivationPackage(source: string): Promise<void> {
  await mkdir(join(source, 'dist'), { recursive: true });
  await writeFile(
    join(source, 'maka.extension.json'),
    JSON.stringify({
      schemaVersion: 1,
      id: 'context-activation-test',
      runtime: {
        entry: 'dist/index.mjs',
        tools: [
          {
            name: 'Noop',
            description: 'Trigger module activation',
            handler: 'Noop',
            inputSchema: { type: 'object', additionalProperties: false },
            recoveryMode: 'never_auto_retry',
          },
        ],
        events: [],
        listeners: [],
        services: [],
        timers: [],
        permissions: { workspace: 'none', network: false },
      },
    }),
  );
  await writeFile(
    join(source, 'dist', 'index.mjs'),
    `export function activate(context) {
  return context.systemPrompt.register({
    id: 'fixture.activated',
    render: ({ sessionId }) => 'activated:' + sessionId,
  });
}
export default { Noop: () => ({ ok: true }) };
`,
  );
}

function invocationContext(cwd: string): Parameters<MakaTool['impl']>[1] {
  return {
    sessionId: 'fault-session',
    turnId: 'fault-turn',
    cwd,
    toolCallId: 'fault-call',
    abortSignal: new AbortController().signal,
    emitOutput: () => undefined,
    askUserQuestion: async () => ({ answers: [] }),
  };
}

async function waitForGeneration(runtime: HostExtensionRuntime, previous: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if ((runtime.inspect('weather-entry').current?.generation ?? 0) > previous) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`Tool Fiber generation did not advance beyond ${previous}`);
}

async function invoke(
  runtime: HostExtensionRuntime,
  workspace: string,
  label: string,
  expectedRevisionLabel = label,
): Promise<unknown> {
  const tool = runtime.resolveTools('session-1', []).find(({ name }) => name === 'Weather');
  assert.ok(tool);
  const output: string[] = [];
  const result = await tool.impl(
    { location: 'Shanghai' },
    {
      sessionId: 'session-1',
      runId: `run-${label}`,
      turnId: `turn-${label}`,
      cwd: workspace,
      toolCallId: `call-${label}`,
      abortSignal: new AbortController().signal,
      emitOutput: (_stream, chunk) => output.push(chunk),
      askUserQuestion: async () => ({ answers: [] }),
    },
  );
  assert.deepEqual(output, [`weather:${expectedRevisionLabel}`]);
  return result;
}

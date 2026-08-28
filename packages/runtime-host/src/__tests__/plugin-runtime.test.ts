import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';
import { HostExtensionRuntime } from '../server/extension-runtime.js';
import type { PackageAgentRuntime } from '../server/in-process-package-runtime.js';

test('one Cordis package owns Tool, UI, and Hook contributions together', async () => {
  const runtime = new HostExtensionRuntime();
  const observed: unknown[] = [];
  await runtime.installTool({
    extensionId: 'fixture.combined',
    toolNames: ['fixture_combined'],
    ui: [
      {
        id: 'fixture.combined',
        bundle: 'window.__MakaModuleLoader__.load({id:"fixture.combined",factory:()=>({})});',
        inject: [],
        external: [],
      },
    ],
    eventContributionIds: ['fixture.combined.changed', 'capture'],
    load: async () => ({
      tools: [
        {
          name: 'fixture_combined',
          description: 'fixture',
          parameters: z.object({ value: z.number() }),
          impl: async ({ value }: { value: number }) => value + 1,
        },
      ],
      events: [
        {
          name: 'fixture.combined.changed',
          description: 'fixture changed',
          payloadSchema: {
            type: 'object',
            properties: { value: { type: 'number' } },
            required: ['value'],
          },
        },
      ],
      listeners: [
        {
          id: 'capture',
          event: 'fixture.combined.changed',
          handler: 'capture',
          priority: 0,
          timeoutMs: 1_000,
          invoke: async (payload: unknown) => {
            observed.push(payload);
          },
        },
      ],
    }),
  });
  await runtime.applyComposition({
    operations: [
      {
        type: 'insert',
        rootId: 'session:session-one',
        entry: { id: 'combined-entry', packageId: 'fixture.combined' },
      },
    ],
  });
  assert.equal(runtime.inspectTools('session-one').length, 1);
  assert.equal(runtime.inspectUi('session-one').length, 1);
  assert.equal(runtime.inspectEvents('session-one').length, 1);
  assert.equal(runtime.inspectEventListeners('session-one').length, 1);
  await runtime.emitEvent(
    'session-one',
    'fixture.combined.changed',
    { value: 3 },
    invocationContext(),
  );
  assert.deepEqual(observed, [{ value: 3 }]);
  await runtime.applyComposition({
    operations: [{ type: 'update', entryId: 'combined-entry', patch: { disabled: true } }],
  });
  assert.equal(runtime.inspectTools('session-one').length, 0);
  assert.equal(runtime.inspectUi('session-one').length, 0);
  assert.equal(runtime.inspectEventListeners('session-one').length, 0);
  await runtime.applyComposition({
    operations: [{ type: 'update', entryId: 'combined-entry', patch: { disabled: false } }],
  });
  assert.equal(runtime.inspectTools('session-one').length, 1);
  assert.equal(runtime.inspectUi('session-one').length, 1);
  assert.equal(runtime.inspectEventListeners('session-one').length, 1);
  await runtime.close();
});

test('failed package reload leaves the current Fiber visible', async () => {
  const runtime = new HostExtensionRuntime();
  await runtime.installTrustedTool({
    extensionId: 'fixture.atomic',
    tools: [
      {
        name: 'fixture_atomic',
        description: 'current',
        parameters: z.object({}),
        impl: async () => 'current',
      },
    ],
  });
  await runtime.applyComposition({
    operations: [
      {
        type: 'insert',
        rootId: 'profile',
        entry: { id: 'atomic-entry', packageId: 'fixture.atomic' },
      },
    ],
  });
  await assert.rejects(
    () =>
      runtime.installTrustedTool({
        extensionId: 'fixture.atomic',
        tools: [],
        healthCheck: () => {
          throw new Error('candidate rejected');
        },
      }),
    /candidate rejected/u,
  );
  assert.equal(runtime.inspect('atomic-entry').current?.generation, 1);
  assert.equal(runtime.inspectTools('profile')[0]?.generation, 1);
  await runtime.close();
});

test('Extension Services use Context/Fiber authority for layered resolution and inspection', async () => {
  const runtime = new HostExtensionRuntime();
  await runtime.installTool({
    extensionId: 'fixture.layered',
    toolNames: [],
    serviceContributionIds: ['fixture.layered.echo'],
    load: async (activation) => ({
      tools: [],
      services: [
        {
          name: 'fixture.layered.echo',
          version: '1',
          description: 'realm echo',
          methods: [
            {
              name: 'read',
              description: 'read realm',
              handler: 'read',
              inputSchema: { type: 'object', additionalProperties: false },
              outputSchema: { type: 'string' },
              timeoutMs: 1_000,
            },
          ],
          invoke: async () => activation.scopeId,
        },
      ],
    }),
  });
  await runtime.applyComposition({
    operations: [
      {
        type: 'insert',
        rootId: 'profile',
        entry: { id: 'layered-profile', packageId: 'fixture.layered' },
      },
      {
        type: 'insert',
        rootId: 'session:a',
        entry: { id: 'layered-session-a', packageId: 'fixture.layered' },
      },
    ],
  });

  assert.equal(
    await runtime.callService('a', 'fixture.layered.echo', 'read', {}, invocationContext()),
    'session:a',
  );
  assert.equal(
    await runtime.callService('b', 'fixture.layered.echo', 'read', {}, invocationContext()),
    'profile',
  );
  assert.equal(runtime.inspectServices('a')[0]?.entryId, 'layered-session-a');
  assert.equal(runtime.inspectServices('b')[0]?.entryId, 'layered-profile');
  const capability = runtime
    .inspectAll()
    .capabilities.find(
      ({ name, scopeId }) => name === 'service:fixture.layered.echo' && scopeId === 'a',
    );
  assert.equal(capability?.role, 'seam');
  assert.equal(capability?.realm.id, 'session:a');
  assert.equal(capability?.provider.realm.id, 'session:a');

  await runtime.applyComposition({
    operations: [{ type: 'remove', entryId: 'layered-session-a' }],
  });
  assert.equal(runtime.inspectServices('a')[0]?.entryId, 'layered-profile');
  await runtime.close();
});

test('Agent create publishes an inspectable Agent Context under its Session Context', async () => {
  const runtime = new HostExtensionRuntime();
  runtime.registerAgentProvider({
    invoke: async (method) => {
      assert.equal(method, 'create');
      return { id: 'agent-one', sessionId: 'child-session' };
    },
    observe: () => () => undefined,
  });
  const agents = runtime.context('parent-session').get<PackageAgentRuntime>('agents');
  assert.ok(agents);
  await agents.invoke(
    'create',
    {},
    {
      sessionId: 'parent-session',
      turnId: 'turn-one',
      cwd: process.cwd(),
      toolCallId: 'tool-one',
      abortSignal: new AbortController().signal,
      callerExtensionId: 'fixture.agent-owner',
    },
  );

  assert.deepEqual(runtime.agentContext('agent-one')?.serviceRealm(), {
    id: 'session:child-session/agent:agent-one',
    kind: 'agent',
    parentId: 'session:child-session',
  });
  assert.ok(
    runtime
      .inspectAll()
      .contexts.some(({ realm }) => realm.id === 'session:child-session/agent:agent-one'),
  );
  const capabilities = runtime.context('parent-session').inspectServices();
  assert.deepEqual(
    capabilities.find(({ name }) => name === 'agentLoop')?.registrations.map(({ id }) => id),
    ['maka.session-turn'],
  );
  assert.deepEqual(
    capabilities
      .find(({ name }) => name === 'agents')
      ?.registrations.map(({ id, realm }) => [id, realm.id]),
    [['agent-one', 'session:child-session/agent:agent-one']],
  );
  await runtime.close();
});

test('Agent execution resolves scoped capabilities and releases their Fiber lifecycle', async () => {
  const runtime = new HostExtensionRuntime();
  const agent = runtime.executionContext('agent-session');
  agent.systemPrompt.register({
    id: 'fixture.agent.prompt',
    render: () => 'AGENT_ONLY',
  });

  assert.deepEqual(
    await runtime.renderSystemPrompt('agent-session', 'system', {
      sessionId: 'agent-session',
      turnId: 'turn-one',
      cwd: process.cwd(),
    }),
    ['AGENT_ONLY'],
  );
  assert.equal(await runtime.releaseAgentContext('agent-session'), true);
  assert.deepEqual(
    await runtime.renderSystemPrompt('agent-session', 'system', {
      sessionId: 'agent-session',
      turnId: 'turn-two',
      cwd: process.cwd(),
    }),
    [],
  );
  await runtime.close();
});

test('Agent extension mounts contribute Tools only to that Agent Context', async () => {
  const runtime = new HostExtensionRuntime();
  await runtime.installTrustedTool({
    extensionId: 'fixture.agent-tools',
    tools: [
      {
        name: 'agent_scoped_tool',
        description: 'agent scoped',
        parameters: z.object({}),
        impl: async () => 'agent',
      },
    ],
  });
  await runtime.mountAgentExtension('agent-session', 'agent-session', {
    id: 'agent-tool-entry',
    packageId: 'fixture.agent-tools',
  });
  assert.deepEqual(
    runtime.resolveTools('agent-session', []).map(({ name }) => name),
    ['agent_scoped_tool'],
  );
  assert.deepEqual(runtime.resolveTools('other-session', []), []);
  assert.equal(
    await runtime.unmountAgentExtension('agent-session', 'agent-session', 'agent-tool-entry'),
    true,
  );
  assert.deepEqual(runtime.resolveTools('agent-session', []), []);
  await runtime.close();
});

function invocationContext() {
  return {
    sessionId: 'session-one',
    turnId: 'turn-one',
    cwd: process.cwd(),
    permissionMode: 'full_access',
    origin: 'host' as const,
    configuration: Object.freeze({}),
    signal: new AbortController().signal,
  };
}

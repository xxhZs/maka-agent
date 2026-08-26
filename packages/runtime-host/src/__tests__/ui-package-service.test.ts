import assert from 'node:assert/strict';
import test from 'node:test';
import type { PackageInvocationContext } from '../server/in-process-package-runtime.js';
import { UiPackageService } from '../server/ui-package-service.js';

test('UI Agent bridge delegates to the shared Package Agent Runtime', async () => {
  const calls: unknown[] = [];
  const service = new UiPackageService();
  service.setAgentRuntime({
    invoke: async (method, input, context) => {
      calls.push({ method, input, context: invocationProjection(context) });
      return method === 'list' ? [{ id: 'agent-1' }] : undefined;
    },
    observe: () => () => undefined,
  });
  const installed = {
    extensionId: 'dev.maka.dashboard',
    root: '/extensions/dashboard',
  } as never;

  assert.deepEqual(
    await service.invokeAgent(
      installed,
      { method: 'list', input: {} },
      new AbortController().signal,
    ),
    [{ id: 'agent-1' }],
  );
  assert.equal(
    await service.invokeAgent(
      installed,
      { method: 'agent.cancel', input: { agentId: 'agent-1' } },
      new AbortController().signal,
    ),
    null,
  );
  assert.deepEqual(calls, [
    {
      method: 'list',
      input: {},
      context: {
        sessionId: 'ui:dev.maka.dashboard',
        turnId: 'ui-agent:list',
        cwd: '/extensions/dashboard',
        toolCallId: 'ui-agent:list',
        callerExtensionId: 'dev.maka.dashboard',
        origin: 'host',
      },
    },
    {
      method: 'agent.cancel',
      input: { agentId: 'agent-1' },
      context: {
        sessionId: 'ui:dev.maka.dashboard',
        turnId: 'ui-agent:agent.cancel',
        cwd: '/extensions/dashboard',
        toolCallId: 'ui-agent:agent.cancel',
        callerExtensionId: 'dev.maka.dashboard',
        origin: 'host',
      },
    },
  ]);
});

test('UI Agent bridge rejects unknown methods before reaching the Runtime', async () => {
  const service = new UiPackageService();
  service.setAgentRuntime({
    invoke: async () => assert.fail('invalid method reached the Agent Runtime'),
    observe: () => () => undefined,
  });
  await assert.rejects(
    service.invokeAgent(
      { extensionId: 'dev.maka.dashboard', root: '/extensions/dashboard' } as never,
      { method: 'session.send', input: {} },
      new AbortController().signal,
    ),
    /UI Agent method is invalid/u,
  );
});

function invocationProjection(
  context: PackageInvocationContext & { readonly callerExtensionId: string },
) {
  return {
    sessionId: context.sessionId,
    turnId: context.turnId,
    cwd: context.cwd,
    toolCallId: context.toolCallId,
    callerExtensionId: context.callerExtensionId,
    origin: context.origin,
  };
}

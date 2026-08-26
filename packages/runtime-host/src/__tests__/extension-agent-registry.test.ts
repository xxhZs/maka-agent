import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentRunHeader } from '@maka/core/agent-run';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import { HostExtensionAgentRegistry } from '../server/extension-agent-registry.js';
import type { PackageInvocationContext } from '../server/in-process-package-runtime.js';

const invocation: PackageInvocationContext & { readonly callerExtensionId: string } = {
  sessionId: 'initiator-session',
  runId: 'initiator-run',
  turnId: 'initiator-turn',
  cwd: '/workspace',
  toolCallId: 'call-1',
  abortSignal: new AbortController().signal,
  callerExtensionId: 'test-extension',
};

test('Extension Agent Registry exposes every low-cost DSH-shaped capability', async () => {
  const createdSessions: unknown[] = [];
  const submittedMessages: Record<string, unknown>[] = [];
  let executionListener:
    | ((value: { sessionId: string; turnId: string; runId: string }) => void)
    | undefined;
  let transcriptListener: ((sessionId: string) => void) | undefined;
  const headers = new Map<string, Record<string, unknown>>();
  const runs = new Map<string, AgentRunHeader>();
  const initialRun = run('owned-agent', 'turn-1', 'run-1', 'running');
  runs.set('owned-agent', initialRun);
  const runtimeEvents: RuntimeEvent[] = [
    {
      id: 'answer-1',
      invocationId: 'invocation-1',
      runId: 'run-1',
      sessionId: 'owned-agent',
      turnId: 'turn-1',
      ts: 10,
      partial: false,
      role: 'model',
      author: 'agent',
      content: { kind: 'text', text: 'final answer' },
    },
  ];
  const registry = new HostExtensionAgentRegistry({
    hostEpoch: 'epoch-1',
    sessions: {
      handlers: {
        'session.create': async (input: Record<string, unknown>) => {
          createdSessions.push(input);
          headers.set(input.sessionId as string, header(input.sessionId as string));
          return { ok: true, result: { session: {} } };
        },
      },
    } as never,
    turns: {
      handlers: {
        'turn.start': async () => ({
          ok: true,
          result: { kind: 'started', turn: turn('owned-agent', 'turn-1', 'run-1', 'running') },
        }),
      },
    } as never,
    turnControl: {
      handlers: {
        'turn.query': async (input: { sessionId: string; turnId: string }) => ({
          ok: true,
          result: turn(input.sessionId, input.turnId, 'run-1', 'running'),
        }),
        'turn.stop': async (input: { sessionId: string; turnId: string; runId: string }) => ({
          ok: true,
          result: turn(input.sessionId, input.turnId, input.runId, 'cancelled'),
        }),
      },
    } as never,
    messages: {
      handlers: {
        'turn.message.submit': async (input: Record<string, unknown>) => {
          submittedMessages.push(input);
          return {
            ok: true,
            result:
              input.placement === 'current_turn'
                ? { disposition: 'steering', queueRevision: 2 }
                : { disposition: 'followup', queueRevision: 3 },
          };
        },
        'queue.retract': async () => ({ ok: true, result: { queueRevision: 4, retracted: [] } }),
      },
      projection: () => ({ hostEpoch: 'epoch-1', queueRevision: 4, steering: [], followup: [] }),
    } as never,
    executions: {
      lookup: async () => undefined,
      read: async (execution: { sessionId: string; turnId: string; runId: string }) =>
        turn(execution.sessionId, execution.turnId, execution.runId, 'running'),
      subscribe: (listener: typeof executionListener) => {
        executionListener = listener;
        return () => {
          executionListener = undefined;
        };
      },
      whenIdle: () => Promise.resolve(),
    } as never,
    stores: {
      sessionStore: {
        readHeaderSnapshot: async (sessionId: string) =>
          headers.get(sessionId) ?? header(sessionId),
        subscribeTranscriptChanges: (listener: typeof transcriptListener) => {
          transcriptListener = listener;
          return () => {
            transcriptListener = undefined;
          };
        },
      },
      agentRunStore: {
        listSessionRuns: async (sessionId: string) =>
          runs.has(sessionId) ? [runs.get(sessionId)!] : [],
        readRun: async (sessionId: string) => runs.get(sessionId) ?? initialRun,
        readEvents: async () => [],
      },
      runtimeEventStore: { readRuntimeEvents: async () => runtimeEvents },
      messageReceiptStore: {
        read: async () => ({
          payload: { placement: 'next_turn' },
          result: { disposition: 'followup' },
        }),
      },
    } as never,
    artifacts: {
      handlers: {
        'artifact.query': async () => ({
          ok: true,
          result: {
            kind: 'page',
            sessionId: 'owned-agent',
            revision: 'sha256:test',
            artifacts: [],
            nextCursor: null,
          },
        }),
      },
    } as never,
    artifactStore: {
      listTurnArtifacts: async () => [
        {
          id: 'artifact-1',
          sessionId: 'owned-agent',
          turnId: 'turn-1',
          createdAt: 1,
          name: 'result.md',
          kind: 'text',
          content: 'result',
          sizeBytes: 6,
          status: 'live',
        },
      ],
    } as never,
    usage: {
      handlers: {
        'usage.query': async () => ({
          ok: true,
          result: {
            kind: 'logs',
            source: 'llm',
            rows: [
              {
                source: 'llm',
                id: 'usage-1',
                ts: 1,
                providerId: 'provider',
                modelId: 'model',
                inputTokens: 10,
                outputTokens: 5,
                cacheMissTokens: 10,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
                reasoningTokens: 0,
                totalTokens: 15,
                costUsd: 0.01,
                costBasis: 'priced',
                latencyMs: 10,
                status: 'success',
                sessionId: 'owned-agent',
                turnId: 'turn-1',
              },
            ],
            offset: 0,
            total: 1,
            nextOffset: null,
            provenance: emptyUsageProvenance(),
          },
        }),
      },
    } as never,
    transcript: {
      readDurablePage: async () => ({
        throughSequence: 1,
        fragments: [
          {
            sequence: 1,
            byteOffset: 0,
            totalBytes: 2,
            payloadDigest: null,
            data: Buffer.from('{}'),
          },
        ],
        rawBytes: 2,
        next: null,
      }),
      readActiveOverlay: async () => [{ id: 'overlay-1', role: 'assistant' }],
    } as never,
    acquireResidency: () => ({ release: () => undefined }) as never,
  });

  const descriptor = await registry.invoke(
    'create',
    {
      id: 'owned-agent',
      prompt: 'start',
      connectionSlug: 'provider',
      model: 'model',
      thinkingLevel: 'high',
      toolProfile: 'headless-coding-v1',
      permissionMode: 'execute',
      collaborationMode: 'agent',
      orchestrationMode: 'default',
      maxSteps: 8,
    },
    invocation,
  );
  assert.equal((descriptor as { id: string }).id, 'owned-agent');
  assert.equal((createdSessions[0] as { sessionId: string }).sessionId, 'owned-agent');
  assert.equal(
    ((await registry.invoke('get', { agentId: 'owned-agent' }, invocation)) as { id: string }).id,
    'owned-agent',
  );
  assert.equal(((await registry.invoke('list', {}, invocation)) as unknown[]).length, 1);
  assert.equal(((await registry.invoke('roots', {}, invocation)) as unknown[]).length, 1);

  await registry.invoke(
    'agent.followup',
    { agentId: 'owned-agent', content: 'next', messageId: 'message-1' },
    invocation,
  );
  await registry.invoke(
    'agent.steer',
    { agentId: 'owned-agent', content: 'now', messageId: 'message-2' },
    invocation,
  );
  assert.deepEqual(
    submittedMessages.map(({ placement }) => placement),
    ['next_turn', 'current_turn'],
  );
  assert.ok(
    await registry.invoke(
      'agent.receipt',
      { agentId: 'owned-agent', messageId: 'message-1' },
      invocation,
    ),
  );
  assert.equal(
    (
      (await registry.invoke('agent.inbox', { agentId: 'owned-agent' }, invocation)) as {
        queueRevision: number;
      }
    ).queueRevision,
    4,
  );
  assert.ok(
    await registry.invoke(
      'agent.retract',
      { agentId: 'owned-agent', retractId: 'retract-1' },
      invocation,
    ),
  );

  const observations: unknown[] = [];
  const disposeObservation = registry.observe(
    { agentId: 'owned-agent' },
    (observation) => observations.push(observation),
    invocation,
  );
  executionListener?.({ sessionId: 'owned-agent', turnId: 'turn-1', runId: 'run-1' });
  transcriptListener?.('owned-agent');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(observations.map((value) => (value as { kind: string }).kind).sort(), [
    'execution_changed',
    'runtime_events',
    'transcript_changed',
  ]);
  disposeObservation();

  assert.ok(await registry.invoke('agent.status', { agentId: 'owned-agent' }, invocation));
  assert.equal(
    (
      (await registry.invoke('agent.session', { agentId: 'owned-agent' }, invocation)) as {
        id: string;
      }
    ).id,
    'owned-agent',
  );
  assert.equal(
    (
      (await registry.invoke('agent.options', { agentId: 'owned-agent' }, invocation)) as {
        model: string;
      }
    ).model,
    'model',
  );
  assert.ok(await registry.invoke('agent.whenIdle', { agentId: 'owned-agent' }, invocation));
  assert.ok(await registry.invoke('agent.cancel', { agentId: 'owned-agent' }, invocation));
  assert.ok(await registry.invoke('agent.events', { agentId: 'owned-agent' }, invocation));
  assert.equal(
    (
      (await registry.invoke('agent.result', { agentId: 'owned-agent' }, invocation)) as {
        text: string;
      }
    ).text,
    'final answer',
  );
  assert.equal(
    (
      (await registry.invoke('agent.artifacts', { agentId: 'owned-agent' }, invocation)) as {
        kind: string;
      }
    ).kind,
    'page',
  );
  assert.equal(
    (
      (await registry.invoke('agent.usage', { agentId: 'owned-agent' }, invocation)) as {
        summary: { totalTokens: number };
      }
    ).summary.totalTokens,
    15,
  );
  assert.equal(
    (
      (await registry.invoke('agent.transcript', { agentId: 'owned-agent' }, invocation)) as {
        overlay: unknown[];
      }
    ).overlay.length,
    1,
  );

  headers.set('resumed-agent', header('resumed-agent'));
  assert.equal(
    (
      (await registry.invoke('resume', { sessionId: 'resumed-agent' }, invocation)) as {
        id: string;
      }
    ).id,
    'resumed-agent',
  );
  assert.equal(((await registry.invoke('list', {}, invocation)) as unknown[]).length, 2);
});

function turn(sessionId: string, turnId: string, runId: string, status: 'running' | 'cancelled') {
  return status === 'cancelled'
    ? {
        sessionId,
        turnId,
        runId,
        status,
        terminalEventId: `terminal-${runId}`,
        abortSource: 'test',
      }
    : { sessionId, turnId, runId, status };
}

function run(
  sessionId: string,
  turnId: string,
  runId: string,
  status: AgentRunHeader['status'],
): AgentRunHeader {
  return {
    sessionId,
    turnId,
    runId,
    status,
    backendKind: 'ai-sdk',
    llmConnectionSlug: 'provider',
    modelId: 'model',
    cwd: '/workspace',
    permissionMode: 'execute',
    createdAt: 1,
    updatedAt: 2,
  };
}

function header(id: string) {
  return {
    id,
    cwd: '/workspace',
    name: id,
    model: 'model',
    llmConnectionSlug: 'provider',
    permissionMode: 'execute',
    status: 'active',
    collaborationMode: 'agent',
    orchestrationMode: 'default',
  };
}

function emptyUsageProvenance() {
  return {
    coverage: {
      legacyRecords: 0,
      canonicalAttempts: 0,
      usageReportedAttempts: 0,
      usagePartialAttempts: 0,
      usageMissingAttempts: 0,
      pendingRepairs: 0,
      unreadableRecords: 0,
      unpricedAttempts: 0,
    },
  };
}

import { randomUUID } from 'node:crypto';
import { isCollaborationMode } from '@maka/core/collaboration';
import { isOrchestrationMode } from '@maka/core/orchestration';
import { isPermissionMode } from '@maka/core/permission';
import { isSessionToolProfile } from '@maka/core/session';
import { isThinkingLevel } from '@maka/core/model-thinking';
import { inspectAgentRunReadModel } from '@maka/runtime/agent-run-inspect';
import type { ExecutionStoresWriter } from '@maka/storage/execution-stores';
import type { InteractiveArtifactStoreWriter } from '@maka/storage/artifact-stores';
import type {
  ArtifactQueryInput,
  SessionCreateInput,
  TurnSnapshot,
  UsageQueryResult,
} from '../protocol/index.js';
import type { HostArtifactCoordinator } from './artifact-coordinator.js';
import type { RuntimeHostResidency } from './host-kernel.js';
import type { HostInteractiveTurnCoordinator } from './interactive-turn-coordinator.js';
import type {
  PackageAgentDescriptor,
  PackageAgentObservation,
  PackageAgentRuntime,
  PackageAgentRuntimeMethod,
  PackageInvocationContext,
} from './in-process-package-runtime.js';
import type { HostMessageCoordinator } from './message-coordinator.js';
import type { RootTurnCoordinator } from './root-turn-coordinator.js';
import type { HostSessionCatalogCoordinator } from './session-catalog-coordinator.js';
import type { SessionTranscriptReader } from './session-transcript-reader.js';
import type { HostTurnControlCoordinator } from './turn-control-coordinator.js';
import type { HostUsagePricingCoordinator } from './usage-pricing-coordinator.js';

type AgentInvocation = PackageInvocationContext & { readonly callerExtensionId: string };

interface AgentRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly ownerExtensionId: string;
  turn?: AgentTurnSnapshot;
}

type AgentTurnSnapshot = Pick<TurnSnapshot, 'sessionId' | 'turnId' | 'runId' | 'status'> & {
  readonly terminalEventId?: string;
  readonly failureClass?: string;
  readonly failureMessage?: string;
  readonly abortSource?: string;
};

export interface HostExtensionAgentRegistryOptions {
  readonly hostEpoch: string;
  readonly sessions: HostSessionCatalogCoordinator;
  readonly turns: HostInteractiveTurnCoordinator;
  readonly turnControl: HostTurnControlCoordinator;
  readonly messages: HostMessageCoordinator;
  readonly executions: Pick<RootTurnCoordinator, 'lookup' | 'read' | 'subscribe' | 'whenIdle'>;
  readonly stores: ExecutionStoresWriter<'interactive'>;
  readonly artifacts: HostArtifactCoordinator;
  readonly artifactStore: InteractiveArtifactStoreWriter;
  readonly usage: HostUsagePricingCoordinator;
  readonly transcript: SessionTranscriptReader;
  readonly acquireResidency: () => RuntimeHostResidency;
}

/** DSH-shaped plugin Agent control plane backed by Maka's Session/Turn authorities. */
export class HostExtensionAgentRegistry implements PackageAgentRuntime {
  readonly #records = new Map<string, AgentRecord>();

  constructor(private readonly options: HostExtensionAgentRegistryOptions) {}

  invoke(
    method: PackageAgentRuntimeMethod,
    input: unknown,
    invocation: AgentInvocation,
  ): Promise<unknown> {
    switch (method) {
      case 'create':
        return this.#create(input, invocation);
      case 'resume':
        return this.#resume(input, invocation);
      case 'get':
        return this.#get(input);
      case 'list':
        return this.#list();
      case 'roots':
        return this.#roots();
      case 'run':
        return this.#run(input, invocation);
      case 'stop':
        return this.#stop(input);
      case 'agent.followup':
        return this.#submit(input, invocation, 'next_turn');
      case 'agent.steer':
        return this.#submit(input, invocation, 'current_turn');
      case 'agent.cancel':
        return this.#cancel(input);
      case 'agent.whenIdle':
        return this.#whenIdle(input, invocation.abortSignal);
      case 'agent.retract':
        return this.#retract(input);
      case 'agent.receipt':
        return this.#receipt(input);
      case 'agent.status':
        return this.#status(input);
      case 'agent.session':
        return this.#session(input);
      case 'agent.options':
        return this.#options(input);
      case 'agent.inbox':
        return this.#inbox(input);
      case 'agent.events':
        return this.#events(input);
      case 'agent.result':
        return this.#result(input);
      case 'agent.artifacts':
        return this.#artifacts(input);
      case 'agent.usage':
        return this.#usage(input);
      case 'agent.transcript':
        return this.#transcript(input);
    }
  }

  observe(
    value: { readonly agentId: string },
    listener: (observation: PackageAgentObservation) => void,
    _invocation: AgentInvocation,
  ): () => void {
    const record = this.#requireRecord(value);
    const seenRuntimeEventIds = new Set<string>();
    let active = true;
    let runtimeEventTail = Promise.resolve();
    const publishRuntimeEvents = (): void => {
      runtimeEventTail = runtimeEventTail
        .then(async () => {
          if (!active) return;
          const run = await this.#resolveRun(record, undefined);
          if (!run) return;
          const events = await this.options.stores.runtimeEventStore.readRuntimeEvents(
            record.sessionId,
            run.runId,
          );
          const inserted = events.filter((event) => !seenRuntimeEventIds.has(event.id));
          for (const event of inserted) seenRuntimeEventIds.add(event.id);
          if (inserted.length > 0 && active) {
            safeNotify(listener, {
              kind: 'runtime_events',
              agentId: record.id,
              runId: run.runId,
              events: clone(inserted),
            });
          }
        })
        .catch(() => undefined);
    };
    const execution = this.options.executions.subscribe((changed) => {
      if (changed.sessionId !== record.sessionId) return;
      void this.options.executions.read(changed).then(
        (snapshot) => {
          record.turn = snapshot;
          safeNotify(listener, {
            kind: 'execution_changed',
            agentId: record.id,
            execution: clone(snapshot),
          });
          publishRuntimeEvents();
        },
        () => undefined,
      );
    });
    const transcript = this.options.stores.sessionStore.subscribeTranscriptChanges((sessionId) => {
      if (sessionId === record.sessionId) {
        safeNotify(listener, { kind: 'transcript_changed', agentId: record.id });
        publishRuntimeEvents();
      }
    });
    return once(() => {
      active = false;
      execution();
      transcript();
    });
  }

  async #create(value: unknown, invocation: AgentInvocation): Promise<PackageAgentDescriptor> {
    const input = createInput(value, invocation.cwd);
    const sessionId = input.sessionId ?? randomUUID();
    const operationContext = this.#operationContext(invocation);
    const created = await this.options.sessions.handlers['session.create'](
      {
        sessionId,
        workspace: { kind: 'host_path', path: input.cwd },
        modelTarget: input.modelTarget,
        ...(input.name ? { name: input.name } : {}),
        ...(input.thinkingLevel ? { thinkingLevel: input.thinkingLevel } : {}),
        ...(input.toolProfile ? { toolProfile: input.toolProfile } : {}),
        ...(input.permissionMode ? { permissionMode: input.permissionMode } : {}),
        ...(input.collaborationMode ? { collaborationMode: input.collaborationMode } : {}),
        ...(input.orchestrationMode ? { orchestrationMode: input.orchestrationMode } : {}),
      },
      operationContext,
    );
    if (!created.ok) throw new Error(created.error.message);
    const turnId = randomUUID();
    const started = await this.options.turns.handlers['turn.start'](
      {
        sessionId,
        turnId,
        content: { text: input.prompt },
        ...(input.maxSteps === undefined ? {} : { maxSteps: input.maxSteps }),
      },
      operationContext,
    );
    if (!started.ok) throw new Error(started.error.message);
    if (started.result.kind !== 'started') throw new Error('Maka Agent did not start a Turn');
    const record: AgentRecord = {
      id: sessionId,
      sessionId,
      ownerExtensionId: invocation.callerExtensionId,
      turn: started.result.turn,
    };
    this.#records.set(record.id, record);
    return this.#descriptor(record);
  }

  async #resume(value: unknown, invocation: AgentInvocation): Promise<PackageAgentDescriptor> {
    const input = object(value, 'agents.resume input');
    exactKeys(input, ['id', 'sessionId', 'prompt'], 'agents.resume input');
    const sessionId = entityId(input.sessionId ?? input.id, 'agents.resume sessionId');
    const header = await this.options.stores.sessionStore.readHeaderSnapshot(sessionId);
    let record = this.#records.get(sessionId);
    if (!record) {
      record = {
        id: sessionId,
        sessionId,
        ownerExtensionId: invocation.callerExtensionId,
        turn: await this.#latestTurn(sessionId),
      };
      this.#records.set(record.id, record);
    }
    if (input.prompt !== undefined) {
      nonEmptyText(input.prompt, 'agents.resume prompt');
      await this.#submit(
        {
          agentId: record.id,
          content: input.prompt,
        },
        invocation,
        'next_turn',
      );
    }
    void header;
    return this.#descriptor(record);
  }

  async #get(value: unknown): Promise<PackageAgentDescriptor | undefined> {
    const input = object(value, 'agents.get input');
    exactKeys(input, ['agentId'], 'agents.get input');
    const record = this.#records.get(entityId(input.agentId, 'agents.get agentId'));
    return record ? this.#descriptor(record) : undefined;
  }

  async #list(): Promise<readonly PackageAgentDescriptor[]> {
    return Promise.all([...this.#records.values()].map((record) => this.#descriptor(record)));
  }

  async #roots(): Promise<readonly PackageAgentDescriptor[]> {
    const descriptors: PackageAgentDescriptor[] = [];
    for (const record of this.#records.values()) {
      const header = await this.options.stores.sessionStore.readHeaderSnapshot(record.sessionId);
      if (!header.parentSessionId && !header.subagentParent)
        descriptors.push(await this.#descriptor(record));
    }
    return descriptors;
  }

  async #run(value: unknown, invocation: AgentInvocation): Promise<unknown> {
    const descriptor = await this.#create(value, invocation);
    return descriptor.turn ? clone(descriptor.turn) : descriptor;
  }

  async #stop(value: unknown): Promise<unknown> {
    const input = object(value, 'agents.stop input');
    exactKeys(input, ['sessionId', 'turnId', 'runId'], 'agents.stop input');
    const stopped = await this.options.turnControl.handlers['turn.stop'](
      {
        sessionId: entityId(input.sessionId, 'agents.stop sessionId'),
        turnId: entityId(input.turnId, 'agents.stop turnId'),
        runId: entityId(input.runId, 'agents.stop runId'),
      },
      this.#operationContext(),
    );
    if (!stopped.ok) throw new Error(stopped.error.message);
    const record = this.#records.get(stopped.result.sessionId);
    if (record) record.turn = stopped.result;
    return clone(stopped.result);
  }

  async #submit(
    value: unknown,
    invocation: AgentInvocation,
    placement: 'current_turn' | 'next_turn',
  ): Promise<unknown> {
    const input = object(
      value,
      `agent.${placement === 'current_turn' ? 'steer' : 'followup'} input`,
    );
    exactKeys(input, ['agentId', 'content', 'messageId'], 'Agent message input');
    const record = this.#requireRecord(input);
    const content = messageContent(input.content);
    const messageId =
      input.messageId === undefined ? randomUUID() : entityId(input.messageId, 'messageId');
    const outcome = await this.options.messages.handlers['turn.message.submit'](
      {
        originHostEpoch: this.options.hostEpoch,
        sessionId: record.sessionId,
        messageId,
        content,
        placement,
      },
      this.#operationContext(invocation),
    );
    if (!outcome.ok) throw new Error(outcome.error.message);
    if (outcome.result.disposition === 'turn_started') {
      const queried = await this.options.turnControl.handlers['turn.query'](
        { sessionId: record.sessionId, turnId: outcome.result.turnId },
        this.#operationContext(),
      );
      if (queried.ok) record.turn = queried.result;
    }
    return clone({ messageId, ...outcome.result });
  }

  async #cancel(value: unknown): Promise<unknown> {
    const input = object(value, 'agent.cancel input');
    exactKeys(input, ['agentId', 'turnId', 'runId'], 'agent.cancel input');
    const record = this.#requireRecord(input);
    const turn = await this.#resolveTurn(record, input);
    if (!turn) return { status: 'idle', sessionId: record.sessionId };
    if (terminal(turn)) return clone(turn);
    return this.#stop({ sessionId: record.sessionId, turnId: turn.turnId, runId: turn.runId });
  }

  async #whenIdle(value: unknown, signal: AbortSignal): Promise<unknown> {
    const input = object(value, 'agent.whenIdle input');
    exactKeys(input, ['agentId'], 'agent.whenIdle input');
    const record = this.#requireRecord(input);
    const pending = this.options.executions.whenIdle(record.sessionId);
    if (pending) await waitFor(pending, signal);
    record.turn = await this.#latestTurn(record.sessionId);
    return this.#statusFor(record);
  }

  async #retract(value: unknown): Promise<unknown> {
    const input = object(value, 'agent.retract input');
    exactKeys(input, ['agentId', 'retractId'], 'agent.retract input');
    const record = this.#requireRecord(input);
    const retractId =
      input.retractId === undefined ? randomUUID() : entityId(input.retractId, 'retractId');
    const outcome = await this.options.messages.handlers['queue.retract'](
      {
        originHostEpoch: this.options.hostEpoch,
        sessionId: record.sessionId,
        retractId,
      },
      this.#operationContext(),
    );
    if (!outcome.ok) throw new Error(outcome.error.message);
    return clone({ retractId, ...outcome.result });
  }

  async #receipt(value: unknown): Promise<unknown> {
    const input = object(value, 'agent.receipt input');
    exactKeys(input, ['agentId', 'messageId', 'operation'], 'agent.receipt input');
    const record = this.#requireRecord(input);
    const operation = input.operation ?? 'submit';
    if (operation !== 'submit' && operation !== 'retract' && operation !== 'interrupt') {
      throw new TypeError('agent.receipt operation is invalid');
    }
    return clone(
      await this.options.stores.messageReceiptStore.read(
        this.options.hostEpoch,
        operation,
        record.sessionId,
        entityId(input.messageId, 'agent.receipt messageId'),
      ),
    );
  }

  async #status(value: unknown): Promise<unknown> {
    const record = this.#requireRecord(object(value, 'agent.status input'));
    return this.#statusFor(record);
  }

  async #session(value: unknown): Promise<unknown> {
    const record = this.#requireRecord(object(value, 'agent.session input'));
    return clone(await this.options.stores.sessionStore.readHeaderSnapshot(record.sessionId));
  }

  async #options(value: unknown): Promise<unknown> {
    const header = (await this.#session(value)) as Record<string, unknown>;
    return clone({
      cwd: header.cwd,
      model: header.model,
      connectionSlug: header.llmConnectionSlug,
      thinkingLevel: header.thinkingLevel,
      toolProfile: header.toolProfile,
      permissionMode: header.permissionMode,
      collaborationMode: header.collaborationMode ?? 'agent',
      orchestrationMode: header.orchestrationMode ?? 'default',
    });
  }

  async #inbox(value: unknown): Promise<unknown> {
    const record = this.#requireRecord(object(value, 'agent.inbox input'));
    return clone(this.options.messages.projection(record.sessionId));
  }

  async #events(value: unknown): Promise<unknown> {
    const input = object(value, 'agent.events input');
    exactKeys(input, ['agentId', 'runId', 'maxEvents'], 'agent.events input');
    const record = this.#requireRecord(input);
    const run = await this.#resolveRun(record, input.runId);
    if (!run) return null;
    const maxEvents =
      input.maxEvents === undefined ? 256 : positiveInteger(input.maxEvents, 'maxEvents');
    const inspected = await inspectAgentRunReadModel(
      this.options.stores.agentRunStore,
      this.options.stores.runtimeEventStore,
      { sessionId: record.sessionId, runId: run.runId, header: run },
    );
    return clone({
      header: inspected.header,
      events: inspected.events.slice(-maxEvents),
      runtimeEvents: inspected.runtimeEvents.slice(-maxEvents),
      diagnostics: inspected.diagnostics.slice(-maxEvents),
      sourceHealth: inspected.sourceHealth,
      truncated: {
        events: inspected.events.length > maxEvents,
        runtimeEvents: inspected.runtimeEvents.length > maxEvents,
        diagnostics: inspected.diagnostics.length > maxEvents,
      },
    });
  }

  async #result(value: unknown): Promise<unknown> {
    const input = object(value, 'agent.result input');
    exactKeys(input, ['agentId', 'runId', 'maxBytes'], 'agent.result input');
    const record = this.#requireRecord(input);
    const run = await this.#resolveRun(record, input.runId);
    if (!run) return null;
    const maxBytes =
      input.maxBytes === undefined ? 64 * 1024 : positiveInteger(input.maxBytes, 'maxBytes');
    const inspected = await inspectAgentRunReadModel(
      this.options.stores.agentRunStore,
      this.options.stores.runtimeEventStore,
      { sessionId: record.sessionId, runId: run.runId, header: run },
    );
    const text = [...inspected.runtimeEvents]
      .reverse()
      .find(
        (event) =>
          event.role === 'model' &&
          !event.partial &&
          event.content?.kind === 'text' &&
          event.content.text.trim().length > 0,
      )?.content;
    const artifacts = await this.options.artifactStore.listTurnArtifacts(
      record.sessionId,
      run.turnId,
    );
    const boundedText = text?.kind === 'text' ? truncateUtf8(text.text, maxBytes) : undefined;
    return clone({
      status: inspected.header.status,
      ...(boundedText
        ? { text: boundedText.text, textTruncated: boundedText.truncated }
        : { textTruncated: false }),
      artifactIds: artifacts.map((artifact) => artifact.id),
      diagnostics: inspected.diagnostics,
      sourceHealth: inspected.sourceHealth,
      ...(inspected.header.failureClass ? { failureClass: inspected.header.failureClass } : {}),
    });
  }

  async #artifacts(value: unknown): Promise<unknown> {
    const input = object(value, 'agent.artifacts input');
    const record = this.#requireRecord(input);
    const { agentId: _agentId, ...request } = input;
    const kind = request.kind ?? 'list_start';
    const artifactInput = { ...request, kind, sessionId: record.sessionId } as ArtifactQueryInput;
    const outcome = await this.options.artifacts.handlers['artifact.query'](
      artifactInput,
      this.#operationContext(),
    );
    if (!outcome.ok) throw new Error(outcome.error.message);
    return clone(outcome.result);
  }

  async #usage(value: unknown): Promise<unknown> {
    const input = object(value, 'agent.usage input');
    exactKeys(input, ['agentId', 'runId', 'maxRecords'], 'agent.usage input');
    const record = this.#requireRecord(input);
    const maxRecords =
      input.maxRecords === undefined ? 256 : positiveInteger(input.maxRecords, 'maxRecords');
    const turnId =
      input.runId === undefined ? undefined : (await this.#resolveRun(record, input.runId))?.turnId;
    const rows: Extract<UsageQueryResult, { kind: 'logs'; source: 'llm' }>['rows'][number][] = [];
    let offset = 0;
    let totalMatching = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let totalTokens = 0;
    let totalCostUsd = 0;
    let hasUnpriced = false;
    for (;;) {
      const outcome = await this.options.usage.handlers['usage.query'](
        {
          kind: 'logs',
          source: 'llm',
          query: { range: 'all', status: 'all' },
          offset,
          limit: 128,
        },
        this.#operationContext(),
      );
      if (!outcome.ok) throw new Error(outcome.error.message);
      if (outcome.result.kind !== 'logs' || outcome.result.source !== 'llm') {
        throw new Error('Maka usage authority returned an unexpected projection');
      }
      for (const row of outcome.result.rows) {
        if (row.sessionId !== record.sessionId || (turnId && row.turnId !== turnId)) continue;
        totalMatching += 1;
        inputTokens += row.inputTokens;
        outputTokens += row.outputTokens;
        totalTokens += row.totalTokens;
        if (row.costUsd === undefined) hasUnpriced = true;
        else totalCostUsd += row.costUsd;
        if (rows.length < maxRecords) rows.push(row);
      }
      if (outcome.result.nextOffset === null) break;
      offset = outcome.result.nextOffset;
    }
    return clone({
      summary: {
        inputTokens,
        outputTokens,
        totalTokens,
        totalCostUsd,
        costStatus: hasUnpriced ? 'partially_unpriced' : 'priced',
      },
      rows,
      total: totalMatching,
      truncated: totalMatching > rows.length,
    });
  }

  async #transcript(value: unknown): Promise<unknown> {
    const input = object(value, 'agent.transcript input');
    exactKeys(
      input,
      [
        'agentId',
        'direction',
        'throughSequence',
        'position',
        'byteOffset',
        'maxBytes',
        'maxMessages',
        'includeOverlay',
      ],
      'agent.transcript input',
    );
    const record = this.#requireRecord(input);
    const direction = input.direction ?? 'older';
    if (direction !== 'older' && direction !== 'newer')
      throw new TypeError('transcript direction is invalid');
    const maxBytes =
      input.maxBytes === undefined ? 128 * 1024 : positiveInteger(input.maxBytes, 'maxBytes');
    const maxMessages =
      input.maxMessages === undefined ? 128 : positiveInteger(input.maxMessages, 'maxMessages');
    const durable = await this.options.transcript.readDurablePage(record.sessionId, {
      direction,
      ...(input.throughSequence === undefined
        ? {}
        : { throughSequence: nullableCount(input.throughSequence, 'throughSequence') }),
      ...(input.position === undefined ? {} : { position: count(input.position, 'position') }),
      ...(input.byteOffset === undefined
        ? {}
        : { byteOffset: count(input.byteOffset, 'byteOffset') }),
      maxBytes,
      maxMessages,
    });
    const activeTurn = record.turn && !terminal(record.turn) ? (record.turn as TurnSnapshot) : null;
    const overlay =
      input.includeOverlay === false
        ? []
        : await this.options.transcript.readActiveOverlay(record.sessionId, activeTurn);
    return clone({
      durable: {
        ...durable,
        fragments: durable.fragments.map((fragment) => ({
          ...fragment,
          data: fragment.data.toString('utf8'),
        })),
      },
      overlay,
    });
  }

  async #statusFor(record: AgentRecord): Promise<unknown> {
    const turn = await this.#resolveTurn(record, {});
    if (turn)
      return clone({ agentId: record.id, sessionId: record.sessionId, status: turn.status, turn });
    const header = await this.options.stores.sessionStore.readHeaderSnapshot(record.sessionId);
    return clone({
      agentId: record.id,
      sessionId: record.sessionId,
      status: 'idle',
      sessionStatus: header.status,
    });
  }

  async #descriptor(record: AgentRecord): Promise<PackageAgentDescriptor> {
    const header = await this.options.stores.sessionStore.readHeaderSnapshot(record.sessionId);
    const turn = await this.#resolveTurn(record, {});
    return clone({
      id: record.id,
      sessionId: record.sessionId,
      ownerExtensionId: record.ownerExtensionId,
      root: !header.parentSessionId && !header.subagentParent,
      ...(turn ? { turn: { turnId: turn.turnId, runId: turn.runId, status: turn.status } } : {}),
    });
  }

  #requireRecord(value: Record<string, unknown> | { readonly agentId: string }): AgentRecord {
    const id = entityId(value.agentId, 'agentId');
    const record = this.#records.get(id);
    if (!record) throw new Error(`Agent is not registered: ${id}`);
    return record;
  }

  async #resolveTurn(
    record: AgentRecord,
    input: Record<string, unknown>,
  ): Promise<AgentTurnSnapshot | undefined> {
    if (input.turnId !== undefined || input.runId !== undefined) {
      const turnId = entityId(input.turnId, 'turnId');
      const runId = entityId(input.runId, 'runId');
      const queried = await this.options.turnControl.handlers['turn.query'](
        { sessionId: record.sessionId, turnId },
        this.#operationContext(),
      );
      if (queried.ok && queried.result.runId === runId) {
        record.turn = queried.result;
        return queried.result;
      }
      const run = await this.options.stores.agentRunStore.readRun(record.sessionId, runId);
      if (run.turnId !== turnId) throw new Error('Agent Turn and Run identity do not match');
      return runToTurn(run);
    }
    const active = record.turn;
    if (active && !terminal(active)) {
      const queried = await this.options.turnControl.handlers['turn.query'](
        { sessionId: record.sessionId, turnId: active.turnId },
        this.#operationContext(),
      );
      if (queried.ok) {
        record.turn = queried.result;
        return queried.result;
      }
    }
    record.turn = await this.#latestTurn(record.sessionId);
    return record.turn;
  }

  async #resolveRun(record: AgentRecord, value: unknown) {
    const runId = value === undefined ? undefined : entityId(value, 'runId');
    if (runId) return this.options.stores.agentRunStore.readRun(record.sessionId, runId);
    const runs = await this.options.stores.agentRunStore.listSessionRuns(record.sessionId);
    return newestRun(runs);
  }

  async #latestTurn(sessionId: string): Promise<AgentTurnSnapshot | undefined> {
    const runs = await this.options.stores.agentRunStore.listSessionRuns(sessionId);
    const latest = newestRun(runs);
    return latest ? runToTurn(latest) : undefined;
  }

  #operationContext(invocation?: AgentInvocation) {
    const callerExtensionId = invocation?.callerExtensionId ?? 'agent-registry';
    return {
      hostEpoch: this.options.hostEpoch,
      connectionId: `extension:${callerExtensionId}`,
      surface: 'run' as const,
      principal: `extension:${callerExtensionId}`,
      acquireResidency: this.options.acquireResidency,
    };
  }
}

function createInput(value: unknown, fallbackCwd: string) {
  const input = object(value, 'agents.create input');
  exactKeys(
    input,
    [
      'id',
      'sessionId',
      'prompt',
      'cwd',
      'name',
      'connectionSlug',
      'provider',
      'model',
      'thinkingLevel',
      'toolProfile',
      'permissionMode',
      'collaborationMode',
      'orchestrationMode',
      'maxSteps',
    ],
    'agents.create input',
  );
  const prompt = nonEmptyText(input.prompt, 'agents.create prompt');
  if (Buffer.byteLength(prompt, 'utf8') > 48 * 1024)
    throw new TypeError('agents.create prompt exceeds 48 KiB');
  const cwd = input.cwd === undefined ? fallbackCwd : nonEmptyText(input.cwd, 'agents.create cwd');
  const idValue = input.sessionId ?? input.id;
  const sessionId =
    idValue === undefined ? undefined : entityId(idValue, 'agents.create sessionId');
  const connectionSlug = input.connectionSlug ?? input.provider;
  if ((connectionSlug === undefined) !== (input.model === undefined)) {
    throw new TypeError(
      'agents.create connectionSlug/provider and model must be supplied together',
    );
  }
  const modelTarget: SessionCreateInput['modelTarget'] =
    connectionSlug === undefined
      ? { kind: 'default' }
      : {
          kind: 'explicit',
          connectionSlug: nonEmptyText(connectionSlug, 'agents.create connectionSlug'),
          model: nonEmptyText(input.model, 'agents.create model'),
        };
  if (input.thinkingLevel !== undefined && !isThinkingLevel(input.thinkingLevel))
    throw new TypeError('agents.create thinkingLevel is invalid');
  if (input.toolProfile !== undefined && !isSessionToolProfile(input.toolProfile))
    throw new TypeError('agents.create toolProfile is invalid');
  if (input.permissionMode !== undefined && !isPermissionMode(input.permissionMode))
    throw new TypeError('agents.create permissionMode is invalid');
  if (input.collaborationMode !== undefined && !isCollaborationMode(input.collaborationMode))
    throw new TypeError('agents.create collaborationMode is invalid');
  if (input.orchestrationMode !== undefined && !isOrchestrationMode(input.orchestrationMode))
    throw new TypeError('agents.create orchestrationMode is invalid');
  return {
    sessionId,
    prompt,
    cwd,
    modelTarget,
    ...(input.name === undefined ? {} : { name: nonEmptyText(input.name, 'agents.create name') }),
    ...(input.thinkingLevel === undefined ? {} : { thinkingLevel: input.thinkingLevel }),
    ...(input.toolProfile === undefined ? {} : { toolProfile: input.toolProfile }),
    ...(input.permissionMode === undefined ? {} : { permissionMode: input.permissionMode }),
    ...(input.collaborationMode === undefined
      ? {}
      : { collaborationMode: input.collaborationMode }),
    ...(input.orchestrationMode === undefined
      ? {}
      : { orchestrationMode: input.orchestrationMode }),
    ...(input.maxSteps === undefined
      ? {}
      : { maxSteps: positiveInteger(input.maxSteps, 'agents.create maxSteps') }),
  };
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const allowed = new Set(keys);
  for (const key of Object.keys(value))
    if (!allowed.has(key)) throw new TypeError(`${label} has an unknown field: ${key}`);
}

function entityId(value: unknown, label: string): string {
  const text = nonEmptyText(value, label);
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(text)) throw new TypeError(`${label} is invalid`);
  return text;
}

function nonEmptyText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0)
    throw new TypeError(`${label} must be a non-empty string`);
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0)
    throw new TypeError(`${label} must be a positive integer`);
  return value as number;
}

function count(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw new TypeError(`${label} must be a non-negative integer`);
  return value as number;
}

function nullableCount(value: unknown, label: string): number | null {
  return value === null ? null : count(value, label);
}

function messageContent(value: unknown): { text: string } {
  if (typeof value === 'string') return { text: nonEmptyText(value, 'Agent message content') };
  const input = object(value, 'Agent message content');
  exactKeys(input, ['text'], 'Agent message content');
  return { text: nonEmptyText(input.text, 'Agent message text') };
}

function newestRun<
  T extends { readonly createdAt: number; readonly updatedAt: number; readonly runId: string },
>(runs: readonly T[]): T | undefined {
  return [...runs].sort(
    (left, right) =>
      right.createdAt - left.createdAt ||
      right.updatedAt - left.updatedAt ||
      right.runId.localeCompare(left.runId),
  )[0];
}

function runToTurn(
  run: Awaited<ReturnType<ExecutionStoresWriter<'interactive'>['agentRunStore']['readRun']>>,
): AgentTurnSnapshot {
  const base = { sessionId: run.sessionId, turnId: run.turnId, runId: run.runId };
  if (run.status === 'completed') return { ...base, status: 'completed' };
  if (run.status === 'failed')
    return {
      ...base,
      status: 'failed',
      failureClass: run.failureClass ?? 'unknown',
    };
  if (run.status === 'cancelled') return { ...base, status: 'cancelled' };
  return { ...base, status: run.status };
}

function terminal(turn: AgentTurnSnapshot): boolean {
  return turn.status === 'completed' || turn.status === 'failed' || turn.status === 'cancelled';
}

function clone<T>(value: T): T {
  return value === undefined ? value : structuredClone(value);
}

function once(dispose: () => void): () => void {
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    dispose();
  };
}

function safeNotify(
  listener: (observation: PackageAgentObservation) => void,
  observation: PackageAgentObservation,
): void {
  try {
    listener(observation);
  } catch {
    // Notifications are hints. Durable Agent state remains authoritative.
  }
}

async function waitFor(task: Promise<void>, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw signal.reason;
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    void task.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

function truncateUtf8(value: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return { text: value, truncated: false };
  let text = '';
  for (const codePoint of value) {
    if (Buffer.byteLength(`${text}${codePoint}…`, 'utf8') > maxBytes) break;
    text += codePoint;
  }
  return { text: `${text}…`, truncated: true };
}

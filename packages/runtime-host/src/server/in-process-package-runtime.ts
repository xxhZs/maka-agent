import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import type { MakaTool, MakaToolContext } from '@maka/runtime/tool-runtime';
import { z } from 'zod';
import type { ExtensionConfigurationScalar } from '../protocol/extension.js';
import type { InstalledToolPackage } from './plugin-runtime-manifest.js';

export interface PackageInvocationContext {
  readonly sessionId: string;
  readonly runId?: string;
  readonly turnId: string;
  readonly cwd: string;
  readonly toolCallId: string;
  readonly operationId?: string;
  readonly abortSignal: AbortSignal;
  readonly permissionMode?: string;
  readonly origin?: 'provider' | 'code_mode' | 'host';
  readonly eventDepth?: number;
  readonly serviceDepth?: number;
  readonly emitOutput?: (stream: 'stdout' | 'stderr', chunk: string) => void;
}

export type PackageEventEmitter = (
  event: string,
  payload: unknown,
  context: PackageInvocationContext,
) => Promise<unknown>;

export type PackageServiceCaller = (
  service: string,
  method: string,
  input: unknown,
  context: PackageInvocationContext & { readonly callerExtensionId: string },
) => Promise<unknown>;

export interface PackageAgentRunInput {
  readonly prompt: string;
  readonly cwd?: string;
  readonly name?: string;
  readonly maxSteps?: number;
}

export interface PackageAgentStopInput {
  readonly sessionId: string;
  readonly turnId: string;
  readonly runId: string;
}

export const PACKAGE_AGENT_RUNTIME_METHODS = [
  'create',
  'resume',
  'get',
  'list',
  'roots',
  'run',
  'stop',
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
] as const;

export type PackageAgentRuntimeMethod = (typeof PACKAGE_AGENT_RUNTIME_METHODS)[number];

export interface PackageAgentDescriptor {
  readonly id: string;
  readonly sessionId: string;
  readonly ownerExtensionId: string;
  readonly root: boolean;
  readonly turn?: {
    readonly turnId: string;
    readonly runId: string;
    readonly status: string;
  };
}

export type PackageAgentObservation =
  | { readonly kind: 'execution_changed'; readonly agentId: string; readonly execution: unknown }
  | { readonly kind: 'transcript_changed'; readonly agentId: string }
  | {
      readonly kind: 'runtime_events';
      readonly agentId: string;
      readonly runId: string;
      readonly events: readonly unknown[];
    };

export interface PackageAgentRuntime {
  invoke(
    method: PackageAgentRuntimeMethod,
    input: unknown,
    context: PackageInvocationContext & { readonly callerExtensionId: string },
  ): Promise<unknown>;
  observe(
    input: { readonly agentId: string },
    listener: (observation: PackageAgentObservation) => void,
    context: PackageInvocationContext & { readonly callerExtensionId: string },
  ): () => void;
}

export interface PackageAgentHandle {
  readonly id: string;
  readonly sessionId: string;
  readonly ownerExtensionId: string;
  readonly root: boolean;
  followup(input: unknown): Promise<unknown>;
  steer(input: unknown): Promise<unknown>;
  cancel(input?: unknown): Promise<unknown>;
  whenIdle(input?: unknown): Promise<unknown>;
  retract(input?: unknown): Promise<unknown>;
  receipt(input: unknown): Promise<unknown>;
  status(): Promise<unknown>;
  session(): Promise<unknown>;
  options(): Promise<unknown>;
  inbox(): Promise<unknown>;
  events(input?: unknown): Promise<unknown>;
  result(input?: unknown): Promise<unknown>;
  artifacts(input?: unknown): Promise<unknown>;
  usage(input?: unknown): Promise<unknown>;
  transcript(input?: unknown): Promise<unknown>;
  observe(listener: (observation: PackageAgentObservation) => void): () => void;
}

export type PackageContinuation = (value?: unknown) => unknown | Promise<unknown>;

type PackageHandler = (
  value: unknown,
  context: Readonly<
    PackageInvocationContext & {
      readonly configuration: Readonly<Record<string, ExtensionConfigurationScalar>>;
      readonly emitEvent: (event: string, payload: unknown) => Promise<unknown>;
      readonly callService: (service: string, method: string, input: unknown) => Promise<unknown>;
      /** Host-owned Agent Runtime; independent from Tool/UI/Hook contributions. */
      readonly agents: Readonly<{
        create(input: unknown): Promise<PackageAgentHandle>;
        resume(input: unknown): Promise<PackageAgentHandle>;
        get(id: string): Promise<PackageAgentHandle | undefined>;
        list(): Promise<unknown>;
        roots(): Promise<unknown>;
        currentInitiator(): Readonly<PackageInvocationContext>;
        requireInitiator(): Readonly<PackageInvocationContext>;
        /** Compatibility shortcut for create({ prompt, ... }). */
        run(input: PackageAgentRunInput): Promise<unknown>;
        /** Compatibility shortcut for cancelling one exact Maka Run. */
        stop(input: PackageAgentStopInput): Promise<unknown>;
      }>;
    }
  >,
  next?: PackageContinuation,
) => unknown | Promise<unknown>;

interface PackageModule {
  readonly default?: unknown;
  readonly tools?: unknown;
}

export class InProcessPackageError extends Error {
  readonly name = 'InProcessPackageError';

  constructor(
    readonly code: 'load_failed' | 'handler_missing' | 'aborted' | 'retired',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

/**
 * One trusted in-process Extension activation.
 *
 * Package code has the same security authority as the Runtime Host. The public
 * context is a cooperative API and not a sandbox boundary. A module is loaded
 * once for the activation and all contribution calls share its live state.
 */
export class InProcessPackageActivation {
  readonly #invocations = new Set<Promise<unknown>>();
  readonly #agentObservers = new Set<() => void>();
  #handlersTask: Promise<Readonly<Record<string, PackageHandler>>> | undefined;

  constructor(
    readonly installedPackage: InstalledToolPackage,
    readonly configuration: Readonly<Record<string, ExtensionConfigurationScalar>> = Object.freeze(
      {},
    ),
    private readonly emitEvent?: PackageEventEmitter,
    private readonly callService?: PackageServiceCaller,
    private readonly agents?: PackageAgentRuntime,
  ) {}

  tools(): readonly MakaTool[] {
    return Object.freeze(
      this.installedPackage.manifest.tools.map((declaration) => {
        let parameters: unknown;
        try {
          parameters = z.fromJSONSchema(declaration.inputSchema);
        } catch (error) {
          throw new InProcessPackageError(
            'load_failed',
            `Tool package JSON Schema is unsupported: ${declaration.name}`,
            { cause: error },
          );
        }
        return Object.freeze({
          name: declaration.name,
          description: declaration.description,
          parameters,
          ...(declaration.displayName ? { displayName: declaration.displayName } : {}),
          categoryHint: effectiveCategory(this.installedPackage.manifest, declaration.category),
          recoveryMode: declaration.recoveryMode ?? 'never_auto_retry',
          executionFacts: executionFacts(this.installedPackage.manifest),
          permissionArgs: (args: unknown) => args,
          impl: (args: unknown, context: MakaToolContext) =>
            this.invoke(declaration.handler, args, context),
        } satisfies MakaTool);
      }),
    );
  }

  async healthCheck(handlers: readonly string[]): Promise<void> {
    this.#assertActive();
    const loaded = await this.#handlers();
    for (const handler of handlers) requireHandler(loaded, handler);
  }

  invoke(handler: string, args: unknown, context: MakaToolContext): Promise<unknown> {
    return this.invokeRaw(handler, args, context);
  }

  invokeRaw(
    handler: string,
    value: unknown,
    context: PackageInvocationContext,
    next?: PackageContinuation,
  ): Promise<unknown> {
    this.#assertActive();
    if (context.abortSignal.aborted) {
      return Promise.reject(
        new InProcessPackageError('aborted', `Extension invocation was aborted: ${handler}`, {
          cause: context.abortSignal.reason,
        }),
      );
    }
    const invocation = this.#invoke(handler, value, context, next);
    this.#invocations.add(invocation);
    void invocation.then(
      () => this.#invocations.delete(invocation),
      () => this.#invocations.delete(invocation),
    );
    return invocation;
  }

  async dispose(): Promise<void> {
    // Registries stop exposing this activation before disposal. Captured Turn
    // snapshots intentionally retain their bound handlers and may still enter
    // after a Binding update; those live references are the generation lease.
    for (const dispose of this.#agentObservers) dispose();
    this.#agentObservers.clear();
    await Promise.allSettled([...this.#invocations]);
  }

  async #invoke(
    handlerName: string,
    value: unknown,
    context: PackageInvocationContext,
    next?: PackageContinuation,
  ): Promise<unknown> {
    const handler = requireHandler(await this.#handlers(), handlerName);
    const agentContext = {
      ...context,
      callerExtensionId: this.installedPackage.extensionId,
    };
    const callAgentRuntime = (
      method: PackageAgentRuntimeMethod,
      input: unknown,
    ): Promise<unknown> => {
      if (!this.agents) throw new Error('Maka Agent Runtime is unavailable');
      return this.agents.invoke(method, input, agentContext);
    };
    const handle = (descriptor: PackageAgentDescriptor): PackageAgentHandle => {
      const agentInput = (input: unknown): Record<string, unknown> => ({
        ...(input && typeof input === 'object' && !Array.isArray(input)
          ? (input as Record<string, unknown>)
          : input === undefined
            ? {}
            : { content: input }),
        agentId: descriptor.id,
      });
      return Object.freeze({
        id: descriptor.id,
        sessionId: descriptor.sessionId,
        ownerExtensionId: descriptor.ownerExtensionId,
        root: descriptor.root,
        followup: (input: unknown) => callAgentRuntime('agent.followup', agentInput(input)),
        steer: (input: unknown) => callAgentRuntime('agent.steer', agentInput(input)),
        cancel: (input?: unknown) => callAgentRuntime('agent.cancel', agentInput(input)),
        whenIdle: (input?: unknown) => callAgentRuntime('agent.whenIdle', agentInput(input)),
        retract: (input?: unknown) => callAgentRuntime('agent.retract', agentInput(input)),
        receipt: (input: unknown) => callAgentRuntime('agent.receipt', agentInput(input)),
        status: () => callAgentRuntime('agent.status', { agentId: descriptor.id }),
        session: () => callAgentRuntime('agent.session', { agentId: descriptor.id }),
        options: () => callAgentRuntime('agent.options', { agentId: descriptor.id }),
        inbox: () => callAgentRuntime('agent.inbox', { agentId: descriptor.id }),
        events: (input?: unknown) => callAgentRuntime('agent.events', agentInput(input)),
        result: (input?: unknown) => callAgentRuntime('agent.result', agentInput(input)),
        artifacts: (input?: unknown) => callAgentRuntime('agent.artifacts', agentInput(input)),
        usage: (input?: unknown) => callAgentRuntime('agent.usage', agentInput(input)),
        transcript: (input?: unknown) => callAgentRuntime('agent.transcript', agentInput(input)),
        observe: (listener: (observation: PackageAgentObservation) => void) => {
          if (typeof listener !== 'function')
            throw new TypeError('Agent observer must be a function');
          if (!this.agents) throw new Error('Maka Agent Runtime is unavailable');
          const dispose = this.agents.observe({ agentId: descriptor.id }, listener, agentContext);
          let active = true;
          const trackedDispose = () => {
            if (!active) return;
            active = false;
            this.#agentObservers.delete(trackedDispose);
            dispose();
          };
          this.#agentObservers.add(trackedDispose);
          return trackedDispose;
        },
      });
    };
    const descriptor = async (method: 'create' | 'resume', input: unknown) =>
      handle((await callAgentRuntime(method, input)) as PackageAgentDescriptor);
    const agents = Object.freeze({
      create: (input: unknown) => descriptor('create', input),
      resume: (input: unknown) => descriptor('resume', input),
      get: async (id: string) => {
        const value = await callAgentRuntime('get', { agentId: id });
        return value === undefined || value === null
          ? undefined
          : handle(value as PackageAgentDescriptor);
      },
      list: () => callAgentRuntime('list', {}),
      roots: () => callAgentRuntime('roots', {}),
      currentInitiator: () => Object.freeze({ ...context }),
      requireInitiator: () => Object.freeze({ ...context }),
      run: (input: PackageAgentRunInput) => callAgentRuntime('run', input),
      stop: (input: PackageAgentStopInput) => callAgentRuntime('stop', input),
    });
    const runtimeContext = Object.freeze({
      ...context,
      configuration: this.configuration,
      agents,
      emitEvent: (event: string, payload: unknown) => {
        if (!this.emitEvent) throw new Error('Extension Event emission is unavailable');
        return this.emitEvent(event, payload, context);
      },
      callService: (service: string, method: string, input: unknown) => {
        if (!this.callService) throw new Error('Extension Service calls are unavailable');
        return this.callService(service, method, input, {
          ...context,
          callerExtensionId: this.installedPackage.extensionId,
        });
      },
    });
    const result = await handler(value, runtimeContext, next);
    if (context.abortSignal.aborted) {
      throw new InProcessPackageError(
        'aborted',
        `Extension invocation was aborted: ${handlerName}`,
        {
          cause: context.abortSignal.reason,
        },
      );
    }
    return result;
  }

  #handlers(): Promise<Readonly<Record<string, PackageHandler>>> {
    this.#assertActive();
    this.#handlersTask ??= loadHandlers(this.installedPackage.entry);
    return this.#handlersTask;
  }

  #assertActive(): void {
    // Authority is owned by the lifecycle registries. A captured contribution
    // is itself a lease and remains callable until its Turn releases the snapshot.
  }
}

async function loadHandlers(entry: string): Promise<Readonly<Record<string, PackageHandler>>> {
  let imported: PackageModule;
  try {
    const url = pathToFileURL(entry);
    url.searchParams.set('makaActivation', randomUUID());
    imported = (await import(url.href)) as PackageModule;
  } catch (error) {
    throw new InProcessPackageError('load_failed', `Unable to load Extension entry: ${entry}`, {
      cause: error,
    });
  }
  const handlers = imported.default ?? imported.tools;
  if (!handlers || typeof handlers !== 'object' || Array.isArray(handlers)) {
    throw new InProcessPackageError(
      'load_failed',
      'Extension entry must export a default handler object',
    );
  }
  return handlers as Readonly<Record<string, PackageHandler>>;
}

function requireHandler(
  handlers: Readonly<Record<string, PackageHandler>>,
  name: string,
): PackageHandler {
  const handler = handlers[name];
  if (typeof handler !== 'function') {
    throw new InProcessPackageError('handler_missing', `Extension handler is missing: ${name}`);
  }
  return handler;
}

function effectiveCategory(
  manifest: InstalledToolPackage['manifest'],
  declared: InstalledToolPackage['manifest']['tools'][number]['category'],
): NonNullable<InstalledToolPackage['manifest']['tools'][number]['category']> {
  if (declared) return declared;
  if (manifest.permissions.workspace === 'write') return 'file_write';
  if (manifest.permissions.network) return 'network_send';
  return 'read';
}

function executionFacts(manifest: InstalledToolPackage['manifest']): MakaTool['executionFacts'] {
  return Object.freeze({
    isolation: 'none',
    writesAffectHost: manifest.permissions.workspace === 'write',
    writeBack: 'direct',
    network: manifest.permissions.network ? 'host' : 'disabled',
    secrets: 'host_env',
  });
}

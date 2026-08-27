import { AsyncLocalStorage } from 'node:async_hooks';
import { Service, type Context, type Disposable } from '@maka/runtime/plugin-kernel';
import type {
  PackageAgentObservation,
  PackageAgentRuntime,
  PackageAgentRuntimeMethod,
  PackageInvocationContext,
} from './in-process-package-runtime.js';

type AgentInvocation = PackageInvocationContext & { readonly callerExtensionId: string };

declare module '@maka/runtime/plugin-kernel' {
  interface Context {
    agents: HostExtensionAgentService;
    agentLoop: HostExtensionAgentLoopService;
  }
}

/** Swappable concrete driver behind the stable Agent registry. */
export class HostExtensionAgentLoopService extends Service implements PackageAgentRuntime {
  private readonly initiators = new AsyncLocalStorage<AgentInvocation | undefined>();
  private provider:
    | {
        readonly token: symbol;
        readonly runtime: PackageAgentRuntime;
        readonly context: Context;
      }
    | undefined;

  constructor(ctx: Context) {
    super(ctx, {
      name: 'agentLoop',
      role: 'seam',
      permissions: Object.freeze(['sessionAccess']),
      isolate: true,
    });
  }

  registerProvider(runtime: PackageAgentRuntime): Disposable<Promise<void>> {
    if (!runtime || typeof runtime.invoke !== 'function' || typeof runtime.observe !== 'function') {
      throw new TypeError('Agent loop provider is invalid');
    }
    if (this.provider) throw new Error('Agent loop provider is already registered');
    const provider = { token: Symbol('agentLoop.provider'), runtime, context: this.ctx };
    return this.ctx.effect(() => {
      if (this.provider) throw new Error('Agent loop provider is already registered');
      this.provider = provider;
      return () => {
        if (this.provider?.token === provider.token) this.provider = undefined;
      };
    }, 'agentLoop.provider');
  }

  invoke(
    method: PackageAgentRuntimeMethod,
    input: unknown,
    context: AgentInvocation,
  ): Promise<unknown> {
    return this.runtime().invoke(method, input, context);
  }

  observe(
    input: { readonly agentId: string },
    listener: (observation: PackageAgentObservation) => void,
    context: AgentInvocation,
  ): () => void {
    return this.runtime().observe(input, listener, context);
  }

  providerAvailable(): boolean {
    return this.provider !== undefined;
  }

  _inspectRegistrations(): readonly import('@maka/runtime/plugin-kernel').ServiceRegistrationInspection[] {
    const provider = this.provider;
    if (!provider) return Object.freeze([]);
    return Object.freeze([
      Object.freeze({
        id: 'maka.session-turn',
        fiberId: provider.context.fiber.id,
        fiberName: provider.context.fiber.name,
        fiberState: provider.context.fiber.state,
        realm: provider.context.serviceRealm(),
      }),
    ]);
  }

  currentInitiator(): AgentInvocation | undefined {
    return this.initiators.getStore();
  }

  requireInitiator(): AgentInvocation {
    const initiator = this.currentInitiator();
    if (!initiator) throw new Error('No initiating Agent invocation is active');
    return initiator;
  }

  withInitiator<T>(initiator: AgentInvocation, operation: () => T): T {
    return this.initiators.run(initiator, operation);
  }

  withoutInitiator<T>(operation: () => T): T {
    return this.initiators.run(undefined, operation);
  }

  private runtime(): PackageAgentRuntime {
    const runtime = this.provider?.runtime;
    if (!runtime) throw new Error('Maka Agent loop provider is unavailable');
    return runtime;
  }
}

/**
 * Stable Agent capability mounted on the Extension Context.
 *
 * The Service owns discovery and the provider slot; Maka's Session/Turn-backed
 * implementation is registered separately, mirroring DSH's ctx.agents plus
 * AgentFactory split. Package and UI bridges resolve this exact Service from
 * their scoped Context instead of receiving a parallel Host singleton.
 */
export class HostExtensionAgentService extends Service implements PackageAgentRuntime {
  private readonly contexts = new Map<string, Context>();

  constructor(
    ctx: Context,
    private readonly createAgentContext: (sessionId: string, agentId: string) => Context,
    private readonly loop: HostExtensionAgentLoopService,
  ) {
    super(ctx, {
      name: 'agents',
      role: 'registry',
      permissions: Object.freeze(['sessionAccess']),
      isolate: true,
    });
  }

  registerProvider(runtime: PackageAgentRuntime): Disposable<Promise<void>> {
    const dispose = this.loop.registerProvider(runtime);
    return async () => {
      await dispose();
      this.contexts.clear();
    };
  }

  async invoke(
    method: PackageAgentRuntimeMethod,
    input: unknown,
    context: AgentInvocation,
  ): Promise<unknown> {
    const result = await this.loop.invoke(method, input, context);
    if (
      (method === 'create' || method === 'resume' || method === 'get') &&
      isAgentDescriptor(result)
    ) {
      this.contexts.set(result.id, this.createAgentContext(result.sessionId, result.id));
    }
    return result;
  }

  observe(
    input: { readonly agentId: string },
    listener: (observation: PackageAgentObservation) => void,
    context: AgentInvocation,
  ): () => void {
    return this.loop.observe(input, listener, context);
  }

  providerAvailable(): boolean {
    return this.loop.providerAvailable();
  }

  context(agentId: string): Context | undefined {
    return this.contexts.get(agentId);
  }

  releaseContext(agentId: string): boolean {
    return this.contexts.delete(agentId);
  }

  inspectContexts(): readonly import('@maka/runtime/plugin-kernel').ServiceRealmInspection[] {
    return Object.freeze(
      [...this.contexts.values()]
        .map((context) => context.serviceRealm())
        .sort((left, right) => left.id.localeCompare(right.id)),
    );
  }

  _inspectRegistrations(): readonly import('@maka/runtime/plugin-kernel').ServiceRegistrationInspection[] {
    return Object.freeze(
      [...this.contexts.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([id, context]) =>
          Object.freeze({
            id,
            fiberId: context.fiber.id,
            fiberName: context.fiber.name,
            fiberState: context.fiber.state,
            realm: context.serviceRealm(),
          }),
        ),
    );
  }

  currentInitiator(): AgentInvocation | undefined {
    return this.loop.currentInitiator();
  }

  requireInitiator(): AgentInvocation {
    return this.loop.requireInitiator();
  }

  withInitiator<T>(initiator: AgentInvocation, operation: () => T): T {
    return this.loop.withInitiator(initiator, operation);
  }

  withoutInitiator<T>(operation: () => T): T {
    return this.loop.withoutInitiator(operation);
  }
}

function isAgentDescriptor(
  value: unknown,
): value is { readonly id: string; readonly sessionId: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const descriptor = value as { readonly id?: unknown; readonly sessionId?: unknown };
  return (
    typeof descriptor.id === 'string' &&
    descriptor.id.length > 0 &&
    typeof descriptor.sessionId === 'string' &&
    descriptor.sessionId.length > 0
  );
}

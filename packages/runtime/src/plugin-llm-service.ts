import type { LanguageModelV4 } from '@ai-sdk/provider';
import { PROVIDER_REGISTRY } from '@maka/core/llm-connections';
import { getAIModel, type ModelFactoryInput } from './model-factory.js';
import { Service, type Context, type Disposable } from './plugin-kernel.js';
import {
  assertScopedRegistryIdAvailable,
  visibleScopedRegistryEntries,
} from './plugin-scoped-registry.js';

declare module './plugin-kernel.js' {
  interface Context {
    llm: PluginLlmService;
  }
}

export interface MakaLlmAdapter {
  readonly id: string;
  readonly priority?: number;
  readonly providers?: readonly string[];
  supports?(input: ModelFactoryInput): boolean;
  create(input: ModelFactoryInput): LanguageModelV4;
  providerInfo?(provider: string): MakaLlmProviderInfo;
  listModels?(provider: string, signal?: AbortSignal): Promise<readonly MakaLlmModelInfo[]>;
  resolveModel?(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<MakaResolvedModelInfo | undefined>;
  retryPolicy?(provider: string): MakaLlmRetryPolicy | undefined;
}

export interface MakaLlmProviderInfo {
  readonly id: string;
  readonly adapterId: string;
  readonly label?: string;
}

export interface MakaLlmModelInfo {
  readonly id: string;
  readonly label?: string;
  readonly contextWindow?: number;
}

export interface MakaResolvedModelInfo extends MakaLlmModelInfo {
  readonly provider: string;
  readonly defaultMaxTokens?: number;
  readonly reasoningEfforts?: readonly string[];
}

export interface MakaLlmRetryPolicy {
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
}

export interface MakaLlmAdapterInspection {
  readonly id: string;
  readonly priority: number;
  readonly ownerFiberId: number;
  readonly ownerFiberName: string;
  readonly realm: import('./plugin-kernel.js').ServiceRealmInspection;
}

interface RegisteredAdapter extends MakaLlmAdapterInspection {
  readonly token: symbol;
  readonly adapter: MakaLlmAdapter;
  readonly ownerContext: Context;
}

/** Provider-neutral model adapter registry, equivalent to DSH's ctx.llm seam. */
export class PluginLlmService extends Service {
  private readonly adapters: RegisteredAdapter[] = [];

  constructor(ctx: Context) {
    super(ctx, {
      name: 'llm',
      role: 'registry',
      permissions: Object.freeze(['model']),
      isolate: true,
    });
    this.register({
      id: 'maka.builtin',
      priority: -1_000,
      providers: Object.freeze(Object.keys(PROVIDER_REGISTRY)),
      supports: () => true,
      create: getAIModel,
      providerInfo: (provider) => ({
        id: provider,
        adapterId: 'maka.builtin',
        label: PROVIDER_REGISTRY[provider as keyof typeof PROVIDER_REGISTRY]?.label ?? provider,
      }),
      listModels: async (provider) =>
        (
          PROVIDER_REGISTRY[provider as keyof typeof PROVIDER_REGISTRY]?.defaultEnabledModelIds ??
          []
        ).map((id) => ({ id })),
    });
  }

  register(adapter: MakaLlmAdapter): Disposable<Promise<void>> {
    validateAdapter(adapter);
    assertScopedRegistryIdAvailable(this.ctx, this.name, this.adapters, adapter.id);
    const owner = this.ctx.fiber;
    const entry: RegisteredAdapter = Object.freeze({
      id: adapter.id,
      priority: adapter.priority ?? 0,
      ownerFiberId: owner.id,
      ownerFiberName: owner.name,
      realm: this.ctx.serviceRealm(),
      token: Symbol(adapter.id),
      adapter,
      ownerContext: this.ctx,
    });
    this.adapters.push(entry);
    try {
      return this.ctx.effect(
        () => () => {
          const index = this.adapters.findIndex(({ token }) => token === entry.token);
          if (index >= 0) this.adapters.splice(index, 1);
        },
        `llm.adapter:${adapter.id}`,
      );
    } catch (error) {
      const index = this.adapters.findIndex(({ token }) => token === entry.token);
      if (index >= 0) this.adapters.splice(index, 1);
      throw error;
    }
  }

  create(input: ModelFactoryInput): LanguageModelV4 {
    const matches = visibleScopedRegistryEntries(this.ctx, this.name, this.adapters)
      .filter(({ adapter }) => accepts(adapter, input))
      .sort((left, right) => right.priority - left.priority);
    const selected = matches[0];
    if (!selected) {
      throw new Error(`No LLM adapter accepts ${input.connection.providerType}/${input.modelId}`);
    }
    if (matches[1]?.priority === selected.priority) {
      throw new Error(`LLM adapter route is ambiguous between ${selected.id} and ${matches[1].id}`);
    }
    return this.intercept(selected.adapter.create(input));
  }

  listProviders(): readonly MakaLlmProviderInfo[] {
    const providers = new Map<string, MakaLlmProviderInfo>();
    for (const { id: adapterId, adapter } of [
      ...visibleScopedRegistryEntries(this.ctx, this.name, this.adapters),
    ].sort((left, right) => right.priority - left.priority)) {
      for (const provider of adapter.providers ?? []) {
        if (providers.has(provider)) continue;
        const info = adapter.providerInfo?.(provider);
        providers.set(
          provider,
          Object.freeze({
            id: provider,
            adapterId,
            ...(info?.label ? { label: info.label } : {}),
          }),
        );
      }
    }
    return Object.freeze([...providers.values()]);
  }

  async listModels(provider: string, signal?: AbortSignal): Promise<readonly MakaLlmModelInfo[]> {
    const adapter = this.adapterForProvider(provider);
    if (!adapter?.listModels) return Object.freeze([]);
    return Object.freeze(
      (await adapter.listModels(provider, signal)).map((model) => Object.freeze({ ...model })),
    );
  }

  async resolveModel(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<MakaResolvedModelInfo | undefined> {
    const adapter = this.adapterForProvider(provider);
    if (!adapter) return undefined;
    const resolved = await adapter.resolveModel?.(provider, model, signal);
    return resolved
      ? Object.freeze({
          ...resolved,
          ...(resolved.reasoningEfforts
            ? { reasoningEfforts: Object.freeze([...resolved.reasoningEfforts]) }
            : {}),
        })
      : Object.freeze({ id: model, provider });
  }

  retryPolicy(provider: string): MakaLlmRetryPolicy | undefined {
    const policy = this.adapterForProvider(provider)?.retryPolicy?.(provider);
    return policy ? Object.freeze({ ...policy }) : undefined;
  }

  inspect(): readonly MakaLlmAdapterInspection[] {
    return Object.freeze(
      visibleScopedRegistryEntries(this.ctx, this.name, this.adapters)
        .map(({ token: _token, adapter: _adapter, ownerContext: _ownerContext, ...entry }) =>
          Object.freeze(entry),
        )
        .sort((left, right) => right.priority - left.priority || left.id.localeCompare(right.id)),
    );
  }

  _inspectRegistrations(): readonly import('./plugin-kernel.js').ServiceRegistrationInspection[] {
    return Object.freeze(
      visibleScopedRegistryEntries(this.ctx, this.name, this.adapters).map((entry) =>
        Object.freeze({
          id: entry.id,
          priority: entry.priority,
          fiberId: entry.ownerContext.fiber.id,
          fiberName: entry.ownerContext.fiber.name,
          fiberState: entry.ownerContext.fiber.state,
          realm: entry.ownerContext.serviceRealm(),
        }),
      ),
    );
  }

  private adapterForProvider(provider: string): MakaLlmAdapter | undefined {
    return visibleScopedRegistryEntries(this.ctx, this.name, this.adapters)
      .filter(({ adapter }) => adapter.providers?.includes(provider))
      .sort((left, right) => right.priority - left.priority)[0]?.adapter;
  }

  private intercept(model: LanguageModelV4): LanguageModelV4 {
    const ctx = this.ctx;
    return Object.freeze({
      specificationVersion: model.specificationVersion,
      provider: model.provider,
      modelId: model.modelId,
      supportedUrls: model.supportedUrls,
      doGenerate: (options: Parameters<LanguageModelV4['doGenerate']>[0]) =>
        ctx.waterfall(
          'llm/generate',
          Object.freeze({ provider: model.provider, modelId: model.modelId, options }),
          () => model.doGenerate(options),
        ) as ReturnType<LanguageModelV4['doGenerate']>,
      doStream: (options: Parameters<LanguageModelV4['doStream']>[0]) =>
        ctx.waterfall(
          'llm/stream',
          Object.freeze({ provider: model.provider, modelId: model.modelId, options }),
          () => model.doStream(options),
        ) as ReturnType<LanguageModelV4['doStream']>,
    });
  }
}

function validateAdapter(adapter: MakaLlmAdapter): void {
  if (!adapter || typeof adapter !== 'object') throw new TypeError('LLM adapter is required');
  if (!/^[A-Za-z][A-Za-z0-9._:-]{0,127}$/u.test(adapter.id)) {
    throw new TypeError('LLM adapter id is invalid');
  }
  if (
    adapter.priority !== undefined &&
    (!Number.isSafeInteger(adapter.priority) || Math.abs(adapter.priority) > 1_000_000)
  ) {
    throw new TypeError(`LLM adapter priority is invalid: ${adapter.id}`);
  }
  if (
    (adapter.supports !== undefined && typeof adapter.supports !== 'function') ||
    (adapter.providers !== undefined &&
      (!Array.isArray(adapter.providers) ||
        adapter.providers.some(
          (provider) =>
            typeof provider !== 'string' || !/^[A-Za-z][A-Za-z0-9._:-]{0,127}$/u.test(provider),
        ))) ||
    (adapter.supports === undefined && (adapter.providers?.length ?? 0) === 0) ||
    typeof adapter.create !== 'function'
  ) {
    throw new TypeError(`LLM adapter implementation is invalid: ${adapter.id}`);
  }
}

function accepts(adapter: MakaLlmAdapter, input: ModelFactoryInput): boolean {
  return (
    adapter.providers?.includes(input.connection.providerType) === true ||
    adapter.supports?.(input) === true
  );
}

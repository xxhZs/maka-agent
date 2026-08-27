import type { WebSearchResponse } from '@maka/core/web-search';
import { Service, type Context, type Disposable } from './plugin-kernel.js';
import {
  assertScopedRegistryIdAvailable,
  visibleScopedRegistryEntries,
} from './plugin-scoped-registry.js';

declare module './plugin-kernel.js' {
  interface Context {
    web: PluginWebService;
  }
}

export interface MakaWebCapability {
  search(input: {
    readonly query: string;
    readonly limit: number;
    readonly sessionId: string;
    readonly abortSignal?: AbortSignal;
  }): Promise<WebSearchResponse>;
  fetch(input: {
    readonly url: string;
    readonly sessionId: string;
    readonly abortSignal?: AbortSignal;
  }): Promise<string>;
}

export interface MakaWebProvider {
  readonly id: string;
  readonly priority?: number;
  create(base: MakaWebCapability, context: Context): MakaWebCapability;
}

export interface MakaWebSearchProvider {
  readonly id: string;
  available?(): boolean;
  search(
    input: Parameters<MakaWebCapability['search']>[0],
  ): ReturnType<MakaWebCapability['search']>;
}

export interface MakaWebFetchProvider {
  readonly id: string;
  available?(): boolean;
  fetch(input: Parameters<MakaWebCapability['fetch']>[0]): ReturnType<MakaWebCapability['fetch']>;
}

export type MakaWebErrorCode =
  | 'WEB_DUPLICATE_PROVIDER'
  | 'WEB_PROVIDER_UNAVAILABLE'
  | 'WEB_PROVIDER_AMBIGUOUS';

export class MakaWebError extends Error {
  readonly name = 'MakaWebError';
  constructor(
    readonly code: MakaWebErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface MakaWebProviderInspection {
  readonly id: string;
  readonly priority: number;
  readonly ownerFiberId: number;
  readonly ownerFiberName: string;
  readonly realm: import('./plugin-kernel.js').ServiceRealmInspection;
}

interface RegisteredProvider extends MakaWebProviderInspection {
  readonly token: symbol;
  readonly provider: MakaWebProvider;
  readonly ownerContext: Context;
}

interface RegisteredOperationProvider<T extends { readonly id: string }>
  extends MakaWebProviderInspection {
  readonly token: symbol;
  readonly provider: T;
  readonly ownerContext: Context;
}

/** Scoped web provider seam used by the canonical WebSearch and WebFetch tools. */
export class PluginWebService extends Service {
  private readonly providers: RegisteredProvider[] = [];
  private readonly searchProviders: RegisteredOperationProvider<MakaWebSearchProvider>[] = [];
  private readonly fetchProviders: RegisteredOperationProvider<MakaWebFetchProvider>[] = [];

  constructor(ctx: Context) {
    super(ctx, {
      name: 'web',
      role: 'seam',
      permissions: Object.freeze(['network']),
      isolate: true,
    });
  }

  register(provider: MakaWebProvider): Disposable<Promise<void>> {
    validateProvider(provider);
    assertScopedRegistryIdAvailable(this.ctx, this.name, this.providers, provider.id);
    const owner = this.ctx.fiber;
    const entry: RegisteredProvider = Object.freeze({
      id: provider.id,
      priority: provider.priority ?? 0,
      ownerFiberId: owner.id,
      ownerFiberName: owner.name,
      realm: this.ctx.serviceRealm(),
      token: Symbol(provider.id),
      provider,
      ownerContext: this.ctx,
    });
    this.providers.push(entry);
    try {
      return this.ctx.effect(
        () => () => {
          const index = this.providers.findIndex(({ token }) => token === entry.token);
          if (index >= 0) this.providers.splice(index, 1);
        },
        `web.provider:${provider.id}`,
      );
    } catch (error) {
      const index = this.providers.findIndex(({ token }) => token === entry.token);
      if (index >= 0) this.providers.splice(index, 1);
      throw error;
    }
  }

  registerSearchProvider(provider: MakaWebSearchProvider): Disposable<Promise<void>> {
    validateOperationProvider(provider, 'search');
    return this.registerOperationProvider(this.searchProviders, provider, 'web.search.provider');
  }

  registerFetchProvider(provider: MakaWebFetchProvider): Disposable<Promise<void>> {
    validateOperationProvider(provider, 'fetch');
    return this.registerOperationProvider(this.fetchProviders, provider, 'web.fetch.provider');
  }

  resolve(base: MakaWebCapability): MakaWebCapability {
    const ordered = [...visibleScopedRegistryEntries(this.ctx, this.name, this.providers)].sort(
      (left, right) => right.priority - left.priority,
    );
    const selected = ordered[0];
    if (selected && ordered[1]?.priority === selected.priority) {
      throw new Error(
        `Web provider route is ambiguous between ${selected.id} and ${ordered[1].id}`,
      );
    }
    const capability = selected ? selected.provider.create(base, this.ctx) : base;
    if (
      !capability ||
      typeof capability.search !== 'function' ||
      typeof capability.fetch !== 'function'
    ) {
      throw new TypeError(`Web provider returned an invalid capability: ${selected?.id ?? 'base'}`);
    }
    if (
      visibleScopedRegistryEntries(this.ctx, this.name, this.searchProviders).length === 0 &&
      visibleScopedRegistryEntries(this.ctx, this.name, this.fetchProviders).length === 0
    ) {
      return capability;
    }
    return Object.freeze({
      search: (input: Parameters<MakaWebCapability['search']>[0]) => {
        const provider = this.selectOperationProvider(
          this.searchProviders,
          'searchProvider',
          'search',
        );
        return provider ? provider.search(input) : capability.search(input);
      },
      fetch: (input: Parameters<MakaWebCapability['fetch']>[0]) => {
        const provider = this.selectOperationProvider(
          this.fetchProviders,
          'fetchProvider',
          'fetch',
        );
        return provider ? provider.fetch(input) : capability.fetch(input);
      },
    });
  }

  inspect(): readonly MakaWebProviderInspection[] {
    return Object.freeze(
      visibleScopedRegistryEntries(this.ctx, this.name, this.providers)
        .map(({ token: _token, provider: _provider, ownerContext: _ownerContext, ...entry }) =>
          Object.freeze(entry),
        )
        .sort((left, right) => right.priority - left.priority || left.id.localeCompare(right.id)),
    );
  }

  _inspectRegistrations(): readonly import('./plugin-kernel.js').ServiceRegistrationInspection[] {
    return Object.freeze(
      [
        ...visibleScopedRegistryEntries(this.ctx, this.name, this.providers),
        ...visibleScopedRegistryEntries(this.ctx, this.name, this.searchProviders).map((entry) => ({
          ...entry,
          id: `search:${entry.id}`,
        })),
        ...visibleScopedRegistryEntries(this.ctx, this.name, this.fetchProviders).map((entry) => ({
          ...entry,
          id: `fetch:${entry.id}`,
        })),
      ].map((entry) =>
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

  private registerOperationProvider<T extends { readonly id: string }>(
    entries: RegisteredOperationProvider<T>[],
    provider: T,
    label: string,
  ): Disposable<Promise<void>> {
    if (
      entries.some(
        (entry) =>
          entry.id === provider.id && this.ctx.sameServiceRealm(entry.ownerContext, this.name),
      )
    ) {
      throw new MakaWebError(
        'WEB_DUPLICATE_PROVIDER',
        `Web provider is already registered in this realm: ${provider.id}`,
      );
    }
    const entry: RegisteredOperationProvider<T> = Object.freeze({
      id: provider.id,
      priority: 0,
      ownerFiberId: this.ctx.fiber.id,
      ownerFiberName: this.ctx.fiber.name,
      realm: this.ctx.serviceRealm(),
      token: Symbol(provider.id),
      provider,
      ownerContext: this.ctx,
    });
    entries.push(entry);
    return this.ctx.effect(
      () => () => {
        const index = entries.findIndex(({ token }) => token === entry.token);
        if (index >= 0) entries.splice(index, 1);
      },
      `${label}:${provider.id}`,
    );
  }

  private selectOperationProvider<T extends { readonly id: string; available?(): boolean }>(
    entries: readonly RegisteredOperationProvider<T>[],
    configKey: 'searchProvider' | 'fetchProvider',
    operation: 'search' | 'fetch',
  ): T | undefined {
    const candidates = visibleScopedRegistryEntries(this.ctx, this.name, entries).filter(
      ({ provider }) => provider.available?.() !== false,
    );
    const configured = [...this.ctx.interceptConfig(this.name)]
      .reverse()
      .map((value) =>
        value && typeof value === 'object'
          ? (value as Record<string, unknown>)[configKey]
          : undefined,
      )
      .find((value): value is string => typeof value === 'string' && value.length > 0);
    if (configured) {
      const selected = candidates.find(({ id }) => id === configured);
      if (!selected) {
        throw new MakaWebError(
          'WEB_PROVIDER_UNAVAILABLE',
          `Configured Web ${operation} provider is unavailable: ${configured}`,
        );
      }
      return selected.provider;
    }
    if (candidates.length > 1) {
      throw new MakaWebError(
        'WEB_PROVIDER_AMBIGUOUS',
        `Multiple Web ${operation} providers are available: ${candidates
          .map(({ id }) => id)
          .sort()
          .join(', ')}`,
      );
    }
    return candidates[0]?.provider;
  }
}

function validateProvider(provider: MakaWebProvider): void {
  if (!provider || typeof provider !== 'object') throw new TypeError('Web provider is required');
  if (!/^[A-Za-z][A-Za-z0-9._:-]{0,127}$/u.test(provider.id)) {
    throw new TypeError('Web provider id is invalid');
  }
  if (
    provider.priority !== undefined &&
    (!Number.isSafeInteger(provider.priority) || Math.abs(provider.priority) > 1_000_000)
  ) {
    throw new TypeError(`Web provider priority is invalid: ${provider.id}`);
  }
  if (typeof provider.create !== 'function') {
    throw new TypeError(`Web provider implementation is invalid: ${provider.id}`);
  }
}

function validateOperationProvider(
  provider: MakaWebSearchProvider | MakaWebFetchProvider,
  operation: 'search' | 'fetch',
): void {
  if (!provider || typeof provider !== 'object') throw new TypeError('Web provider is required');
  if (!/^[A-Za-z][A-Za-z0-9._:-]{0,127}$/u.test(provider.id)) {
    throw new TypeError('Web provider id is invalid');
  }
  if (provider.available !== undefined && typeof provider.available !== 'function') {
    throw new TypeError(`Web provider availability is invalid: ${provider.id}`);
  }
  if (typeof (provider as unknown as Record<string, unknown>)[operation] !== 'function') {
    throw new TypeError(`Web ${operation} provider implementation is invalid: ${provider.id}`);
  }
}

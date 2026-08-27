import type { FilesystemExecutor } from './filesystem-executor.js';
import { Service, type Context, type Disposable } from './plugin-kernel.js';
import {
  assertScopedRegistryIdAvailable,
  visibleScopedRegistryEntries,
} from './plugin-scoped-registry.js';

declare module './plugin-kernel.js' {
  interface Context {
    fs: PluginFilesystemService;
  }
}

export interface MakaFilesystemProvider {
  readonly id: string;
  readonly priority?: number;
  provide?(context: Context): FilesystemExecutor;
  create?(base: FilesystemExecutor, context: Context): FilesystemExecutor;
}

export interface MakaFilesystemProviderInspection {
  readonly id: string;
  readonly priority: number;
  readonly ownerFiberId: number;
  readonly ownerFiberName: string;
  readonly realm: import('./plugin-kernel.js').ServiceRealmInspection;
}

interface RegisteredProvider extends MakaFilesystemProviderInspection {
  readonly token: symbol;
  readonly provider: MakaFilesystemProvider;
  readonly ownerContext: Context;
}

/** Scoped filesystem provider seam consumed by Maka's built-in file tools. */
export class PluginFilesystemService extends Service {
  private readonly providers: RegisteredProvider[] = [];

  constructor(ctx: Context) {
    super(ctx, {
      name: 'fs',
      role: 'seam',
      permissions: Object.freeze(['workspace']),
      isolate: true,
    });
  }

  register(provider: MakaFilesystemProvider): Disposable<Promise<void>> {
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
        `fs.provider:${provider.id}`,
      );
    } catch (error) {
      const index = this.providers.findIndex(({ token }) => token === entry.token);
      if (index >= 0) this.providers.splice(index, 1);
      throw error;
    }
  }

  resolve(base: FilesystemExecutor): FilesystemExecutor {
    const ordered = [...visibleScopedRegistryEntries(this.ctx, this.name, this.providers)].sort(
      (left, right) => right.priority - left.priority,
    );
    const selected = ordered[0];
    if (!selected) return base;
    if (ordered[1]?.priority === selected.priority) {
      throw new Error(
        `Filesystem provider route is ambiguous between ${selected.id} and ${ordered[1].id}`,
      );
    }
    const executor =
      selected.provider.provide?.(this.ctx) ?? selected.provider.create?.(base, this.ctx);
    if (
      !executor ||
      typeof executor.execute !== 'function' ||
      typeof executor.applyPatch !== 'function'
    ) {
      throw new TypeError(`Filesystem provider returned an invalid executor: ${selected.id}`);
    }
    return executor;
  }

  inspect(): readonly MakaFilesystemProviderInspection[] {
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
      visibleScopedRegistryEntries(this.ctx, this.name, this.providers).map((entry) =>
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
}

function validateProvider(provider: MakaFilesystemProvider): void {
  if (!provider || typeof provider !== 'object') {
    throw new TypeError('Filesystem provider is required');
  }
  if (!/^[A-Za-z][A-Za-z0-9._:-]{0,127}$/u.test(provider.id)) {
    throw new TypeError('Filesystem provider id is invalid');
  }
  if (
    provider.priority !== undefined &&
    (!Number.isSafeInteger(provider.priority) || Math.abs(provider.priority) > 1_000_000)
  ) {
    throw new TypeError(`Filesystem provider priority is invalid: ${provider.id}`);
  }
  if (typeof provider.create !== 'function' && typeof provider.provide !== 'function') {
    throw new TypeError(`Filesystem provider implementation is invalid: ${provider.id}`);
  }
}

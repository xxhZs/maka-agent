import type { ShellRunLauncher } from './shell-tools.js';
import { Service, type Context, type Disposable } from './plugin-kernel.js';
import {
  assertScopedRegistryIdAvailable,
  visibleScopedRegistryEntries,
} from './plugin-scoped-registry.js';

declare module './plugin-kernel.js' {
  interface Context {
    shell: PluginShellService;
  }
}

export interface MakaShellProvider {
  readonly id: string;
  readonly priority?: number;
  provide?(context: Context): ShellRunLauncher;
  create?(base: ShellRunLauncher, context: Context): ShellRunLauncher;
}

export interface MakaShellProviderInspection {
  readonly id: string;
  readonly priority: number;
  readonly ownerFiberId: number;
  readonly ownerFiberName: string;
  readonly realm: import('./plugin-kernel.js').ServiceRealmInspection;
}

interface RegisteredProvider extends MakaShellProviderInspection {
  readonly token: symbol;
  readonly provider: MakaShellProvider;
  readonly ownerContext: Context;
}

/** Scoped subprocess provider seam consumed by Maka's canonical Bash tool. */
export class PluginShellService extends Service {
  private readonly providers: RegisteredProvider[] = [];

  constructor(ctx: Context) {
    super(ctx, {
      name: 'shell',
      role: 'seam',
      permissions: Object.freeze(['process']),
      isolate: true,
    });
  }

  register(provider: MakaShellProvider): Disposable<Promise<void>> {
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
        `shell.provider:${provider.id}`,
      );
    } catch (error) {
      const index = this.providers.findIndex(({ token }) => token === entry.token);
      if (index >= 0) this.providers.splice(index, 1);
      throw error;
    }
  }

  resolve(base: ShellRunLauncher): ShellRunLauncher {
    const ordered = [...visibleScopedRegistryEntries(this.ctx, this.name, this.providers)].sort(
      (left, right) => right.priority - left.priority,
    );
    const selected = ordered[0];
    if (!selected) return base;
    if (ordered[1]?.priority === selected.priority) {
      throw new Error(
        `Shell provider route is ambiguous between ${selected.id} and ${ordered[1].id}`,
      );
    }
    const launcher =
      selected.provider.provide?.(this.ctx) ?? selected.provider.create?.(base, this.ctx);
    if (
      !launcher ||
      typeof launcher.runForegroundBash !== 'function' ||
      typeof launcher.runBackgroundBash !== 'function'
    ) {
      throw new TypeError(`Shell provider returned an invalid launcher: ${selected.id}`);
    }
    return launcher;
  }

  inspect(): readonly MakaShellProviderInspection[] {
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

function validateProvider(provider: MakaShellProvider): void {
  if (!provider || typeof provider !== 'object') throw new TypeError('Shell provider is required');
  if (!/^[A-Za-z][A-Za-z0-9._:-]{0,127}$/u.test(provider.id)) {
    throw new TypeError('Shell provider id is invalid');
  }
  if (
    provider.priority !== undefined &&
    (!Number.isSafeInteger(provider.priority) || Math.abs(provider.priority) > 1_000_000)
  ) {
    throw new TypeError(`Shell provider priority is invalid: ${provider.id}`);
  }
  if (typeof provider.create !== 'function' && typeof provider.provide !== 'function') {
    throw new TypeError(`Shell provider implementation is invalid: ${provider.id}`);
  }
}

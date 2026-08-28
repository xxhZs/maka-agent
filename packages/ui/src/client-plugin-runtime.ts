import type { ReactNode } from 'react';
import type {
  ChildrenDecl,
  ComposedSlotProps,
  EntryKeyOf,
  OwnerOf,
  SlotComponent,
  SlotMap,
} from './ui-slots.js';
import { SlotCore } from './ui-slots.js';
import {
  ClientWorkbarRegistry,
  type ClientWorkbarPlacement,
  type ClientWorkbarViewProps,
  type ClientWorkbarViewRegistration,
} from './client-workbar.js';

export interface MakaClientPluginDescriptor {
  readonly entryId: string;
  readonly extensionId: string;
  readonly generation: number;
  readonly id: string;
  readonly bundleSha256: string;
  readonly url: string;
  readonly inject: readonly string[];
  readonly external: readonly string[];
  readonly tools: readonly string[];
}

export interface MakaClientPluginDiagnostic {
  readonly source: string;
  readonly message: string;
}

export interface MakaClientPluginSnapshot {
  readonly digest: string;
  readonly plugins: readonly MakaClientPluginDescriptor[];
  readonly diagnostics: readonly MakaClientPluginDiagnostic[];
}

export interface MakaClientBundleRegistration {
  readonly id: string;
  readonly factory: (
    require: (specifier: string) => unknown,
  ) => Record<string, unknown>;
}

export interface MakaClientModuleLoaderTarget {
  load(registration: MakaClientBundleRegistration): void;
  inspect(): {
    readonly active: readonly { id: string; bundleSha256: string }[];
    readonly failures: readonly { id: string; message: string }[];
  };
}

declare global {
  interface Window {
    /** Stable factory-registration facade used by trusted client bundles. */
    __MakaModuleLoader__?: MakaClientModuleLoaderTarget;
  }
}

type SlotName = keyof SlotMap & string;

export interface MakaClientPluginSlots {
  register<
    K extends SlotName,
    EntryKey extends EntryKeyOf<K> = EntryKeyOf<K>,
    Declared extends ChildrenDecl = Record<never, never>,
    Match = never,
  >(
    options: {
      name: K;
      children?: Declared;
      key?: EntryKey;
      id?: string;
      order?: number;
      label?: string | (() => string);
      priority?: number;
      select?: (owner: OwnerOf<K>) => Match | null;
    },
    component: SlotComponent<ComposedSlotProps<
      K,
      EntryKey,
      keyof Declared & SlotName,
      Match
    >>,
  ): () => void;
}

export interface MakaClientPluginContext {
  readonly id: string;
  readonly bundleSha256: string;
  readonly slots: MakaClientPluginSlots;
  readonly workbar: {
    register(
      view: Omit<ClientWorkbarViewRegistration, 'render'>,
      render: (props: ClientWorkbarViewProps) => ReactNode,
    ): () => void;
    open(id: string, sessionId: string, placement?: ClientWorkbarPlacement): void;
  };
  readonly tools: {
    invoke(sessionId: string, name: string, args: unknown): Promise<unknown>;
  };
  /** Own an arbitrary plugin effect. Cleanup runs in reverse registration order. */
  effect(setup: () => void | (() => void), label?: string): () => void;
  /** Add plugin CSS to the host document with lifecycle-owned removal. */
  style(css: string, label?: string): () => void;
}

export type MakaClientPluginApply = (
  context: MakaClientPluginContext,
) => void | (() => void) | Promise<void | (() => void)>;

interface StagedSlotRegistration {
  readonly options: Record<string, unknown>;
  readonly component: SlotComponent<Record<string, unknown>>;
  cancelled: boolean;
  disposer?: () => void;
}

interface StagedWorkbarRegistration {
  readonly view: ClientWorkbarViewRegistration;
  cancelled: boolean;
  disposer?: () => void;
}

interface StagedPlugin {
  readonly descriptor: MakaClientPluginDescriptor;
  readonly signature: string;
  readonly slots: StagedSlotRegistration[];
  readonly workbar: StagedWorkbarRegistration[];
  readonly effects: Array<() => void>;
  slotDisposers: Array<() => void>;
  disposed: boolean;
}

interface ActivePlugin extends StagedPlugin {}

export interface ClientPluginRuntimeOptions {
  readonly core: SlotCore;
  readonly staticModules: Readonly<Record<string, unknown>>;
  readonly workbar?: ClientWorkbarRegistry;
  readonly invokeTool?: (
    descriptor: MakaClientPluginDescriptor,
    sessionId: string,
    name: string,
    args: unknown,
  ) => Promise<unknown>;
  readonly loadBundle?: (descriptor: MakaClientPluginDescriptor) => Promise<void>;
  readonly document?: Pick<Document, 'createElement' | 'head'>;
}

function normalizeModuleId(specifier: string): string {
  return specifier.endsWith('/client')
    ? specifier.slice(0, -'/client'.length)
    : specifier;
}

function descriptorSignature(
  descriptor: MakaClientPluginDescriptor,
  byId: ReadonlyMap<string, MakaClientPluginDescriptor>,
): string {
  const dependencies = [...new Set([...descriptor.inject, ...descriptor.external])]
    .sort()
    .map((id) => `${id}@${byId.get(id)?.bundleSha256 ?? 'missing'}`);
  return [
    descriptor.entryId,
    String(descriptor.generation),
    descriptor.bundleSha256,
    ...descriptor.tools.slice().sort(),
    ...dependencies,
  ].join('\u0000');
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Renderer-side peer of DSH's client module table.
 *
 * Bundles are classic scripts whose only top-level action is
 * `window.__MakaModuleLoader__.load({ id, factory })`. The factory is then
 * materialized against host-owned React/JSX singletons and activated through
 * one lifecycle context. Slot registrations are staged until activation
 * succeeds, then swapped in one microtask turn so a failed update leaves the
 * current plugin live.
 */
export class ClientPluginRuntime {
  readonly #core: SlotCore;
  readonly #staticModules: Readonly<Record<string, unknown>>;
  readonly #workbar: ClientWorkbarRegistry | undefined;
  readonly #invokeTool: ClientPluginRuntimeOptions['invokeTool'];
  readonly #loadBundle: (descriptor: MakaClientPluginDescriptor) => Promise<void>;
  readonly #factories = new Map<string, MakaClientBundleRegistration['factory']>();
  readonly #moduleCache = new Map<string, Record<string, unknown>>();
  readonly #active = new Map<string, ActivePlugin>();
  readonly #failed = new Map<string, string>();
  readonly #failureMessages = new Map<string, string>();
  readonly #scripts = new Map<string, HTMLScriptElement>();
  readonly #document: Pick<Document, 'createElement' | 'head'> | undefined;
  #pendingRegistration: MakaClientPluginDescriptor | undefined;
  #closed = false;

  constructor(options: ClientPluginRuntimeOptions) {
    this.#core = options.core;
    this.#staticModules = options.staticModules;
    this.#workbar = options.workbar;
    this.#invokeTool = options.invokeTool;
    this.#document = options.document ?? globalThis.document;
    this.#loadBundle = options.loadBundle ?? ((descriptor) => this.#loadScript(descriptor));
  }

  readonly loader: MakaClientModuleLoaderTarget = {
    load: (registration) => this.registerBundle(registration),
    inspect: () => ({ active: this.inspect(), failures: this.failures() }),
  };

  registerBundle(registration: MakaClientBundleRegistration): void {
    const pending = this.#pendingRegistration;
    if (!pending) throw new Error('client plugin bundle registered outside a load request');
    if (registration.id !== pending.id) {
      throw new Error(
        `client plugin bundle registered as "${registration.id}", expected "${pending.id}"`,
      );
    }
    if (typeof registration.factory !== 'function') {
      throw new Error(`client plugin "${registration.id}" did not register a factory`);
    }
    const key = this.#moduleKey(pending);
    if (this.#factories.has(key)) {
      throw new Error(`client plugin "${registration.id}" registered its factory twice`);
    }
    this.#factories.set(key, registration.factory);
  }

  inspect(): readonly { id: string; bundleSha256: string }[] {
    return Object.freeze(
      [...this.#active.values()]
        .map(({ descriptor }) => Object.freeze({
          id: descriptor.id,
          bundleSha256: descriptor.bundleSha256,
        }))
        .sort((left, right) => compareStrings(left.id, right.id)),
    );
  }

  failures(): readonly { id: string; message: string }[] {
    return Object.freeze(
      [...this.#failureMessages]
        .map(([id, message]) => Object.freeze({ id, message }))
        .sort((left, right) => compareStrings(left.id, right.id)),
    );
  }

  async reconcile(snapshot: MakaClientPluginSnapshot): Promise<void> {
    if (this.#closed) throw new Error('client plugin runtime is closed');
    const byId = new Map(snapshot.plugins.map((descriptor) => [descriptor.id, descriptor]));
    const ordered = this.#order(snapshot.plugins, byId);
    const staged = new Map<string, StagedPlugin>();

    for (const descriptor of ordered) {
      const signature = descriptorSignature(descriptor, byId);
      if (this.#active.get(descriptor.id)?.signature === signature) continue;
      if (this.#failed.get(descriptor.id) === signature) continue;
      try {
        await this.#ensureFactory(descriptor);
        staged.set(
          descriptor.id,
          await this.#stage(descriptor, signature, byId, staged),
        );
      } catch (error) {
        this.#failed.set(descriptor.id, signature);
        this.#failureMessages.set(descriptor.id, asError(error).message);
        await this.#disposeStaged(staged.get(descriptor.id));
        staged.delete(descriptor.id);
        // A dependent cannot be activated against a failed candidate graph.
        for (const candidate of ordered) {
          if (
            candidate.inject.includes(descriptor.id) ||
            candidate.external.map(normalizeModuleId).includes(descriptor.id)
          ) {
            this.#failed.set(candidate.id, descriptorSignature(candidate, byId));
          }
        }
      }
    }

    // Commit after every candidate has activated successfully. SlotCore batches
    // listener notification in a microtask, so dispose/register is one render.
    const committed: StagedPlugin[] = [];
    try {
      for (const descriptor of ordered) {
        const candidate = staged.get(descriptor.id);
        if (!candidate) continue;
        const current = this.#active.get(descriptor.id);
        this.#disposeSlots(current);
        try {
          this.#commitSlots(candidate);
        } catch (error) {
          this.#disposeSlots(candidate);
          if (current) this.#commitSlots(current);
          throw error;
        }
        this.#active.set(descriptor.id, candidate);
        committed.push(candidate);
        if (current) await this.#disposeEffects(current);
        this.#failed.delete(descriptor.id);
        this.#failureMessages.delete(descriptor.id);
      }
    } catch (error) {
      for (const candidate of staged.values()) {
        if (!committed.includes(candidate)) await this.#disposeStaged(candidate);
      }
      throw error;
    }

    for (const [id, current] of [...this.#active]) {
      if (byId.has(id)) continue;
      this.#active.delete(id);
      this.#failureMessages.delete(id);
      await this.#dispose(current);
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const active = [...this.#active.values()].reverse();
    this.#active.clear();
    await Promise.allSettled(active.map((plugin) => this.#dispose(plugin)));
    for (const script of this.#scripts.values()) script.remove();
    this.#scripts.clear();
    this.#factories.clear();
    this.#moduleCache.clear();
    this.#failureMessages.clear();
  }

  async #ensureFactory(descriptor: MakaClientPluginDescriptor): Promise<void> {
    const key = this.#moduleKey(descriptor);
    if (this.#factories.has(key)) return;
    if (this.#pendingRegistration) {
      throw new Error('client plugin bundle loads must be serialized');
    }
    this.#pendingRegistration = descriptor;
    try {
      await this.#loadBundle(descriptor);
      if (!this.#factories.has(key)) {
        throw new Error(`client plugin "${descriptor.id}" loaded without registering a factory`);
      }
    } finally {
      this.#pendingRegistration = undefined;
    }
  }

  async #loadScript(descriptor: MakaClientPluginDescriptor): Promise<void> {
    const document = this.#document;
    if (!document) throw new Error('client plugin script loading requires a document');
    const script = document.createElement('script');
    script.async = true;
    script.src = descriptor.url;
    script.dataset.makaClientPlugin = descriptor.id;
    await new Promise<void>((resolve, reject) => {
      script.addEventListener('load', () => resolve(), { once: true });
      script.addEventListener(
        'error',
        () => reject(new Error(`failed to load ${descriptor.url}`)),
        { once: true },
      );
      document.head.append(script);
    });
    this.#scripts.set(this.#moduleKey(descriptor), script);
  }

  async #stage(
    descriptor: MakaClientPluginDescriptor,
    signature: string,
    byId: ReadonlyMap<string, MakaClientPluginDescriptor>,
    staged: ReadonlyMap<string, StagedPlugin>,
  ): Promise<StagedPlugin> {
    const exports = this.#materialize(descriptor, byId, staged, new Set());
    const apply = exports.apply ?? exports.default;
    if (typeof apply !== 'function') {
      throw new Error(`client plugin "${descriptor.id}" must export apply(ctx) or default(ctx)`);
    }
    const candidate: StagedPlugin = {
      descriptor,
      signature,
      slots: [],
      workbar: [],
      effects: [],
      slotDisposers: [],
      disposed: false,
    };
    const context = this.#context(candidate);
    try {
      const cleanup = await (apply as MakaClientPluginApply)(context);
      if (typeof cleanup === 'function') candidate.effects.push(cleanup);
      return candidate;
    } catch (error) {
      await this.#disposeStaged(candidate);
      throw error;
    }
  }

  #context(plugin: StagedPlugin): MakaClientPluginContext {
    const own = (cleanup: () => void): (() => void) => {
      let live = true;
      const disposer = () => {
        if (!live) return;
        live = false;
        cleanup();
      };
      plugin.effects.push(disposer);
      return disposer;
    };
    const slots: MakaClientPluginSlots = {
      register: ((options: Record<string, unknown>, component: SlotComponent<Record<string, unknown>>) => {
        const registration: StagedSlotRegistration = {
          options: Object.freeze({ ...options, registrant: plugin.descriptor.id }),
          component,
          cancelled: false,
        };
        plugin.slots.push(registration);
        return () => {
          registration.cancelled = true;
          registration.disposer?.();
          registration.disposer = undefined;
        };
      }) as unknown as MakaClientPluginSlots['register'],
    };
    const workbar = {
      register: (
        view: Omit<ClientWorkbarViewRegistration, 'render'>,
        render: (props: ClientWorkbarViewProps) => ReactNode,
      ) => {
        if (!this.#workbar) throw new Error('client Workbar is unavailable');
        const registration: StagedWorkbarRegistration = {
          view: Object.freeze({ ...view, render }),
          cancelled: false,
        };
        plugin.workbar.push(registration);
        return () => {
          registration.cancelled = true;
          registration.disposer?.();
          registration.disposer = undefined;
        };
      },
      open: (
        id: string,
        sessionId: string,
        placement: ClientWorkbarPlacement = 'right',
      ) => {
        if (!this.#workbar) throw new Error('client Workbar is unavailable');
        this.#workbar.open(plugin.descriptor.id, id, sessionId, placement);
      },
    };
    return Object.freeze({
      id: plugin.descriptor.id,
      bundleSha256: plugin.descriptor.bundleSha256,
      slots,
      workbar: Object.freeze(workbar),
      tools: Object.freeze({
        invoke: async (sessionId: string, name: string, args: unknown) => {
          if (!plugin.descriptor.tools.includes(name)) {
            throw new Error(`client Tool is not declared: ${name}`);
          }
          if (!this.#invokeTool) throw new Error('client Tool bridge is unavailable');
          return this.#invokeTool(plugin.descriptor, sessionId, name, args);
        },
      }),
      effect: (setup: () => void | (() => void)) => {
        const cleanup = setup();
        return own(typeof cleanup === 'function' ? cleanup : () => undefined);
      },
      style: (css: string, label?: string) => {
        if (typeof css !== 'string') throw new Error('client plugin CSS must be a string');
        const document = this.#document;
        if (!document) throw new Error('client plugin CSS requires a document');
        const element = document.createElement('style');
        element.dataset.makaClientPlugin = plugin.descriptor.id;
        if (label) element.dataset.makaClientPluginStyle = label;
        element.textContent = css;
        document.head.append(element);
        return own(() => element.remove());
      },
    });
  }

  #materialize(
    descriptor: MakaClientPluginDescriptor,
    byId: ReadonlyMap<string, MakaClientPluginDescriptor>,
    staged: ReadonlyMap<string, StagedPlugin>,
    visiting: Set<string>,
  ): Record<string, unknown> {
    const key = this.#moduleKey(descriptor);
    const cached = this.#moduleCache.get(key);
    if (cached) return cached;
    if (visiting.has(descriptor.id)) {
      throw new Error(`client plugin module cycle at "${descriptor.id}"`);
    }
    const factory = this.#factories.get(key);
    if (!factory) throw new Error(`client plugin factory is unavailable for "${descriptor.id}"`);
    const nextVisiting = new Set(visiting).add(descriptor.id);
    const exports = factory((specifier) => {
      const normalized = normalizeModuleId(specifier);
      if (Object.hasOwn(this.#staticModules, specifier)) return this.#staticModules[specifier];
      if (Object.hasOwn(this.#staticModules, normalized)) return this.#staticModules[normalized];
      const dependency = byId.get(normalized);
      if (!dependency || !descriptor.external.map(normalizeModuleId).includes(normalized)) {
        throw new Error(
          `client plugin "${descriptor.id}" requested undeclared module "${specifier}"`,
        );
      }
      // A dependency candidate is materialized by its exact bundle digest;
      // activation ordering is governed separately by inject/external edges.
      void staged;
      return this.#materialize(dependency, byId, staged, nextVisiting);
    });
    if (!exports || typeof exports !== 'object') {
      throw new Error(`client plugin "${descriptor.id}" factory must return exports`);
    }
    this.#moduleCache.set(key, exports);
    return exports;
  }

  #order(
    descriptors: readonly MakaClientPluginDescriptor[],
    byId: ReadonlyMap<string, MakaClientPluginDescriptor>,
  ): MakaClientPluginDescriptor[] {
    const ordered: MakaClientPluginDescriptor[] = [];
    const state = new Map<string, 'visiting' | 'visited'>();
    const visit = (descriptor: MakaClientPluginDescriptor) => {
      const current = state.get(descriptor.id);
      if (current === 'visited') return;
      if (current === 'visiting') {
        throw new Error(`client plugin dependency cycle at "${descriptor.id}"`);
      }
      state.set(descriptor.id, 'visiting');
      for (const dependencyId of [...descriptor.inject, ...descriptor.external.map(normalizeModuleId)]) {
        const dependency = byId.get(dependencyId);
        if (!dependency) {
          throw new Error(
            `client plugin "${descriptor.id}" depends on missing "${dependencyId}"`,
          );
        }
        visit(dependency);
      }
      state.set(descriptor.id, 'visited');
      ordered.push(descriptor);
    };
    for (const descriptor of [...descriptors].sort((a, b) => compareStrings(a.id, b.id))) {
      visit(descriptor);
    }
    return ordered;
  }

  #commitSlots(plugin: StagedPlugin): void {
    plugin.slotDisposers = plugin.slots
      .filter(({ cancelled }) => !cancelled)
      .map((registration) => {
        const disposer = this.#core.register(
          registration.options as never,
          registration.component as never,
        );
        registration.disposer = disposer;
        return disposer;
      });
    for (const registration of plugin.workbar) {
      if (registration.cancelled) continue;
      registration.disposer = this.#workbar?.register(plugin.descriptor.id, registration.view);
    }
  }

  #disposeSlots(plugin: StagedPlugin | undefined): void {
    if (!plugin) return;
    for (const dispose of plugin.slotDisposers.reverse()) dispose();
    plugin.slotDisposers = [];
    for (const registration of plugin.slots) registration.disposer = undefined;
    for (const registration of [...plugin.workbar].reverse()) {
      registration.disposer?.();
      registration.disposer = undefined;
    }
  }

  async #disposeEffects(plugin: StagedPlugin): Promise<void> {
    if (plugin.disposed) return;
    plugin.disposed = true;
    for (const dispose of plugin.effects.reverse()) {
      await Promise.resolve().then(dispose).catch(() => undefined);
    }
    plugin.effects.length = 0;
  }

  async #disposeStaged(plugin: StagedPlugin | undefined): Promise<void> {
    if (!plugin) return;
    this.#disposeSlots(plugin);
    await this.#disposeEffects(plugin);
  }

  async #dispose(plugin: StagedPlugin): Promise<void> {
    this.#disposeSlots(plugin);
    await this.#disposeEffects(plugin);
  }

  #moduleKey(descriptor: MakaClientPluginDescriptor): string {
    return `${descriptor.id}\u0000${descriptor.bundleSha256}`;
  }
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

export type MakaClientPluginRenderable = ReactNode;

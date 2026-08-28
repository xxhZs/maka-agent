import {
  Component,
  createContext,
  Fragment,
  type ReactNode,
  useContext,
  useSyncExternalStore,
} from 'react';

/**
 * UI slot contract table. Slot owners extend this interface with declaration
 * merging from their own package.
 */
export interface SlotMap {
  root: { kind: 'single'; scope: 'root'; owner: { children: ReactNode } };
}

export type SlotKind = 'single' | 'list' | 'keyed' | 'chain';
export type SlotScope = 'root' | 'session-maybe' | 'session';

export interface SlotEntryDef {
  kind: SlotKind;
  scope: SlotScope;
  owner?: object;
  keyProps?: Record<string, object>;
}

export type SlotSpec<E extends SlotEntryDef = SlotEntryDef> = {
  kind: E['kind'];
  scope: E['scope'];
};

export type ChildrenDecl = {
  [K in keyof SlotMap & string]?: SlotSpec<SlotMap[K]>;
};

export interface GlobalStandardProps {}

export interface SessionStandardProps {
  sessionId: string;
}

export interface SessionMaybeStandardProps {
  sessionId: string | undefined;
}

export type OwnerOf<K extends keyof SlotMap & string> =
  SlotMap[K] extends { owner: infer Owner extends object } ? Owner : object;

export type EntryKeyOf<K extends keyof SlotMap & string> =
  SlotMap[K] extends { kind: 'keyed'; keyProps: infer Props extends object }
    ? keyof Props & string
    : string;

export type KeyPropsOf<
  K extends keyof SlotMap & string,
  EntryKey extends EntryKeyOf<K>,
> = SlotMap[K] extends { kind: 'keyed'; keyProps: infer Props extends object }
  ? EntryKey extends keyof Props
    ? Props[EntryKey] extends object
      ? Props[EntryKey]
      : never
    : never
  : object;

export type ScopeOf<K extends keyof SlotMap & string> = SlotMap[K]['scope'];

export type PropsRuntime<
  K extends keyof SlotMap & string,
  EntryKey extends EntryKeyOf<K> = EntryKeyOf<K>,
> = OwnerOf<K>
  & KeyPropsOf<K, EntryKey>
  & GlobalStandardProps
  & (ScopeOf<K> extends 'session'
    ? SessionStandardProps
    : ScopeOf<K> extends 'session-maybe'
      ? SessionMaybeStandardProps
      : object);

export interface RenderSlotOptions<EntryKey extends string = string> {
  entryKey?: EntryKey;
  only?: string;
  fallback?: ReactNode;
}

export interface RenderChainOptions {
  fallback?: ReactNode;
  /** Keep the fallback mounted and hide it while a chain entry is elected. */
  overlay?: boolean;
}

export type ChainSelect<Owner extends object, Match> = (owner: Owner) => Match | null;

type ChainKeysOf<Keys extends keyof SlotMap & string> = Keys extends unknown
  ? SlotMap[Keys]['kind'] extends 'chain'
    ? Keys
    : never
  : never;

type NonChainKeysOf<Keys extends keyof SlotMap & string> = Exclude<Keys, ChainKeysOf<Keys>>;

export type PropsRenderSlots<Keys extends keyof SlotMap & string> = {
  renderSlot: <
    K extends NonChainKeysOf<Keys>,
    EntryKey extends EntryKeyOf<K> = EntryKeyOf<K>,
  >(
    name: K,
    owner: OwnerOf<K> & KeyPropsOf<K, NoInfer<EntryKey>>,
    options?: RenderSlotOptions<EntryKey>,
  ) => ReactNode;
  readonly __renders?: ((name: Keys) => void) | undefined;
} & ([ChainKeysOf<Keys>] extends [never]
  ? object
  : {
      renderSlotChain: <K extends ChainKeysOf<Keys>>(
        name: K,
        owner: OwnerOf<K>,
        options?: RenderChainOptions,
      ) => ReactNode;
    });

export type MatchedShare<K extends keyof SlotMap & string, Match> =
  SlotMap[K]['kind'] extends 'chain' ? { matched: Match } : object;

export type ComposedSlotProps<
  K extends keyof SlotMap & string,
  EntryKey extends EntryKeyOf<K>,
  Children extends keyof SlotMap & string,
  Match = never,
> = PropsRuntime<K, EntryKey> & PropsRenderSlots<Children> & MatchedShare<K, Match>;

export type SlotComponent<Props> = (props: Props) => ReactNode;

export type SlotLabel = string | (() => string);

export function resolveSlotLabel(label: SlotLabel | undefined): string | undefined {
  return typeof label === 'function' ? label() : label;
}

type KindOptions<
  K extends keyof SlotMap & string,
  EntryKey extends EntryKeyOf<K>,
  Match,
> = SlotMap[K]['kind'] extends 'keyed'
  ? { key: EntryKey; priority?: number }
  : SlotMap[K]['kind'] extends 'list'
    ? { id: string; order?: number; label?: SlotLabel; priority?: number }
    : SlotMap[K]['kind'] extends 'chain'
      ? { select: ChainSelect<OwnerOf<K>, Match>; priority?: number }
      : { priority?: number };

type RegisterOptions<
  K extends keyof SlotMap & string,
  EntryKey extends EntryKeyOf<K>,
  Declared extends ChildrenDecl,
  Match,
> = {
  name: K;
  children?: Declared;
  registrant?: string;
} & KindOptions<K, EntryKey, Match>;

interface ErasedRegisterOptions {
  name: string;
  key?: string;
  id?: string;
  order?: number;
  label?: SlotLabel;
  priority?: number;
  select?: (owner: never) => unknown;
  children?: Record<string, SlotSpec>;
  registrant?: string;
}

export interface StoredSlotEntry {
  component: SlotComponent<Record<string, unknown>>;
  options: {
    key?: string;
    id?: string;
    order?: number;
    label?: SlotLabel;
    priority?: number;
  };
  select?: ((owner: never) => unknown) | undefined;
  children?: Readonly<Record<string, SlotSpec>> | undefined;
  registrant?: string | undefined;
}

interface SlotRecord {
  spec: SlotSpec | undefined;
  declaredBy: string | undefined;
  parent: string | undefined;
  entries: readonly StoredSlotEntry[];
  version: number;
  listeners: Set<() => void>;
}

const EMPTY_ENTRIES: readonly StoredSlotEntry[] = Object.freeze([]);

export interface LiveSlotOccupant {
  registrant?: string;
  key?: string;
  id?: string;
  order?: number;
  priority: number;
  active: boolean;
}

export interface LiveSlotNode {
  name: string;
  kind: SlotKind;
  scope: SlotScope;
  declaredBy?: string;
  occupants: LiveSlotOccupant[];
  children: LiveSlotNode[];
}

/**
 * React-free slot registry. `root` is its single a-priori declaration; every
 * other slot exists only while a live parent registration declares it.
 */
export class SlotCore {
  private readonly records = new Map<string, SlotRecord>();
  private readonly dirty = new Set<SlotRecord>();
  private readonly abdicated = new WeakSet<StoredSlotEntry>();
  private flushScheduled = false;

  constructor() {
    const root = this.record('root');
    root.spec = { kind: 'single', scope: 'root' };
    root.declaredBy = '(built-in)';
  }

  register<
    K extends keyof SlotMap & string,
    const EntryKey extends EntryKeyOf<K> = EntryKeyOf<K>,
    const Declared extends ChildrenDecl = Record<never, never>,
    Match = never,
  >(
    options: RegisterOptions<K, EntryKey, Declared, Match>,
    component: SlotComponent<ComposedSlotProps<
      K,
      NoInfer<EntryKey>,
      keyof NoInfer<Declared> & keyof SlotMap & string,
      NoInfer<Match>
    >>,
  ): () => void;
  register(options: ErasedRegisterOptions, component: unknown): () => void {
    const record = this.records.get(options.name);
    if (!record?.spec) {
      throw new Error(`slot "${options.name}" is not declared`);
    }

    const priority = options.priority ?? 0;
    const samePriority = (entry: StoredSlotEntry) => (entry.options.priority ?? 0) === priority;
    switch (record.spec.kind) {
      case 'single':
        if (record.entries.some(samePriority)) {
          throw new Error(`single slot "${options.name}" already has a registration at priority ${priority}`);
        }
        break;
      case 'keyed':
        if (options.key === undefined) {
          throw new Error(`keyed slot "${options.name}" requires options.key`);
        }
        if (record.entries.some((entry) => entry.options.key === options.key && samePriority(entry))) {
          throw new Error(
            `keyed slot "${options.name}" already has key "${options.key}" at priority ${priority}`,
          );
        }
        break;
      case 'list':
        if (options.id === undefined) {
          throw new Error(`list slot "${options.name}" requires options.id`);
        }
        if (record.entries.some((entry) => entry.options.id === options.id && samePriority(entry))) {
          throw new Error(
            `list slot "${options.name}" already has id "${options.id}" at priority ${priority}`,
          );
        }
        break;
      case 'chain':
        if (options.select === undefined) {
          throw new Error(`chain slot "${options.name}" requires options.select`);
        }
        break;
    }

    if (options.children) {
      for (const childName of Object.keys(options.children)) {
        const child = this.records.get(childName);
        if (child?.spec) {
          throw new Error(
            `slot "${childName}" is already declared by ${child.declaredBy ?? 'another entry'}`,
          );
        }
      }
    }

    const entry: StoredSlotEntry = {
      component: component as SlotComponent<Record<string, unknown>>,
      options: {
        ...(options.key === undefined ? {} : { key: options.key }),
        ...(options.id === undefined ? {} : { id: options.id }),
        ...(options.order === undefined ? {} : { order: options.order }),
        ...(options.label === undefined ? {} : { label: options.label }),
        ...(options.priority === undefined ? {} : { priority: options.priority }),
      },
      ...(options.select === undefined ? {} : { select: options.select }),
      ...(options.children === undefined ? {} : { children: options.children }),
      ...(options.registrant === undefined ? {} : { registrant: options.registrant }),
    };

    const entries = [...record.entries, entry];
    entries.sort(record.spec.kind === 'list'
      ? (left, right) =>
          ((left.options.priority ?? 0) - (right.options.priority ?? 0))
          || ((left.options.order ?? 0) - (right.options.order ?? 0))
      : (left, right) => (left.options.priority ?? 0) - (right.options.priority ?? 0));
    record.entries = entries;
    this.markDirty(record);

    if (options.children) {
      for (const [childName, childSpec] of Object.entries(options.children)) {
        const child = this.record(childName);
        child.spec = childSpec;
        child.parent = options.name;
        child.declaredBy = options.registrant
          ? `${options.registrant} in "${options.name}"`
          : `an entry in "${options.name}"`;
        this.markDirty(child);
      }
    }

    let live = true;
    return () => {
      if (!live || !record.entries.includes(entry)) return;
      live = false;
      record.entries = record.entries.filter((candidate) => candidate !== entry);
      this.markDirty(record);
      this.releaseEntry(entry);
    };
  }

  isLive(entry: StoredSlotEntry): boolean {
    for (const record of this.records.values()) {
      if (record.entries.includes(entry)) return true;
    }
    return false;
  }

  entries(name: string): readonly StoredSlotEntry[] {
    return this.records.get(name)?.entries ?? EMPTY_ENTRIES;
  }

  entriesOfSlot(name: string): readonly StoredSlotEntry[] {
    const record = this.records.get(name);
    if (!record?.spec) return EMPTY_ENTRIES;
    if (record.spec.kind === 'chain') return record.entries;

    const winners: StoredSlotEntry[] = [];
    const seen = new Set<string | undefined>();
    for (const entry of record.entries) {
      if (this.abdicated.has(entry)) continue;
      const cell = record.spec.kind === 'keyed'
        ? entry.options.key
        : record.spec.kind === 'list'
          ? entry.options.id
          : undefined;
      if (seen.has(cell)) continue;
      seen.add(cell);
      winners.push(entry);
    }
    return winners;
  }

  spec<K extends keyof SlotMap & string>(name: K): SlotSpec<SlotMap[K]> | undefined {
    return this.records.get(name)?.spec as SlotSpec<SlotMap[K]> | undefined;
  }

  specDynamic(name: string): SlotSpec | undefined {
    return this.records.get(name)?.spec;
  }

  getVersion(name: string): number {
    return this.records.get(name)?.version ?? 0;
  }

  subscribe(name: string, listener: () => void): () => void {
    const record = this.record(name);
    record.listeners.add(listener);
    return () => record.listeners.delete(listener);
  }

  reportEntryError(name: string, entry: StoredSlotEntry, options: { abdicate: boolean }): void {
    if (!options.abdicate || this.abdicated.has(entry)) return;
    this.abdicated.add(entry);
    const record = this.records.get(name);
    if (record) this.markDirty(record);
  }

  snapshot(root?: string): LiveSlotNode[] {
    const build = (name: string, ancestors: Set<string>): LiveSlotNode | undefined => {
      const record = this.records.get(name);
      if (!record?.spec || ancestors.has(name)) return undefined;
      const nextAncestors = new Set(ancestors).add(name);
      const active = new Set(this.entriesOfSlot(name));
      const children = [...this.records.entries()]
        .filter(([, child]) => child.spec && child.parent === name)
        .flatMap(([childName]) => {
          const child = build(childName, nextAncestors);
          return child ? [child] : [];
        });
      return {
        name,
        kind: record.spec.kind,
        scope: record.spec.scope,
        ...(record.declaredBy === undefined ? {} : { declaredBy: record.declaredBy }),
        occupants: record.entries.map((entry) => ({
          ...(entry.registrant === undefined ? {} : { registrant: entry.registrant }),
          ...(entry.options.key === undefined ? {} : { key: entry.options.key }),
          ...(entry.options.id === undefined ? {} : { id: entry.options.id }),
          ...(entry.options.order === undefined ? {} : { order: entry.options.order }),
          priority: entry.options.priority ?? 0,
          active: active.has(entry),
        })),
        children,
      };
    };

    if (root !== undefined) {
      const node = build(root, new Set());
      return node ? [node] : [];
    }
    return [...this.records.entries()]
      .filter(([, record]) => record.spec && !record.parent)
      .flatMap(([name]) => {
        const node = build(name, new Set());
        return node ? [node] : [];
      });
  }

  private releaseEntry(entry: StoredSlotEntry): void {
    if (!entry.children) return;
    for (const childName of Object.keys(entry.children)) {
      const child = this.records.get(childName);
      if (!child) continue;
      const descendants = child.entries;
      child.spec = undefined;
      child.declaredBy = undefined;
      child.parent = undefined;
      child.entries = EMPTY_ENTRIES;
      this.markDirty(child);
      for (const descendant of descendants) this.releaseEntry(descendant);
    }
  }

  private record(name: string): SlotRecord {
    let record = this.records.get(name);
    if (!record) {
      record = {
        spec: undefined,
        declaredBy: undefined,
        parent: undefined,
        entries: EMPTY_ENTRIES,
        version: 0,
        listeners: new Set(),
      };
      this.records.set(name, record);
    }
    return record;
  }

  private markDirty(record: SlotRecord): void {
    record.version += 1;
    this.dirty.add(record);
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    queueMicrotask(() => {
      this.flushScheduled = false;
      const dirty = [...this.dirty];
      this.dirty.clear();
      for (const item of dirty) {
        for (const listener of [...item.listeners]) listener();
      }
    });
  }
}

interface SlotHostValue {
  core: SlotCore;
  sessionId: string | undefined;
  globalProps: object;
  sessionProps: object;
  sessionMaybeProps: object;
}

const SlotHostContext = createContext<SlotHostValue | null>(null);

export interface SlotProviderProps {
  core: SlotCore;
  sessionId?: string;
  globalProps?: GlobalStandardProps;
  sessionProps?: Omit<SessionStandardProps, 'sessionId'>;
  sessionMaybeProps?: Omit<SessionMaybeStandardProps, 'sessionId'>;
  children: ReactNode;
}

export function SlotProvider({
  core,
  sessionId,
  globalProps = {},
  sessionProps = {},
  sessionMaybeProps = {},
  children,
}: SlotProviderProps): ReactNode {
  return (
    <SlotHostContext.Provider
      value={{ core, sessionId, globalProps, sessionProps, sessionMaybeProps }}
    >
      {children}
    </SlotHostContext.Provider>
  );
}

function makeRenderSlots(entry: StoredSlotEntry, host: SlotHostValue): Record<string, unknown> {
  if (!entry.children) return {};
  const assertOwned = (name: string): SlotSpec => {
    if (!host.core.isLive(entry)) {
      throw new Error(`cannot render slot "${name}" from a disposed registration`);
    }
    const spec = entry.children?.[name];
    if (!spec) throw new Error(`slot "${name}" is not declared by this registration`);
    return spec;
  };
  return {
    renderSlot: (name: string, owner: object, options?: RenderSlotOptions) => {
      const spec = assertOwned(name);
      if (spec.kind === 'chain') {
        throw new Error(`slot "${name}" is chain-kind; use renderSlotChain`);
      }
      return <DynamicSlotOutlet name={name} owner={owner} options={options} />;
    },
    renderSlotChain: (name: string, owner: object, options?: RenderChainOptions) => {
      const spec = assertOwned(name);
      if (spec.kind !== 'chain') {
        throw new Error(`slot "${name}" is ${spec.kind}-kind; use renderSlot`);
      }
      return <DynamicSlotOutlet name={name} owner={owner} options={options} />;
    },
  };
}

function propsForEntry(
  host: SlotHostValue,
  scope: SlotScope,
  owner: object,
  entry: StoredSlotEntry,
): Record<string, unknown> {
  const scoped = scope === 'session'
    ? { ...host.sessionProps, sessionId: host.sessionId }
    : scope === 'session-maybe'
      ? { ...host.sessionMaybeProps, sessionId: host.sessionId }
      : {};
  return {
    ...host.globalProps,
    ...scoped,
    ...makeRenderSlots(entry, host),
    ...owner,
  };
}

class SlotEntryBoundary extends Component<
  { name: string; entry: StoredSlotEntry; core: SlotCore; abdicate: boolean; children: ReactNode },
  { failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(): void {
    this.props.core.reportEntryError(this.props.name, this.props.entry, {
      abdicate: this.props.abdicate,
    });
  }

  override render(): ReactNode {
    return this.state.failed ? <span data-slot-error={this.props.name} /> : this.props.children;
  }
}

let nextEntryId = 1;
const entryIds = new WeakMap<StoredSlotEntry, number>();

function entryId(entry: StoredSlotEntry): number {
  let value = entryIds.get(entry);
  if (value === undefined) {
    value = nextEntryId++;
    entryIds.set(entry, value);
  }
  return value;
}

function DynamicSlotOutlet({
  name,
  owner,
  options,
  required = false,
}: {
  name: string;
  owner: object;
  options?: RenderSlotOptions & RenderChainOptions;
  required?: boolean;
}): ReactNode {
  const host = useContext(SlotHostContext);
  const core = host?.core;
  useSyncExternalStore(
    (listener) => core?.subscribe(name, listener) ?? (() => {}),
    () => core?.getVersion(name) ?? 0,
    () => core?.getVersion(name) ?? 0,
  );

  if (!host || !core) {
    if (required) throw new Error(`required slot "${name}" rendered without SlotProvider`);
    return <>{options?.fallback ?? null}</>;
  }

  const spec = core.specDynamic(name);
  if (!spec) return null;
  if (spec.scope === 'session' && host.sessionId === undefined) {
    return <>{options?.fallback ?? null}</>;
  }

  const allEntries = core.entries(name);
  const winners = core.entriesOfSlot(name);
  const renderEntry = (entry: StoredSlotEntry, entryOwner: object = owner) => {
    const Component = entry.component;
    return (
      <SlotEntryBoundary
        name={name}
        entry={entry}
        core={core}
        abdicate={spec.kind !== 'chain'}
        key={entryId(entry)}
      >
        <Component {...propsForEntry(host, spec.scope, entryOwner, entry)} />
      </SlotEntryBoundary>
    );
  };

  if (spec.kind === 'single') {
    const entry = winners[0];
    if (!entry) {
      if (allEntries.length > 0) return <span data-slot-error={name} />;
      if (required) throw new Error(`required slot "${name}" has no registration`);
      return <>{options?.fallback ?? null}</>;
    }
    return renderEntry(entry);
  }

  if (spec.kind === 'keyed') {
    const entry = winners.find((candidate) => candidate.options.key === options?.entryKey);
    if (!entry) {
      const failed = allEntries.some((candidate) => candidate.options.key === options?.entryKey);
      return failed ? <span data-slot-error={name} /> : <>{options?.fallback ?? null}</>;
    }
    return renderEntry(entry);
  }

  if (spec.kind === 'chain') {
    let elected: ReactNode = null;
    for (const entry of allEntries) {
      let matched: unknown;
      try {
        matched = entry.select?.(owner as never) ?? null;
      } catch {
        matched = null;
      }
      if (matched === null) continue;
      elected = renderEntry(entry, { ...owner, matched });
      break;
    }
    if (options?.overlay) {
      return (
        <>
          <span
            data-chain-overlay-fallback={name}
            style={{ display: elected === null ? 'contents' : 'none' }}
          >
            {options.fallback ?? null}
          </span>
          {elected}
        </>
      );
    }
    return elected ?? <>{options?.fallback ?? null}</>;
  }

  const winnerById = new Map(winners.map((entry) => [entry.options.id, entry]));
  const rows: Array<{
    id: string | undefined;
    entry: StoredSlotEntry | undefined;
    order: number;
  }> = [];
  const seen = new Set<string | undefined>();
  for (const registered of allEntries) {
    const id = registered.options.id;
    if (seen.has(id) || (options?.only !== undefined && id !== options.only)) continue;
    seen.add(id);
    const entry = winnerById.get(id);
    rows.push({
      id,
      entry,
      order: entry?.options.order ?? registered.options.order ?? 0,
    });
  }
  rows.sort((left, right) => left.order - right.order);
  if (rows.length === 0) return <>{options?.fallback ?? null}</>;
  return (
    <>
      {rows.map((row, index) => row.entry
        ? renderEntry(row.entry)
        : <span data-slot-error={name} key={row.id ?? index} />)}
    </>
  );
}

export interface SlotOutletProps<
  K extends keyof SlotMap & string,
  EntryKey extends EntryKeyOf<K> = EntryKeyOf<K>,
> {
  name: K;
  owner: OwnerOf<K> & KeyPropsOf<K, EntryKey>;
  options?: RenderSlotOptions<EntryKey> & RenderChainOptions;
}

/** Typed React outlet for a host-owned slot render position. */
export function SlotOutlet<
  K extends keyof SlotMap & string,
  EntryKey extends EntryKeyOf<K> = EntryKeyOf<K>,
>({ name, owner, options }: SlotOutletProps<K, EntryKey>): ReactNode {
  return (
    <span data-slot={name} style={{ display: 'contents' }}>
      <DynamicSlotOutlet name={name} owner={owner} options={options} />
    </span>
  );
}

/** The Electron Renderer shell's root mounting seam. */
export function SlotRoot({ owner }: { owner: OwnerOf<'root'> }): ReactNode {
  return (
    <span data-slot="root" style={{ display: 'contents' }}>
      <DynamicSlotOutlet name="root" owner={owner} required />
    </span>
  );
}

export { Fragment as SlotFragment };

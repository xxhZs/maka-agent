import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { StoredMessage } from '@maka/core/session';
import type { ToolActivityItem } from '@maka/ui';
import {
  EXTENSION_UI_AGENT_RPC_METHOD,
  type ExtensionUiContributionProjection,
  type ExtensionUiSnapshotResult,
  type ExtensionUiStateValue,
} from '@maka/runtime-host/protocol';
import { uiExtensionFrameUrl } from './ui-extension-frame-url.js';
import { UiPluginRuntime } from './ui-plugin-runtime.js';

const DESKTOP_UI_SCOPE = 'desktop-ui';
const REFRESH_MS = 1_000;

interface UiExtensionSlotContextValue {
  readonly contributions: readonly ExtensionUiContributionProjection[];
  readonly onSafeMode: () => void;
}

export type UiExtensionFrameContext = ExtensionUiStateValue;

const UiExtensionSlotContext = createContext<UiExtensionSlotContextValue>({
  contributions: Object.freeze([]),
  onSafeMode: () => undefined,
});
const UiExtensionSessionScopeContext = createContext<(sessionId: string | undefined) => void>(
  () => undefined,
);

export function useUiExtensionSessionScope(sessionId: string | undefined): void {
  const setSessionId = useContext(UiExtensionSessionScopeContext);
  useEffect(() => {
    setSessionId(sessionId);
    return () => setSessionId(undefined);
  }, [sessionId, setSessionId]);
}

export function UiExtensionSlotProvider({
  contributions,
  onSafeMode,
  children,
}: UiExtensionSlotContextValue & { readonly children?: ReactNode }) {
  const value = useMemo(() => ({ contributions, onSafeMode }), [contributions, onSafeMode]);
  return (
    <UiExtensionSlotContext.Provider value={value}>{children}</UiExtensionSlotContext.Provider>
  );
}

/**
 * Stable composition seat owned by the official Maka snapshot.
 *
 * Each child remains a separate opaque-origin frame and therefore keeps its
 * own Fiber generation, permissions, Host bridge, state, and disposal
 * boundary. Adding or replacing one child never remounts the root snapshot.
 */
export function UiExtensionSlot({
  name,
  className,
  context: frameContext = null,
}: {
  name: string;
  className?: string;
  context?: UiExtensionFrameContext;
}) {
  const host = useContext(UiExtensionSlotContext);
  const contributions = host.contributions.filter(
    (item) => item.surface === 'app.slot' && item.slot === name,
  );
  if (contributions.length === 0) return null;
  return (
    <div
      className={['maka-ui-extension-slot', className].filter(Boolean).join(' ')}
      data-ui-slot={name}
    >
      {contributions.map((item) => (
        <SandboxedUiFrame
          key={`${item.scopeId}:${item.extensionId}:${item.generation}:${item.id}`}
          contribution={item}
          layer="slot"
          onSafeMode={host.onSafeMode}
          contributions={host.contributions}
          ancestry={new Set([contributionKey(item)])}
          context={item.hostState === true ? frameContext : null}
        />
      ))}
    </div>
  );
}

/** Render contributions selected by a product-native UI contract prefix. */
export function UiExtensionPoint({
  names,
  context = null,
  className,
}: {
  names: readonly string[];
  context?: UiExtensionFrameContext;
  className?: string;
}) {
  const host = useContext(UiExtensionSlotContext);
  const allowed = new Set(names);
  const contributions = host.contributions.filter(
    (item) => item.surface === 'app.slot' && item.slot && allowed.has(item.slot),
  );
  if (contributions.length === 0) return null;
  return (
    <div className={['maka-ui-extension-point', className].filter(Boolean).join(' ')}>
      {contributions.map((item) => (
        <SandboxedUiFrame
          key={`${item.scopeId}:${item.extensionId}:${item.generation}:${item.id}`}
          contribution={item}
          layer="slot"
          onSafeMode={host.onSafeMode}
          contributions={host.contributions}
          ancestry={new Set([contributionKey(item)])}
          context={item.hostState === true ? context : null}
        />
      ))}
    </div>
  );
}

export function useUiExtensionPoints(prefix: string): readonly ExtensionUiContributionProjection[] {
  const host = useContext(UiExtensionSlotContext);
  return useMemo(
    () => host.contributions.filter(
      (item) => item.surface === 'app.slot' && item.slot?.startsWith(prefix),
    ),
    [host.contributions, prefix],
  );
}

export function UiExtensionSettingsPages() {
  const pages = useUiExtensionPoints('settings.page.');
  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => {
    if (selected && pages.some(({ slot }) => slot === selected)) return;
    setSelected(pages[0]?.slot ?? null);
  }, [pages, selected]);
  if (pages.length === 0 || !selected) return null;
  return (
    <section className="maka-ui-extension-settings-pages" aria-label="Extension settings">
      <div className="maka-ui-extension-settings-page-tabs" role="tablist">
        {pages.map((page) => (
          <button
            key={`${page.extensionId}:${page.id}`}
            type="button"
            role="tab"
            aria-selected={selected === page.slot}
            onClick={() => setSelected(page.slot ?? null)}
          >
            {(page.slot ?? page.id).replace(/^settings\.page\./u, '').replace(/[.-]+/gu, ' ')}
          </button>
        ))}
      </div>
      <UiExtensionPoint
        names={[selected]}
        context={{ kind: 'settings.page', page: selected }}
        className="maka-ui-extension-point--settings"
      />
    </section>
  );
}

export function useUiToolResultContributionRenderer():
  | ((item: ToolActivityItem) => ReactNode | undefined)
  | undefined {
  const allContributions = useUiExtensionPoints('tool.result');
  const contributions = useMemo(
    () => allContributions.filter(({ hostState }) => hostState === true),
    [allContributions],
  );
  return useMemo(() => {
    if (contributions.length === 0) return undefined;
    const declared = new Set(contributions.map(({ slot }) => slot).filter(Boolean));
    return (item: ToolActivityItem) => {
      const specific = `tool.result.${normalizePointName(item.toolName)}`;
      const names = [specific, 'tool.result'].filter((name) => declared.has(name));
      if (names.length === 0) return undefined;
      return (
        <UiExtensionPoint
          names={names}
          context={toFrameContext({
            kind: 'tool.result',
            toolUseId: item.toolUseId,
            toolName: item.toolName,
            status: item.status,
            args: item.args,
            result: item.result,
            durationMs: item.durationMs,
          })}
          className="maka-ui-extension-point--tool-result"
        />
      );
    };
  }, [contributions]);
}

export function useUiConversationItems(
  messages: readonly StoredMessage[],
  sessionId: string | undefined,
): ReadonlyArray<{ id: string; afterTurnId: string; content: ReactNode }> | undefined {
  const allContributions = useUiExtensionPoints('conversation.node');
  const contributions = useMemo(
    () => allContributions.filter(({ hostState }) => hostState === true),
    [allContributions],
  );
  return useMemo(() => {
    if (!sessionId || contributions.length === 0) return undefined;
    const declared = new Set(contributions.map(({ slot }) => slot).filter(Boolean));
    const byTurn = new Map<string, StoredMessage[]>();
    for (const message of messages) {
      if (!('turnId' in message) || typeof message.turnId !== 'string') continue;
      const current = byTurn.get(message.turnId) ?? [];
      current.push(message);
      byTurn.set(message.turnId, current);
    }
    return [...byTurn].flatMap(([turnId, turnMessages]) => {
      const names = new Set<string>();
      if (declared.has('conversation.node')) names.add('conversation.node');
      for (const message of turnMessages) {
        const name = `conversation.node.${normalizePointName(message.type)}`;
        if (declared.has(name)) names.add(name);
      }
      if (names.size === 0) return [];
      return [{
        id: `extension-node:${turnId}`,
        afterTurnId: turnId,
        content: (
          <UiExtensionPoint
            names={[...names]}
            context={toFrameContext({
              kind: 'conversation.node',
              sessionId,
              turnId,
              messages: turnMessages,
            })}
            className="maka-ui-extension-point--conversation-node"
          />
        ),
      }];
    });
  }, [contributions, messages, sessionId]);
}

function normalizePointName(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '') || 'unknown';
}

function toFrameContext(value: unknown): UiExtensionFrameContext {
  try {
    return JSON.parse(JSON.stringify(value)) as UiExtensionFrameContext;
  } catch {
    return null;
  }
}

/**
 * The fixed Desktop shell is intentionally tiny. The shipped Maka product UI
 * is the trusted fallback snapshot; installed client contributions enter the
 * same root/overlay selection path and may replace the entire product surface.
 */
export function UiExtensionHost({
  officialSnapshot,
}: {
  officialSnapshot: () => ReactNode;
}) {
  const [snapshot, setSnapshot] = useState<ExtensionUiSnapshotResult | null>(null);
  const [sessionSnapshot, setSessionSnapshot] = useState<ExtensionUiSnapshotResult | null>(null);
  const [activeSessionId, setActiveSessionId] = useState<string | undefined>();
  const [clientContributions, setClientContributions] = useState<
    readonly ExtensionUiContributionProjection[]
  >(Object.freeze([]));
  const [safeMode, setSafeMode] = useState(false);
  const [notification, setNotification] = useState<string | null>(null);
  const clientRuntime = useMemo(() => new UiPluginRuntime(), []);

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      try {
        const next = await window.maka.runtimeHost.query('extension.ui.snapshot', {
          scopeId: DESKTOP_UI_SCOPE,
        });
        if (!disposed) setSnapshot((current) => (current?.digest === next.digest ? current : next));
      } catch {
        // Fail open to the compiled official snapshot while the Host reconnects.
      } finally {
        if (!disposed) timer = setTimeout(refresh, REFRESH_MS);
      }
    };
    void refresh();
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const receive = (event: Event) => {
      const message = (event as CustomEvent<{ message?: unknown }>).detail?.message;
      if (typeof message !== 'string') return;
      setNotification(message);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => setNotification(null), 4_000);
    };
    window.addEventListener('maka-ui-extension-notify', receive);
    return () => {
      window.removeEventListener('maka-ui-extension-notify', receive);
      if (timer) clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (!activeSessionId) {
      setSessionSnapshot(null);
      return;
    }
    const refresh = async () => {
      try {
        const next = await window.maka.runtimeHost.query('extension.ui.snapshot', {
          scopeId: activeSessionId,
        });
        if (!disposed) {
          setSessionSnapshot((current) => (current?.digest === next.digest ? current : next));
        }
      } catch {
        if (!disposed) setSessionSnapshot(null);
      } finally {
        if (!disposed) timer = setTimeout(refresh, REFRESH_MS);
      }
    };
    void refresh();
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
    };
  }, [activeSessionId]);

  useEffect(() => {
    let cancelled = false;
    void clientRuntime
      .reconcile([
        ...(snapshot?.contributions ?? []),
        ...(sessionSnapshot?.contributions ?? []),
      ])
      .then((contributions) => {
        if (!cancelled) setClientContributions(contributions);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [clientRuntime, sessionSnapshot, snapshot]);

  useEffect(
    () => () => {
      void clientRuntime.close();
    },
    [clientRuntime],
  );

  useEffect(() => {
    const recover = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key === 'Backspace') {
        event.preventDefault();
        setSafeMode(true);
      }
    };
    window.addEventListener('keydown', recover, { capture: true });
    return () => window.removeEventListener('keydown', recover, { capture: true });
  }, []);

  const selected = useMemo(
    () => selectUiSnapshots(null, clientContributions),
    [clientContributions],
  );
  const selectedRoot = safeMode ? selected.official : selected.root;
  return (
    <UiExtensionSessionScopeContext.Provider value={setActiveSessionId}>
    <div
      className="maka-ui-extension-shell"
      data-ui-safe-mode={safeMode || undefined}
      data-ui-composition-id={safeMode ? 'dev.maka.desktop@desktop-build' : `${snapshot?.digest ?? ''}:${sessionSnapshot?.digest ?? ''}`}
    >
      {selectedRoot.kind === 'sandboxed' ? (
        <SandboxedUiFrame
          contribution={selectedRoot.contribution}
          layer="root"
          onSafeMode={() => setSafeMode(true)}
          contributions={selected.slots}
          ancestry={new Set([contributionKey(selectedRoot.contribution)])}
        />
      ) : (
        <UiExtensionSlotProvider
          contributions={safeMode ? Object.freeze([]) : selected.slots}
          onSafeMode={() => setSafeMode(true)}
        >
          <div
            className="maka-ui-official-snapshot"
            data-extension-id={selectedRoot.extensionId}
            data-extension-build={selectedRoot.buildId}
          >
            {officialSnapshot()}
          </div>
        </UiExtensionSlotProvider>
      )}
      {!safeMode && selected.overlays.map((item) => (
        <SandboxedUiFrame
          key={`${item.scopeId}:${item.extensionId}:${item.id}`}
          contribution={item}
          layer="overlay"
          onSafeMode={() => setSafeMode(true)}
          contributions={selected.slots}
          ancestry={new Set([contributionKey(item)])}
        />
      ))}
      {notification ? (
        <div className="maka-ui-extension-notification" role="status" aria-live="polite">
          {notification}
        </div>
      ) : null}
    </div>
    </UiExtensionSessionScopeContext.Provider>
  );
}

type UiSnapshotCandidate =
  | {
      readonly kind: 'official';
      readonly extensionId: 'dev.maka.desktop';
      readonly buildId: 'desktop-build';
      readonly id: 'official-root';
      readonly priority: -10_000;
      readonly node: ReactNode;
    }
  | {
      readonly kind: 'sandboxed';
      readonly extensionId: string;
      readonly generation: number;
      readonly id: string;
      readonly priority: number;
      readonly contribution: ExtensionUiContributionProjection;
    };

export function selectUiSnapshots(
  officialNode: ReactNode,
  contributions: readonly ExtensionUiContributionProjection[],
) {
  const official: UiSnapshotCandidate = Object.freeze({
    kind: 'official',
    extensionId: 'dev.maka.desktop',
    buildId: 'desktop-build',
    id: 'official-root',
    priority: -10_000,
    node: officialNode,
  });
  const ordered = [...contributions].sort(
    (left, right) =>
      right.priority - left.priority ||
      left.extensionId.localeCompare(right.extensionId) ||
      left.id.localeCompare(right.id),
  );
  const dynamicRoot = ordered.find(({ surface }) => surface === 'app.root');
  return Object.freeze({
    official,
    root: dynamicRoot && dynamicRoot.priority > official.priority
      ? Object.freeze({
          kind: 'sandboxed' as const,
          extensionId: dynamicRoot.extensionId,
          generation: dynamicRoot.generation,
          id: dynamicRoot.id,
          priority: dynamicRoot.priority,
          contribution: dynamicRoot,
        })
      : official,
    overlays: Object.freeze(ordered.filter(({ surface }) => surface === 'app.overlay')),
    slots: Object.freeze(ordered.filter(({ surface }) => surface === 'app.slot')),
  });
}

function SandboxedUiFrame({
  contribution,
  layer,
  onSafeMode,
  contributions,
  ancestry,
  context = null,
}: {
  contribution: ExtensionUiContributionProjection;
  layer: 'root' | 'overlay' | 'slot';
  onSafeMode: () => void;
  contributions: readonly ExtensionUiContributionProjection[];
  ancestry: ReadonlySet<string>;
  context?: UiExtensionFrameContext;
}) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [slotRects, setSlotRects] = useState<ReadonlyMap<string, UiSlotRect>>(new Map());
  const token = useMemo(
    () => crypto.randomUUID(),
    [contribution.entryId, contribution.generation, contribution.id],
  );
  useLayoutEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.source !== frameRef.current?.contentWindow) return;
      if (isBridgeReady(event.data, token)) {
        postBridgeReady(frameRef.current, token, context);
        return;
      }
      const layout = decodeSlotLayout(event.data, token, contribution.slots ?? []);
      if (layout) {
        setSlotRects(layout);
        return;
      }
      const request = decodeBridgeRequest(event.data, token);
      if (!request) return;
      if (request.kind === 'safe_mode') {
        onSafeMode();
        return;
      }
      const identity = {
        scopeId: contribution.scopeId,
        entryId: contribution.entryId,
        extensionId: contribution.extensionId,
        generation: contribution.generation,
      };
      const operation = request.kind === 'client'
        ? runClientBridgeRequest(request.method, request.input)
        : isAgentBridgeRequest(request)
        ? runAgentBridgeRequest(contribution, identity, request)
        : request.kind === 'config'
          ? window.maka.runtimeHost.query('extension.configuration.query', {
              entryId: contribution.entryId,
            })
        : request.kind === 'invoke'
        ? window.maka.runtimeHost.command('extension.ui.rpc.invoke', {
          ...identity,
          method: request.method,
          args: request.args as ExtensionUiStateValue,
        })
        : request.kind === 'get'
          ? window.maka.runtimeHost.query('extension.ui.state.query', {
            ...identity,
            key: request.key,
          })
          : request.kind === 'events'
            ? window.maka.runtimeHost.query('extension.ui.state.events', {
                ...identity,
                key: request.key,
                afterSequence: request.afterSequence,
                waitMs: request.waitMs,
              })
          : window.maka.runtimeHost.command(
            'extension.ui.state.mutate',
            request.kind === 'set'
              ? { ...identity, key: request.key, kind: 'set', value: request.value as ExtensionUiStateValue }
              : { ...identity, key: request.key, kind: 'delete' },
          );
      void operation.then(
        (result) => frameRef.current?.contentWindow?.postMessage({ channel: 'maka-ui-host/v1', token, id: request.id, ok: true, result }, '*'),
        (error) => frameRef.current?.contentWindow?.postMessage({ channel: 'maka-ui-host/v1', token, id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) }, '*'),
      );
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, [context, contribution, onSafeMode, token]);
  useEffect(() => {
    frameRef.current?.contentWindow?.postMessage(
      { channel: 'maka-ui-context/v1', token, context },
      '*',
    );
  }, [context, token]);
  return (
    <div className={`maka-ui-extension-frame-host maka-ui-extension-frame-host--${layer}`}>
      <iframe
        ref={frameRef}
        className={`maka-ui-extension-frame maka-ui-extension-frame--${layer}`}
        title={`${contribution.extensionId}: ${contribution.id}`}
        data-extension-id={contribution.extensionId}
        data-extension-generation={contribution.generation}
        data-contribution-id={contribution.id}
        sandbox="allow-scripts allow-modals"
        referrerPolicy="no-referrer"
        src={uiExtensionFrameUrl({
          scopeId: contribution.scopeId,
          entryId: contribution.entryId,
          extensionId: contribution.extensionId,
          generation: contribution.generation,
          contributionId: contribution.id,
          token,
        })}
      />
      {[...slotRects].map(([slot, rect]) => (
        <div
          key={slot}
          className="maka-ui-extension-nested-slot"
          data-ui-slot={slot}
          style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }}
        >
          {slotChildren(slot, contributions, ancestry).map((child) => {
            const key = contributionKey(child);
            return (
              <SandboxedUiFrame
                key={key}
                contribution={child}
                layer="slot"
                onSafeMode={onSafeMode}
                contributions={contributions}
                ancestry={new Set([...ancestry, key])}
                context={context}
              />
            );
          })}
        </div>
      ))}
    </div>
  );
}

interface UiSlotRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

function decodeSlotLayout(
  value: unknown,
  token: string,
  declared: readonly string[],
): ReadonlyMap<string, UiSlotRect> | null {
  if (!value || typeof value !== 'object') return null;
  const message = value as Record<string, unknown>;
  if (
    message.channel !== 'maka-ui-slot-layout/v1' ||
    message.token !== token ||
    !Array.isArray(message.slots) ||
    message.slots.length > 32
  ) return null;
  const allowed = new Set(declared);
  const result = new Map<string, UiSlotRect>();
  for (const value of message.slots) {
    if (!value || typeof value !== 'object') return null;
    const rect = value as Record<string, unknown>;
    if (
      typeof rect.name !== 'string' ||
      !allowed.has(rect.name) ||
      ![rect.x, rect.y, rect.width, rect.height].every(
        (number) => typeof number === 'number' && Number.isFinite(number),
      ) ||
      (rect.width as number) < 0 ||
      (rect.height as number) < 0
    ) return null;
    result.set(rect.name, {
      x: rect.x as number,
      y: rect.y as number,
      width: rect.width as number,
      height: rect.height as number,
    });
  }
  return result;
}

function slotChildren(
  slot: string,
  contributions: readonly ExtensionUiContributionProjection[],
  ancestry: ReadonlySet<string>,
): readonly ExtensionUiContributionProjection[] {
  return contributions
    .filter(
      (item) =>
        item.surface === 'app.slot' &&
        item.slot === slot &&
        !ancestry.has(contributionKey(item)),
    )
    .sort(
      (left, right) =>
        right.priority - left.priority ||
        left.extensionId.localeCompare(right.extensionId) ||
        left.id.localeCompare(right.id),
    );
}

function contributionKey(contribution: ExtensionUiContributionProjection): string {
  return `${contribution.scopeId}:${contribution.entryId}:${contribution.generation}:${contribution.id}`;
}

function postBridgeReady(
  frame: HTMLIFrameElement | null,
  token: string,
  context: UiExtensionFrameContext,
): void {
  frame?.contentWindow?.postMessage({ channel: 'maka-ui-host-ready/v1', token, context }, '*');
}

function isBridgeReady(value: unknown, token: string): boolean {
  if (!value || typeof value !== 'object') return false;
  const message = value as Record<string, unknown>;
  return message.channel === 'maka-ui-bridge-ready/v1' && message.token === token;
}

type UiBridgeRequest =
  | { id: string; kind: 'safe_mode' }
  | { id: string; kind: 'config' }
  | { id: string; kind: 'get' | 'delete'; key: string }
  | { id: string; kind: 'set'; key: string; value: unknown }
  | { id: string; kind: 'events'; key: string; afterSequence: number; waitMs: number }
  | { id: string; kind: 'invoke'; method: string; args: unknown }
  | { id: string; kind: 'client'; method: string; input: unknown }
  | { id: string; kind: 'agent_invoke'; method: string; input: unknown };

function decodeBridgeRequest(value: unknown, token: string): UiBridgeRequest | null {
  if (!value || typeof value !== 'object') return null;
  const request = value as Record<string, unknown>;
  if (request.channel !== 'maka-ui-bridge/v1' || request.token !== token) return null;
  if (typeof request.id !== 'string' || !/^[0-9]{1,16}$/u.test(request.id)) return null;
  if (request.kind === 'safe_mode') return { id: request.id, kind: request.kind };
  if (request.kind === 'config') return { id: request.id, kind: request.kind };
  if (request.kind === 'invoke') {
    if (typeof request.method !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,127}$/u.test(request.method)) return null;
    return { id: request.id, kind: request.kind, method: request.method, args: request.args };
  }
  if (request.kind === 'agent_invoke') {
    if (typeof request.method !== 'string' || !/^[a-z][A-Za-z0-9.]{0,63}$/u.test(request.method)) {
      return null;
    }
    return {
      id: request.id,
      kind: request.kind,
      method: request.method,
      input: request.input,
    };
  }
  if (request.kind === 'client') {
    if (
      typeof request.method !== 'string' ||
      !['theme', 'navigate', 'notify', 'confirm', 'clipboard.write'].includes(request.method)
    ) return null;
    return { id: request.id, kind: request.kind, method: request.method, input: request.input };
  }
  if (request.kind === 'events') {
    if (
      typeof request.key !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(request.key) ||
      !Number.isSafeInteger(request.afterSequence) ||
      (request.afterSequence as number) < 0 ||
      !Number.isSafeInteger(request.waitMs) ||
      (request.waitMs as number) < 0 ||
      (request.waitMs as number) > 25_000
    ) return null;
    return {
      id: request.id,
      kind: request.kind,
      key: request.key,
      afterSequence: request.afterSequence as number,
      waitMs: request.waitMs as number,
    };
  }
  if (request.kind !== 'get' && request.kind !== 'set' && request.kind !== 'delete') return null;
  if (typeof request.key !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(request.key)) return null;
  return request.kind === 'set'
    ? { id: request.id, kind: request.kind, key: request.key, value: request.value }
    : { id: request.id, kind: request.kind, key: request.key };
}

async function runClientBridgeRequest(method: string, input: unknown): Promise<unknown> {
  if (method === 'theme') {
    return {
      colorScheme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
      theme: document.documentElement.dataset.makaTheme ?? 'default',
      locale: document.documentElement.lang || navigator.language,
    };
  }
  if (method === 'navigate') {
    const route = (input as { route?: unknown } | null)?.route;
    if (typeof route !== 'string' || !/^[a-z][a-z0-9.-]{0,127}$/u.test(route)) {
      throw new Error('UI route is invalid');
    }
    window.sessionStorage.setItem('maka-ui-extension-route-v1', route);
    window.dispatchEvent(new CustomEvent('maka-ui-extension-navigate', { detail: { route } }));
    return { accepted: true };
  }
  if (method === 'notify') {
    const message = (input as { message?: unknown } | null)?.message;
    if (typeof message !== 'string' || !message.trim() || message.length > 1_024) {
      throw new Error('UI notification is invalid');
    }
    window.dispatchEvent(new CustomEvent('maka-ui-extension-notify', { detail: { message } }));
    return { accepted: true };
  }
  if (method === 'confirm') {
    const message = (input as { message?: unknown } | null)?.message;
    if (typeof message !== 'string' || !message.trim() || message.length > 1_024) {
      throw new Error('UI confirmation is invalid');
    }
    return { confirmed: window.confirm(message) };
  }
  if (method === 'clipboard.write') {
    const text = (input as { text?: unknown } | null)?.text;
    if (typeof text !== 'string' || text.length > 64 * 1_024) {
      throw new Error('UI clipboard payload is invalid');
    }
    await navigator.clipboard.writeText(text);
    return { written: true };
  }
  throw new Error('UI Client method is unavailable');
}

function isAgentBridgeRequest(
  request: UiBridgeRequest,
): request is Extract<UiBridgeRequest, { kind: 'agent_invoke' }> {
  return request.kind === 'agent_invoke';
}

function runAgentBridgeRequest(
  contribution: ExtensionUiContributionProjection,
  identity: {
    readonly scopeId: string;
    readonly entryId: string;
    readonly extensionId: string;
    readonly generation: number;
  },
  request: Extract<UiBridgeRequest, { kind: 'agent_invoke' }>,
): Promise<unknown> {
  if (contribution.surface !== 'app.root' || contribution.sessionAccess !== true) {
    throw new Error('This UI Extension has no Agent capability');
  }
  return invokeUiAgent(identity, request.method, request.input);
}

async function invokeUiAgent(
  identity: {
    readonly scopeId: string;
    readonly entryId: string;
    readonly extensionId: string;
    readonly generation: number;
  },
  method: string,
  input: unknown,
): Promise<unknown> {
  const result = await window.maka.runtimeHost.command('extension.ui.rpc.invoke', {
    ...identity,
    method: EXTENSION_UI_AGENT_RPC_METHOD,
    args: { method, input } as ExtensionUiStateValue,
  });
  return result.value;
}

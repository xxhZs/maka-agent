export type MakaUiStateValue =
  | null
  | boolean
  | number
  | string
  | readonly MakaUiStateValue[]
  | { readonly [key: string]: MakaUiStateValue };

export const MAKA_UI_SDK_VERSION = 1 as const;

export const MAKA_UI_POINT_PREFIXES = Object.freeze({
  route: 'client.route.',
  settingsPage: 'settings.page.',
  conversationNode: 'conversation.node',
  toolResult: 'tool.result',
  artifactRenderer: 'artifact.renderer',
} as const);

export type MakaUiClientTheme = {
  readonly colorScheme: 'light' | 'dark';
  readonly theme: string;
  readonly locale: string;
};

export interface MakaUiClientApi {
  theme(): Promise<MakaUiClientTheme>;
  navigate(route: string): Promise<{ readonly accepted: true }>;
  notify(message: string): Promise<{ readonly accepted: true }>;
  confirm(message: string): Promise<{ readonly confirmed: boolean }>;
  writeClipboard(text: string): Promise<{ readonly written: true }>;
}

export interface MakaUiSdk {
  getConfig(): Promise<Readonly<Record<string, string | number | boolean>>>;
  getState(
    key: string,
  ): Promise<{ readonly found: boolean; readonly value: MakaUiStateValue | null }>;
  setState(key: string, value: MakaUiStateValue): Promise<{ readonly changed: boolean }>;
  deleteState(key: string): Promise<{ readonly changed: boolean }>;
  subscribe(
    key: string,
    listener: (value: MakaUiStateValue | undefined, event: unknown) => void,
  ): () => void;
  getContext(): MakaUiStateValue;
  onContext(listener: (context: MakaUiStateValue) => void): () => void;
  invoke(method: string, args?: MakaUiStateValue): Promise<unknown>;
  readonly client: MakaUiClientApi;
  readonly agents: Readonly<Record<string, (...args: unknown[]) => Promise<unknown>>>;
}

export function uiPoint(
  input:
    | { readonly kind: 'route'; readonly id: string }
    | { readonly kind: 'settings.page'; readonly id: string }
    | { readonly kind: 'conversation.node'; readonly messageType?: string }
    | { readonly kind: 'tool.result'; readonly toolName?: string }
    | { readonly kind: 'artifact.renderer'; readonly artifactKind?: string },
): string {
  switch (input.kind) {
    case 'route':
      return `${MAKA_UI_POINT_PREFIXES.route}${segment(input.id)}`;
    case 'settings.page':
      return `${MAKA_UI_POINT_PREFIXES.settingsPage}${segment(input.id)}`;
    case 'conversation.node':
      return input.messageType
        ? `${MAKA_UI_POINT_PREFIXES.conversationNode}.${segment(input.messageType)}`
        : MAKA_UI_POINT_PREFIXES.conversationNode;
    case 'tool.result':
      return input.toolName
        ? `${MAKA_UI_POINT_PREFIXES.toolResult}.${segment(input.toolName)}`
        : MAKA_UI_POINT_PREFIXES.toolResult;
    case 'artifact.renderer':
      return input.artifactKind
        ? `${MAKA_UI_POINT_PREFIXES.artifactRenderer}.${segment(input.artifactKind)}`
        : MAKA_UI_POINT_PREFIXES.artifactRenderer;
  }
}

export function requireMakaUiSdk(
  value: unknown = (globalThis as { makaUI?: unknown }).makaUI,
): MakaUiSdk {
  if (!value || typeof value !== 'object') throw new Error('makaUI SDK is unavailable');
  const sdk = value as Partial<MakaUiSdk>;
  if (
    typeof sdk.getState !== 'function' ||
    typeof sdk.getContext !== 'function' ||
    !sdk.client ||
    typeof sdk.client.theme !== 'function'
  ) {
    throw new Error('makaUI SDK is incompatible; requires SDK v1');
  }
  return sdk as MakaUiSdk;
}

function segment(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
  if (!normalized || normalized.length > 96)
    throw new TypeError('UI contribution point is invalid');
  return normalized;
}

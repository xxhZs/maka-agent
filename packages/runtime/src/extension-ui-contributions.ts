import { createHash } from 'node:crypto';
import type { MakaContributionContext } from './plugin-runtime.js';

export const EXTENSION_UI_BUNDLE_MAX_BYTES = 1024 * 1024;

export interface ExtensionUiContribution {
  readonly id: string;
  /** Trusted Renderer factory bundle. It registers typed React components through ctx.slots. */
  readonly bundle: string;
  readonly inject?: readonly string[];
  readonly external?: readonly string[];
  /** Same-package Runtime Tools this trusted Client bundle may invoke. */
  readonly tools?: readonly string[];
}

export interface ExtensionUiContributionInspection {
  readonly scopeId: string;
  readonly entryId: string;
  readonly extensionId: string;
  readonly generation: number;
  readonly id: string;
  readonly bundle: string;
  readonly bundleSha256: string;
  readonly inject: readonly string[];
  readonly external: readonly string[];
  readonly tools: readonly string[];
}

export type ExtensionUiReadiness = 'pending' | 'ready' | 'failed';

export interface ExtensionUiReadinessInspection {
  readonly entryId: string;
  readonly generation: number;
  readonly status: ExtensionUiReadiness;
  readonly diagnostic?: string;
}

export class ExtensionUiContributionError extends Error {
  readonly name = 'ExtensionUiContributionError';

  constructor(
    readonly code: 'invalid_ui' | 'ui_id_conflict',
    message: string,
  ) {
    super(message);
  }
}

interface RegisteredUi extends ExtensionUiContributionInspection {
  readonly token: symbol;
}

/**
 * Typed, renderer-agnostic UI contribution registry.
 *
 * Entries are retained by activation token rather than overwritten. That is
 * important during current/candidate updates: readers select only the exact
 * Fiber generations committed by the lifecycle kernel, so an activating candidate is
 * never exposed before the Entry commit and the current UI never blinks out.
 */
export class ExtensionUiContributionRegistry {
  readonly #byScope = new Map<string, RegisteredUi[]>();
  readonly #readiness = new Map<string, ExtensionUiReadinessInspection>();

  setReadiness(
    scopeId: string,
    entryId: string,
    generation: number,
    status: ExtensionUiReadiness,
    diagnostic?: string,
  ): void {
    validateIdentity('scopeId', scopeId);
    this.#readiness.set(
      `${scopeId}\u0000${entryId}`,
      Object.freeze({
        entryId,
        generation,
        status,
        ...(diagnostic ? { diagnostic } : {}),
      }),
    );
  }

  inspectReadiness(scopeId?: string): readonly ExtensionUiReadinessInspection[] {
    return Object.freeze(
      [...this.#readiness.entries()]
        .filter(([key]) => !scopeId || key.startsWith(`${scopeId}\u0000`))
        .map(([, value]) => value),
    );
  }

  register(
    context: Pick<MakaContributionContext, 'entryId' | 'scopeId' | 'extensionId' | 'generation'>,
    contribution: ExtensionUiContribution,
  ): () => void {
    validateContext(context);
    validateExtensionUiContribution(contribution);
    const entries = this.#byScope.get(context.scopeId) ?? [];
    const conflict = entries.find(
      (entry) =>
        entry.id === contribution.id &&
        (entry.entryId !== context.entryId || entry.extensionId !== context.extensionId),
    );
    if (conflict) {
      throw new ExtensionUiContributionError(
        'ui_id_conflict',
        `UI contribution "${contribution.id}" is already owned by entry ${conflict.entryId}`,
      );
    }
    const entry: RegisteredUi = Object.freeze({
      // ExtensionActivationContext also carries runtime-only capabilities such as
      // AbortSignal and effect/dependency functions. Never retain those in the UI
      // inspection record: inspections cross the durable Tool-result boundary.
      entryId: context.entryId,
      scopeId: context.scopeId,
      extensionId: context.extensionId,
      generation: context.generation,
      ...contribution,
      inject: Object.freeze([...(contribution.inject ?? [])]),
      external: Object.freeze([...(contribution.external ?? [])]),
      tools: Object.freeze([...(contribution.tools ?? [])]),
      bundleSha256: createHash('sha256').update(contribution.bundle).digest('hex'),
      token: Symbol(contribution.id),
    });
    entries.push(entry);
    this.#byScope.set(context.scopeId, entries);
    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      const current = this.#byScope.get(context.scopeId);
      if (!current) return;
      const index = current.findIndex(({ token }) => token === entry.token);
      if (index >= 0) current.splice(index, 1);
      if (current.length === 0) this.#byScope.delete(context.scopeId);
      this.#readiness.delete(`${context.scopeId}\u0000${context.entryId}`);
    };
  }

  inspect(
    scopeId: string,
    committed: readonly { readonly entryId: string; readonly generation: number }[],
  ): readonly ExtensionUiContributionInspection[] {
    validateIdentity('scopeId', scopeId);
    const generations = new Map(committed.map(({ entryId, generation }) => [entryId, generation]));
    return Object.freeze(
      (this.#byScope.get(scopeId) ?? [])
        .filter((entry) => generations.get(entry.entryId) === entry.generation)
        .map(({ token: _token, ...entry }) => Object.freeze(entry))
        .sort(compareUi),
    );
  }
}

export function contributeExtensionUi(
  context: MakaContributionContext,
  registry: ExtensionUiContributionRegistry,
  contribution: ExtensionUiContribution,
): void {
  const unregister = registry.register(context, contribution);
  try {
    context.ownEffect(`ui:${contribution.id}`, unregister);
  } catch (error) {
    unregister();
    throw error;
  }
}

export function validateExtensionUiContribution(contribution: ExtensionUiContribution): void {
  if (!contribution || typeof contribution !== 'object') {
    throw new ExtensionUiContributionError('invalid_ui', 'UI contribution is required');
  }
  validateIdentity('UI contribution id', contribution.id);
  if (
    typeof contribution.bundle !== 'string' ||
    contribution.bundle.length === 0 ||
    Buffer.byteLength(contribution.bundle, 'utf8') > EXTENSION_UI_BUNDLE_MAX_BYTES
  ) {
    throw new ExtensionUiContributionError(
      'invalid_ui',
      'UI client bundle is invalid or too large',
    );
  }
  validateDependencies('inject', contribution.inject);
  validateDependencies('external', contribution.external);
  if (
    contribution.tools !== undefined &&
    (!Array.isArray(contribution.tools) ||
      contribution.tools.length > 64 ||
      contribution.tools.some((name) => !/^[A-Za-z][A-Za-z0-9_-]{0,127}$/u.test(name)) ||
      new Set(contribution.tools.map((name) => name.toLowerCase())).size !==
        contribution.tools.length)
  ) {
    throw new ExtensionUiContributionError('invalid_ui', 'UI client Tool allowlist is invalid');
  }
}

function validateContext(
  context: Pick<MakaContributionContext, 'entryId' | 'scopeId' | 'extensionId' | 'generation'>,
): void {
  validateIdentity('entryId', context.entryId);
  validateIdentity('scopeId', context.scopeId);
  validateIdentity('extensionId', context.extensionId);
  if (!Number.isSafeInteger(context.generation) || context.generation <= 0) {
    throw new ExtensionUiContributionError('invalid_ui', 'Fiber generation is required');
  }
}

function validateIdentity(label: string, value: string): void {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    Buffer.byteLength(value, 'utf8') > 128 ||
    /[\r\n\0]/u.test(value)
  ) {
    throw new ExtensionUiContributionError('invalid_ui', `Invalid ${label}`);
  }
}

function compareUi(
  left: ExtensionUiContributionInspection,
  right: ExtensionUiContributionInspection,
): number {
  return compareString(left.extensionId, right.extensionId) || compareString(left.id, right.id);
}

function validateDependencies(label: string, value: readonly string[] | undefined): void {
  if (
    value !== undefined &&
    (!Array.isArray(value) ||
      value.length > 64 ||
      value.some(
        (id) =>
          typeof id !== 'string' ||
          !/^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)$/u.test(id),
      ) ||
      new Set(value).size !== value.length)
  ) {
    throw new ExtensionUiContributionError('invalid_ui', `UI ${label} dependencies are invalid`);
  }
}

function compareString(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

import type { Context } from './plugin-kernel.js';

export interface ScopedRegistryEntry {
  readonly id: string;
  readonly ownerContext: Context;
}

export function assertScopedRegistryIdAvailable<T extends ScopedRegistryEntry>(
  context: Context,
  service: string,
  entries: readonly T[],
  id: string,
): void {
  if (
    entries.some(
      (entry) => entry.id === id && context.sameServiceRealm(entry.ownerContext, service),
    )
  ) {
    throw new Error(`${service} registration is already defined in this realm: ${id}`);
  }
}

/**
 * Resolves one registration per id through App → Profile → Session → Agent.
 * Explicit Context.isolate() labels remain a hard boundary before realm ranking.
 */
export function visibleScopedRegistryEntries<T extends ScopedRegistryEntry>(
  context: Context,
  service: string,
  entries: readonly T[],
): readonly T[] {
  const selected = new Map<string, { readonly entry: T; readonly specificity: number }>();
  for (const entry of entries) {
    const specificity = context.serviceSpecificity(entry.ownerContext, service);
    if (specificity < 0) continue;
    const current = selected.get(entry.id);
    if (!current || specificity > current.specificity) {
      selected.set(entry.id, { entry, specificity });
    }
  }
  return Object.freeze([...selected.values()].map(({ entry }) => entry));
}

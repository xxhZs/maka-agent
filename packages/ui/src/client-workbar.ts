import type { ReactNode } from 'react';

export type ClientWorkbarPlacement = 'right' | 'bottom' | 'main';

export interface ClientWorkbarViewProps {
  readonly sessionId: string;
  readonly active: boolean;
  readonly placement: ClientWorkbarPlacement;
  /** Present when the view owns the main conversation surface. */
  readonly close?: () => void;
}

export interface ClientWorkbarViewRegistration {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly render: (props: ClientWorkbarViewProps) => ReactNode;
}

export interface ClientWorkbarView extends ClientWorkbarViewRegistration {
  readonly key: string;
  readonly pluginId: string;
}

export interface ClientWorkbarOpenRequest {
  readonly key: string;
  readonly sessionId: string;
  readonly placement: ClientWorkbarPlacement;
}

const VIEW_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

/** Renderer-local registry for native Client plugin panels hosted by Maka's Workbar. */
export class ClientWorkbarRegistry {
  readonly #views = new Map<string, ClientWorkbarView>();
  readonly #listeners = new Set<() => void>();
  readonly #openListeners = new Set<(request: ClientWorkbarOpenRequest) => void>();
  #snapshot: readonly ClientWorkbarView[] = Object.freeze([]);

  register(pluginId: string, registration: ClientWorkbarViewRegistration): () => void {
    if (!VIEW_ID_PATTERN.test(registration.id)) {
      throw new Error(`client Workbar view id is invalid: ${registration.id}`);
    }
    if (!registration.title.trim()) throw new Error('client Workbar view title is required');
    if (typeof registration.render !== 'function') {
      throw new Error('client Workbar view render must be a function');
    }
    const key = `${pluginId}:${registration.id}`;
    if (this.#views.has(key)) throw new Error(`client Workbar view already registered: ${key}`);
    const view: ClientWorkbarView = Object.freeze({
      ...registration,
      key,
      pluginId,
      title: registration.title.trim(),
    });
    this.#views.set(key, view);
    this.#publish();
    let live = true;
    return () => {
      if (!live) return;
      live = false;
      if (this.#views.delete(key)) this.#publish();
    };
  }

  open(
    pluginId: string,
    id: string,
    sessionId: string,
    placement: ClientWorkbarPlacement = 'right',
  ): void {
    const key = `${pluginId}:${id}`;
    if (!this.#views.has(key)) throw new Error(`client Workbar view is not active: ${key}`);
    if (!sessionId) throw new Error('client Workbar view requires a session');
    const request = Object.freeze({ key, sessionId, placement });
    for (const listener of [...this.#openListeners]) listener(request);
  }

  snapshot = (): readonly ClientWorkbarView[] => this.#snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  onOpen(listener: (request: ClientWorkbarOpenRequest) => void): () => void {
    this.#openListeners.add(listener);
    return () => this.#openListeners.delete(listener);
  }

  #publish(): void {
    this.#snapshot = Object.freeze(
      [...this.#views.values()].sort(
        (left, right) => left.title.localeCompare(right.title) || left.key.localeCompare(right.key),
      ),
    );
    for (const listener of [...this.#listeners]) listener();
  }
}

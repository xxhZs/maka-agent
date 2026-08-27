import { Service, type Awaitable, type Context, type Disposable } from './plugin-kernel.js';
import {
  assertScopedRegistryIdAvailable,
  visibleScopedRegistryEntries,
} from './plugin-scoped-registry.js';

declare module './plugin-kernel.js' {
  interface Context {
    systemPrompt: PluginSystemPromptService;
  }
}

export interface MakaSystemPromptContext {
  readonly sessionId: string;
  readonly turnId: string;
  readonly cwd: string;
}

export interface MakaSystemPromptContribution {
  readonly id: string;
  readonly priority?: number;
  readonly phase?: 'system' | 'turn_tail';
  readonly section?: string;
  readonly toolNames?: readonly string[];
  render(context: MakaSystemPromptContext): Awaitable<string | undefined>;
}

export interface MakaSystemPromptFragment {
  readonly id: string;
  readonly section: string;
  readonly phase: 'system' | 'turn_tail';
  readonly text: string;
  readonly toolNames: readonly string[];
}

export interface MakaSystemPromptAssembly {
  readonly fragments: readonly MakaSystemPromptFragment[];
  readonly toolNames: readonly string[];
}

export interface MakaSystemPromptContributionInspection {
  readonly id: string;
  readonly priority: number;
  readonly phase: 'system' | 'turn_tail';
  readonly section: string;
  readonly toolNames: readonly string[];
  readonly ownerFiberId: number;
  readonly ownerFiberName: string;
  readonly realm: import('./plugin-kernel.js').ServiceRealmInspection;
}

interface RegisteredContribution extends MakaSystemPromptContributionInspection {
  readonly token: symbol;
  readonly contribution: MakaSystemPromptContribution;
  readonly ownerContext: Context;
  readonly section: string;
  readonly toolNames: readonly string[];
}

/** Ordered, Fiber-owned system-prompt contribution registry. */
export class PluginSystemPromptService extends Service {
  private readonly contributions: RegisteredContribution[] = [];

  constructor(ctx: Context) {
    super(ctx, {
      name: 'systemPrompt',
      role: 'registry',
      permissions: Object.freeze([]),
      isolate: true,
    });
  }

  register(contribution: MakaSystemPromptContribution): Disposable<Promise<void>> {
    validateContribution(contribution);
    assertScopedRegistryIdAvailable(this.ctx, this.name, this.contributions, contribution.id);
    const owner = this.ctx.fiber;
    const entry: RegisteredContribution = Object.freeze({
      id: contribution.id,
      priority: contribution.priority ?? 0,
      phase: contribution.phase ?? 'system',
      section: contribution.section ?? contribution.id,
      toolNames: Object.freeze([...(contribution.toolNames ?? [])]),
      ownerFiberId: owner.id,
      ownerFiberName: owner.name,
      realm: this.ctx.serviceRealm(),
      token: Symbol(contribution.id),
      contribution,
      ownerContext: this.ctx,
    });
    this.contributions.push(entry);
    try {
      return this.ctx.effect(
        () => () => {
          const index = this.contributions.findIndex(({ token }) => token === entry.token);
          if (index >= 0) this.contributions.splice(index, 1);
        },
        `systemPrompt.contribution:${contribution.id}`,
      );
    } catch (error) {
      const index = this.contributions.findIndex(({ token }) => token === entry.token);
      if (index >= 0) this.contributions.splice(index, 1);
      throw error;
    }
  }

  async render(
    phase: 'system' | 'turn_tail',
    context: MakaSystemPromptContext,
  ): Promise<readonly string[]> {
    return Object.freeze((await this.assemble(phase, context)).fragments.map(({ text }) => text));
  }

  async assemble(
    phase: 'system' | 'turn_tail',
    context: MakaSystemPromptContext,
  ): Promise<MakaSystemPromptAssembly> {
    const fragments: MakaSystemPromptFragment[] = [];
    const toolNames = new Set<string>();
    for (const entry of this.ordered(phase)) {
      const rendered = await entry.contribution.render(context);
      if (!rendered?.trim()) continue;
      for (const toolName of entry.toolNames) toolNames.add(toolName);
      fragments.push(
        Object.freeze({
          id: entry.id,
          section: entry.section,
          phase: entry.phase,
          text: rendered,
          toolNames: entry.toolNames,
        }),
      );
    }
    return Object.freeze({
      fragments: Object.freeze(fragments),
      toolNames: Object.freeze([...toolNames].sort()),
    });
  }

  inspect(): readonly MakaSystemPromptContributionInspection[] {
    return Object.freeze(
      this.ordered().map(
        ({ token: _token, contribution: _contribution, ownerContext: _ownerContext, ...entry }) =>
          Object.freeze(entry),
      ),
    );
  }

  _inspectRegistrations(): readonly import('./plugin-kernel.js').ServiceRegistrationInspection[] {
    return Object.freeze(
      visibleScopedRegistryEntries(this.ctx, this.name, this.contributions).map((entry) =>
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

  private ordered(phase?: 'system' | 'turn_tail'): RegisteredContribution[] {
    return [...visibleScopedRegistryEntries(this.ctx, this.name, this.contributions)]
      .filter((entry) => phase === undefined || entry.phase === phase)
      .sort((left, right) => right.priority - left.priority || left.id.localeCompare(right.id));
  }
}

function validateContribution(contribution: MakaSystemPromptContribution): void {
  if (!contribution || typeof contribution !== 'object') {
    throw new TypeError('System prompt contribution is required');
  }
  if (!/^[A-Za-z][A-Za-z0-9._:-]{0,127}$/u.test(contribution.id)) {
    throw new TypeError('System prompt contribution id is invalid');
  }
  if (
    contribution.priority !== undefined &&
    (!Number.isSafeInteger(contribution.priority) || Math.abs(contribution.priority) > 1_000_000)
  ) {
    throw new TypeError(`System prompt contribution priority is invalid: ${contribution.id}`);
  }
  if (typeof contribution.render !== 'function') {
    throw new TypeError(`System prompt contribution renderer is invalid: ${contribution.id}`);
  }
  if (
    contribution.section !== undefined &&
    (typeof contribution.section !== 'string' || !contribution.section.trim())
  ) {
    throw new TypeError(`System prompt section is invalid: ${contribution.id}`);
  }
  if (
    contribution.toolNames !== undefined &&
    (!Array.isArray(contribution.toolNames) ||
      contribution.toolNames.some(
        (name) => typeof name !== 'string' || !/^[A-Za-z][A-Za-z0-9._:-]{0,127}$/u.test(name),
      ))
  ) {
    throw new TypeError(`System prompt tool names are invalid: ${contribution.id}`);
  }
}

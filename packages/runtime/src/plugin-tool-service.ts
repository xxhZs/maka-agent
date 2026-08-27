import { Service, type Context } from './plugin-kernel.js';
import type { MakaTool } from './tool-runtime.js';
import {
  ExtensionToolContributionRegistry,
  type ExtensionToolContributionInspection,
  type ExtensionToolContributionRegistryOptions,
} from './extension-tool-contributions.js';
import { pluginIdentity, registerPluginContribution } from './plugin-runtime.js';

declare module './plugin-kernel.js' {
  interface Context {
    tools: PluginToolService;
  }
}

export class PluginToolService extends Service {
  readonly registry: ExtensionToolContributionRegistry;

  constructor(ctx: Context, options: ExtensionToolContributionRegistryOptions = {}) {
    super(ctx, {
      name: 'tools',
      role: 'registry',
      permissions: Object.freeze([]),
      isolate: true,
    });
    this.registry = new ExtensionToolContributionRegistry(options);
  }

  register(tool: MakaTool): void {
    const identity = pluginIdentity(this.ctx);
    registerPluginContribution(this.ctx, `tool:${tool.name}`, () =>
      this.registry.register({ ...identity, runtimeContext: this.ctx }, tool),
    );
  }

  compose(coreTools: readonly MakaTool[]): readonly MakaTool[] {
    return this.registry.compose(this.ctx, coreTools);
  }

  inspect(): readonly ExtensionToolContributionInspection[] {
    return this.registry.inspect(this.ctx);
  }

  _inspectRegistrations(): readonly import('./plugin-kernel.js').ServiceRegistrationInspection[] {
    return this.registry.inspectRegistrations(this.ctx);
  }
}

import type { MakaToolContext } from '@maka/runtime/tool-runtime';
import type { Context } from '@maka/runtime/plugin-kernel';
import { join } from 'node:path';
import {
  InProcessPackageActivation,
  PACKAGE_AGENT_RUNTIME_METHODS,
  type PackageAgentRuntime,
  type PackageAgentRuntimeMethod,
} from './in-process-package-runtime.js';
import type { InstalledToolPackage, ToolPackageManifest } from './plugin-runtime-manifest.js';
import type { InstalledUiPackage } from './plugin-ui-manifest.js';

/** Executes a trusted UI package's private Host methods in process. */
export class UiPackageService {
  constructor(
    private readonly resolveAgents: (scopeId: string) => PackageAgentRuntime | undefined = () =>
      undefined,
    private readonly resolveContext: (scopeId: string) => Context | undefined = () => undefined,
  ) {}

  async invokeAgent(
    installed: InstalledUiPackage,
    value: unknown,
    signal: AbortSignal,
  ): Promise<unknown> {
    const agents = this.resolveAgents('desktop-ui');
    if (!agents) throw new Error('Maka Agent Service is unavailable');
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new TypeError('UI Agent request must be an object');
    }
    const request = value as Record<string, unknown>;
    if (Object.keys(request).some((key) => key !== 'method' && key !== 'input')) {
      throw new TypeError('UI Agent request contains an unknown field');
    }
    if (
      typeof request.method !== 'string' ||
      !PACKAGE_AGENT_RUNTIME_METHODS.includes(request.method as PackageAgentRuntimeMethod)
    ) {
      throw new TypeError('UI Agent method is invalid');
    }
    const method = request.method as PackageAgentRuntimeMethod;
    const result = await agents.invoke(method, request.input ?? {}, {
      sessionId: `ui:${installed.extensionId}`,
      turnId: `ui-agent:${method}`,
      cwd: installed.root,
      toolCallId: `ui-agent:${method}`,
      abortSignal: signal,
      callerExtensionId: installed.extensionId,
      origin: 'host',
    });
    return result === undefined ? null : JSON.parse(JSON.stringify(result));
  }

  async healthCheck(installed: InstalledUiPackage): Promise<void> {
    if (!installed.manifest.host) return;
    const runtimePackage = asRuntimePackage(installed);
    const activation = new InProcessPackageActivation(
      runtimePackage,
      undefined,
      undefined,
      undefined,
      this.resolveAgents('desktop-ui'),
      this.resolveContext('desktop-ui'),
    );
    try {
      await activation.healthCheck(runtimePackage.manifest.tools.map(({ handler }) => handler));
    } finally {
      await activation.dispose();
    }
  }

  async invoke(
    installed: InstalledUiPackage,
    methodName: string,
    args: unknown,
    signal: AbortSignal,
  ): Promise<unknown> {
    const declaration = installed.manifest.host?.methods.find(({ name }) => name === methodName);
    if (!declaration) throw new Error(`UI Host method is not declared: ${methodName}`);
    const activation = new InProcessPackageActivation(
      asRuntimePackage(installed),
      undefined,
      undefined,
      undefined,
      this.resolveAgents('desktop-ui'),
      this.resolveContext('desktop-ui'),
    );
    const context: MakaToolContext = {
      sessionId: `ui:${installed.extensionId}`,
      turnId: `ui-host:${methodName}`,
      cwd: installed.root,
      toolCallId: `ui-host:${methodName}`,
      abortSignal: signal,
      emitOutput: () => undefined,
    };
    try {
      return await activation.invoke(declaration.handler, args, context);
    } finally {
      await activation.dispose();
    }
  }
}

function asRuntimePackage(installed: InstalledUiPackage): InstalledToolPackage {
  const host = installed.manifest.host;
  if (!host) throw new Error('UI package does not declare a Host service');
  const manifest: ToolPackageManifest = {
    schemaVersion: 1,
    id: installed.extensionId,
    entry: host.entry,
    tools: Object.freeze(
      host.methods.map(({ name, handler }) =>
        Object.freeze({
          name,
          description: `Private UI Host method ${name}`,
          handler,
          inputSchema: Object.freeze({}),
          category: 'network_send' as const,
          recoveryMode: 'never_auto_retry' as const,
        }),
      ),
    ),
    permissions: Object.freeze({
      workspace: 'none' as const,
      network: installed.manifest.permissions.network,
    }),
  };
  return Object.freeze({
    extensionId: installed.extensionId,
    root: installed.root,
    entry: join(installed.root, ...host.entry.split('/')),
    manifest: Object.freeze(manifest),
  });
}

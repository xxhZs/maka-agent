import { useEffect } from 'react';
import * as ReactModule from 'react';
import * as ReactJsxRuntime from 'react/jsx-runtime';
import * as MakaUiModule from '@maka/ui';
import {
  ClientPluginRuntime,
  type ClientWorkbarRegistry,
  type MakaClientPluginDescriptor,
  type SlotCore,
} from '@maka/ui';

const CLIENT_PLUGIN_REFRESH_MS = 1_000;

/** Reconcile the Renderer Client graph from the unified Extension composition. */
export function useClientPlugins(core: SlotCore, workbar: ClientWorkbarRegistry): void {
  useEffect(() => {
    const runtimeHost = window.maka?.runtimeHost;
    if (!runtimeHost) return;
    const runtime = new ClientPluginRuntime({
      core,
      workbar,
      invokeTool: async (descriptor, sessionId, name, args) => {
        const session = (await window.maka.sessions.list()).find(({ id }) => id === sessionId);
        if (!session?.cwd) throw new Error('Client Tool session workspace is unavailable');
        const result = await runtimeHost.command('extension.client.tool.invoke', {
          entryId: descriptor.entryId,
          extensionId: descriptor.extensionId,
          generation: descriptor.generation,
          id: descriptor.id,
          sessionId,
          toolName: name,
          args,
        });
        return result.value;
      },
      staticModules: Object.freeze({
        react: ReactModule,
        'react/jsx-runtime': ReactJsxRuntime,
        '@maka/ui': MakaUiModule,
        '@maka/ui/ui-slots': MakaUiModule,
      }),
    });
    const previousLoader = window.__MakaModuleLoader__;
    window.__MakaModuleLoader__ = runtime.loader;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let lastDigest: string | undefined;

    const refresh = async () => {
      try {
        const snapshot = await runtimeHost.query('extension.ui.snapshot', {
          scopeId: 'desktop-ui',
        });
        if (!stopped && snapshot.digest !== lastDigest) {
          await runtime.reconcile({
            digest: snapshot.digest,
            plugins: snapshot.contributions.map(toDescriptor),
            diagnostics: [],
          });
          lastDigest = snapshot.digest;
        }
      } catch {
        // Keep the last committed Client graph while Host state is unavailable.
      } finally {
        if (!stopped) timer = setTimeout(refresh, CLIENT_PLUGIN_REFRESH_MS);
      }
    };
    void refresh();

    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (window.__MakaModuleLoader__ === runtime.loader) {
        window.__MakaModuleLoader__ = previousLoader;
      }
      void runtime.close();
    };
  }, [core, workbar]);
}

function toDescriptor(
  contribution: Awaited<ReturnType<typeof window.maka.runtimeHost.query<'extension.ui.snapshot'>>>['contributions'][number],
): MakaClientPluginDescriptor {
  const url = new URL('maka-client-plugin://bundle/v1');
  url.searchParams.set('scopeId', 'desktop-ui');
  url.searchParams.set('entryId', contribution.entryId);
  url.searchParams.set('extensionId', contribution.extensionId);
  url.searchParams.set('generation', String(contribution.generation));
  url.searchParams.set('id', contribution.id);
  url.searchParams.set('bundleSha256', contribution.bundleSha256);
  return Object.freeze({
    entryId: contribution.entryId,
    extensionId: contribution.extensionId,
    generation: contribution.generation,
    id: contribution.id,
    bundleSha256: contribution.bundleSha256,
    url: url.toString(),
    inject: contribution.inject,
    external: contribution.external,
    tools: contribution.tools,
  });
}

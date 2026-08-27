import { useCallback, useEffect, useState } from 'react';
import { Button, EmptyState, List, ListItem, StatusDot, Switch } from '@astryxdesign/core';
import { ModulePage, dotForStatus, type ModuleHubHeader } from '@maka/ui';
import { FolderOpen, Monitor, RefreshCcw, Trash2, ICON_SIZE } from '@maka/ui/icons';
import type { UiExtensionEntry } from '../preload/bridge-contract.js';
import {
  UiExtensionPoint,
  useUiExtensionPoints,
} from './ui-extension-host.js';

export function UiExtensionsPage({ hubHeader }: { hubHeader: ModuleHubHeader }) {
  const [entries, setEntries] = useState<readonly UiExtensionEntry[]>([]);
  const [busy, setBusy] = useState<string | null>('load');
  const [error, setError] = useState<string | null>(null);
  const routeContributions = useUiExtensionPoints('client.route.');
  const settingsContributions = useUiExtensionPoints('settings.page.');
  const contributedPages = [...routeContributions, ...settingsContributions];
  const [activeRoute, setActiveRoute] = useState<string | null>(() => {
    const route = window.sessionStorage.getItem('maka-ui-extension-route-v1');
    if (!route) return null;
    return route.startsWith('client.route.') || route.startsWith('settings.page.')
      ? route
      : `client.route.${route}`;
  });
  const [inspected, setInspected] = useState<string | null>(null);
  const reload = useCallback(async () => {
    setBusy('load');
    try {
      setEntries(await window.maka.uiExtensions.list());
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  }, []);
  useEffect(() => { void reload(); }, [reload]);
  useEffect(() => {
    const receive = (event: Event) => {
      const route = (event as CustomEvent<{ route?: unknown }>).detail?.route;
      if (typeof route !== 'string') return;
      const slot = route.startsWith('client.route.') || route.startsWith('settings.page.')
        ? route
        : `client.route.${route}`;
      if (contributedPages.some((item) => item.slot === slot)) setActiveRoute(slot);
    };
    window.addEventListener('maka-ui-extension-navigate', receive);
    return () => window.removeEventListener('maka-ui-extension-navigate', receive);
  }, [contributedPages]);

  const act = async (label: string, operation: () => Promise<unknown>) => {
    setBusy(label);
    try {
      await operation();
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setBusy(null);
    }
  };
  const latest = [...entries].reverse().filter((entry, index, all) =>
    all.findIndex((candidate) => candidate.extensionId === entry.extensionId) === index,
  );
  const inspectedEntry = latest.find(({ extensionId }) => extensionId === inspected);
  return (
    <main className="maka-main detailPane maka-module-main agents-chat-panel" data-page-shell="layout" data-module="ui-extensions" data-maka-contract="module-main" aria-label="Extensions">
      <ModulePage
        title={hubHeader.title}
        meta={`${new Set(entries.map((entry) => entry.extensionId)).size} 个插件`}
        actions={<div className="maka-module-main-actions" role="group" aria-label="插件操作">
          <Button
            variant="primary"
            label={busy === 'import' ? '正在导入…' : '安装插件'}
            icon={<FolderOpen size={ICON_SIZE.chrome} aria-hidden="true" />}
            isDisabled={busy !== null}
            onClick={() => void act('import', async () => {
              const result = await window.maka.uiExtensions.importLocal();
              if (!result.ok && result.reason === 'cancelled') return;
            })}
          />
          <Button variant="secondary" label="刷新" icon={<RefreshCcw size={ICON_SIZE.chrome} aria-hidden="true" />} isDisabled={busy !== null} onClick={() => void reload()} />
        </div>}
        toolbar={<div className="maka-module-page-bar">{hubHeader.badge}</div>}
      >
        {contributedPages.length > 0 ? (
          <section className="maka-ui-contributed-pages" aria-label="插件页面">
            <div className="maka-module-main-actions" role="navigation" aria-label="插件页面导航">
              {contributedPages.map((page) => (
                <Button
                  key={`${page.extensionId}:${page.id}`}
                  variant={activeRoute === page.slot ? 'primary' : 'secondary'}
                  label={pageLabel(page.slot ?? page.id)}
                  onClick={() => setActiveRoute(page.slot ?? null)}
                />
              ))}
            </div>
            {activeRoute ? (
              <UiExtensionPoint
                names={[activeRoute]}
                context={{ kind: activeRoute.startsWith('settings.page.') ? 'settings.page' : 'client.route', route: activeRoute }}
                className="maka-ui-extension-point--page"
              />
            ) : null}
          </section>
        ) : null}
        {error ? <div role="alert" className="maka-module-error">{error}</div> : null}
        {latest.length === 0 && busy === null ? (
          <EmptyState icon={<Monitor size={ICON_SIZE.empty} />} title="还没有插件" description="安装插件目录或 .maka-extension Bundle；一个插件可同时提供 Tool、UI、Event、Service 和 Timer。" />
        ) : (
          <>
          <List aria-label="已安装插件">
            {latest.map((entry) => (
              <ListItem
                key={entry.extensionId}
                label={entry.displayName}
                description={`${entry.toolNames.length} Tools · ${entry.uiContributionIds.length} UI · ${entry.eventContributionIds.length} Events/Listeners · ${entry.serviceContributionIds.length} Services · ${entry.timerContributionIds.length} Timers · ${entry.dependencies.length} 依赖${entry.error ? ` · ${entry.error}` : ''}`}
                startContent={<StatusDot variant={dotForStatus(entry.status === 'active' ? 'success' : entry.status === 'failed' ? 'error' : 'neutral')} label={entry.status} />}
                endContent={<div className="maka-module-main-actions">
                  <Switch
                    label={`${entry.enabled ? '停用' : '启用'} ${entry.extensionId}`}
                    value={entry.enabled}
                    isDisabled={busy !== null}
                    onChange={(enabled) => void act(`toggle:${entry.extensionId}`, () => window.maka.uiExtensions.setEnabled(entry.extensionId, enabled))}
                  />
                  {Object.keys(entry.configuration.properties).length > 0
                    ? entry.entries.map((compositionEntry) => (
                        <Button
                          key={compositionEntry.entryId}
                          variant="ghost"
                          label={`配置${compositionEntry.scopeId === 'profile' ? ' Tool / Event / Service / Timer' : ' UI'}`}
                          isDisabled={busy !== null}
                          onClick={() =>
                            void act(`configure:${compositionEntry.entryId}`, async () => {
                              const current = await window.maka.uiExtensions.getConfiguration(
                                compositionEntry.entryId,
                              );
                              const encoded = window.prompt(
                                `编辑 ${entry.displayName} · ${compositionEntry.scopeId} 配置（JSON）`,
                                JSON.stringify(current.configuration, null, 2),
                              );
                              if (encoded === null) return;
                              const parsed = JSON.parse(encoded) as Record<
                                string,
                                string | number | boolean
                              >;
                              await window.maka.uiExtensions.configure(
                                compositionEntry.entryId,
                                parsed,
                              );
                            })
                          }
                        />
                      ))
                    : null}
                  {entry.entries.map((compositionEntry) => (
                    <Button
                      key={`reload:${compositionEntry.entryId}`}
                      variant="ghost"
                      label={`重载 ${compositionEntry.scopeId} · r${compositionEntry.generation}`}
                      isDisabled={busy !== null}
                      onClick={() => void act(`reload:${compositionEntry.entryId}`, () =>
                        window.maka.uiExtensions.reload(compositionEntry.entryId),
                      )}
                    />
                  ))}
                  <Button
                    variant="ghost"
                    label={inspected === entry.extensionId ? '收起诊断' : '检查'}
                    isDisabled={busy !== null}
                    onClick={() => setInspected((current) => current === entry.extensionId ? null : entry.extensionId)}
                  />
                  <Button
                    variant="ghost"
                    label="导出"
                    isDisabled={busy !== null}
                    onClick={() => void act(`export:${entry.extensionId}`, () =>
                      window.maka.uiExtensions.export(entry.extensionId),
                    )}
                  />
                  <Button variant="ghost" label="删除" icon={<Trash2 size={ICON_SIZE.chrome} aria-hidden="true" />} isDisabled={busy !== null} onClick={() => void act(`remove:${entry.extensionId}`, () => window.maka.uiExtensions.remove(entry.extensionId))} />
                </div>}
              />
            ))}
          </List>
          {inspectedEntry ? (
            <pre className="maka-ui-extension-inspection" aria-label={`${inspectedEntry.displayName} 插件诊断`}>
              {JSON.stringify({
                extensionId: inspectedEntry.extensionId,
                status: inspectedEntry.status,
                entries: inspectedEntry.entries,
                contributions: inspectedEntry.contributions,
                permissions: {
                  configuredSecrets: Object.entries(inspectedEntry.configuration.properties)
                    .filter(([, property]) => property.secret)
                    .map(([key]) => key),
                },
                reloadPolicy: 'candidate activation is atomic; failed reload keeps the committed generation',
              }, null, 2)}
            </pre>
          ) : null}
          </>
        )}
      </ModulePage>
    </main>
  );
}

function pageLabel(slot: string): string {
  const value = slot.replace(/^(?:client\.route|settings\.page)\./u, '');
  return value.split(/[.-]/u).filter(Boolean).map((part) =>
    `${part.charAt(0).toUpperCase()}${part.slice(1)}`,
  ).join(' ');
}

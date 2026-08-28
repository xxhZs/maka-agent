import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  ClientPluginRuntime,
  type MakaClientBundleRegistration,
  type MakaClientPluginDescriptor,
  type MakaClientPluginSnapshot,
} from '../client-plugin-runtime.js';
import { createMakaUiSlotCore } from '../ui-slot-catalog.js';
import { SlotOutlet, SlotProvider } from '../ui-slots.js';
import { ClientWorkbarRegistry } from '../client-workbar.js';

function descriptor(id: string, bundleSha256: string): MakaClientPluginDescriptor {
  return Object.freeze({
    entryId: `entry-${id}`,
    extensionId: id,
    generation: 1,
    id,
    bundleSha256,
    url: `maka-client-plugin://bundle/${id}/${bundleSha256}.js`,
    inject: Object.freeze([]),
    external: Object.freeze([]),
    tools: Object.freeze([]),
  });
}

function snapshot(...plugins: MakaClientPluginDescriptor[]): MakaClientPluginSnapshot {
  return Object.freeze({
    digest: plugins.map(({ id, bundleSha256 }) => `${id}@${bundleSha256}`).join(','),
    plugins: Object.freeze(plugins),
    diagnostics: Object.freeze([]),
  });
}

function renderFooter(core: ReturnType<typeof createMakaUiSlotCore>): string {
  return renderToStaticMarkup(
    <SlotProvider core={core}>
      <SlotOutlet name="sidebar.footer.action" owner={{ wide: true }} />
    </SlotProvider>,
  );
}

describe('ClientPluginRuntime', () => {
  test('loads a bundle factory and renders its React contribution in the host tree', async () => {
    const core = createMakaUiSlotCore();
    const bundles = new Map<string, MakaClientBundleRegistration['factory']>();
    bundles.set('weather@r1', (require) => {
      const React = require('react') as typeof import('react');
      return {
        apply(ctx: import('../client-plugin-runtime.js').MakaClientPluginContext) {
          ctx.slots.register(
            { name: 'sidebar.footer.action', id: 'weather' },
            () => React.createElement('button', null, 'Weather 24°'),
          );
        },
      };
    });
    let runtime!: ClientPluginRuntime;
    runtime = new ClientPluginRuntime({
      core,
      staticModules: { react: { createElement } },
      loadBundle: async (plugin) => {
        runtime.registerBundle({ id: plugin.id, factory: bundles.get(`${plugin.id}@${plugin.bundleSha256}`)! });
      },
    });

    await runtime.reconcile(snapshot(descriptor('weather', 'r1')));

    assert.match(renderFooter(core), /Weather 24°/u);
    assert.deepEqual(runtime.inspect(), [{ id: 'weather', bundleSha256: 'r1' }]);
    await runtime.close();
    assert.doesNotMatch(renderFooter(core), /Weather 24°/u);
  });

  test('updates atomically, preserves current on activation failure, and disposes effects', async () => {
    const core = createMakaUiSlotCore();
    const disposed: string[] = [];
    const bundles = new Map<string, MakaClientBundleRegistration['factory']>();
    const bundle = (label: string, fail = false): MakaClientBundleRegistration['factory'] => () => ({
      apply(ctx: import('../client-plugin-runtime.js').MakaClientPluginContext) {
        ctx.effect(() => () => disposed.push(label));
        ctx.slots.register(
          { name: 'sidebar.footer.action', id: 'versioned' },
          () => createElement('span', null, label),
        );
        if (fail) throw new Error('candidate failed');
      },
    });
    bundles.set('versioned@r1', bundle('one'));
    bundles.set('versioned@r2', bundle('broken', true));
    bundles.set('versioned@r3', bundle('three'));
    let runtime!: ClientPluginRuntime;
    runtime = new ClientPluginRuntime({
      core,
      staticModules: {},
      loadBundle: async (plugin) => runtime.registerBundle({
        id: plugin.id,
        factory: bundles.get(`${plugin.id}@${plugin.bundleSha256}`)!,
      }),
    });

    await runtime.reconcile(snapshot(descriptor('versioned', 'r1')));
    await runtime.reconcile(snapshot(descriptor('versioned', 'r2')));
    assert.match(renderFooter(core), />one</u);
    assert.deepEqual(disposed, ['broken']);

    await runtime.reconcile(snapshot(descriptor('versioned', 'r3')));
    assert.match(renderFooter(core), />three</u);
    assert.deepEqual(disposed, ['broken', 'one']);

    await runtime.reconcile(snapshot());
    assert.doesNotMatch(renderFooter(core), />three</u);
    assert.deepEqual(disposed, ['broken', 'one', 'three']);
  });

  test('loads declared client dependencies before their consumers', async () => {
    const core = createMakaUiSlotCore();
    const loaded: string[] = [];
    const dependency = descriptor('palette', 'r1');
    const consumer = Object.freeze({
      ...descriptor('themed-card', 'r1'),
      inject: Object.freeze(['palette']),
      external: Object.freeze(['palette/client']),
    });
    let runtime!: ClientPluginRuntime;
    runtime = new ClientPluginRuntime({
      core,
      staticModules: {},
      loadBundle: async (plugin) => {
        loaded.push(plugin.id);
        runtime.registerBundle({
          id: plugin.id,
          factory: plugin.id === 'palette'
            ? () => ({ color: 'violet', apply() {} })
            : (require) => {
                const palette = require('palette/client') as { color: string };
                return {
                  apply(ctx: import('../client-plugin-runtime.js').MakaClientPluginContext) {
                    ctx.slots.register(
                      { name: 'sidebar.footer.action', id: 'themed' },
                      () => createElement('span', null, palette.color),
                    );
                  },
                };
              },
        });
      },
    });

    await runtime.reconcile(snapshot(consumer, dependency));

    assert.deepEqual(loaded, ['palette', 'themed-card']);
    assert.match(renderFooter(core), /violet/u);
  });

  test('owns Workbar views and invokes only same-package declared Client Tools', async () => {
    const core = createMakaUiSlotCore();
    const workbar = new ClientWorkbarRegistry();
    const calls: Array<{ sessionId: string; name: string; args: unknown }> = [];
    let context!: import('../client-plugin-runtime.js').MakaClientPluginContext;
    let runtime!: ClientPluginRuntime;
    runtime = new ClientPluginRuntime({
      core,
      workbar,
      staticModules: {},
      invokeTool: async (_descriptor, sessionId, name, args) => {
        calls.push({ sessionId, name, args });
        return { ok: true };
      },
      loadBundle: async (plugin) => runtime.registerBundle({
        id: plugin.id,
        factory: () => ({
          apply(ctx: import('../client-plugin-runtime.js').MakaClientPluginContext) {
            context = ctx;
            ctx.workbar.register(
              { id: 'canvas', title: 'Canvas' },
              ({ sessionId }) => createElement('div', null, sessionId),
            );
          },
        }),
      }),
    });
    const plugin = Object.freeze({
      ...descriptor('canvas', 'r1'),
      tools: Object.freeze(['designer_get']),
    });
    await runtime.reconcile(snapshot(plugin));
    assert.equal(workbar.snapshot()[0]?.key, 'canvas:canvas');
    let opened = '';
    let openedPlacement = '';
    const stop = workbar.onOpen(({ key, placement }) => {
      opened = key;
      openedPlacement = placement;
    });
    context.workbar.open('canvas', 'session-one', 'main');
    assert.equal(opened, 'canvas:canvas');
    assert.equal(openedPlacement, 'main');
    assert.deepEqual(await context.tools.invoke('session-one', 'designer_get', {}), { ok: true });
    assert.deepEqual(calls, [{ sessionId: 'session-one', name: 'designer_get', args: {} }]);
    await assert.rejects(
      context.tools.invoke('session-one', 'undeclared', {}),
      /not declared/u,
    );
    await runtime.reconcile(snapshot());
    assert.equal(workbar.snapshot().length, 0);
    stop();
  });
});

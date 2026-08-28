import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  type PropsRenderSlots,
  type PropsRuntime,
  SlotCore,
  SlotOutlet,
  SlotProvider,
  SlotRoot,
} from '../ui-slots.js';
import { createMakaUiSlotCore, MAKA_UI_SLOT_SPECS } from '../ui-slot-catalog.js';

declare module '../ui-slots.js' {
  interface SlotMap {
    'test.single': {
      kind: 'single';
      scope: 'root';
      owner: { title: string };
    };
    'test.list': { kind: 'list'; scope: 'root' };
    'test.keyed': {
      kind: 'keyed';
      scope: 'session';
      owner: { shared: string };
      keyProps: {
        bash: { command: string };
        read: { path: string };
      };
    };
    'test.chain': {
      kind: 'chain';
      scope: 'session-maybe';
      owner: { mode: 'plain' | 'plan' };
    };
    'test.child': { kind: 'single'; scope: 'root' };
  }
}

function declareTestSlots(core: SlotCore): () => void {
  return core.register(
    {
      name: 'root',
      registrant: 'test-shell',
      children: {
        'test.single': { kind: 'single', scope: 'root' },
        'test.list': { kind: 'list', scope: 'root' },
        'test.keyed': { kind: 'keyed', scope: 'session' },
        'test.chain': { kind: 'chain', scope: 'session-maybe' },
      },
    },
    (_props: PropsRuntime<'root'> & PropsRenderSlots<
      'test.single' | 'test.list' | 'test.keyed' | 'test.chain'
    >) => null,
  );
}

describe('SlotCore', () => {
  it('implements single/list/keyed shadowing and stable order', () => {
    const core = new SlotCore();
    declareTestSlots(core);

    const Single = ({ title }: PropsRuntime<'test.single'>) => <b>{title}</b>;
    core.register({ name: 'test.single', priority: 10 }, Single);
    core.register({ name: 'test.single', priority: 0 }, Single);
    assert.equal(core.entriesOfSlot('test.single')[0]?.options.priority ?? 0, 0);
    assert.throws(
      () => core.register({ name: 'test.single' }, Single),
      /already has a registration/,
    );

    const Item = () => null;
    core.register({ name: 'test.list', id: 'late', order: 20 }, Item);
    core.register({ name: 'test.list', id: 'early', order: 10 }, Item);
    core.register({ name: 'test.list', id: 'early', order: 99, priority: 5 }, Item);
    assert.deepEqual(
      core.entriesOfSlot('test.list').map((entry) => entry.options.id),
      ['early', 'late'],
    );

    const Bash = ({ command }: PropsRuntime<'test.keyed', 'bash'>) => <i>{command}</i>;
    core.register({ name: 'test.keyed', key: 'bash' }, Bash);
    assert.equal(core.entriesOfSlot('test.keyed')[0]?.options.key, 'bash');
  });

  it('collapses declared descendants when their owner is disposed', () => {
    const core = new SlotCore();
    declareTestSlots(core);
    const disposeParent = core.register(
      {
        name: 'test.single',
        children: { 'test.child': { kind: 'single', scope: 'root' } },
      },
      (_props: PropsRuntime<'test.single'> & PropsRenderSlots<'test.child'>) => null,
    );
    const disposeChild = core.register({ name: 'test.child' }, () => null);
    assert.equal(core.spec('test.child')?.kind, 'single');
    assert.equal(core.entries('test.child').length, 1);

    disposeParent();
    assert.equal(core.spec('test.child'), undefined);
    assert.equal(core.entries('test.child').length, 0);
    disposeChild();
    assert.equal(core.entries('test.child').length, 0);
  });

  it('batches same-turn subscription notifications', async () => {
    const core = new SlotCore();
    declareTestSlots(core);
    let calls = 0;
    core.subscribe('test.list', () => calls++);
    core.register({ name: 'test.list', id: 'a' }, () => null);
    core.register({ name: 'test.list', id: 'b' }, () => null);
    await Promise.resolve();
    assert.equal(calls, 1);
  });
});

describe('SlotOutlet', () => {
  it('fails loudly when the required root has no registration', () => {
    const core = new SlotCore();
    assert.throws(
      () => renderToStaticMarkup(
        <SlotProvider core={core}>
          <SlotRoot owner={{ children: null }} />
        </SlotProvider>,
      ),
      /required slot "root" has no registration/,
    );
  });

  it('renders typed owner/key props and strict-session fallback', () => {
    const core = new SlotCore();
    declareTestSlots(core);
    core.register(
      { name: 'test.keyed', key: 'bash' },
      ({ shared, command, sessionId }: PropsRuntime<'test.keyed', 'bash'>) => (
        <p>{shared}:{command}:{sessionId}</p>
      ),
    );

    const absent = renderToStaticMarkup(
      <SlotProvider core={core}>
        <SlotOutlet
          name="test.keyed"
          owner={{ shared: 'tool', command: 'pwd' }}
          options={{ entryKey: 'bash', fallback: <em>empty</em> }}
        />
      </SlotProvider>,
    );
    assert.match(absent, /empty/);

    const present = renderToStaticMarkup(
      <SlotProvider core={core} sessionId="session-1">
        <SlotOutlet
          name="test.keyed"
          owner={{ shared: 'tool', command: 'pwd' }}
          options={{ entryKey: 'bash' }}
        />
      </SlotProvider>,
    );
    assert.match(present, /tool:pwd:session-1/);
    assert.match(present, /data-slot="test.keyed"/);
  });

  it('elects the first matching chain entry and supports persistent fallback', () => {
    const core = new SlotCore();
    declareTestSlots(core);
    core.register(
      {
        name: 'test.chain',
        priority: 0,
        select: ({ mode }) => mode === 'plan' ? { label: 'planner' } : null,
      },
      ({ matched, sessionId }: PropsRuntime<'test.chain'> & { matched: { label: string } }) => (
        <strong>{matched.label}:{sessionId ?? 'none'}</strong>
      ),
    );

    const plain = renderToStaticMarkup(
      <SlotProvider core={core}>
        <SlotOutlet
          name="test.chain"
          owner={{ mode: 'plain' }}
          options={{ fallback: <span>composer</span> }}
        />
      </SlotProvider>,
    );
    assert.match(plain, /composer/);

    const plan = renderToStaticMarkup(
      <SlotProvider core={core}>
        <SlotOutlet
          name="test.chain"
          owner={{ mode: 'plan' }}
          options={{ fallback: <span>composer</span>, overlay: true }}
        />
      </SlotProvider>,
    );
    assert.match(plan, /planner:none/);
    assert.match(plan, /data-chain-overlay-fallback="test.chain"/);
  });
});

describe('Maka UI slot catalog', () => {
  it('declares the exact 48 DSH b150a551b slot contracts', () => {
    const expected = [
      'conversation',
      'conversation.chat.assistant-actions',
      'conversation.chat.commandview',
      'conversation.chat.node',
      'conversation.chat.turnTail',
      'conversation.composer',
      'conversation.composer.bar',
      'conversation.composer.dock',
      'conversation.details.tool',
      'conversation.hero.agentPreset',
      'conversation.hero.brand.mark',
      'conversation.hero.workspace',
      'conversation.hero.workspace.directoryFlow',
      'conversation.input.attachments',
      'conversation.input.dock',
      'conversation.input.left',
      'conversation.input.model',
      'conversation.input.overlay',
      'conversation.input.plan',
      'conversation.input.right',
      'conversation.message.images',
      'conversation.session',
      'conversation.session.header',
      'conversation.session.header.actions',
      'conversation.session.header.lineage',
      'conversation.session.header.utilities',
      'conversation.view',
      'details',
      'root',
      'settings.action',
      'settings.close',
      'settings.general.item',
      'settings.header',
      'settings.onboarding',
      'settings.plugin.item',
      'settings.plugins.tab',
      'settings.section',
      'settings.trigger',
      'shell.overlay',
      'sidebar',
      'sidebar.brand.mark',
      'sidebar.brand.name',
      'sidebar.footer.action',
      'sidebar.settings',
      'sidebar.workspaces',
      'sidebar.workspaces.directoryFlow',
      'tool.call.toolview',
      'tool.view.cordis',
    ];
    assert.deepEqual(['root', ...Object.keys(MAKA_UI_SLOT_SPECS)].sort(), expected);

    const core = createMakaUiSlotCore();
    for (const name of expected) assert.ok(core.specDynamic(name), name);
    assert.equal(core.snapshot('root')[0]?.children.length, 47);
  });

  it('renders a registered React contribution in the host tree', () => {
    const core = createMakaUiSlotCore();
    core.register(
      { name: 'sidebar.footer.action', id: 'fixture-action' },
      ({ wide }: PropsRuntime<'sidebar.footer.action'>) => (
        <button type="button">{wide ? 'wide action' : 'compact action'}</button>
      ),
    );

    const markup = renderToStaticMarkup(
      <SlotProvider core={core}>
        <SlotOutlet name="sidebar.footer.action" owner={{ wide: true }} />
      </SlotProvider>,
    );
    assert.match(markup, /wide action/);
    assert.doesNotMatch(markup, /iframe/i);
  });
});

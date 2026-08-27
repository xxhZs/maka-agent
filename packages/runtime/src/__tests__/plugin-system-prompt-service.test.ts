import assert from 'node:assert/strict';
import test from 'node:test';
import { Context } from '../plugin-kernel.js';
import { PluginSystemPromptService } from '../plugin-system-prompt-service.js';

test('system prompt contributions are ordered and removed with their owner Fiber', async () => {
  const root = new Context();
  new PluginSystemPromptService(root);
  const fiber = root.plugin({
    name: 'fixture-prompt',
    inject: ['systemPrompt'],
    apply(ctx: Context) {
      ctx.systemPrompt.register({ id: 'fixture.second', priority: 10, render: () => 'second' });
      ctx.systemPrompt.register({
        id: 'fixture.first',
        section: 'tools.filesystem',
        toolNames: ['Read', 'Write'],
        priority: 20,
        render: () => 'first',
      });
      ctx.systemPrompt.register({
        id: 'fixture.tail',
        phase: 'turn_tail',
        render: ({ sessionId }) => `tail:${sessionId}`,
      });
    },
  });
  await fiber;
  const context = { sessionId: 'session-1', turnId: 'turn-1', cwd: '/tmp' };

  assert.deepEqual(await root.systemPrompt.render('system', context), ['first', 'second']);
  assert.deepEqual(await root.systemPrompt.assemble('system', context), {
    fragments: [
      {
        id: 'fixture.first',
        section: 'tools.filesystem',
        phase: 'system',
        text: 'first',
        toolNames: ['Read', 'Write'],
      },
      {
        id: 'fixture.second',
        section: 'fixture.second',
        phase: 'system',
        text: 'second',
        toolNames: [],
      },
    ],
    toolNames: ['Read', 'Write'],
  });
  assert.deepEqual(await root.systemPrompt.render('turn_tail', context), ['tail:session-1']);

  await fiber.dispose();
  assert.deepEqual(await root.systemPrompt.render('system', context), []);
  await root.fiber.dispose();
});

test('system prompt contributions inherit Profile and isolate Session and Agent realms', async () => {
  const root = new Context();
  new PluginSystemPromptService(root);
  const profile = root.extend({ makaRootId: 'profile' });
  const sessionA = root.extend({ makaRootId: 'session:a' });
  const sessionB = root.extend({ makaRootId: 'session:b' });
  const agentA = sessionA.extend({ makaAgentId: 'agent-a' });
  const fibers = [
    profile.plugin({
      name: 'profile-prompt',
      inject: ['systemPrompt'],
      apply(ctx: Context) {
        ctx.systemPrompt.register({ id: 'shared', render: () => 'profile' });
      },
    }),
    sessionA.plugin({
      name: 'session-prompt',
      inject: ['systemPrompt'],
      apply(ctx: Context) {
        ctx.systemPrompt.register({ id: 'shared', render: () => 'session-a' });
      },
    }),
    agentA.plugin({
      name: 'agent-prompt',
      inject: ['systemPrompt'],
      apply(ctx: Context) {
        ctx.systemPrompt.register({ id: 'shared', render: () => 'agent-a' });
      },
    }),
  ];
  await Promise.all(fibers.map((fiber) => fiber.await()));
  const promptContext = { sessionId: 'fixture', turnId: 'turn', cwd: '/tmp' };

  assert.deepEqual(await sessionA.systemPrompt.render('system', promptContext), ['session-a']);
  assert.deepEqual(await sessionB.systemPrompt.render('system', promptContext), ['profile']);
  assert.deepEqual(await agentA.systemPrompt.render('system', promptContext), ['agent-a']);
  await root.fiber.dispose();
});

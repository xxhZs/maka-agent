import assert from 'node:assert/strict';
import test from 'node:test';
import type { FilesystemExecutor } from '../filesystem-executor.js';
import { Context } from '../plugin-kernel.js';
import { PluginFilesystemService } from '../plugin-filesystem-service.js';

function executor(marker: string): FilesystemExecutor {
  return {
    async execute() {
      return { kind: 'read', content: marker };
    },
    async applyPatch() {
      return { status: 'completed' };
    },
  };
}

test('filesystem providers are scoped to their owner Fiber and wrap the canonical executor', async () => {
  const root = new Context();
  new PluginFilesystemService(root);
  const base = executor('base');
  const wrapped = executor('wrapped');
  const plugin = {
    name: 'fixture-fs',
    inject: ['fs'],
    apply(ctx: Context) {
      ctx.fs.register({
        id: 'fixture.fs',
        priority: 100,
        create: (received) => {
          assert.equal(received, base);
          return wrapped;
        },
      });
    },
  };
  const fiber = root.plugin(plugin);
  await fiber;

  assert.equal(root.fs.resolve(base), wrapped);
  assert.deepEqual(
    root.fs.inspect().map(({ id }) => id),
    ['fixture.fs'],
  );

  await fiber.dispose();
  assert.equal(root.fs.resolve(base), base);
  assert.deepEqual(root.fs.inspect(), []);

  const direct = root.plugin({
    name: 'fixture-fs-backend',
    inject: ['fs'],
    apply(ctx: Context) {
      ctx.fs.register({ id: 'fixture.fs.backend', provide: () => wrapped });
    },
  });
  await direct;
  assert.equal(root.fs.resolve(base), wrapped);
  await root.fiber.dispose();
});

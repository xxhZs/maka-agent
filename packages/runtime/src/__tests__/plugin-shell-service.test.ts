import assert from 'node:assert/strict';
import test from 'node:test';
import { Context } from '../plugin-kernel.js';
import { PluginShellService } from '../plugin-shell-service.js';
import type { ShellRunLauncher } from '../shell-tools.js';

function launcher(marker: string): ShellRunLauncher {
  return {
    async runForegroundBash() {
      return { kind: 'terminal', command: marker, cwd: '/', exitCode: 0, output: marker };
    },
    async runBackgroundBash() {
      return { kind: 'shell_run', ref: marker, command: marker, cwd: '/' };
    },
  } as unknown as ShellRunLauncher;
}

test('shell providers are scoped to their owner Fiber and wrap the canonical launcher', async () => {
  const root = new Context();
  new PluginShellService(root);
  const base = launcher('base');
  const wrapped = launcher('wrapped');
  const fiber = root.plugin({
    name: 'fixture-shell',
    inject: ['shell'],
    apply(ctx: Context) {
      ctx.shell.register({
        id: 'fixture.shell',
        priority: 100,
        create: (received) => {
          assert.equal(received, base);
          return wrapped;
        },
      });
    },
  });
  await fiber;

  assert.equal(root.shell.resolve(base), wrapped);
  assert.deepEqual(
    root.shell.inspect().map(({ id }) => id),
    ['fixture.shell'],
  );

  await fiber.dispose();
  assert.equal(root.shell.resolve(base), base);

  const direct = root.plugin({
    name: 'fixture-shell-backend',
    inject: ['shell'],
    apply(ctx: Context) {
      ctx.shell.register({ id: 'fixture.shell.backend', provide: () => wrapped });
    },
  });
  await direct;
  assert.equal(root.shell.resolve(base), wrapped);
  await root.fiber.dispose();
});

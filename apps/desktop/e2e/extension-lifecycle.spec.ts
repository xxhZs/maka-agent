import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { COMPOSER_INPUT, expect, test } from './fixtures';

test('one combined Extension runs every contribution and recovers after a Maka restart', async ({
  extensionWindow,
}) => {
  let { page } = extensionWindow;
  const { userDataDir } = extensionWindow;
  const workspaceRoot = path.join(userDataDir, 'workspaces', 'default');
  const sourcePath = path.join(userDataDir, 'combined-extension');
  await writeCombinedExtension(sourcePath);

  const installed = await page.evaluate(() => window.maka.uiExtensions.importLocal());
  expect(installed).toEqual({ ok: true, extensionId: 'dev.maka.e2e-combined' });

  await expect
    .poll(() =>
      page.evaluate(async () =>
        (await window.maka.uiExtensions.list()).find(
          ({ extensionId }) => extensionId === 'dev.maka.e2e-combined',
        ),
      ),
    )
    .toMatchObject({
      enabled: true,
      status: 'active',
      toolNames: ['e2e_echo'],
      uiContributionIds: ['e2e-panel'],
      eventContributionIds: [
        'event:dev.maka.e2e-combined.completed',
        'listener:dev.maka.e2e-combined.completed:observe-completed',
        'listener:maka.tools.execute:around-tools',
      ],
      serviceContributionIds: ['dev.maka.e2e-combined.status'],
      timerContributionIds: ['heartbeat'],
    });

  const panel = page.frameLocator('iframe').getByTestId('combined-extension-panel');
  await expect(panel).toHaveText('READY: strict');

  await expect.poll(() => readJson(path.join(workspaceRoot, 'e2e-timer.json'))).toMatchObject({
    kind: 'heartbeat',
  });
  await invokeExtensionThroughMaka(page);
  await expect(page.getByRole('log')).toContainText('"tool":true');
  await expect(panel).toContainText('through-maka');
  await expect.poll(() => readJson(path.join(workspaceRoot, 'e2e-service.json'))).toMatchObject({
    value: 'through-maka',
  });
  await expect.poll(() => readJson(path.join(workspaceRoot, 'e2e-event.json'))).toMatchObject({
    value: 'through-maka',
  });
  await expect.poll(() => readLines(path.join(workspaceRoot, 'e2e-hook.jsonl'))).toHaveLength(2);

  page = await extensionWindow.restart();
  await expect
    .poll(() =>
      page.evaluate(async () =>
        (await window.maka.uiExtensions.list()).find(
          ({ extensionId }) => extensionId === 'dev.maka.e2e-combined',
        ),
      ),
    )
    .toMatchObject({ enabled: true, status: 'active', toolNames: ['e2e_echo'] });
  await expect(page.frameLocator('iframe').getByTestId('combined-extension-panel')).toBeVisible();
  await invokeExtensionThroughMaka(page);
  await expect.poll(() => readLines(path.join(workspaceRoot, 'e2e-hook.jsonl'))).toHaveLength(4);

  await page.evaluate(() => window.maka.uiExtensions.setEnabled('dev.maka.e2e-combined', false));
  await expect(page.frameLocator('iframe').getByTestId('combined-extension-panel')).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(async () =>
        (await window.maka.uiExtensions.list()).find(
          ({ extensionId }) => extensionId === 'dev.maka.e2e-combined',
        )?.status,
      ),
    )
    .toBe('disabled');

  await page.evaluate(() => window.maka.uiExtensions.setEnabled('dev.maka.e2e-combined', true));
  await expect(page.frameLocator('iframe').getByTestId('combined-extension-panel')).toHaveText(
    'READY: strict',
  );

  await page.evaluate(() => window.maka.uiExtensions.remove('dev.maka.e2e-combined'));
  await expect
    .poll(() =>
      page.evaluate(async () =>
        (await window.maka.uiExtensions.list()).some(
          ({ extensionId }) => extensionId === 'dev.maka.e2e-combined',
        ),
      ),
    )
    .toBe(false);
  await expect(page.frameLocator('iframe').getByTestId('combined-extension-panel')).toHaveCount(0);
});

async function writeCombinedExtension(root: string): Promise<void> {
  await Promise.all([
    mkdir(path.join(root, 'dist'), { recursive: true }),
    mkdir(path.join(root, 'documents'), { recursive: true }),
  ]);
  await writeFile(
    path.join(root, 'maka.extension.json'),
    JSON.stringify({
      schemaVersion: 1,
      id: 'dev.maka.e2e-combined',
      displayName: 'Combined Extension E2E',
      description: 'Exercises every runtime contribution through a real Maka window.',
      configuration: {
        properties: { mode: { type: 'string', default: 'strict' } },
        required: [],
      },
      runtime: {
        entry: 'dist/runtime.mjs',
        tools: [
          {
            name: 'e2e_echo',
            description: 'Echo an E2E payload.',
            handler: 'echo',
            visualization: { stateKey: 'lifecycle.result' },
            inputSchema: { type: 'object', additionalProperties: true },
          },
        ],
        events: [
          {
            name: 'dev.maka.e2e-combined.completed',
            description: 'An E2E action completed.',
            payloadSchema: { type: 'object', additionalProperties: true },
          },
        ],
        listeners: [
          {
            id: 'around-tools',
            event: 'maka.tools.execute',
            handler: 'aroundTools',
          },
          {
            id: 'observe-completed',
            event: 'dev.maka.e2e-combined.completed',
            handler: 'observe',
          },
        ],
        services: [
          {
            name: 'dev.maka.e2e-combined.status',
            version: '1',
            methods: [
              {
                name: 'read',
                handler: 'readStatus',
                inputSchema: {
                  type: 'object',
                  properties: { value: { type: 'string' } },
                  required: ['value'],
                  additionalProperties: false,
                },
                outputSchema: {
                  type: 'object',
                  properties: { ready: { type: 'boolean' } },
                  required: ['ready'],
                  additionalProperties: false,
                },
              },
            ],
          },
        ],
        timers: [
          {
            id: 'heartbeat',
            handler: 'heartbeat',
            intervalMs: 1_000,
            initialDelayMs: 50,
            timeoutMs: 1_000,
            payload: { kind: 'heartbeat' },
          },
        ],
        permissions: { workspace: 'write', network: false },
      },
      ui: {
        contributions: [
          {
            id: 'e2e-panel',
            surface: 'app.overlay',
            priority: 50,
            document: 'documents/panel.html',
          },
        ],
        permissions: { network: false, hostState: true, sessionAccess: false },
      },
    }),
  );
  await writeFile(
    path.join(root, 'dist/runtime.mjs'),
    `import { appendFile, writeFile } from 'node:fs/promises';
    import { join } from 'node:path';
    const write = (context, name, value) => writeFile(join(context.cwd, name), JSON.stringify(value));
    export default {
      echo: async (input, context) => {
        const service = await context.callService('dev.maka.e2e-combined.status', 'read', input);
        await context.emitEvent('dev.maka.e2e-combined.completed', { ...input, service });
        return { ...input, service, tool: true };
      },
      aroundTools: async (payload, context, next) => {
        await appendFile(join(context.cwd, 'e2e-hook.jsonl'), JSON.stringify({ phase: 'before' }) + '\\n');
        const result = await next(payload);
        await appendFile(join(context.cwd, 'e2e-hook.jsonl'), JSON.stringify({ phase: 'after' }) + '\\n');
        return result;
      },
      observe: async (payload, context) => write(context, 'e2e-event.json', payload),
      readStatus: async (input, context) => {
        await write(context, 'e2e-service.json', input);
        return { ready: true };
      },
      heartbeat: async (payload, context) => write(context, 'e2e-timer.json', payload),
    };\n`,
  );
  await writeFile(
    path.join(root, 'documents/panel.html'),
    `<!doctype html><html><body><strong data-testid="combined-extension-panel">BOOTING</strong><script>
      window.makaUI.getConfig().then(async (config) => {
        await window.makaUI.setState('e2e.ready', true);
        document.querySelector('[data-testid="combined-extension-panel"]').textContent = 'READY: ' + config.mode;
      });
      setInterval(async () => {
        const state = await window.makaUI.getState('lifecycle.result');
        if (state && state.value) document.querySelector('[data-testid="combined-extension-panel"]').textContent = 'RESULT: ' + JSON.stringify(state.value);
      }, 50);
    </script></body></html>`,
  );
}

async function invokeExtensionThroughMaka(page: import('@playwright/test').Page): Promise<void> {
  await page.getByRole('button', { name: '新任务', exact: true }).click({ force: true });
  const composer = page.locator(COMPOSER_INPUT);
  await composer.fill('__e2e_extension_lifecycle__');
  await composer.press('Enter');
  await expect(page.getByRole('button', { name: '重新生成' })).toHaveCount(1, { timeout: 20_000 });
}

async function readJson(file: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function readLines(file: string): Promise<readonly string[]> {
  try {
    return (await readFile(file, 'utf8')).trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

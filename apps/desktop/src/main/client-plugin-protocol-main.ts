import { protocol } from 'electron';
import type { DesktopRuntimeHostClient } from './runtime-host-client.js';
import {
  createClientPluginRequestHandler,
  type ClientPluginProtocolClient,
} from './client-plugin-protocol.js';

let installed = false;
let activeClient: ClientPluginProtocolClient | null = null;

export function registerClientPluginProtocol(client: DesktopRuntimeHostClient): void {
  activeClient = client;
  if (installed) return;
  installed = true;
  protocol.handle(
    'maka-client-plugin',
    createClientPluginRequestHandler(() => activeClient),
  );
}

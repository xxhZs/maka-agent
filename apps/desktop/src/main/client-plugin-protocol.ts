import type { ExtensionUiSnapshotResult } from '@maka/runtime-host/protocol';

const EXPECTED_QUERY_KEYS = Object.freeze([
  'bundleSha256',
  'entryId',
  'extensionId',
  'generation',
  'id',
  'scopeId',
]);

export interface ClientPluginProtocolClient {
  request(
    operation: 'extension.ui.snapshot',
    input: { readonly scopeId: string },
  ): Promise<ExtensionUiSnapshotResult>;
}

/** Serve only an exact, currently active Client bundle from the Host composition. */
export function createClientPluginRequestHandler(
  resolveClient: () => ClientPluginProtocolClient | null,
): (request: Request) => Promise<Response> {
  return async (request) => {
    if (request.method !== 'GET') return response('Method not allowed', 405);
    const identity = decodeClientPluginIdentity(request.url);
    if (!identity) return response('Invalid Client plugin request', 400);
    const client = resolveClient();
    if (!client) return response('Runtime Host unavailable', 503);
    try {
      const snapshot = await client.request('extension.ui.snapshot', {
        scopeId: identity.scopeId,
      });
      const contribution = snapshot.contributions.find(
        (item) =>
          item.entryId === identity.entryId &&
          item.extensionId === identity.extensionId &&
          item.generation === identity.generation &&
          item.id === identity.id &&
          item.bundleSha256 === identity.bundleSha256,
      );
      if (!contribution) return response('Client plugin bundle is stale or inactive', 404);
      return new Response(contribution.bundle, {
        status: 200,
        headers: {
          'cache-control': 'no-store',
          'content-security-policy': "default-src 'none'",
          'content-type': 'text/javascript; charset=utf-8',
          'cross-origin-resource-policy': 'same-origin',
        },
      });
    } catch {
      return response('Runtime Host unavailable', 503);
    }
  };
}

function decodeClientPluginIdentity(urlValue: string): {
  readonly scopeId: 'desktop-ui';
  readonly entryId: string;
  readonly extensionId: string;
  readonly generation: number;
  readonly id: string;
  readonly bundleSha256: string;
} | null {
  const url = new URL(urlValue);
  if (
    url.protocol !== 'maka-client-plugin:' ||
    url.hostname !== 'bundle' ||
    url.pathname !== '/v1' ||
    [...url.searchParams.keys()].sort().join('\0') !== EXPECTED_QUERY_KEYS.join('\0')
  ) return null;
  const scopeId = url.searchParams.get('scopeId');
  const entryId = url.searchParams.get('entryId');
  const extensionId = url.searchParams.get('extensionId');
  const generation = Number(url.searchParams.get('generation'));
  const id = url.searchParams.get('id');
  const bundleSha256 = url.searchParams.get('bundleSha256');
  if (
    scopeId !== 'desktop-ui' ||
    !entryId ||
    !extensionId ||
    !Number.isSafeInteger(generation) ||
    generation <= 0 ||
    !id ||
    !bundleSha256 ||
    !/^[a-f0-9]{64}$/u.test(bundleSha256)
  ) return null;
  return { scopeId, entryId, extensionId, generation, id, bundleSha256 };
}

function response(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: {
      'cache-control': 'no-store',
      'content-type': 'text/plain; charset=utf-8',
    },
  });
}

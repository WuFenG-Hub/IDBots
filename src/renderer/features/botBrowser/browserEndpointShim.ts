import {
  browserFailure,
  type BrowserCacheClearInput,
  type BrowserCommandResult,
  type BrowserHostAdapter,
  type BrowserTrustedActionKind,
} from '@openagentinternet/agent-browser-host-contract';

export interface BrowserEndpointShimRequest {
  url: string;
  method?: string;
  body?: Record<string, unknown> | null;
}

export interface BrowserEndpointShimResponse {
  status: number;
  body: BrowserCommandResult<unknown>;
}

type BrowserEndpointShim = (
  request: BrowserEndpointShimRequest,
) => Promise<BrowserEndpointShimResponse>;

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function browserOrigin(): string {
  const origin = globalThis.location?.origin;
  return typeof origin === 'string' && origin ? origin : 'http://127.0.0.1';
}

function methodOf(method: string | undefined): string {
  return text(method || 'GET').toUpperCase();
}

function actorIdFromUrl(url: URL): string | undefined {
  return text(url.searchParams.get('actorId')) || undefined;
}

function statusForResult(result: BrowserCommandResult<unknown>): number {
  if (result.ok) {
    return 200;
  }
  if (result.state === 'waiting' || result.state === 'manual_action_required') {
    return 200;
  }
  const code = 'code' in result ? result.code : '';
  if (code === 'method_not_allowed') {
    return 405;
  }
  if (code === 'not_found') {
    return 404;
  }
  if (code === 'browser_resource_not_found') {
    return 404;
  }
  if (code === 'browser_config_missing') {
    return 500;
  }
  return 400;
}

function response(body: BrowserCommandResult<unknown>): BrowserEndpointShimResponse {
  return {
    status: statusForResult(body),
    body,
  };
}

function methodNotAllowed(): BrowserEndpointShimResponse {
  return response(browserFailure('method_not_allowed', 'Method not allowed.'));
}

function readBody(request: BrowserEndpointShimRequest): Record<string, unknown> {
  return request.body && typeof request.body === 'object' && !Array.isArray(request.body)
    ? request.body
    : {};
}

export function createBrowserEndpointShim(adapter: BrowserHostAdapter): BrowserEndpointShim {
  return async (request) => {
    const url = new URL(request.url, browserOrigin());
    const method = methodOf(request.method);
    const actorId = actorIdFromUrl(url);

    if (url.pathname === '/api/browser/runtime') {
      if (method !== 'GET') return methodNotAllowed();
      return response(await adapter.getRuntime({ actorId }));
    }

    if (url.pathname === '/api/browser/resolve') {
      if (method !== 'GET') return methodNotAllowed();
      const uri = text(url.searchParams.get('uri'));
      if (!uri) {
        return response(browserFailure('missing_uri', 'Browser resolve requires a uri query parameter.'));
      }
      return response(await adapter.resolveResource({ actorId, uri }));
    }

    if (url.pathname === '/api/browser/settings') {
      if (method === 'GET') {
        return response(await adapter.getSettings({ actorId }));
      }
      if (method === 'PUT') {
        const body = readBody(request);
        return response(
          await adapter.updateSettings({
            actorId,
            browser:
              body.browser && typeof body.browser === 'object' && !Array.isArray(body.browser)
                ? body.browser as Record<string, unknown>
                : undefined,
          }),
        );
      }
      return methodNotAllowed();
    }

    if (url.pathname === '/api/browser/cache') {
      if (method === 'GET') {
        return response(await adapter.getCache({ actorId }));
      }
      if (method === 'DELETE') {
        const body = readBody(request);
        const input: BrowserCacheClearInput = {
          actorId,
          scope: text(body.scope) || undefined,
          all: typeof body.all === 'boolean' ? body.all : undefined,
          pinId: text(body.pinId) || undefined,
          cacheKey: text(body.cacheKey) || undefined,
        };
        return response(await adapter.clearCache(input));
      }
      return methodNotAllowed();
    }

    if (url.pathname === '/api/browser/actions') {
      if (method !== 'POST') return methodNotAllowed();
      const body = readBody(request);
      return response(
        await adapter.runTrustedAction({
          actorId,
          resourceUri: text(body.resourceUri),
          kind: text(body.kind) as BrowserTrustedActionKind,
          payload:
            body.payload && typeof body.payload === 'object' && !Array.isArray(body.payload)
              ? body.payload as Record<string, unknown>
              : undefined,
        }),
      );
    }

    return response(browserFailure('not_found', 'Browser endpoint not found.'));
  };
}

let freshRequestCounter = 0;

function nextFreshRequestToken(): string {
  freshRequestCounter = (freshRequestCounter + 1) % Number.MAX_SAFE_INTEGER;
  return `${Date.now()}-${freshRequestCounter}`;
}

export function withFreshQuery(url: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set('_fresh', nextFreshRequestToken());
  return parsed.toString();
}

export function freshGetInit(init: RequestInit = {}): RequestInit {
  const headers = new Headers(init.headers);
  headers.set('Cache-Control', 'no-cache');
  headers.set('Pragma', 'no-cache');

  return {
    ...init,
    cache: 'no-store',
    headers,
  };
}

export function freshGetUrlAndInit(url: string, init: RequestInit = {}): { url: string; init: RequestInit } {
  return {
    url: withFreshQuery(url),
    init: freshGetInit(init),
  };
}

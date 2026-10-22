/**
 * Origin checks (REQ-B-8 / C3): state-changing requests and WebSocket
 * upgrades must carry an Origin header whose scheme + host (+ port) exactly
 * matches CP_PUBLIC_ORIGIN. Default ports are normalized (http:80, https:443)
 * so `https://app.example.com` matches `https://app.example.com:443`.
 */

function normalizePort(scheme: string, port: string): string {
  if (port === '') {
    return scheme === 'https' ? '443' : scheme === 'http' ? '80' : '';
  }
  return port;
}

export function isOriginAllowed(originHeader: string | undefined | null, publicOrigin: string): boolean {
  if (!originHeader) {
    return false;
  }
  let origin: URL;
  let expected: URL;
  try {
    origin = new URL(originHeader);
    expected = new URL(publicOrigin);
  } catch {
    return false;
  }
  if (origin.protocol !== expected.protocol) {
    return false;
  }
  if (origin.hostname !== expected.hostname) {
    return false;
  }
  return normalizePort(origin.protocol, origin.port) === normalizePort(expected.protocol, expected.port);
}

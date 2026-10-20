import http from 'node:http';
import https from 'node:https';

/**
 * Minimal Docker Engine API client. Implemented over `node:http` (not global
 * fetch) so both `http(s)://host:port` and `http+unix:///path/to/docker.sock`
 * transports share one code path — undici's global fetch cannot speak to a
 * unix socket without a custom dispatcher, and we want zero extra deps.
 * Only `ping()` is wired in this phase; the lifecycle methods are typed
 * stubs that later phases (provisioning, upgrades, logs) fill in.
 */

export interface DockerRequestResult {
  status: number;
  body: string;
}

interface Transport {
  requestOptions(path: string): { options: http.RequestOptions; requestUrl?: URL };
}

class HttpTransport implements Transport {
  constructor(private readonly baseUrl: URL) {}

  requestOptions(path: string) {
    const requestUrl = new URL(path, this.baseUrl);
    return {
      requestUrl,
      options: {
        hostname: requestUrl.hostname,
        port: requestUrl.port,
        path: `${requestUrl.pathname}${requestUrl.search}`,
        protocol: requestUrl.protocol,
        headers: { Host: requestUrl.host },
      },
    };
  }
}

class UnixSocketTransport implements Transport {
  constructor(private readonly socketPath: string) {}

  requestOptions(path: string) {
    return {
      options: {
        socketPath: this.socketPath,
        path,
        headers: { Host: 'docker' },
      },
    };
  }
}

export class DockerClient {
  private readonly transport: Transport;

  constructor(url: string) {
    if (url.startsWith('http+unix://')) {
      this.transport = new UnixSocketTransport(decodeURIComponent(url.slice('http+unix://'.length)));
      return;
    }
    if (url.startsWith('http://') || url.startsWith('https://')) {
      this.transport = new HttpTransport(new URL(url));
      return;
    }
    throw new Error(`CP_DOCKER_URL must be http(s):// or http+unix://, got "${url}"`);
  }

  private request(method: string, path: string, body?: string): Promise<DockerRequestResult> {
    const { options } = this.transport.requestOptions(path);
    return new Promise((resolve, reject) => {
      const client = options.protocol === 'https:' ? https : http;
      const req = client.request(
        { ...options, method, headers: { ...options.headers, 'Content-Length': body ? Buffer.byteLength(body) : 0 } },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') });
          });
        },
      );
      req.on('error', reject);
      req.setTimeout(5000, () => req.destroy(new Error('docker request timed out')));
      if (body) {
        req.write(body);
      }
      req.end();
    });
  }

  /** `GET /_ping` — true when the engine answers 200, false otherwise. */
  async ping(): Promise<boolean> {
    try {
      const result = await this.request('GET', '/_ping');
      return result.status === 200;
    } catch {
      return false;
    }
  }

  async createVolume(): Promise<never> {
    throw new Error('DockerClient.createVolume is not implemented yet');
  }

  async inspectContainer(): Promise<never> {
    throw new Error('DockerClient.inspectContainer is not implemented yet');
  }

  async createContainer(): Promise<never> {
    throw new Error('DockerClient.createContainer is not implemented yet');
  }

  async startContainer(): Promise<never> {
    throw new Error('DockerClient.startContainer is not implemented yet');
  }

  async stopContainer(): Promise<never> {
    throw new Error('DockerClient.stopContainer is not implemented yet');
  }

  async removeContainer(): Promise<never> {
    throw new Error('DockerClient.removeContainer is not implemented yet');
  }

  async listContainers(): Promise<never> {
    throw new Error('DockerClient.listContainers is not implemented yet');
  }

  async containerLogs(): Promise<never> {
    throw new Error('DockerClient.containerLogs is not implemented yet');
  }

  async pullImage(): Promise<never> {
    throw new Error('DockerClient.pullImage is not implemented yet');
  }
}

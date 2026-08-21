import express, { Request, Response } from 'express';
import {
  Browser,
  Page,
  Response as PlaywrightResponse,
  WebSocket as PlaywrightWebSocket,
  chromium,
} from 'playwright';
import crypto from 'crypto';
import dotenv from 'dotenv';
import http, { IncomingMessage, ServerResponse } from 'http';
import net from 'net';
import path from 'path';
import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import { WorkerSession } from './types/session';
import { WorkerSignal } from './types/signal';

dotenv.config({ path: path.resolve(__dirname, '../.env'), override: true });

const app = express();
app.use(express.json({ limit: '1mb' }));

const workerKey = process.env.WORKER_SHARED_KEY || 'unsafe-worker-key';
const headless = (process.env.PLAYWRIGHT_HEADLESS || 'true').toLowerCase() !== 'false';
const port = Number(process.env.WORKER_PORT || 4300);
const gotoTimeoutMs = Number(process.env.PAGE_GOTO_TIMEOUT_MS || 60000);
const proxyServer = process.env.PLAYWRIGHT_PROXY_SERVER;
const proxyUsername = process.env.PLAYWRIGHT_PROXY_USERNAME;
const proxyPassword = process.env.PLAYWRIGHT_PROXY_PASSWORD;
const caliLoginAccount = process.env.CALI_LOGIN_ACCOUNT;
const caliLoginPassword = process.env.CALI_LOGIN_PASSWORD;
const liveKitStreamEnabled = (process.env.LIVEKIT_STREAM_ENABLED || 'true').toLowerCase() !== 'false';
const ffmpegPath = process.env.FFMPEG_PATH || `${process.env.LOCALAPPDATA || ''}\\Microsoft\\WinGet\\Links\\ffmpeg.exe`;
const streamFps = Number(process.env.LIVEKIT_STREAM_FPS || 60);
const streamWidth = Number(process.env.LIVEKIT_STREAM_WIDTH || 1280);
const streamHeight = Number(process.env.LIVEKIT_STREAM_HEIGHT || 720);
const streamBitrateKbps = Number(process.env.LIVEKIT_STREAM_BITRATE_KBPS || 3000);
const streamGopFrames = Number(process.env.LIVEKIT_STREAM_GOP_FRAMES || 30);
const streamBufferKbps = Number(
  process.env.LIVEKIT_STREAM_BUFFER_KBPS || Math.max(500, Math.floor(streamBitrateKbps / 2)),
);
const streamCaptureFps = Number(process.env.LIVEKIT_CAPTURE_FPS || streamFps);
const streamPipeJpegQuality = Math.min(90, Math.max(35, Number(process.env.LIVEKIT_PIPE_JPEG_QUALITY || 55)));
const streamCaptureWindowTitle = process.env.LIVEKIT_CAPTURE_WINDOW_TITLE || 'CaliBetWorker';
const networkBodySnippetMax = Number(process.env.NETWORK_BODY_SNIPPET_MAX || 20000);

let browser: Browser | null = null;
let localProxyServer: http.Server | null = null;
let localProxyUrl: string | null = null;
const sessions = new Map<string, WorkerSession>();
const sessionPages = new Map<string, Page>();
const sessionSignals = new Map<string, WorkerSignal[]>();
const sessionLiveKitStreams = new Map<string, {
  process: ChildProcessWithoutNullStreams;
  startedAt: string;
  lastStderr: string;
  captureTimer?: NodeJS.Timeout;
}>();
const sessionLiveKitStreamLastStatus = new Map<string, {
  active: false;
  endedAt: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  lastStderr: string;
}>();
const sessionNetworkLogs = new Map<string, Array<{
  id: number;
  url: string;
  method: string;
  status: number;
  resourceType: string;
  contentType: string;
  capturedAt: string;
  bodySnippet?: string;
}>>();
let signalCounter = 1;
let networkLogCounter = 1;

function toLogSnippet(value: unknown, maxLength = 1200): string | undefined {
  if (typeof value === 'string') {
    return value.slice(0, maxLength);
  }

  if (Buffer.isBuffer(value)) {
    return value.toString('utf8').slice(0, maxLength);
  }

  if (value && typeof value === 'object') {
    try {
      return JSON.stringify(value).slice(0, maxLength);
    } catch (_error) {
      return undefined;
    }
  }

  if (value == null) {
    return undefined;
  }

  return String(value).slice(0, maxLength);
}

function isInternalAuthorized(req: Request): boolean {
  return req.header('x-worker-key') === workerKey;
}

function maskProxyServer(value: string | undefined): string | null {
  if (!value) {
    return null;
  }

  try {
    const url = new URL(value);
    return `${url.protocol}//${url.hostname}:${url.port || ''}`;
  } catch (_error) {
    return 'configured';
  }
}

function getProxyUnsupportedReason(): string | null {
  return null;
}

function getLiveKitWhipPublishUrl(liveKit: NonNullable<WorkerSession['liveKit']>): string {
  return `${liveKit.ingressUrl.replace(/\/$/, '')}/${encodeURIComponent(liveKit.streamKey)}`;
}

function isLiveKitRtmpIngress(liveKit: NonNullable<WorkerSession['liveKit']>): boolean {
  return /^rtmps?:\/\//i.test(liveKit.ingressUrl);
}

function maskLiveKitUrl(value: string | undefined): string | null {
  if (!value) {
    return null;
  }

  try {
    const url = new URL(value);
    return `${url.protocol}//${url.hostname}${url.pathname}`;
  } catch (_error) {
    return 'configured';
  }
}

function redactStreamKey(value: string, streamKey: string | undefined): string {
  if (!streamKey) {
    return value;
  }

  return value.replaceAll(streamKey, '[redacted]');
}

function startLiveKitStream(workerSessionId: string): void {
  const session = sessions.get(workerSessionId);
  const page = sessionPages.get(workerSessionId);
  if (!session?.liveKit || !liveKitStreamEnabled) {
    return;
  }

  if (!page) {
    return;
  }

  if (sessionLiveKitStreams.has(workerSessionId)) {
    return;
  }

  const publishUrl = getLiveKitWhipPublishUrl(session.liveKit);
  const bitrate = `${streamBitrateKbps}k`;
  const captureFps = Math.min(streamFps, streamCaptureFps);
  const baseCaptureArgs = [
    '-hide_banner',
    '-loglevel', 'warning',
    '-fflags', 'nobuffer',
    '-fflags', '+genpts',
    '-flags', 'low_delay',
    '-use_wallclock_as_timestamps', '1',
    '-f', 'image2pipe',
    '-vcodec', 'mjpeg',
    '-framerate', String(captureFps),
    '-i', 'pipe:0',
  ];
  const args = isLiveKitRtmpIngress(session.liveKit) ? [
    ...baseCaptureArgs,
    '-f', 'lavfi',
    '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
    '-c:v', 'h264_nvenc',
    '-preset', 'p1',
    '-tune', 'ull',
    '-rc', 'cbr',
    '-rc-lookahead', '0',
    '-bf', '0',
    '-b:v', bitrate,
    '-maxrate', bitrate,
    '-bufsize', `${streamBufferKbps}k`,
    '-g', String(streamGopFrames),
    '-keyint_min', String(streamGopFrames),
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-ar', '48000',
    '-rtmp_live', 'live',
    '-f', 'flv',
    publishUrl,
  ] : [
    ...baseCaptureArgs,
    '-an',
    '-c:v', 'h264_nvenc',
    '-preset', 'p1',
    '-tune', 'ull',
    '-rc', 'cbr',
    '-rc-lookahead', '0',
    '-bf', '0',
    '-b:v', bitrate,
    '-maxrate', bitrate,
    '-bufsize', `${streamBufferKbps}k`,
    '-g', String(streamGopFrames),
    '-keyint_min', String(streamGopFrames),
    '-pix_fmt', 'yuv420p',
    '-f', 'whip',
    '-ts_buffer_size', '4194304',
    '-rtp_history', '2048',
    publishUrl,
  ];

  try {
    const child = spawn(ffmpegPath, args, { windowsHide: true });
    sessionLiveKitStreams.set(workerSessionId, {
      process: child,
      startedAt: new Date().toISOString(),
      lastStderr: '',
    });

    let frameInProgress = false;
    const writeFrame = async () => {
      if (frameInProgress || child.stdin.destroyed) {
        return;
      }

      frameInProgress = true;
      try {
        const frame = await page.screenshot({ type: 'jpeg', quality: streamPipeJpegQuality });
        if (!child.stdin.destroyed && child.stdin.writable) {
          child.stdin.write(frame, (error) => {
            if (!error) {
              return;
            }

            const current = sessionLiveKitStreams.get(workerSessionId);
            if (current) {
              current.lastStderr = `${current.lastStderr}\nffmpeg stdin write failed: ${error.message}`.slice(-4000);
            }
          });
        }
      } catch (error) {
        const current = sessionLiveKitStreams.get(workerSessionId);
        if (current) {
          const message = error instanceof Error ? error.message : String(error);
          current.lastStderr = `${current.lastStderr}\npage capture failed: ${message}`.slice(-4000);
        }
      } finally {
        frameInProgress = false;
      }
    };

    const captureTimer = setInterval(() => {
      writeFrame().catch(() => undefined);
    }, Math.max(33, Math.floor(1000 / captureFps)));
    sessionLiveKitStreams.get(workerSessionId)!.captureTimer = captureTimer;
    writeFrame().catch(() => undefined);

    child.stdin.on('error', (error) => {
      const current = sessionLiveKitStreams.get(workerSessionId);
      if (!current) {
        return;
      }

      current.lastStderr = `${current.lastStderr}\nffmpeg stdin error: ${error.message}`.slice(-4000);
      if (current.captureTimer) {
        clearInterval(current.captureTimer);
        current.captureTimer = undefined;
      }
    });

    child.on('error', (error) => {
      const current = sessionLiveKitStreams.get(workerSessionId);
      if (!current) {
        return;
      }

      current.lastStderr = `${current.lastStderr}\nffmpeg process error: ${error.message}`.slice(-4000);
      if (current.captureTimer) {
        clearInterval(current.captureTimer);
        current.captureTimer = undefined;
      }
    });

    child.stderr.on('data', (data: Buffer) => {
      const current = sessionLiveKitStreams.get(workerSessionId);
      if (!current) {
        return;
      }

      const chunk = redactStreamKey(data.toString(), session.liveKit?.streamKey);
      current.lastStderr = `${current.lastStderr}${chunk}`.slice(-4000);
    });

    child.on('exit', (code, signal) => {
      const current = sessionLiveKitStreams.get(workerSessionId);
      if (current?.captureTimer) {
        clearInterval(current.captureTimer);
      }
      sessionLiveKitStreams.delete(workerSessionId);
      sessionLiveKitStreamLastStatus.set(workerSessionId, {
        active: false,
        endedAt: new Date().toISOString(),
        code,
        signal,
        lastStderr: current?.lastStderr || '',
      });
      if (code !== 0 && signal !== 'SIGTERM') {
        // eslint-disable-next-line no-console
        console.error('[worker] livekit ffmpeg exited:', {
          workerSessionId,
          code,
          signal,
          lastStderr: current?.lastStderr,
        });
      }
    });
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('[worker] livekit stream failed to start:', error instanceof Error ? error.message : error);
  }
}

function stopLiveKitStream(workerSessionId: string): boolean {
  const stream = sessionLiveKitStreams.get(workerSessionId);
  if (!stream) {
    return false;
  }

  stream.process.kill('SIGTERM');
  if (stream.captureTimer) {
    clearInterval(stream.captureTimer);
  }
  sessionLiveKitStreams.delete(workerSessionId);
  return true;
}

function isAuthenticatedSocks5Proxy(): boolean {
  return Boolean(proxyServer?.startsWith('socks5://') && (proxyUsername || proxyPassword));
}

function getProxyServerPort(value: string): number {
  const url = new URL(value);
  return Number(url.port || 1080);
}

function encodeSocks5Address(host: string): Buffer {
  const ipv4Parts = host.split('.').map((part) => Number(part));
  if (ipv4Parts.length === 4 && ipv4Parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)) {
    return Buffer.from([0x01, ...ipv4Parts]);
  }

  const hostBuffer = Buffer.from(host);
  return Buffer.concat([Buffer.from([0x03, hostBuffer.length]), hostBuffer]);
}

function readSocketOnce(socket: net.Socket): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const onData = (data: Buffer) => {
      cleanup();
      resolve(data);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      socket.off('data', onData);
      socket.off('error', onError);
    };

    socket.once('data', onData);
    socket.once('error', onError);
  });
}

async function connectViaSocks5(targetHost: string, targetPort: number): Promise<net.Socket> {
  if (!proxyServer) {
    throw new Error('SOCKS5_PROXY_NOT_CONFIGURED');
  }

  const proxyUrl = new URL(proxyServer);
  const socket = net.connect(getProxyServerPort(proxyServer), proxyUrl.hostname);
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });

  socket.write(Buffer.from([0x05, 0x01, 0x02]));
  const methodResponse = await readSocketOnce(socket);
  if (methodResponse[0] !== 0x05 || methodResponse[1] !== 0x02) {
    socket.destroy();
    throw new Error('SOCKS5_AUTH_METHOD_REJECTED');
  }

  const username = Buffer.from(proxyUsername || '');
  const password = Buffer.from(proxyPassword || '');
  socket.write(Buffer.concat([Buffer.from([0x01, username.length]), username, Buffer.from([password.length]), password]));
  const authResponse = await readSocketOnce(socket);
  if (authResponse[0] !== 0x01 || authResponse[1] !== 0x00) {
    socket.destroy();
    throw new Error('SOCKS5_AUTH_FAILED');
  }

  const address = encodeSocks5Address(targetHost);
  const port = Buffer.allocUnsafe(2);
  port.writeUInt16BE(targetPort, 0);
  socket.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00]), address, port]));
  const connectResponse = await readSocketOnce(socket);
  if (connectResponse[0] !== 0x05 || connectResponse[1] !== 0x00) {
    socket.destroy();
    throw new Error(`SOCKS5_CONNECT_FAILED_${connectResponse[1] ?? 'UNKNOWN'}`);
  }

  return socket;
}

async function startLocalProxyForwarder(): Promise<string> {
  if (localProxyUrl) {
    return localProxyUrl;
  }

  const server = http.createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      if (!req.url) {
        res.writeHead(400);
        res.end();
        return;
      }

      const target = new URL(req.url);
      const upstream = await connectViaSocks5(target.hostname, Number(target.port || 80));
      const requestPath = `${target.pathname}${target.search}`;
      upstream.write(`${req.method} ${requestPath} HTTP/${req.httpVersion}\r\n`);
      for (const [header, value] of Object.entries(req.headers)) {
        if (!value || header.toLowerCase() === 'proxy-connection') {
          continue;
        }
        upstream.write(`${header}: ${Array.isArray(value) ? value.join(', ') : value}\r\n`);
      }
      upstream.write('\r\n');
      req.pipe(upstream);
      upstream.pipe(res);
    } catch (_error) {
      // eslint-disable-next-line no-console
      console.error('[worker] local proxy request failed:', _error instanceof Error ? _error.message : _error);
      res.writeHead(502);
      res.end('LOCAL_PROXY_FORWARD_FAILED');
    }
  });

  server.on('connect', async (req, clientSocket, head) => {
    try {
      const [host, portText] = (req.url || '').split(':');
      const upstream = await connectViaSocks5(host, Number(portText || 443));
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length > 0) {
        upstream.write(head);
      }
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    } catch (_error) {
      // eslint-disable-next-line no-console
      console.error('[worker] local proxy connect failed:', _error instanceof Error ? _error.message : _error);
      clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      clientSocket.destroy();
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('LOCAL_PROXY_BIND_FAILED');
  }

  localProxyServer = server;
  localProxyUrl = `http://127.0.0.1:${address.port}`;
  return localProxyUrl;
}

async function getPlaywrightProxyServer(): Promise<string | undefined> {
  if (!proxyServer) {
    return undefined;
  }

  if (isAuthenticatedSocks5Proxy()) {
    return startLocalProxyForwarder();
  }

  return proxyServer;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function pushNetworkLog(
  workerSessionId: string,
  item: {
    url: string;
    method: string;
    status: number;
    resourceType: string;
    contentType: string;
    bodySnippet?: string;
  },
): void {
  const list = sessionNetworkLogs.get(workerSessionId) || [];
  list.push({
    id: networkLogCounter++,
    url: item.url,
    method: item.method,
    status: item.status,
    resourceType: item.resourceType,
    contentType: item.contentType,
    capturedAt: new Date().toISOString(),
    bodySnippet: item.bodySnippet,
  });

  if (list.length > 800) {
    list.splice(0, list.length - 800);
  }
  sessionNetworkLogs.set(workerSessionId, list);
}

async function captureResponse(workerSessionId: string, response: PlaywrightResponse): Promise<void> {
  const request = response.request();
  const url = response.url();
  const method = request.method();
  const resourceType = request.resourceType();
  const status = response.status();
  const contentType = response.headers()['content-type'] || '';

  if (!/^https?:\/\//i.test(url)) {
    return;
  }

  let bodySnippet: string | undefined;
  const shouldTryBody = (resourceType === 'xhr' || resourceType === 'fetch')
    && (/json|javascript|text|xml/i.test(contentType) || /\/api-gw\/webapi\//i.test(url))
    && status >= 200
    && status < 400;

  if (shouldTryBody) {
    try {
      const text = await response.text();
      bodySnippet = text.slice(0, networkBodySnippetMax);
    } catch (_error) {
      bodySnippet = undefined;
    }
  }

  pushNetworkLog(workerSessionId, {
    url,
    method,
    status,
    resourceType,
    contentType,
    bodySnippet,
  });
}

function attachNetworkTracing(workerSessionId: string, page: Page): void {
  page.on('response', (response) => {
    captureResponse(workerSessionId, response).catch(() => undefined);
  });

  page.on('websocket', (ws: PlaywrightWebSocket) => {
    const url = ws.url();

    pushNetworkLog(workerSessionId, {
      url,
      method: 'WS_OPEN',
      status: 101,
      resourceType: 'websocket',
      contentType: 'websocket',
    });

    ws.on('framesent', (event: { payload: unknown }) => {
      pushNetworkLog(workerSessionId, {
        url,
        method: 'WS_SEND',
        status: 101,
        resourceType: 'websocket',
        contentType: 'websocket',
        bodySnippet: toLogSnippet(event.payload),
      });
    });

    ws.on('framereceived', (event: { payload: unknown }) => {
      pushNetworkLog(workerSessionId, {
        url,
        method: 'WS_RECV',
        status: 101,
        resourceType: 'websocket',
        contentType: 'websocket',
        bodySnippet: toLogSnippet(event.payload),
      });
    });

    ws.on('close', () => {
      pushNetworkLog(workerSessionId, {
        url,
        method: 'WS_CLOSE',
        status: 1000,
        resourceType: 'websocket',
        contentType: 'websocket',
      });
    });

    ws.on('socketerror', (error: string) => {
      pushNetworkLog(workerSessionId, {
        url,
        method: 'WS_ERROR',
        status: 101,
        resourceType: 'websocket',
        contentType: 'websocket',
        bodySnippet: toLogSnippet(error),
      });
    });
  });
}

async function ensureBrowser(): Promise<Browser> {
  if (browser) {
    return browser;
  }

  const launchOptions: Parameters<typeof chromium.launch>[0] = { headless };
  if (!headless) {
    launchOptions.args = [
      `--window-size=${streamWidth},${streamHeight}`,
      '--window-position=0,0',
    ];
  }
  const playwrightProxyServer = await getPlaywrightProxyServer();

  if (playwrightProxyServer) {
    launchOptions.proxy = {
      server: playwrightProxyServer,
      username: isAuthenticatedSocks5Proxy() ? undefined : proxyUsername,
      password: isAuthenticatedSocks5Proxy() ? undefined : proxyPassword,
    };
  }

  browser = await chromium.launch(launchOptions);
  return browser;
}

async function markWorkerCaptureWindow(page: Page): Promise<void> {
  await page.evaluate((title) => {
    document.title = title;
  }, streamCaptureWindowTitle).catch(() => undefined);
  await page.bringToFront().catch(() => undefined);
}

async function autoLoginCali(page: Page): Promise<void> {
  if (!caliLoginAccount || !caliLoginPassword) {
    return;
  }

  try {
    const accountInput = page.getByPlaceholder(/用戶名稱|會員帳號|帳號/i).first();
    const passwordInput = page.getByPlaceholder(/密碼/i).first();
    await accountInput.waitFor({ state: 'visible', timeout: 15000 });
    await passwordInput.waitFor({ state: 'visible', timeout: 15000 });
    await accountInput.fill(caliLoginAccount);
    await passwordInput.fill(caliLoginPassword);
    await page.getByRole('button', { name: /登入|登 入|login/i }).first().click({ timeout: 8000 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // eslint-disable-next-line no-console
    console.warn('[worker] cali auto-login skipped:', message);
  }
}

app.get('/internal/health', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    activeSessions: sessions.size,
    proxy: {
      enabled: Boolean(proxyServer),
      server: maskProxyServer(proxyServer),
      hasUsername: Boolean(proxyUsername),
      unsupportedReason: getProxyUnsupportedReason(),
      localForwarder: localProxyUrl,
    },
    timestamp: new Date().toISOString(),
    tracedSessions: sessionNetworkLogs.size,
    liveKitStreams: {
      enabled: liveKitStreamEnabled,
      active: sessionLiveKitStreams.size,
      ffmpegPath,
      capture: {
        fps: streamFps,
        width: streamWidth,
        height: streamHeight,
        bitrateKbps: streamBitrateKbps,
        gopFrames: streamGopFrames,
        bufferKbps: streamBufferKbps,
        captureFps: Math.min(streamFps, streamCaptureFps),
        pipeJpegQuality: streamPipeJpegQuality,
      },
    },
  });
});

app.get('/internal/session/:id/livekit-stream', (req: Request, res: Response) => {
  if (!isInternalAuthorized(req)) {
    return res.status(401).json({ message: 'UNAUTHORIZED_WORKER_REQUEST' });
  }

  const session = sessions.get(req.params.id);
  if (!session) {
    return res.status(404).json({ message: 'WORKER_SESSION_NOT_FOUND' });
  }

  const stream = sessionLiveKitStreams.get(session.id);
  const lastStatus = sessionLiveKitStreamLastStatus.get(session.id);
  return res.json({
    workerSessionId: session.id,
    configured: Boolean(session.liveKit),
    enabled: liveKitStreamEnabled,
    active: Boolean(stream),
    startedAt: stream?.startedAt,
    endedAt: lastStatus?.endedAt,
    exitCode: lastStatus?.code,
    exitSignal: lastStatus?.signal,
    lastStderr: stream?.lastStderr || lastStatus?.lastStderr,
    room: session.liveKit?.room,
    ingressId: session.liveKit?.ingressId,
    ingressUrl: maskLiveKitUrl(session.liveKit?.ingressUrl),
  });
});

app.post('/internal/session/:id/livekit-stream/start', (req: Request, res: Response) => {
  if (!isInternalAuthorized(req)) {
    return res.status(401).json({ message: 'UNAUTHORIZED_WORKER_REQUEST' });
  }

  const session = sessions.get(req.params.id);
  if (!session) {
    return res.status(404).json({ message: 'WORKER_SESSION_NOT_FOUND' });
  }

  startLiveKitStream(session.id);
  return res.status(201).json({ accepted: true, active: sessionLiveKitStreams.has(session.id) });
});

app.post('/internal/session/:id/livekit-stream/stop', (req: Request, res: Response) => {
  if (!isInternalAuthorized(req)) {
    return res.status(401).json({ message: 'UNAUTHORIZED_WORKER_REQUEST' });
  }

  const session = sessions.get(req.params.id);
  if (!session) {
    return res.status(404).json({ message: 'WORKER_SESSION_NOT_FOUND' });
  }

  return res.status(201).json({ stopped: stopLiveKitStream(session.id) });
});

app.get('/internal/session/:id/network', (req: Request, res: Response) => {
  if (!isInternalAuthorized(req)) {
    return res.status(401).json({ message: 'UNAUTHORIZED_WORKER_REQUEST' });
  }

  const session = sessions.get(req.params.id);
  if (!session) {
    return res.status(404).json({ message: 'WORKER_SESSION_NOT_FOUND' });
  }

  const contains = String(req.query.contains || '').trim().toLowerCase();
  const afterId = Number(req.query.afterId || 0);
  const limit = Math.min(300, Math.max(1, Number(req.query.limit || 120)));
  const logs = sessionNetworkLogs.get(session.id) || [];

  const filtered = logs
    .filter((item) => item.id > afterId)
    .filter((item) => {
      if (!contains) {
        return true;
      }
      return item.url.toLowerCase().includes(contains)
        || item.bodySnippet?.toLowerCase().includes(contains)
        || item.contentType.toLowerCase().includes(contains);
    })
    .slice(-limit);

  return res.json({
    workerSessionId: session.id,
    count: filtered.length,
    logs: filtered,
  });
});

app.get('/internal/egress-ip', async (req: Request, res: Response) => {
  if (!isInternalAuthorized(req)) {
    return res.status(401).json({ message: 'UNAUTHORIZED_WORKER_REQUEST' });
  }

  try {
    const activeBrowser = await ensureBrowser();
    const context = await activeBrowser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();
    const response = await page.goto('https://api.ipify.org?format=json', {
      waitUntil: 'domcontentloaded',
      timeout: gotoTimeoutMs,
    });
    const text = await page.textContent('body');
    await context.close();

    if (!response?.ok() || !text) {
      return res.status(502).json({ message: 'EGRESS_IP_CHECK_FAILED' });
    }

    return res.json({
      proxy: {
        enabled: Boolean(proxyServer),
        server: maskProxyServer(proxyServer),
      },
      result: JSON.parse(text) as unknown,
      checkedAt: new Date().toISOString(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown error';
    return res.status(502).json({ message: 'EGRESS_IP_CHECK_FAILED', detail: message });
  }
});

app.get('/internal/socks5-check', async (req: Request, res: Response) => {
  if (!isInternalAuthorized(req)) {
    return res.status(401).json({ message: 'UNAUTHORIZED_WORKER_REQUEST' });
  }

  const host = String(req.query.host || 'api.ipify.org');
  const targetPort = Number(req.query.port || 443);

  try {
    const socket = await connectViaSocks5(host, targetPort);
    socket.destroy();
    return res.json({ ok: true, host, port: targetPort, checkedAt: new Date().toISOString() });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown error';
    return res.status(502).json({ message: 'SOCKS5_CHECK_FAILED', detail: message });
  }
});

app.post('/internal/session/start', async (req: Request, res: Response) => {
  if (!isInternalAuthorized(req)) {
    return res.status(401).json({ message: 'UNAUTHORIZED_WORKER_REQUEST' });
  }

  const { bridgeSessionId, platformUserId, launchUrl } = req.body as {
    bridgeSessionId?: string;
    platformUserId?: string;
    launchUrl?: string;
    liveKit?: WorkerSession['liveKit'];
  };

  if (!bridgeSessionId || !platformUserId || !launchUrl) {
    return res.status(400).json({ message: 'INVALID_REQUEST' });
  }

  try {
    const activeBrowser = await ensureBrowser();
    const context = await activeBrowser.newContext({
      ignoreHTTPSErrors: true,
    });
    const page = await context.newPage();
    await page.goto(launchUrl, { waitUntil: 'domcontentloaded', timeout: gotoTimeoutMs });
    await markWorkerCaptureWindow(page);
    await autoLoginCali(page);

    const id = crypto.randomUUID();
    const startedAt = new Date().toISOString();

    sessions.set(id, {
      id,
      bridgeSessionId,
      platformUserId,
      launchUrl,
      liveKit: req.body.liveKit,
      startedAt,
    });
    sessionPages.set(id, page);
    sessionSignals.set(id, []);
    sessionNetworkLogs.set(id, []);
    attachNetworkTracing(id, page);
    startLiveKitStream(id);

    return res.status(201).json({
      workerSessionId: id,
      startedAt,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown error';
    // Log root cause to make bridge startup failures diagnosable in dev.
    // eslint-disable-next-line no-console
    console.error('[worker] session/start failed:', message);
    return res.status(502).json({ message: 'WORKER_BOOTSTRAP_FAILED', detail: message });
  }
});

app.get('/internal/session/:id', (req: Request, res: Response) => {
  if (!isInternalAuthorized(req)) {
    return res.status(401).json({ message: 'UNAUTHORIZED_WORKER_REQUEST' });
  }

  const session = sessions.get(req.params.id);
  if (!session) {
    return res.status(404).json({ message: 'WORKER_SESSION_NOT_FOUND' });
  }

  return res.json(session);
});

app.delete('/internal/session/:id', async (req: Request, res: Response) => {
  if (!isInternalAuthorized(req)) {
    return res.status(401).json({ message: 'UNAUTHORIZED_WORKER_REQUEST' });
  }

  const session = sessions.get(req.params.id);
  const page = sessionPages.get(req.params.id);
  if (!session) {
    return res.status(404).json({ message: 'WORKER_SESSION_NOT_FOUND' });
  }

  stopLiveKitStream(session.id);
  sessions.delete(session.id);
  sessionPages.delete(session.id);
  sessionSignals.delete(session.id);
  sessionNetworkLogs.delete(session.id);
  sessionLiveKitStreamLastStatus.delete(session.id);

  if (page) {
    await page.context().close().catch(() => undefined);
  }

  return res.json({ stopped: true });
});

app.post('/internal/session/:id/input', async (req: Request, res: Response) => {
  if (!isInternalAuthorized(req)) {
    return res.status(401).json({ message: 'UNAUTHORIZED_WORKER_REQUEST' });
  }

  const session = sessions.get(req.params.id);
  const page = sessionPages.get(req.params.id);
  if (!session || !page) {
    return res.status(404).json({ message: 'WORKER_SESSION_NOT_FOUND' });
  }

  const body = req.body as {
    type?: 'click' | 'key' | 'scroll';
    xRatio?: number;
    yRatio?: number;
    button?: 'left' | 'right' | 'middle';
    clickCount?: number;
    key?: string;
    deltaY?: number;
  };

  if (!body.type) {
    return res.status(400).json({ message: 'INVALID_INPUT_TYPE' });
  }

  try {
    if (body.type === 'click') {
      const viewport = page.viewportSize() || { width: 1280, height: 720 };
      const xRatio = typeof body.xRatio === 'number' ? body.xRatio : 0.5;
      const yRatio = typeof body.yRatio === 'number' ? body.yRatio : 0.5;
      const x = clamp(Math.round(xRatio * viewport.width), 1, viewport.width - 1);
      const y = clamp(Math.round(yRatio * viewport.height), 1, viewport.height - 1);

      await page.mouse.click(x, y, {
        button: body.button || 'left',
        clickCount: body.clickCount || 1,
      });
    }

    if (body.type === 'key') {
      if (!body.key) {
        return res.status(400).json({ message: 'KEY_IS_REQUIRED' });
      }

      await page.keyboard.press(body.key);
    }

    if (body.type === 'scroll') {
      const deltaY = typeof body.deltaY === 'number' ? body.deltaY : 300;
      await page.mouse.wheel(0, deltaY);
    }

    return res.status(201).json({ accepted: true, appliedAt: new Date().toISOString() });
  } catch (_error) {
    return res.status(502).json({ message: 'INPUT_APPLY_FAILED' });
  }
});

app.get('/internal/session/:id/frame', async (req: Request, res: Response) => {
  if (!isInternalAuthorized(req)) {
    return res.status(401).json({ message: 'UNAUTHORIZED_WORKER_REQUEST' });
  }

  const session = sessions.get(req.params.id);
  const page = sessionPages.get(req.params.id);
  if (!session || !page) {
    return res.status(404).json({ message: 'WORKER_SESSION_NOT_FOUND' });
  }

  try {
    const requestedType = String(req.query.type || 'jpeg').toLowerCase();
    const imageType = requestedType === 'png' ? 'png' : 'jpeg';
    const requestedQuality = Number(req.query.quality || 45);
    const quality = Math.min(90, Math.max(25, requestedQuality));
    const screenshot = imageType === 'jpeg'
      ? await page.screenshot({ type: 'jpeg', quality })
      : await page.screenshot({ type: 'png' });

    return res.json({
      workerSessionId: session.id,
      mimeType: imageType === 'jpeg' ? 'image/jpeg' : 'image/png',
      imageBase64: screenshot.toString('base64'),
      capturedAt: new Date().toISOString(),
    });
  } catch (_error) {
    return res.status(502).json({ message: 'FRAME_CAPTURE_FAILED' });
  }
});

app.post('/internal/session/:id/signal', (req: Request, res: Response) => {
  if (!isInternalAuthorized(req)) {
    return res.status(401).json({ message: 'UNAUTHORIZED_WORKER_REQUEST' });
  }

  const session = sessions.get(req.params.id);
  if (!session) {
    return res.status(404).json({ message: 'WORKER_SESSION_NOT_FOUND' });
  }

  const { from, kind, payload } = req.body as {
    from?: 'CLIENT' | 'WORKER' | 'SYSTEM';
    kind?: 'OFFER' | 'ANSWER' | 'ICE_CANDIDATE';
    payload?: Record<string, unknown>;
  };

  if (!from || !kind || !payload) {
    return res.status(400).json({ message: 'INVALID_SIGNAL' });
  }

  const queue = sessionSignals.get(session.id) || [];
  const signal: WorkerSignal = {
    id: signalCounter++,
    from,
    kind,
    payload,
    createdAt: new Date().toISOString(),
  };

  queue.push(signal);
  sessionSignals.set(session.id, queue);

  return res.status(201).json({ signalId: signal.id, queuedAt: signal.createdAt });
});

app.get('/internal/session/:id/signal/poll', (req: Request, res: Response) => {
  if (!isInternalAuthorized(req)) {
    return res.status(401).json({ message: 'UNAUTHORIZED_WORKER_REQUEST' });
  }

  const session = sessions.get(req.params.id);
  if (!session) {
    return res.status(404).json({ message: 'WORKER_SESSION_NOT_FOUND' });
  }

  const after = Number(req.query.after || 0);
  const queue = sessionSignals.get(session.id) || [];
  const signals = queue.filter((item) => item.id > after).slice(0, 100);

  return res.json({ signals });
});

app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`worker running on port ${port}`);
});

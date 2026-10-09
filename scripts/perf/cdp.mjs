// Minimal Chrome DevTools Protocol client for the measurement harness.
// Launches a throwaway Chrome profile and speaks CDP over Node's built-in
// WebSocket (Node >= 22). No dependencies.
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export async function launchChrome({ binary, headless = true, windowSize = '1280,900', extraArgs = [] }) {
  const userDataDir = await mkdtemp(join(tmpdir(), 'neuromorphic-perf-chrome-'));
  const args = [
    headless ? '--headless=new' : null,
    '--remote-debugging-port=0',
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-sync',
    '--disable-component-update',
    '--disable-background-networking',
    // Keep the measured page from being throttled as a background/occluded
    // window; visibility is exercised explicitly by the harness instead.
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
    `--window-size=${windowSize}`,
    ...extraArgs,
    'about:blank',
  ].filter(Boolean);
  const child = spawn(binary, args, { stdio: 'ignore' });
  const portFile = join(userDataDir, 'DevToolsActivePort');
  let endpoint = null;
  for (let attempt = 0; attempt < 200 && !endpoint; attempt += 1) {
    await delay(50);
    try {
      const [port, path] = (await readFile(portFile, 'utf8')).trim().split('\n');
      if (port && path) endpoint = `ws://127.0.0.1:${port}${path}`;
    } catch {
      // Not written yet.
    }
  }
  if (!endpoint) {
    child.kill();
    throw new Error('Chrome did not expose a DevTools endpoint');
  }
  const connection = await CdpConnection.open(endpoint);
  return {
    connection,
    async close() {
      try {
        await connection.send('Browser.close');
      } catch {
        child.kill();
      }
      connection.close();
      await new Promise((resolve) => {
        if (child.exitCode !== null) resolve();
        else child.once('exit', resolve);
        setTimeout(resolve, 5000);
      });
      await rm(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
    },
  };
}

export class CdpConnection {
  static open(url) {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      socket.addEventListener('open', () => resolve(new CdpConnection(socket)), { once: true });
      socket.addEventListener('error', () => reject(new Error(`could not connect to ${url}`)), { once: true });
    });
  }

  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Set();
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== undefined) {
        const entry = this.pending.get(message.id);
        if (entry) {
          this.pending.delete(message.id);
          if (message.error) entry.reject(new Error(`${entry.method}: ${message.error.message}`));
          else entry.resolve(message.result);
        }
        return;
      }
      for (const listener of this.listeners) listener(message);
    });
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  on(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close() {
    this.socket.close();
  }
}

/** A page target with helpers for evaluation. */
export async function openPage(connection) {
  const { targetId } = await connection.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await connection.send('Target.attachToTarget', { targetId, flatten: true });
  const send = (method, params) => connection.send(method, params, sessionId);
  await send('Page.enable');
  await send('Runtime.enable');
  const errors = [];
  connection.on((message) => {
    if (message.sessionId !== sessionId) return;
    if (message.method === 'Runtime.exceptionThrown') {
      errors.push(message.params.exceptionDetails?.exception?.description ?? message.params.exceptionDetails?.text);
    }
  });
  return {
    targetId,
    sessionId,
    send,
    errors,
    async evaluate(expression, { timeoutMs = 120_000 } = {}) {
      const result = await send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
        timeout: timeoutMs,
      });
      if (result.exceptionDetails) {
        throw new Error(
          `page evaluation failed: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`,
        );
      }
      return result.result.value;
    },
    async navigate(url) {
      const loaded = new Promise((resolve) => {
        const stop = connection.on((message) => {
          if (message.sessionId === sessionId && message.method === 'Page.loadEventFired') {
            stop();
            resolve();
          }
        });
      });
      await send('Page.navigate', { url });
      await loaded;
    },
  };
}

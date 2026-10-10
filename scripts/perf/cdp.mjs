// Minimal Chrome DevTools Protocol client for the measurement harness.
// Launches a throwaway Chrome profile and speaks CDP over Node's built-in
// WebSocket (Node >= 22). No dependencies.
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

/** Wait for a child to exit, at most `ms`; true when it has exited. */
function waitForExit(child, ms) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve(true);
      return;
    }
    const timer = setTimeout(() => resolve(false), ms);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

/** Chrome's arguments for a throwaway, unthrottled measurement profile. */
function chromeArgs({ headless, userDataDir, windowSize, extraArgs }) {
  return [
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
}

/** Poll for Chrome's DevTools endpoint, failing fast if the process dies. */
async function devToolsEndpoint(child, userDataDir, startupTimeoutMs, spawnFailure) {
  const portFile = join(userDataDir, 'DevToolsActivePort');
  const deadline = Date.now() + startupTimeoutMs;
  for (;;) {
    const failure = spawnFailure();
    if (failure) throw new Error(`could not start the browser: ${failure.message}`);
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`the browser exited during startup (${child.exitCode ?? child.signalCode})`);
    }
    try {
      const [port, path] = (await readFile(portFile, 'utf8')).trim().split('\n');
      if (port && path) return `ws://127.0.0.1:${port}${path}`;
    } catch {
      // Not written yet.
    }
    if (Date.now() > deadline) throw new Error('the browser did not expose a DevTools endpoint');
    await delay(50);
  }
}

/**
 * Start Chrome with a throwaway profile and connect over CDP. If any step
 * fails (spawn error, early exit, no DevTools endpoint, or a CDP connection
 * that cannot open), the process is killed and the profile removed before
 * the error is rethrown, so a failed start leaks nothing.
 *
 * `binaryArgs` go before Chrome's own arguments and `profileRoot` holds the
 * profile; both exist so tests can stand in a fake browser.
 */
export async function launchChrome({
  binary,
  headless = true,
  windowSize = '1280,900',
  extraArgs = [],
  binaryArgs = [],
  profileRoot = tmpdir(),
  startupTimeoutMs = 10_000,
}) {
  const userDataDir = await mkdtemp(join(profileRoot, 'neuromorphic-perf-chrome-'));
  let child = null;
  let connection = null;
  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    connection?.close();
    // A binary that failed to spawn has no pid and never emits 'exit'.
    if (child?.pid !== undefined) {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await waitForExit(child, 5000);
    }
    await rm(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
  };

  try {
    let spawnError = null;
    child = spawn(binary, [...binaryArgs, ...chromeArgs({ headless, userDataDir, windowSize, extraArgs })], {
      stdio: 'ignore',
    });
    child.once('error', (error) => {
      spawnError = error;
    });
    const endpoint = await devToolsEndpoint(child, userDataDir, startupTimeoutMs, () => spawnError);
    connection = await CdpConnection.open(endpoint, startupTimeoutMs);
  } catch (error) {
    await release();
    throw error;
  }

  return {
    connection,
    async close() {
      try {
        await connection.send('Browser.close');
      } catch {
        // Fall through: release() kills the process.
      }
      await waitForExit(child, 5000);
      await release();
    },
  };
}

export class CdpConnection {
  static open(url, timeoutMs = 10_000) {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      const timer = setTimeout(() => {
        socket.close();
        reject(new Error(`timed out connecting to ${url}`));
      }, timeoutMs);
      socket.addEventListener(
        'open',
        () => {
          clearTimeout(timer);
          resolve(new CdpConnection(socket));
        },
        { once: true },
      );
      socket.addEventListener(
        'error',
        () => {
          clearTimeout(timer);
          reject(new Error(`could not connect to ${url}`));
        },
        { once: true },
      );
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

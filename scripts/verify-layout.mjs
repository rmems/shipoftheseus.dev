// Layout check for the built site (GitHub #13 / Linear RM-1649).
//
//   npm run build
//   BROWSER_BIN="<absolute path to chrome>" npm run test:layout
//
// Serves `dist/` from an in-process static server and loads every built page
// in headless Chrome at 320, 360, 375, 768, and 1024 CSS px, first at the
// default root text size and then at 200%, each in the site's fonts and in a
// wide fallback face (see FONT_VARIANTS). It fails if any page scrolls
// horizontally and names the element that overflows. The homepage is checked
// a second time with its live telemetry panel open, once the lazily loaded
// view has rendered. It also loads the homepage at a desktop size, where the
// hero's live demo is in view, and fails if the homepage requests the labs
// WASM package. Node 20 needs
// `--experimental-websocket` (the npm script passes it); Node 22 has
// `WebSocket` built in.
import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

export const LAYOUT_WIDTHS = Object.freeze([320, 360, 375, 768, 1024]);
export const TEXT_SCALES = Object.freeze(['100%', '200%']);
const WIDE_FACE = "'DejaVu Sans Mono', 'Courier New', monospace";
/**
 * Font stacks to measure with. `site` is whatever the machine resolves for the
 * site's own stacks (CI runners have none of its named faces). `wide` swaps
 * every font token for a monospace face of about 0.6 em per character (DejaVu
 * Sans Mono on Linux, Courier New elsewhere). That is wider than the site's
 * faces and their usual fallbacks, so a layout that passes it does not depend
 * on font metrics.
 */
export const FONT_VARIANTS = Object.freeze({
  site: null,
  wide: `:root { --serif: ${WIDE_FACE}; --sans: ${WIDE_FACE}; --mono: ${WIDE_FACE}; }`,
});
export const LABS_PACKAGE_PATH = '/wasm/neuromorphic-adapter-labs/';

const repository = resolve(import.meta.dirname, '..');

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.txt': 'text/plain; charset=utf-8',
};

/** Every built HTML page under `dist`, as a URL path (`/`, `/work/`, `/404.html`). */
export async function builtPagePaths(dist) {
  const paths = [];
  const walk = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
      } else if (entry.isFile() && entry.name.endsWith('.html')) {
        const url = `/${relative(dist, path).split(sep).join('/')}`;
        paths.push(url.endsWith('/index.html') ? url.slice(0, -'index.html'.length) : url);
      }
    }
  };
  await walk(dist);
  return paths.sort(byCodeUnit);
}

/** Plain code-unit order (what `sort()` does by default), stated explicitly. */
function byCodeUnit(left, right) {
  if (left < right) return -1;
  return left > right ? 1 : 0;
}

/** Measurements that scroll horizontally, as readable failure lines. */
export function overflowFailures(measurements) {
  return measurements
    .filter((measurement) => measurement.overflowPx > 0)
    .map(
      ({ path, width, scale, fonts, state, overflowPx, culprit, widest }) =>
        `${path} at ${width}px, ${scale} text${fonts && fonts !== 'site' ? `, ${fonts} fonts` : ''}` +
        `${state ? `, ${state}` : ''}: ` +
        `scrolls ${overflowPx}px horizontally` +
        (culprit ? `; first to overflow: ${culprit}` : '') +
        (widest && widest !== culprit ? `; reaches furthest: ${widest}` : ''),
    );
}

/** Requested URL paths that reach the labs package. */
export function labsPackageRequests(urls) {
  return urls.filter((url) => new URL(url, 'http://localhost').pathname.startsWith(LABS_PACKAGE_PATH));
}

/**
 * Page-side measurement: horizontal overflow at the given root text size and
 * font override. Names the outermost element that sticks out of a parent that
 * itself fits (usually the cause) and the element reaching furthest right,
 * each as `tag.classes in ancestor.class "text"`. Self-contained: it is
 * serialized and evaluated in the page.
 */
function measureOverflow({ scale, fontCss }) {
  const root = document.documentElement;
  root.style.fontSize = scale;
  let override = document.getElementById('layout-check-fonts');
  if (fontCss && !override) {
    override = document.createElement('style');
    override.id = 'layout-check-fonts';
    document.head.append(override);
  }
  if (override) override.textContent = fontCss ?? '';
  const limit = root.clientWidth + 0.5;
  const overflowPx = root.scrollWidth - root.clientWidth;
  const classesOf = (element) =>
    typeof element.className === 'string' ? element.className.trim().split(/\s+/).filter(Boolean) : [];
  const describe = (element) => {
    let context = element.parentElement;
    while (context && classesOf(context).length === 0) context = context.parentElement;
    const where = context ? ` in ${context.tagName.toLowerCase()}.${classesOf(context)[0]}` : '';
    const text = (element.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);
    const own = `${element.tagName.toLowerCase()}${classesOf(element).map((name) => `.${name}`).join('')}`;
    return `${own}${where}${text ? ` "${text}"` : ''}`;
  };
  // Content inside a scroll or clip container (a wide table in its
  // `overflow-x: auto` wrapper) cannot widen the page; skip it.
  const clipped = (element) => {
    for (let ancestor = element.parentElement; ancestor && ancestor !== document.body; ancestor = ancestor.parentElement) {
      if (getComputedStyle(ancestor).overflowX !== 'visible') return true;
    }
    return false;
  };
  let culprit = null;
  let widest = null;
  if (overflowPx > 0) {
    let right = limit;
    for (const element of document.body.querySelectorAll('*')) {
      const box = element.getBoundingClientRect();
      if (box.width === 0 || box.right <= limit || clipped(element)) continue;
      if (culprit === null && (element.parentElement?.getBoundingClientRect().right ?? 0) <= limit) {
        culprit = describe(element);
      }
      if (box.right > right) {
        right = box.right;
        widest = describe(element);
      }
    }
  }
  return { overflowPx, culprit, widest };
}

/**
 * Page-side: open the homepage's live telemetry panel and wait for its lazily
 * loaded view to render live data. Without a live runtime (no WebGL or WASM on
 * the machine, so the demo falls back) the data section stays hidden; its
 * static markup is then shown with an injected rule so its layout is still
 * measured. Self-contained: it is serialized and evaluated in the page.
 */
async function openTelemetryPanel({ timeoutMs }) {
  const island = document.querySelector('[data-neuromorphic-demo]');
  const panel = document.querySelector('details[data-demo-telemetry]');
  const live = panel?.querySelector('[data-telemetry-live]');
  if (!panel || !live) return { rendered: 'missing' };
  panel.open = true;
  panel.scrollIntoView({ block: 'start' });
  const started = performance.now();
  while (live.hidden && island?.dataset.mode !== 'fallback' && performance.now() - started < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (live.hidden) {
    const show = document.createElement('style');
    show.id = 'layout-check-telemetry';
    show.textContent = '[data-telemetry-live][hidden] { display: grid !important; }';
    document.head.append(show);
    return { rendered: 'static', telemetryState: panel.dataset.telemetryState ?? null };
  }
  // Let a refresh fill the neuron chips and edge tables.
  await new Promise((resolve) => setTimeout(resolve, 600));
  return { rendered: 'live', telemetryState: panel.dataset.telemetryState ?? null };
}

function serve(root) {
  const requests = [];
  const server = createServer(async (request, response) => {
    try {
      const { pathname } = new URL(request.url, 'http://localhost');
      requests.push(pathname);
      let file = normalize(join(root, decodeURIComponent(pathname)));
      if (!file.startsWith(root + sep) && file !== root) throw new Error('outside root');
      let info = await stat(file).catch(() => null);
      if (info?.isDirectory()) {
        file = join(file, 'index.html');
        info = await stat(file).catch(() => null);
      }
      if (!info) {
        response.writeHead(404).end('not found');
        return;
      }
      response.writeHead(200, {
        'content-type': CONTENT_TYPES[extname(file)] ?? 'application/octet-stream',
        'cache-control': 'no-store',
      });
      createReadStream(file).pipe(response);
    } catch {
      response.writeHead(400).end('bad request');
    }
  });
  return new Promise((resolveServer) => {
    server.listen(0, '127.0.0.1', () => resolveServer({ server, requests }));
  });
}

async function main() {
  const browser = process.env.BROWSER_BIN;
  if (!browser || !isAbsolute(browser)) {
    throw new Error('BROWSER_BIN must be an absolute path to a Chrome or Chromium executable.');
  }
  const dist = join(repository, 'dist');
  if (!(await stat(join(dist, 'index.html')).catch(() => null))) {
    throw new Error('dist/index.html is missing; run `npm run build` first.');
  }

  const { launchChrome, openPage } = await import('./perf/cdp.mjs');
  const { server, requests } = await serve(dist);
  const origin = `http://127.0.0.1:${server.address().port}`;
  const chrome = await launchChrome({ binary: browser, extraArgs: ['--no-sandbox'] });
  const failures = [];
  try {
    const page = await openPage(chrome.connection);
    const measurements = [];
    const paths = await builtPagePaths(dist);
    for (const path of paths) {
      for (const width of LAYOUT_WIDTHS) {
        await page.send('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: true });
        await page.navigate(`${origin}${path}`);
        // Let progressive enhancement (labs, protocol, demo status) settle.
        await delay(400);
        for (const [fonts, fontCss] of Object.entries(FONT_VARIANTS)) {
          for (const scale of TEXT_SCALES) {
            const result = await page.evaluate(`(${measureOverflow.toString()})(${JSON.stringify({ scale, fontCss })})`);
            measurements.push({ path, width, scale, fonts, ...result });
          }
        }
      }
    }
    // The homepage again, with the live telemetry panel open and rendered.
    const panelStates = new Set();
    for (const width of LAYOUT_WIDTHS) {
      await page.send('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: true });
      await page.navigate(`${origin}/`);
      await delay(400);
      const opened = await page.evaluate(`(${openTelemetryPanel.toString()})(${JSON.stringify({ timeoutMs: 6000 })})`);
      if (opened.rendered === 'missing') {
        failures.push(`the homepage has no telemetry panel to open at ${width}px`);
        continue;
      }
      panelStates.add(opened.rendered);
      const state = `telemetry panel open (${opened.rendered === 'live' ? 'live data' : 'static markup, no live runtime'})`;
      for (const [fonts, fontCss] of Object.entries(FONT_VARIANTS)) {
        for (const scale of TEXT_SCALES) {
          const result = await page.evaluate(`(${measureOverflow.toString()})(${JSON.stringify({ scale, fontCss })})`);
          measurements.push({ path: '/', width, scale, fonts, state, ...result });
        }
      }
    }
    failures.push(...overflowFailures(measurements));

    requests.length = 0;
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await page.navigate(`${origin}/`);
    await delay(2500);
    const mode = await page.evaluate(`document.querySelector('[data-neuromorphic-demo]')?.dataset.mode ?? 'missing'`);
    for (const url of labsPackageRequests(requests)) {
      failures.push(`the homepage requested the labs package: ${url}`);
    }
    if (failures.length === 0) {
      process.stdout.write(
        `Layout check passed: ${paths.length} pages at ${LAYOUT_WIDTHS.join(', ')} px with ${TEXT_SCALES.join(' and ')} text, ` +
          `in the site's fonts and in wide fallback fonts, plus the homepage with the telemetry panel open ` +
          `(${[...panelStates].join(' and ')}); the homepage (demo mode: ${mode}) requested no labs package.\n`,
      );
    }
  } finally {
    await chrome.close();
    server.close();
  }
  if (failures.length > 0) {
    throw new Error(`Layout check failed:\n${failures.join('\n')}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}

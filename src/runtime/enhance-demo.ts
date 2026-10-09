import {
  applyDemoView,
  createDemoRuntime,
  detectCapabilities,
  getDemoSeams,
  type DemoRuntime,
  type DemoViewElements,
} from './demo-runtime';
import { provideLiveDemoSeams } from './live-seams';
import { bindDemoTelemetryPanel } from './telemetry-entry';

interface BoundIsland {
  dispose: () => void;
}

function requiredElement<T extends Element>(root: HTMLElement, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (!element) {
    throw new Error(`Neuromorphic demo island is missing ${selector}`);
  }

  return element;
}

function viewElements(root: HTMLElement): DemoViewElements {
  return {
    root: { dataset: root.dataset as Record<string, string> },
    status: requiredElement<HTMLElement>(root, '[data-demo-status]'),
    play: requiredElement<HTMLButtonElement>(root, '[data-demo-play]'),
    surface: requiredElement<HTMLElement>(root, '[data-demo-surface]'),
    origin: requiredElement<HTMLElement>(root, '[data-demo-origin]'),
  };
}

/** Elements whose visibility gates the island (`[data-demo-viewport]`), else the root. */
export function viewportTargets(root: HTMLElement): Element[] {
  const marked =
    typeof root.querySelectorAll === 'function' ? Array.from(root.querySelectorAll('[data-demo-viewport]')) : [];
  return marked.length > 0 ? marked : [root];
}

function motionQueryList(host: Window): MediaQueryList | undefined {
  if (typeof host.matchMedia !== 'function') {
    return undefined;
  }

  return host.matchMedia('(prefers-reduced-motion: reduce)');
}

export function bindDemoIsland(root: HTMLElement, runtime?: DemoRuntime): BoundIsland {
  const boundRuntime =
    runtime ??
    createDemoRuntime({
      capabilities: detectCapabilities(window),
      seams: getDemoSeams(root),
      inViewport: false,
      documentHidden: document.hidden,
    });
  const elements = viewElements(root);
  const play = requiredElement<HTMLButtonElement>(root, '[data-demo-play]');
  // Optional and closed by default: its code loads on first open, and it
  // samples only while open.
  const telemetry = bindDemoTelemetryPanel(root);
  const motionQuery = motionQueryList(window);
  let disposed = false;

  const paint = () => {
    if (!disposed) {
      applyDemoView(boundRuntime.getSnapshot(), elements);
    }
  };
  const unsubscribeSnapshot = boundRuntime.onSnapshotChange(paint);

  const onPlay = () => {
    const pending = boundRuntime.play();
    paint();
    void pending.then(paint);
  };

  const onVisibility = () => {
    void boundRuntime.setDocumentHidden(document.hidden).then(paint);
  };

  const onContextLost = () => {
    boundRuntime.reportContextLost();
    paint();
  };
  const contextLostCapture = { capture: true } as const;

  const onPageHide = (event: Event) => {
    if ('persisted' in event && event.persisted) {
      void boundRuntime.setDocumentHidden(true).then(paint);
      return;
    }

    dispose();
  };

  const onPageShow = () => {
    if (disposed) {
      return;
    }

    void boundRuntime.setDocumentHidden(document.hidden).then(paint);
  };

  const onMotionChange = (event: MediaQueryListEvent) => {
    boundRuntime.setPrefersReducedMotion(event.matches);
    paint();
  };

  const dispose = () => {
    if (disposed) {
      return;
    }

    disposed = true;
    unsubscribeSnapshot();
    play.removeEventListener('click', onPlay);
    document.removeEventListener('visibilitychange', onVisibility);
    document.removeEventListener('astro:before-swap', dispose);
    window.removeEventListener('pagehide', onPageHide);
    window.removeEventListener('pageshow', onPageShow);
    motionQuery?.removeEventListener('change', onMotionChange);
    root.removeEventListener('webglcontextlost', onContextLost, contextLostCapture);
    observer?.disconnect();
    telemetry?.dispose();
    boundRuntime.dispose();
  };

  play.addEventListener('click', onPlay);
  document.addEventListener('visibilitychange', onVisibility);
  document.addEventListener('astro:before-swap', dispose);
  window.addEventListener('pagehide', onPageHide);
  window.addEventListener('pageshow', onPageShow);
  motionQuery?.addEventListener('change', onMotionChange);
  root.addEventListener('webglcontextlost', onContextLost, contextLostCapture);

  // The island runs while any of its viewport targets is on screen. In the
  // homepage hero those are the mesh and the telemetry panel, so hero copy
  // alone in view (the mesh still below the fold on a phone) starts nothing,
  // and reading the open panel keeps it fed. Islands without targets use the
  // whole root.
  const targets = viewportTargets(root);
  const intersecting = new Set<Element>();
  const observer =
    'IntersectionObserver' in window
      ? new IntersectionObserver(
          (entries) => {
            for (const entry of entries) {
              if (entry.isIntersecting) {
                intersecting.add(entry.target);
              } else {
                intersecting.delete(entry.target);
              }
            }
            const visible = intersecting.size > 0;
            void boundRuntime.setInViewport(visible).then(paint);
          },
          { threshold: 0.2 },
        )
      : null;

  if (observer) {
    for (const target of targets) {
      observer.observe(target);
    }
  } else {
    void boundRuntime.setInViewport(true).then(paint);
  }

  void boundRuntime.startIfAllowed().then(paint);
  paint();

  return { dispose };
}

export function enhanceNeuromorphicDemos(scope: ParentNode = document): BoundIsland[] {
  provideLiveDemoSeams();
  const islands: BoundIsland[] = [];

  for (const root of scope.querySelectorAll<HTMLElement>('[data-neuromorphic-demo]')) {
    try {
      islands.push(bindDemoIsland(root));
    } catch {
      // Capability or binding failures must not interrupt the surrounding page.
    }
  }

  return islands;
}

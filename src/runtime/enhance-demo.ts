import {
  applyDemoView,
  createDemoRuntime,
  detectCapabilities,
  getDemoSeams,
  type DemoRuntime,
  type DemoViewElements,
} from './demo-runtime';

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
      seams: getDemoSeams(),
      inViewport: false,
      documentHidden: document.hidden,
    });
  const elements = viewElements(root);
  const play = requiredElement<HTMLButtonElement>(root, '[data-demo-play]');
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
    boundRuntime.dispose();
  };

  play.addEventListener('click', onPlay);
  document.addEventListener('visibilitychange', onVisibility);
  document.addEventListener('astro:before-swap', dispose);
  window.addEventListener('pagehide', onPageHide);
  window.addEventListener('pageshow', onPageShow);
  motionQuery?.addEventListener('change', onMotionChange);
  root.addEventListener('webglcontextlost', onContextLost, contextLostCapture);

  const observer =
    'IntersectionObserver' in window
      ? new IntersectionObserver(
          (entries) => {
            const visible = entries.some((entry) => entry.isIntersecting);
            void boundRuntime.setInViewport(visible).then(paint);
          },
          { threshold: 0.2 },
        )
      : null;

  if (observer) {
    observer.observe(root);
  } else {
    void boundRuntime.setInViewport(true).then(paint);
  }

  void boundRuntime.startIfAllowed().then(paint);
  paint();

  return { dispose };
}

export function enhanceNeuromorphicDemos(scope: ParentNode = document): BoundIsland[] {
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

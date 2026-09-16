import {
  applyDemoView,
  createDemoRuntime,
  detectCapabilities,
  getDemoSeams,
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
  };
}

export function bindDemoIsland(root: HTMLElement): BoundIsland {
  const runtime = createDemoRuntime({
    capabilities: detectCapabilities(window),
    seams: getDemoSeams(),
    inViewport: false,
    documentHidden: document.hidden,
  });
  const elements = viewElements(root);
  const play = requiredElement<HTMLButtonElement>(root, '[data-demo-play]');
  let disposed = false;

  const paint = () => {
    if (!disposed) {
      applyDemoView(runtime.getSnapshot(), elements);
    }
  };

  const onPlay = () => {
    void runtime.play().then(paint);
  };

  const onVisibility = () => {
    runtime.setDocumentHidden(document.hidden);
    paint();
  };

  const onContextLost = () => {
    runtime.reportContextLost();
    paint();
  };

  const dispose = () => {
    if (disposed) {
      return;
    }

    disposed = true;
    play.removeEventListener('click', onPlay);
    document.removeEventListener('visibilitychange', onVisibility);
    document.removeEventListener('astro:before-swap', dispose);
    window.removeEventListener('pagehide', dispose);
    root.removeEventListener('webglcontextlost', onContextLost);
    observer?.disconnect();
    runtime.dispose();
  };

  play.addEventListener('click', onPlay);
  document.addEventListener('visibilitychange', onVisibility);
  document.addEventListener('astro:before-swap', dispose);
  window.addEventListener('pagehide', dispose);
  root.addEventListener('webglcontextlost', onContextLost, { capture: true });

  const observer =
    'IntersectionObserver' in window
      ? new IntersectionObserver(
          (entries) => {
            const visible = entries.some((entry) => entry.isIntersecting);
            runtime.setInViewport(visible);
            paint();
          },
          { threshold: 0.2 },
        )
      : null;

  if (observer) {
    observer.observe(root);
  } else {
    runtime.setInViewport(true);
  }

  void runtime.startIfAllowed().then(paint);
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

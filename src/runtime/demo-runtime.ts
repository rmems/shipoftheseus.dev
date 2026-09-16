export const STATIC_DEMO_STATUS =
  'The static diagram explains the neuromorphic demo. The live visualization is an optional enhancement.';

export const REASON_CODES = [
  'ok',
  'reduced-motion',
  'no-webgl',
  'webgl-context-lost',
  'renderer-error',
  'no-wasm',
  'wasm-init-failed',
  'worker-unavailable',
  'worker-init-failed',
  'worker-runtime-failed',
  'adapter-unavailable',
  'unavailable',
] as const;

export type ReasonCode = (typeof REASON_CODES)[number];

export type DemoMode = 'static' | 'awaiting-play' | 'initializing' | 'live' | 'frozen' | 'fallback';

export type WorkerFailurePhase = 'before-init' | 'after-init';

export interface Capabilities {
  prefersReducedMotion: boolean;
  webgl: boolean;
  wasm: boolean;
  worker: boolean;
}

export interface CapabilityHost {
  matchMedia?: (query: string) => { matches: boolean };
  WebAssembly?: { instantiate?: unknown };
  Worker?: unknown;
  document?: {
    createElement: (tag: string) => {
      getContext: (id: string) => WebGlContext | null;
    };
  };
}

export interface WebGlContext {
  getExtension?: (name: string) => { loseContext?: () => void } | null;
}

export interface RendererSession {
  dispose: () => void;
  pause?: () => void;
  resume?: () => void;
  freeze?: () => void;
}

export interface WasmSession {
  dispose: () => void;
  pause?: () => void;
  resume?: () => void;
}

export interface RendererCreateOptions {
  cameraMotionEnabled: boolean;
}

export interface RendererSeam {
  create: (options: RendererCreateOptions) => Promise<RendererSession>;
  disposePartial?: () => void;
}

export interface WasmSeam {
  init: (options: { useWorker: boolean }) => Promise<WasmSession>;
}

export interface DemoSeams {
  renderer?: RendererSeam | null;
  wasm?: WasmSeam | null;
}

export interface DemoSnapshot {
  mode: DemoMode;
  reason: ReasonCode;
  status: string;
  liveControlsEnabled: boolean;
  playVisible: boolean;
  playEnabled: boolean;
  playLabel: 'Play animation' | 'Pause animation';
  cameraMotionEnabled: boolean;
  freezeFrame: boolean;
  hasGraphicsSurface: boolean;
}

export interface DemoViewElements {
  root: {
    dataset: Record<string, string>;
  };
  status: {
    textContent: string | null;
  };
  play: {
    hidden: boolean;
    disabled: boolean;
    textContent: string | null;
  };
  surface?: {
    hidden: boolean;
  };
}

export interface CreateDemoRuntimeOptions {
  capabilities: Capabilities;
  seams?: DemoSeams;
  inViewport?: boolean;
  documentHidden?: boolean;
}

interface SessionAttempt<T> {
  session: T | null;
  error: ReasonCode | null;
}

const REASON_SET = new Set<string>(REASON_CODES);

let seamProvider: () => DemoSeams = () => ({});

export function provideDemoSeams(provider: () => DemoSeams): void {
  seamProvider = provider;
}

export function getDemoSeams(): DemoSeams {
  return seamProvider();
}

export function isReasonCode(value: unknown): value is ReasonCode {
  return typeof value === 'string' && REASON_SET.has(value);
}

function assertNever(value: never): never {
  throw new Error(`Unhandled demo runtime variant: ${String(value)}`);
}

export function detectCapabilities(host: CapabilityHost = globalThis): Capabilities {
  return {
    prefersReducedMotion: Boolean(host.matchMedia?.('(prefers-reduced-motion: reduce)').matches),
    webgl: detectWebGL(host),
    wasm: typeof host.WebAssembly === 'object' && typeof host.WebAssembly.instantiate === 'function',
    worker: typeof host.Worker === 'function',
  };
}

export function detectWebGL(host: CapabilityHost): boolean {
  if (!host.document?.createElement) {
    return false;
  }

  try {
    const canvas = host.document.createElement('canvas');
    const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
    if (!gl) {
      return false;
    }

    const loseContext = gl.getExtension?.('WEBGL_lose_context');
    loseContext?.loseContext?.();
    return true;
  } catch {
    return false;
  }
}

export function statusMessage(snapshot: Pick<DemoSnapshot, 'mode' | 'reason' | 'cameraMotionEnabled'>): string {
  switch (snapshot.reason) {
    case 'ok':
      if (snapshot.mode === 'live') {
        return snapshot.cameraMotionEnabled
          ? 'Live visualization is running.'
          : 'Live visualization is running. Nonessential camera motion stays off.';
      }
      if (snapshot.mode === 'awaiting-play') {
        return 'Motion is paused. Play animation to start the live visualization.';
      }
      return STATIC_DEMO_STATUS;
    case 'reduced-motion':
      return snapshot.mode === 'live'
        ? 'Live visualization is running. Nonessential camera motion stays off.'
        : 'Motion is paused. Play animation to start the live visualization.';
    case 'no-webgl':
      return 'This browser cannot start the WebGL renderer. The static diagram remains available.';
    case 'webgl-context-lost':
      return 'The renderer lost its graphics context. The static diagram remains available.';
    case 'renderer-error':
      return 'The renderer stopped. The static diagram remains available.';
    case 'no-wasm':
      return 'WebAssembly is unavailable, so the live network cannot run. The static diagram remains available.';
    case 'wasm-init-failed':
      return 'The live network could not start. The static diagram remains available.';
    case 'worker-unavailable':
      return 'The live network could not start. The static diagram remains available.';
    case 'worker-init-failed':
      return 'The live network could not start. The static diagram remains available.';
    case 'worker-runtime-failed':
      return snapshot.mode === 'frozen'
        ? 'The live network paused on the last valid frame.'
        : 'The live network stopped. The static diagram remains available.';
    case 'adapter-unavailable':
      return 'The live visualization is not connected yet. The static diagram remains available.';
    case 'unavailable':
      return 'The live visualization is unavailable. Page content and navigation remain usable.';
    default:
      return assertNever(snapshot.reason);
  }
}

export function reasonFromError(error: unknown, fallback: ReasonCode): ReasonCode {
  if (typeof error === 'object' && error && 'code' in error) {
    const code = (error as { code: unknown }).code;
    if (isReasonCode(code) && code !== 'ok') {
      return code;
    }
  }

  return fallback;
}

function combineFailureReasons(rendererError: ReasonCode | null, wasmError: ReasonCode | null): ReasonCode {
  if (rendererError && wasmError && rendererError !== wasmError) {
    return 'unavailable';
  }

  return rendererError ?? wasmError ?? 'unavailable';
}

export function applyDemoView(snapshot: DemoSnapshot, elements: DemoViewElements): void {
  elements.root.dataset.mode = snapshot.mode;
  elements.root.dataset.reason = snapshot.reason;
  elements.status.textContent = snapshot.status;
  elements.play.hidden = !snapshot.playVisible;
  elements.play.disabled = !snapshot.playEnabled;
  elements.play.textContent = snapshot.playLabel;
  if (elements.surface) {
    elements.surface.hidden = !snapshot.hasGraphicsSurface;
  }
}

function seamsAreConnected(seams: DemoSeams): boolean {
  return Boolean(seams.renderer && seams.wasm);
}

export class DemoRuntime {
  private readonly capabilities: Capabilities;
  private readonly seams: DemoSeams;
  private mode: DemoMode = 'static';
  private reason: ReasonCode = 'ok';
  private inViewport: boolean;
  private documentHidden: boolean;
  private disposed = false;
  private initializing = false;
  private initCompleted = false;
  private workerRetryUsed = false;
  private clockPaused = false;
  private userPaused = false;
  private generation = 0;
  private rendererSession: RendererSession | null = null;
  private wasmSession: WasmSession | null = null;
  private initPromise: Promise<void> | null = null;
  private wasmRetryPromise: Promise<SessionAttempt<WasmSession>> | null = null;

  constructor(options: CreateDemoRuntimeOptions) {
    this.capabilities = options.capabilities;
    this.seams = options.seams ?? {};
    this.inViewport = options.inViewport ?? false;
    this.documentHidden = options.documentHidden ?? false;
    this.syncFromCapabilities();
  }

  getSnapshot(): DemoSnapshot {
    const canLive = this.canAttemptLive();
    const playVisible = canLive && this.mode !== 'frozen' && this.mode !== 'fallback';
    const playEnabled =
      playVisible && !this.initializing && (this.mode === 'awaiting-play' || this.mode === 'live' || this.mode === 'static');
    const cameraMotionEnabled = this.mode === 'live' && !this.capabilities.prefersReducedMotion && !this.clockPaused;
    const snapshot: DemoSnapshot = {
      mode: this.mode,
      reason: this.reason,
      status: '',
      liveControlsEnabled: playVisible,
      playVisible,
      playEnabled,
      playLabel: this.mode === 'live' && !this.userPaused ? 'Pause animation' : 'Play animation',
      cameraMotionEnabled,
      freezeFrame: this.mode === 'frozen',
      hasGraphicsSurface: this.rendererSession !== null && this.mode !== 'fallback',
    };
    snapshot.status = statusMessage(snapshot);
    return snapshot;
  }

  async startIfAllowed(): Promise<void> {
    if (this.disposed || this.userPaused || this.mode === 'frozen' || this.mode === 'fallback') {
      return;
    }

    if (!this.canAttemptLive()) {
      this.syncFromCapabilities();
      return;
    }

    if (this.initCompleted) {
      this.promoteToLive();
      return;
    }

    if (this.capabilities.prefersReducedMotion) {
      this.mode = 'awaiting-play';
      this.reason = 'reduced-motion';
      return;
    }

    if (!this.inViewport || this.documentHidden) {
      if (this.mode === 'static') {
        this.mode = 'awaiting-play';
        this.reason = 'ok';
      }
      return;
    }

    await this.initialize();
  }

  async play(): Promise<void> {
    if (this.disposed || this.mode === 'frozen' || this.mode === 'fallback') {
      return;
    }

    if (this.mode === 'live') {
      this.pauseClock('user');
      this.mode = 'awaiting-play';
      this.reason = this.capabilities.prefersReducedMotion ? 'reduced-motion' : 'ok';
      return;
    }

    this.userPaused = false;
    if (!this.initCompleted) {
      await this.initialize();
    }

    if (this.disposed || !this.initCompleted) {
      return;
    }

    this.promoteToLive();
  }

  setInViewport(inViewport: boolean): void {
    this.inViewport = inViewport;
    if (!inViewport) {
      this.pauseClock('environment');
      return;
    }

    this.resumeClock();
    void this.startIfAllowed();
  }

  setDocumentHidden(documentHidden: boolean): void {
    this.documentHidden = documentHidden;
    if (documentHidden) {
      this.pauseClock('environment');
      return;
    }

    this.resumeClock();
    void this.startIfAllowed();
  }

  reportContextLost(): void {
    this.failGraphics('webgl-context-lost');
  }

  reportRendererError(): void {
    this.failGraphics('renderer-error');
  }

  async reportWorkerFailure(phase: WorkerFailurePhase): Promise<void> {
    switch (phase) {
      case 'before-init':
        if (this.initCompleted) {
          this.freezeOrFallback();
          return;
        }
        await this.retryWasmOnMainThread();
        return;
      case 'after-init':
        this.freezeOrFallback();
        return;
      default:
        assertNever(phase);
    }
  }

  dispose(): void {
    this.disposed = true;
    this.generation += 1;
    this.teardownSessions();
    this.mode = this.mode === 'frozen' ? 'frozen' : 'static';
  }

  private canAttemptLive(): boolean {
    return this.capabilities.webgl && this.capabilities.wasm && seamsAreConnected(this.seams);
  }

  private syncFromCapabilities(): void {
    if (this.disposed || this.initCompleted) {
      return;
    }

    if (!this.capabilities.webgl && !this.capabilities.wasm) {
      this.mode = 'fallback';
      this.reason = 'unavailable';
      return;
    }

    if (!this.capabilities.webgl) {
      this.mode = 'fallback';
      this.reason = 'no-webgl';
      return;
    }

    if (!this.capabilities.wasm) {
      this.mode = 'fallback';
      this.reason = 'no-wasm';
      return;
    }

    if (!seamsAreConnected(this.seams)) {
      this.mode = 'fallback';
      this.reason = 'adapter-unavailable';
      return;
    }

    if (this.capabilities.prefersReducedMotion) {
      this.mode = 'awaiting-play';
      this.reason = 'reduced-motion';
      return;
    }

    this.mode = 'static';
    this.reason = 'ok';
  }

  private cameraMotionPolicy(): boolean {
    return !this.capabilities.prefersReducedMotion;
  }

  private async initialize(): Promise<void> {
    if (this.initPromise !== null) {
      await this.initPromise;
      return;
    }

    this.initPromise = this.runInitialization();
    try {
      await this.initPromise;
    } finally {
      this.initPromise = null;
    }
  }

  private async runInitialization(): Promise<void> {
    if (
      this.disposed ||
      this.initializing ||
      this.initCompleted ||
      this.mode === 'live' ||
      this.mode === 'frozen' ||
      this.mode === 'fallback'
    ) {
      return;
    }

    if (!this.canAttemptLive() || !this.seams.renderer || !this.seams.wasm) {
      this.syncFromCapabilities();
      return;
    }

    this.initializing = true;
    this.mode = 'initializing';
    const generation = ++this.generation;

    const rendererAttempt = await this.tryRenderer(this.seams.renderer);
    const wasmAttempt = await this.tryWasm(this.seams.wasm);

    if (this.disposed || generation !== this.generation) {
      rendererAttempt.session?.dispose();
      wasmAttempt.session?.dispose();
      this.seams.renderer.disposePartial?.();
      this.initializing = false;
      return;
    }

    if (rendererAttempt.error || wasmAttempt.error) {
      rendererAttempt.session?.dispose();
      wasmAttempt.session?.dispose();
      this.seams.renderer.disposePartial?.();
      this.rendererSession = null;
      this.wasmSession = null;
      this.initializing = false;
      this.mode = 'fallback';
      this.reason = combineFailureReasons(rendererAttempt.error, wasmAttempt.error);
      return;
    }

    this.rendererSession = rendererAttempt.session;
    this.wasmSession = wasmAttempt.session;
    this.initCompleted = true;
    this.initializing = false;
    this.promoteToLive();
  }

  private promoteToLive(): void {
    if (this.disposed || !this.initCompleted || this.rendererSession === null || this.wasmSession === null) {
      return;
    }

    if (this.documentHidden || !this.inViewport) {
      this.rendererSession.pause?.();
      this.wasmSession.pause?.();
      this.clockPaused = true;
      this.mode = 'awaiting-play';
      this.reason = this.capabilities.prefersReducedMotion ? 'reduced-motion' : 'ok';
      return;
    }

    this.mode = 'live';
    this.reason = this.capabilities.prefersReducedMotion ? 'reduced-motion' : 'ok';
    this.rendererSession.resume?.();
    this.wasmSession.resume?.();
    this.clockPaused = false;
    this.userPaused = false;
  }

  private async tryRenderer(seam: RendererSeam): Promise<SessionAttempt<RendererSession>> {
    try {
      return {
        session: await seam.create({ cameraMotionEnabled: this.cameraMotionPolicy() }),
        error: null,
      };
    } catch (error) {
      seam.disposePartial?.();
      return { session: null, error: reasonFromError(error, 'renderer-error') };
    }
  }

  private async tryWasm(seam: WasmSeam): Promise<SessionAttempt<WasmSession>> {
    if (this.wasmRetryPromise !== null) {
      return this.wasmRetryPromise;
    }

    if (this.capabilities.worker) {
      try {
        const session = await seam.init({ useWorker: true });
        if (this.wasmRetryPromise !== null) {
          session.dispose();
          return this.wasmRetryPromise;
        }

        return { session, error: null };
      } catch (error) {
        if (this.wasmRetryPromise !== null || (!this.initCompleted && !this.workerRetryUsed)) {
          return this.beginMainThreadRetry(seam, error);
        }

        return { session: null, error: reasonFromError(error, 'worker-init-failed') };
      }
    }

    return this.beginMainThreadRetry(seam, { code: 'worker-unavailable' });
  }

  private beginMainThreadRetry(seam: WasmSeam, error: unknown): Promise<SessionAttempt<WasmSession>> {
    if (this.wasmRetryPromise === null) {
      this.wasmRetryPromise = this.retryWasm(seam, error);
    }

    return this.wasmRetryPromise;
  }

  private async retryWasm(seam: WasmSeam, error: unknown): Promise<SessionAttempt<WasmSession>> {
    this.workerRetryUsed = true;
    try {
      return { session: await seam.init({ useWorker: false }), error: null };
    } catch (retryError) {
      return {
        session: null,
        error: reasonFromError(retryError, reasonFromError(error, 'wasm-init-failed')),
      };
    }
  }

  private async retryWasmOnMainThread(): Promise<void> {
    if (this.initCompleted) {
      this.freezeOrFallback();
      return;
    }

    if (this.seams.wasm === null || this.seams.wasm === undefined) {
      if (!this.initializing) {
        this.mode = 'fallback';
        this.reason = 'worker-init-failed';
      }
      return;
    }

    const attempt = await this.beginMainThreadRetry(this.seams.wasm, { code: 'worker-init-failed' });
    if (this.initializing || this.disposed || this.mode === 'fallback') {
      return;
    }

    if (attempt.error !== null || attempt.session === null) {
      this.teardownSessions();
      this.mode = 'fallback';
      this.reason = attempt.error ?? 'wasm-init-failed';
      return;
    }

    this.wasmSession?.dispose();
    this.wasmSession = attempt.session;
  }

  private freezeOrFallback(): void {
    if (this.rendererSession?.freeze) {
      this.rendererSession.freeze();
      this.wasmSession?.pause?.();
      this.clockPaused = true;
      this.mode = 'frozen';
      this.reason = 'worker-runtime-failed';
      return;
    }

    this.teardownSessions();
    this.mode = 'fallback';
    this.reason = 'worker-runtime-failed';
  }

  private failGraphics(reason: ReasonCode): void {
    this.generation += 1;
    this.seams.renderer?.disposePartial?.();
    this.teardownSessions();
    this.mode = 'fallback';
    this.reason = reason;
  }

  private pauseClock(origin: 'user' | 'environment'): void {
    if (this.mode !== 'live') {
      return;
    }

    this.rendererSession?.pause?.();
    this.wasmSession?.pause?.();
    this.clockPaused = true;
    if (origin === 'user') {
      this.userPaused = true;
    }
  }

  private resumeClock(): void {
    if (this.mode !== 'live' || this.userPaused || this.documentHidden || !this.inViewport) {
      return;
    }

    this.rendererSession?.resume?.();
    this.wasmSession?.resume?.();
    this.clockPaused = false;
  }

  private teardownSessions(): void {
    this.rendererSession?.dispose();
    this.wasmSession?.dispose();
    this.rendererSession = null;
    this.wasmSession = null;
    this.initCompleted = false;
    this.initializing = false;
    this.clockPaused = false;
  }
}

export function createDemoRuntime(options: CreateDemoRuntimeOptions): DemoRuntime {
  return new DemoRuntime(options);
}

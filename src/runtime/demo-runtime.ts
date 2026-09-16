import { executionOriginData, executionOriginLabel, type ExecutionOrigin } from '../native-evidence/view';

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
  pause: () => void;
  resume: () => void;
  freeze?: () => void;
  setCameraMotionEnabled?: (enabled: boolean) => void;
}

export interface WasmSession {
  dispose: () => void;
  pause: () => void;
  resume: () => void;
}

export interface RendererCreateOptions {
  cameraMotionEnabled: boolean;
  signal: AbortSignal;
  onRendererError: () => void;
}

export interface RendererSeam {
  create: (options: RendererCreateOptions) => Promise<RendererSession>;
  disposePartial?: () => void;
}

export interface WasmInitOptions {
  useWorker: boolean;
  signal: AbortSignal;
  onWorkerFailure: (phase: WorkerFailurePhase) => void;
}

export interface WasmSeam {
  init: (options: WasmInitOptions) => Promise<WasmSession>;
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
  origin?: {
    textContent: string | null;
    dataset: {
      origin?: string;
    };
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

interface PauseResume {
  dispose: () => void;
  pause?: unknown;
  resume?: unknown;
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

function canPauseAndResume(session: PauseResume): boolean {
  return typeof session.pause === 'function' && typeof session.resume === 'function';
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
  if (snapshot.mode === 'initializing') {
    return 'Starting the live visualization.';
  }

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

export function demoExecutionOrigin(
  snapshot: Pick<DemoSnapshot, 'mode' | 'reason'>,
): Exclude<ExecutionOrigin, 'recorded-cuda-fpga'> {
  switch (snapshot.mode) {
    case 'live':
      return 'live-wasm';
    case 'static':
    case 'awaiting-play':
    case 'initializing':
    case 'frozen':
    case 'fallback':
      break;
    default:
      return assertNever(snapshot.mode);
  }

  switch (snapshot.reason) {
    case 'adapter-unavailable':
    case 'no-wasm':
    case 'wasm-init-failed':
    case 'worker-unavailable':
    case 'worker-init-failed':
    case 'unavailable':
      return 'unavailable-wasm';
    case 'worker-runtime-failed':
      return snapshot.mode === 'frozen' ? 'static-diagram' : 'unavailable-wasm';
    case 'ok':
    case 'reduced-motion':
    case 'no-webgl':
    case 'webgl-context-lost':
    case 'renderer-error':
      return 'static-diagram';
    default:
      return assertNever(snapshot.reason);
  }
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
  if (elements.origin) {
    const origin = demoExecutionOrigin(snapshot);
    elements.origin.textContent = executionOriginLabel(origin);
    elements.origin.dataset.origin = executionOriginData(origin);
  }
}

function seamsAreConnected(seams: DemoSeams): boolean {
  return Boolean(seams.renderer && seams.wasm);
}

export class DemoRuntime {
  private readonly capabilities: Capabilities;
  private readonly seams: DemoSeams;
  private prefersReducedMotion: boolean;
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
  private pendingRendererSession: RendererSession | null = null;
  private pendingWasmSession: WasmSession | null = null;
  private initPromise: Promise<void> | null = null;
  private wasmRetryPromise: Promise<SessionAttempt<WasmSession>> | null = null;
  private partialGraphicsDisposed = false;
  private initAbort: AbortController | null = null;
  private rendererCameraMotionEnabled = false;
  private readonly snapshotListeners = new Set<() => void>();

  constructor(options: CreateDemoRuntimeOptions) {
    this.capabilities = options.capabilities;
    this.seams = options.seams ?? {};
    this.prefersReducedMotion = options.capabilities.prefersReducedMotion;
    this.inViewport = options.inViewport ?? false;
    this.documentHidden = options.documentHidden ?? false;
    this.syncFromCapabilities();
  }

  getSnapshot(): DemoSnapshot {
    const canLive = this.canAttemptLive();
    const playVisible = canLive && this.mode !== 'frozen' && this.mode !== 'fallback';
    const playEnabled =
      playVisible && !this.initializing && (this.mode === 'awaiting-play' || this.mode === 'live' || this.mode === 'static');
    const cameraMotionEnabled = this.mode === 'live' && !this.prefersReducedMotion && !this.clockPaused;
    const snapshot: DemoSnapshot = {
      mode: this.initializing ? 'initializing' : this.mode,
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

    if (this.prefersReducedMotion) {
      if (!this.initCompleted && !this.initializing) {
        this.mode = 'awaiting-play';
        this.reason = 'reduced-motion';
      }
      return;
    }

    if (this.initCompleted) {
      this.promoteToLive();
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
      this.reason = this.prefersReducedMotion ? 'reduced-motion' : 'ok';
      return;
    }

    this.userPaused = false;
    if (!this.initCompleted) {
      await this.initialize();
    }

    if (this.disposed || !this.initCompleted) {
      return;
    }

    if (!(await this.ensureRendererCameraMotion(this.cameraMotionPolicy()))) {
      return;
    }

    if (this.disposed || !this.initCompleted || this.initializationClosed()) {
      return;
    }

    if (this.rendererCameraMotionEnabled !== this.cameraMotionPolicy()) {
      if (!(await this.ensureRendererCameraMotion(this.cameraMotionPolicy()))) {
        return;
      }
    }

    if (this.disposed || !this.initCompleted || this.initializationClosed()) {
      return;
    }

    this.promoteToLive();
  }

  setInViewport(inViewport: boolean): Promise<void> {
    this.inViewport = inViewport;
    if (!inViewport) {
      this.pauseClock('environment');
      return Promise.resolve();
    }

    return this.startIfAllowed();
  }

  setDocumentHidden(documentHidden: boolean): Promise<void> {
    this.documentHidden = documentHidden;
    if (documentHidden) {
      this.pauseClock('environment');
      return Promise.resolve();
    }

    return this.startIfAllowed();
  }

  setPrefersReducedMotion(prefersReducedMotion: boolean): void {
    if (this.disposed || this.mode === 'frozen' || this.mode === 'fallback') {
      return;
    }

    this.prefersReducedMotion = prefersReducedMotion;
    if (prefersReducedMotion && (this.mode === 'live' || this.mode === 'initializing')) {
      this.applyCameraMotionEnabled(false);
      if (this.mode === 'live') {
        this.pauseClock('user');
        this.mode = 'awaiting-play';
        this.reason = 'reduced-motion';
      }
      return;
    }

    if (this.mode === 'awaiting-play') {
      this.reason = prefersReducedMotion ? 'reduced-motion' : 'ok';
    }

    if (this.mode === 'live') {
      this.reason = 'ok';
      this.applyCameraMotionEnabled(true);
    }
  }

  reportContextLost(): void {
    this.failGraphics('webgl-context-lost');
  }

  reportRendererError(): void {
    this.failGraphics('renderer-error');
  }

  async reportWorkerFailure(phase: WorkerFailurePhase): Promise<void> {
    if (this.disposed || this.mode === 'frozen' || this.mode === 'fallback') {
      return;
    }

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

  onSnapshotChange(listener: () => void): () => void {
    this.snapshotListeners.add(listener);
    return () => {
      this.snapshotListeners.delete(listener);
    };
  }

  dispose(): void {
    this.disposed = true;
    this.generation += 1;
    this.abortInitialization();
    if (this.initializing) {
      this.disposePartialGraphics();
    }
    this.snapshotListeners.clear();
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

    if (this.prefersReducedMotion) {
      this.mode = 'awaiting-play';
      this.reason = 'reduced-motion';
      return;
    }

    this.mode = 'static';
    this.reason = 'ok';
  }

  private cameraMotionPolicy(): boolean {
    return !this.prefersReducedMotion;
  }

  private applyCameraMotionEnabled(enabled: boolean): void {
    const session = this.rendererSession ?? this.pendingRendererSession;
    if (session?.setCameraMotionEnabled) {
      session.setCameraMotionEnabled(enabled);
      this.rendererCameraMotionEnabled = enabled;
    }
  }

  private async ensureRendererCameraMotion(enabled: boolean): Promise<boolean> {
    if (this.initializationClosed()) {
      return false;
    }

    this.applyCameraMotionEnabled(enabled);
    if (this.rendererCameraMotionEnabled === enabled) {
      return true;
    }

    return this.recreateRenderer(enabled);
  }

  private beginRendererAllocation(): void {
    this.initializing = true;
    this.mode = 'initializing';
    this.partialGraphicsDisposed = false;
    if (this.initAbort === null || this.initAbort.signal.aborted) {
      this.initAbort = new AbortController();
    }
  }

  private async recreateRenderer(enabled: boolean): Promise<boolean> {
    if (this.seams.renderer === undefined || this.seams.renderer === null || this.initializationClosed()) {
      return false;
    }

    this.rendererSession?.dispose();
    this.rendererSession = null;
    this.pendingRendererSession?.dispose();
    this.pendingRendererSession = null;
    this.beginRendererAllocation();
    const generation = this.generation;
    const requested = enabled;

    try {
      const session = await this.seams.renderer.create({
        cameraMotionEnabled: requested,
        signal: this.initSignal(),
        onRendererError: () => this.handleRendererError(),
      });
      if (
        this.generation !== generation ||
        this.initializationClosed() ||
        this.initializationCanceled()
      ) {
        session.dispose();
        this.disposePartialGraphics();
        this.initializing = false;
        return false;
      }

      if (!canPauseAndResume(session)) {
        session.dispose();
        this.disposePartialGraphics();
        this.failClosed('renderer-error');
        return false;
      }

      const currentPolicy = this.cameraMotionPolicy();
      if (currentPolicy !== requested) {
        session.dispose();
        this.disposePartialGraphics();
        this.initializing = false;
        return this.recreateRenderer(currentPolicy);
      }

      this.rendererSession = session;
      this.pendingRendererSession = null;
      this.rendererCameraMotionEnabled = requested;
      session.setCameraMotionEnabled?.(requested);
      this.initializing = false;
      return true;
    } catch (error) {
      if (this.generation !== generation || this.initializationCanceled() || this.initializationClosed()) {
        this.disposePartialGraphics();
        this.initializing = false;
        return false;
      }

      this.failClosed(reasonFromError(error, 'renderer-error'));
      return false;
    }
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
    this.partialGraphicsDisposed = false;
    this.initAbort = new AbortController();
    const generation = ++this.generation;
    const rendererSeam = this.seams.renderer;
    const wasmSeam = this.seams.wasm;

    await new Promise<void>((resolve) => {
      let rendererAttempt: SessionAttempt<RendererSession> | null = null;
      let wasmAttempt: SessionAttempt<WasmSession> | null = null;
      let finished = false;

      const finish = () => {
        if (finished) {
          return;
        }
        finished = true;
        resolve();
      };

      const dropRenderer = (session: RendererSession | null) => {
        this.releaseOwnedRenderer(session);
        this.disposePartialGraphics();
      };

      const dropWasm = (session: WasmSession | null) => {
        this.releaseOwnedWasm(session);
      };

      const failNow = (reason: ReasonCode) => {
        if (finished || this.initializationClosed()) {
          finish();
          return;
        }

        this.failClosed(reason);
        finish();
      };

      this.initAbort?.signal.addEventListener(
        'abort',
        () => {
          finish();
        },
        { once: true },
      );

      void this.tryRenderer(rendererSeam).then((attempt) => {
        if (finished || !this.isCurrentGeneration(generation)) {
          dropRenderer(attempt.session);
          finish();
          return;
        }

        this.pendingRendererSession = attempt.session;
        rendererAttempt = attempt;
        if (attempt.error) {
          failNow(attempt.error);
          return;
        }

        if (!attempt.session) {
          if (this.initializationCanceled() || this.initializationClosed()) {
            finish();
          }
          return;
        }

        if (rendererAttempt !== null && wasmAttempt?.session && !wasmAttempt.error) {
          void this.commitInitialization(generation, rendererAttempt, wasmAttempt).finally(finish);
        }
      });

      void this.tryWasm(wasmSeam).then((attempt) => {
        if (finished || !this.isCurrentGeneration(generation)) {
          dropWasm(attempt.session);
          finish();
          return;
        }

        this.pendingWasmSession = attempt.session;
        wasmAttempt = attempt;
        if (attempt.error) {
          failNow(attempt.error);
          return;
        }

        if (!attempt.session) {
          if (this.initializationCanceled() || this.initializationClosed()) {
            finish();
          }
          return;
        }

        if (wasmAttempt !== null && rendererAttempt?.session && !rendererAttempt.error) {
          void this.commitInitialization(generation, rendererAttempt, wasmAttempt).finally(finish);
        }
      });
    });
  }

  private isCurrentGeneration(generation: number): boolean {
    return !this.disposed && generation === this.generation;
  }

  private initializationClosed(): boolean {
    return this.disposed || this.mode === 'frozen' || this.mode === 'fallback';
  }

  private releaseOwnedRenderer(session: RendererSession | null): void {
    if (session === null) {
      return;
    }

    if (this.pendingRendererSession === session) {
      this.pendingRendererSession.dispose();
      this.pendingRendererSession = null;
      return;
    }

    if (this.rendererSession === session) {
      this.rendererSession.dispose();
      this.rendererSession = null;
    }
  }

  private releaseOwnedWasm(session: WasmSession | null): void {
    if (session === null) {
      return;
    }

    if (this.pendingWasmSession === session) {
      this.pendingWasmSession.dispose();
      this.pendingWasmSession = null;
      return;
    }

    if (this.wasmSession === session) {
      this.wasmSession.dispose();
      this.wasmSession = null;
    }
  }

  private failClosed(reason: ReasonCode): void {
    if (this.initializationClosed()) {
      return;
    }

    this.generation += 1;
    this.abortInitialization();
    this.disposePartialGraphics();
    this.teardownSessions();
    this.mode = 'fallback';
    this.reason = reason;
  }

  private async commitInitialization(
    generation: number,
    rendererAttempt: SessionAttempt<RendererSession>,
    wasmAttempt: SessionAttempt<WasmSession>,
  ): Promise<void> {
    if (this.discardIfStale(generation)) {
      return;
    }

    if (this.initializationClosed()) {
      this.releaseOwnedRenderer(rendererAttempt.session);
      this.releaseOwnedWasm(wasmAttempt.session);
      this.pendingRendererSession = null;
      this.pendingWasmSession = null;
      this.initializing = false;
      return;
    }

    if (
      rendererAttempt.error ||
      wasmAttempt.error ||
      rendererAttempt.session === null ||
      wasmAttempt.session === null
    ) {
      this.failClosed(combineFailureReasons(rendererAttempt.error, wasmAttempt.error));
      return;
    }

    this.rendererSession = rendererAttempt.session;
    this.wasmSession = wasmAttempt.session;
    this.pendingRendererSession = null;
    this.pendingWasmSession = null;
    this.initCompleted = true;
    this.initializing = false;

    if (!(await this.ensureRendererCameraMotion(this.cameraMotionPolicy()))) {
      return;
    }

    if (this.initializationClosed() || this.rendererSession === null || this.wasmSession === null) {
      return;
    }

    if (this.rendererCameraMotionEnabled !== this.cameraMotionPolicy()) {
      if (!(await this.ensureRendererCameraMotion(this.cameraMotionPolicy()))) {
        return;
      }
      if (this.initializationClosed() || this.rendererSession === null || this.wasmSession === null) {
        return;
      }
    }

    if (this.prefersReducedMotion) {
      this.rendererSession.pause();
      this.wasmSession.pause();
      this.clockPaused = true;
      this.mode = 'awaiting-play';
      this.reason = 'reduced-motion';
      return;
    }

    this.promoteToLive();
  }

  private discardIfStale(generation: number): boolean {
    if (this.isCurrentGeneration(generation)) {
      return false;
    }

    this.pendingRendererSession?.dispose();
    this.pendingRendererSession = null;
    this.pendingWasmSession?.dispose();
    this.pendingWasmSession = null;
    this.disposePartialGraphics();
    this.initializing = false;
    return true;
  }

  private disposePartialGraphics(): void {
    if (this.partialGraphicsDisposed) {
      return;
    }

    this.partialGraphicsDisposed = true;
    this.seams.renderer?.disposePartial?.();
  }

  private abortInitialization(): void {
    this.initAbort?.abort();
  }

  private initSignal(): AbortSignal {
    this.initAbort ??= new AbortController();
    return this.initAbort.signal;
  }

  private initializationCanceled(): boolean {
    return this.disposed || Boolean(this.initAbort?.signal.aborted);
  }

  private promoteToLive(): void {
    if (this.disposed || !this.initCompleted || this.rendererSession === null || this.wasmSession === null) {
      return;
    }

    if (this.documentHidden || !this.inViewport) {
      if (!this.clockPaused) {
        this.rendererSession.pause();
        this.wasmSession.pause();
        this.clockPaused = true;
      }
      this.mode = 'awaiting-play';
      this.reason = this.prefersReducedMotion ? 'reduced-motion' : 'ok';
      return;
    }

    const shouldResume = this.clockPaused;
    this.mode = 'live';
    this.reason = this.prefersReducedMotion ? 'reduced-motion' : 'ok';
    this.applyCameraMotionEnabled(!this.prefersReducedMotion);
    if (shouldResume) {
      this.rendererSession.resume();
      this.wasmSession.resume();
    }
    this.clockPaused = false;
    this.userPaused = false;
  }

  private async tryRenderer(seam: RendererSeam): Promise<SessionAttempt<RendererSession>> {
    const cameraMotionEnabled = this.cameraMotionPolicy();
    try {
      const session = await seam.create({
        cameraMotionEnabled,
        signal: this.initSignal(),
        onRendererError: () => this.handleRendererError(),
      });
      if (this.initializationCanceled()) {
        session.dispose();
        this.disposePartialGraphics();
        return { session: null, error: null };
      }

      if (!canPauseAndResume(session)) {
        session.dispose();
        this.disposePartialGraphics();
        return { session: null, error: 'renderer-error' };
      }

      this.pendingRendererSession = session;
      this.rendererCameraMotionEnabled = cameraMotionEnabled;
      return { session, error: null };
    } catch (error) {
      if (this.initializationCanceled()) {
        return { session: null, error: null };
      }

      this.disposePartialGraphics();
      return { session: null, error: reasonFromError(error, 'renderer-error') };
    }
  }

  private async tryWasm(seam: WasmSeam): Promise<SessionAttempt<WasmSession>> {
    if (this.wasmRetryPromise !== null) {
      return this.wasmRetryPromise;
    }

    if (this.capabilities.worker) {
      try {
        const session = await seam.init(this.wasmInitOptions(true));
        if (this.wasmRetryPromise !== null) {
          session.dispose();
          return this.wasmRetryPromise;
        }

        return this.adoptWasmSession(session);
      } catch (error) {
        if (this.initializationCanceled()) {
          return { session: null, error: null };
        }

        if (this.wasmRetryPromise !== null || (!this.initCompleted && !this.workerRetryUsed)) {
          return this.beginMainThreadRetry(seam, error);
        }

        return { session: null, error: reasonFromError(error, 'worker-init-failed') };
      }
    }

    return this.beginMainThreadRetry(seam, { code: 'worker-unavailable' });
  }

  private wasmInitOptions(useWorker: boolean): WasmInitOptions {
    return {
      useWorker,
      signal: this.initSignal(),
      onWorkerFailure: (phase) => this.handleWorkerFailure(phase),
    };
  }

  private acceptWasmSession(session: WasmSession): SessionAttempt<WasmSession> {
    if (canPauseAndResume(session)) {
      return { session, error: null };
    }

    session.dispose();
    return { session: null, error: 'wasm-init-failed' };
  }

  private adoptWasmSession(session: WasmSession): SessionAttempt<WasmSession> {
    if (this.initializationClosed() || this.initializationCanceled()) {
      session.dispose();
      return { session: null, error: null };
    }

    const accepted = this.acceptWasmSession(session);
    if (accepted.session) {
      this.pendingWasmSession = accepted.session;
    }
    return accepted;
  }

  private handleWorkerFailure(phase: WorkerFailurePhase): void {
    if (this.disposed) {
      return;
    }

    switch (phase) {
      case 'after-init':
        this.freezeOrFallback();
        this.emitSnapshotChange();
        return;
      case 'before-init':
        void this.reportWorkerFailure(phase).then(() => {
          if (!this.disposed) {
            this.emitSnapshotChange();
          }
        });
        return;
      default:
        assertNever(phase);
    }
  }

  private handleRendererError(): void {
    if (this.disposed) {
      return;
    }

    this.reportRendererError();
    this.emitSnapshotChange();
  }

  private emitSnapshotChange(): void {
    for (const listener of this.snapshotListeners) {
      listener();
    }
  }

  private beginMainThreadRetry(seam: WasmSeam, error: unknown): Promise<SessionAttempt<WasmSession>> {
    this.wasmRetryPromise ??= this.retryWasm(seam, error);
    return this.wasmRetryPromise;
  }

  private async retryWasm(seam: WasmSeam, error: unknown): Promise<SessionAttempt<WasmSession>> {
    this.workerRetryUsed = true;
    try {
      const session = await seam.init(this.wasmInitOptions(false));
      return this.adoptWasmSession(session);
    } catch (retryError) {
      if (this.initializationCanceled()) {
        return { session: null, error: null };
      }

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
    if (this.disposed || this.mode === 'frozen' || this.mode === 'fallback') {
      return;
    }

    this.generation += 1;
    this.abortInitialization();

    if (this.rendererSession?.freeze) {
      this.rendererSession.freeze();
      this.wasmSession?.pause();
      this.clockPaused = true;
      this.initializing = false;
      this.mode = 'frozen';
      this.reason = 'worker-runtime-failed';
      return;
    }

    this.disposePartialGraphics();
    this.teardownSessions();
    this.mode = 'fallback';
    this.reason = 'worker-runtime-failed';
  }

  private failGraphics(reason: ReasonCode): void {
    this.failClosed(reason);
  }

  private pauseClock(origin: 'user' | 'environment'): void {
    if (this.mode !== 'live' || this.clockPaused) {
      return;
    }

    if (this.rendererSession === null || this.wasmSession === null) {
      this.failGraphics('renderer-error');
      return;
    }

    this.rendererSession.pause();
    this.wasmSession.pause();
    this.clockPaused = true;
    if (origin === 'user') {
      this.userPaused = true;
    }
  }

  private teardownSessions(): void {
    this.pendingRendererSession?.dispose();
    this.pendingRendererSession = null;
    this.pendingWasmSession?.dispose();
    this.pendingWasmSession = null;
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

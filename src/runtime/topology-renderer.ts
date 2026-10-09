import type {
  RendererCreateOptions,
  RendererSeam,
  RendererSession,
  ReasonCode,
} from './demo-runtime';
import type { NeuromorphicState } from './neuromorphic-adapter';
import type { SimulationChannel } from './simulation-channel';
import {
  QUALITY_LADDER,
  cappedPixelRatio,
  watchDevicePixelRatio,
  type AdaptiveQualityController,
  type AdaptiveQualityReader,
  type QualitySettings,
} from './adaptive-quality';
import type { PerfProbe } from './perf-probe';
import {
  LIVE_SPIKE_EVENT_PROVENANCE,
  SPIKE_EVENT_STEP_MS,
  createSpikeEventBuffer,
  feedSpikeEvents,
  propagationSpanInto,
  type PropagationSpan,
  type SpikeEventBuffer,
  type SpikePropagationEvent,
} from './spike-events';

/** Drawn pulse width at its head, in CSS pixels. */
const PULSE_WIDTH_PX = 3;

/** Draw order, back to front: edges, then pulses, then the neuron markers. */
export const EDGE_RENDER_ORDER = 0;
export const PULSE_RENDER_ORDER = 1;
export const NODE_RENDER_ORDER = 2;

/** Animation-frame jitter tolerated by the quality level's frame-interval cap. */
const FRAME_CAP_TOLERANCE_MS = 2;

class RendererSeamError extends Error {
  code: ReasonCode;

  constructor(code: ReasonCode, message: string) {
    super(message);
    this.name = 'TopologyRendererError';
    this.code = code;
  }
}

interface NodeLayout {
  x: number;
  y: number;
}

/**
 * Deterministic topology layout: nodes on a ring with a small index-keyed
 * radial jitter. Pure function of the topology projection — never of timing or
 * device state.
 */
export function layoutTopology(nodeCount: number): NodeLayout[] {
  const positions: NodeLayout[] = [];
  for (let node = 0; node < nodeCount; node += 1) {
    const angle = (2 * Math.PI * node) / nodeCount - Math.PI / 2;
    const jitter = ((node * 2654435761) % 97) / 97;
    const radius = 0.92 + jitter * 0.14;
    positions.push({ x: Math.cos(angle) * radius, y: Math.sin(angle) * radius });
  }
  return positions;
}

interface CssPalette {
  signal: string;
  muted: string;
  ink: string;
}

function readPalette(): CssPalette {
  const style = globalThis.getComputedStyle?.(document.documentElement);
  return {
    signal: style?.getPropertyValue('--signal').trim() || '#2f5bd0',
    muted: style?.getPropertyValue('--muted').trim() || '#8a8578',
    ink: style?.getPropertyValue('--ink').trim() || '#1c1a14',
  };
}

export interface TopologyRendererSeamOptions {
  channel: SimulationChannel;
  island?: HTMLElement;
  /**
   * Live spike-event buffer shared with telemetry consumers. The renderer
   * feeds it from `channel` while running, clears it on pause, and clears it
   * again on dispose. Defaults to a private `live-wasm` buffer.
   */
  spikeEvents?: SpikeEventBuffer;
  /**
   * Adaptive presentation quality (`adaptive-quality.ts`). The renderer feeds
   * it frame timings and applies its pixel-ratio cap, pulse cap, and frame
   * interval. Without one, the renderer stays at full quality.
   */
  quality?: AdaptiveQualityController;
  /** Opt-in timing probe (`perf-probe.ts`); `null` in normal visits. */
  probe?: PerfProbe | null;
}

/** Per-frame facts for development inspection and performance budgets. */
export interface TopologyRendererInspection {
  /** Propagation pulses drawn in the most recent frame. */
  drawnPulses: number;
  /** Events buffered when that frame was drawn. */
  bufferedEvents: number;
  /** Whether nonessential motion (camera drift, pulses) is enabled. */
  motionEnabled: boolean;
  /** Active presentation quality level name. */
  quality: QualitySettings['name'];
  /** Pixel ratio applied to the drawing buffer. */
  pixelRatio: number;
}

export interface TopologyRendererSeam extends RendererSeam {
  /** The current session's last frame, or `null` without a live session. */
  inspect: () => TopologyRendererInspection | null;
  /** Read side of the adaptive quality controller, when one is attached. */
  quality: AdaptiveQualityReader | null;
}

/**
 * Three.js renderer seam for the WASM topology projection. Loads `three` only
 * when the runtime actually attempts the live path, so static readers never
 * pay the bundle cost.
 *
 * Spike propagation: each `neuromod` spike is mapped through the snapshot's
 * `synaptic-wiring` edges by `spike-events.ts` (on publish, not per frame);
 * frames only read the buffer and draw each in-flight event as a short pulse
 * travelling source → target over its delay. With reduced motion, pulses and
 * camera drift stay off and only the static topology and node state render.
 */
export function createTopologyRendererSeam(options: TopologyRendererSeamOptions): TopologyRendererSeam {
  let partial: (() => void) | null = null;
  let inspectSession: (() => TopologyRendererInspection) | null = null;
  const spikeEvents =
    options.spikeEvents ?? createSpikeEventBuffer({ provenance: LIVE_SPIKE_EVENT_PROVENANCE });
  const quality = options.quality ?? null;
  const probe = options.probe ?? null;

  return {
    inspect() {
      return inspectSession?.() ?? null;
    },
    quality,
    disposePartial() {
      partial?.();
      partial = null;
    },
    async create(createOptions: RendererCreateOptions): Promise<RendererSession> {
      const surface = (options.island ?? document).querySelector<HTMLElement>(
        '[data-demo-surface]',
      );
      if (!surface) {
        throw new RendererSeamError('renderer-error', 'demo surface is missing');
      }

      if (createOptions.signal.aborted) {
        throw new RendererSeamError('renderer-error', 'renderer init aborted');
      }

      let THREE: typeof import('three');
      try {
        THREE = await import('three');
      } catch (error) {
        throw new RendererSeamError(
          'renderer-error',
          error instanceof Error ? error.message : 'could not load the renderer',
        );
      }
      if (createOptions.signal.aborted) {
        throw new RendererSeamError('renderer-error', 'renderer init aborted');
      }

      const palette = readPalette();
      const canvas = document.createElement('canvas');
      canvas.setAttribute('aria-hidden', 'true');

      let renderer: import('three').WebGLRenderer;
      try {
        renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
      } catch (error) {
        throw new RendererSeamError(
          'no-webgl',
          error instanceof Error ? error.message : 'WebGL context could not be created',
        );
      }

      const disposables: { dispose: () => void }[] = [renderer];
      partial = () => {
        for (const disposable of disposables) {
          disposable.dispose();
        }
        canvas.remove();
      };

      const scene = new THREE.Scene();
      const camera = new THREE.OrthographicCamera(-1.5, 1.5, 1.5, -1.5, 0.1, 10);
      camera.position.z = 4;
      const world = new THREE.Group();
      scene.add(world);

      const nodeMaterial = new THREE.PointsMaterial({
        size: 16,
        vertexColors: true,
        sizeAttenuation: false,
      });
      const edgeMaterial = new THREE.LineBasicMaterial({
        vertexColors: true,
        transparent: true,
        opacity: 0.55,
      });
      // Pulses: one tapered quad (two triangles) per in-flight event, with
      // RGBA vertex colors fading from an opaque head to a clear tail.
      const pulseMaterial = new THREE.MeshBasicMaterial({
        vertexColors: true,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      disposables.push(nodeMaterial, edgeMaterial, pulseMaterial);
      const pulseCapacity = spikeEvents.capacity;
      const pulsePositions = new Float32Array(pulseCapacity * 6 * 3);
      const pulseColors = new Float32Array(pulseCapacity * 6 * 4);
      const pulsePositionAttribute = new THREE.BufferAttribute(pulsePositions, 3);
      const pulseColorAttribute = new THREE.BufferAttribute(pulseColors, 4);
      pulsePositionAttribute.setUsage(THREE.DynamicDrawUsage);
      pulseColorAttribute.setUsage(THREE.DynamicDrawUsage);
      const pulseGeometry = new THREE.BufferGeometry();
      pulseGeometry.setAttribute('position', pulsePositionAttribute);
      pulseGeometry.setAttribute('color', pulseColorAttribute);
      pulseGeometry.setDrawRange(0, 0);
      disposables.push(pulseGeometry);
      const pulseMesh = new THREE.Mesh(pulseGeometry, pulseMaterial);
      pulseMesh.frustumCulled = false;
      // Layering, back to front: edges (z −0.01, order 0), pulses (z −0.005,
      // order 1), nodes (z 0, order 2). The opaque nodes write depth, and
      // pulses are depth-tested against them, so pulses pass under the
      // neuron markers. The explicit orders keep that true if nodes ever
      // become transparent.
      pulseMesh.renderOrder = PULSE_RENDER_ORDER;
      world.add(pulseMesh);

      let nodeGeometry: import('three').BufferGeometry | null = null;
      let edgeGeometry: import('three').BufferGeometry | null = null;
      // Topology geometry is replaced on a digest change; only the current
      // pair is ever retained, so rebuilds cannot accumulate disposables.
      disposables.push({
        dispose() {
          nodeGeometry?.dispose();
          edgeGeometry?.dispose();
        },
      });
      let pointsObject: import('three').Points | null = null;
      let edgeObject: import('three').LineSegments | null = null;
      let builtDigest: string | null = null;
      let nodeCount = 0;
      let nodePositions: NodeLayout[] = [];

      const signalColor = new THREE.Color(palette.signal);
      const mutedColor = new THREE.Color(palette.muted);
      const inkColor = new THREE.Color(palette.ink);
      const inhibitoryColor = mutedColor.clone().lerp(inkColor, 0.25);
      const excitatoryColor = signalColor.clone();
      // Pulses use the full-strength tokens so they read over the softer edges:
      // `--signal` for excitatory synapses, `--ink` for inhibitory ones.
      const excitatoryPulseColor = signalColor.clone();
      const inhibitoryPulseColor = inkColor.clone();
      // Reused for per-frame node colors instead of cloning each frame.
      const nodeScratchColor = mutedColor.clone();
      const spikeFlash = new Map<number, number>();
      let latest: NeuromorphicState | null = options.channel.latest();
      let latestAt = 0;
      const unsubscribe = options.channel.subscribe((state) => {
        latest = state;
        latestAt = performance.now();
        for (const neuron of state.spikeNeurons) {
          spikeFlash.set(neuron, 1);
        }
      });
      // Ingestion runs on publish, independent of frames; frames only read.
      const feed = feedSpikeEvents(options.channel, spikeEvents, () => createOptions.onRendererError());
      // Partial-init cleanup releases the channel and the buffer as well.
      disposables.push({
        dispose() {
          unsubscribe();
          feed.detach();
        },
      });

      function rebuildTopology(state: NeuromorphicState): void {
        builtDigest = state.topologyDigest;
        nodeCount = state.topologyNodeIds.length;
        nodePositions = layoutTopology(nodeCount);
        // Flash state is keyed by neuron id; drop ids of the previous topology.
        spikeFlash.clear();

        if (pointsObject) {
          world.remove(pointsObject);
          pointsObject = null;
        }
        if (edgeObject) {
          world.remove(edgeObject);
          edgeObject = null;
        }
        nodeGeometry?.dispose();
        edgeGeometry?.dispose();

        nodeGeometry = new THREE.BufferGeometry();
        const pointPositions = new Float32Array(nodeCount * 3);
        const pointColors = new Float32Array(nodeCount * 3);
        for (let node = 0; node < nodeCount; node += 1) {
          pointPositions[node * 3] = nodePositions[node].x;
          pointPositions[node * 3 + 1] = nodePositions[node].y;
          pointPositions[node * 3 + 2] = 0;
          mutedColor.toArray(pointColors, node * 3);
        }
        nodeGeometry.setAttribute('position', new THREE.BufferAttribute(pointPositions, 3));
        nodeGeometry.setAttribute('color', new THREE.BufferAttribute(pointColors, 3));
        pointsObject = new THREE.Points(nodeGeometry, nodeMaterial);
        pointsObject.renderOrder = NODE_RENDER_ORDER;
        world.add(pointsObject);

        edgeGeometry = new THREE.BufferGeometry();
        const edgeCount = state.topologyEdgeSources.length;
        const linePositions = new Float32Array(edgeCount * 6);
        const lineColors = new Float32Array(edgeCount * 6);
        const weightExtent = state.topologyEdgeWeights.reduce(
          (extent, weight) => Math.max(extent, Math.abs(weight)),
          0,
        ) || 1;
        for (let edge = 0; edge < edgeCount; edge += 1) {
          const source = nodePositions[state.topologyEdgeSources[edge]];
          const target = nodePositions[state.topologyEdgeTargets[edge]];
          linePositions.set([source.x, source.y, -0.01, target.x, target.y, -0.01], edge * 6);
          const base = state.topologyPolarities[edge] === 0 ? excitatoryColor : inhibitoryColor;
          const strength = Math.min(1, 0.35 + 0.65 * (Math.abs(state.topologyEdgeWeights[edge]) / weightExtent));
          const color = base.clone().lerp(mutedColor, 1 - strength);
          color.toArray(lineColors, edge * 6);
          color.toArray(lineColors, edge * 6 + 3);
        }
        edgeGeometry.setAttribute('position', new THREE.BufferAttribute(linePositions, 3));
        edgeGeometry.setAttribute('color', new THREE.BufferAttribute(lineColors, 3));
        edgeObject = new THREE.LineSegments(edgeGeometry, edgeMaterial);
        edgeObject.renderOrder = EDGE_RENDER_ORDER;
        world.add(edgeObject);
      }

      let disposed = false;
      let paused = true;
      let frozen = false;
      // Governs all nonessential motion: camera drift and propagation pulses.
      // The runtime turns it off whenever reduced motion is requested.
      let motionEnabled = createOptions.cameraMotionEnabled;
      let frame = 0;
      let lastFrameTime = 0;
      let worldPerPixel = 0.01;
      let drawnPulses = 0;
      let settings: QualitySettings = quality?.current() ?? QUALITY_LADDER[0];
      let pixelRatio = 1;
      let lastCallbackAt = 0;
      let lastDrawnAt = Number.NEGATIVE_INFINITY;

      // Allocation-free per frame: vertices go straight into the
      // preallocated attribute arrays.
      const writeVertex = (
        vertex: number,
        x: number,
        y: number,
        alpha: number,
        color: import('three').Color,
      ) => {
        const p = vertex * 3;
        pulsePositions[p] = x;
        pulsePositions[p + 1] = y;
        pulsePositions[p + 2] = -0.005;
        const c = vertex * 4;
        pulseColors[c] = color.r;
        pulseColors[c + 1] = color.g;
        pulseColors[c + 2] = color.b;
        pulseColors[c + 3] = alpha;
      };

      const writePulse = (
        slot: number,
        source: NodeLayout,
        target: NodeLayout,
        head: number,
        tail: number,
        color: import('three').Color,
      ) => {
        const dx = target.x - source.x;
        const dy = target.y - source.y;
        const length = Math.hypot(dx, dy) || 1;
        const halfWidth = (PULSE_WIDTH_PX / 2) * worldPerPixel;
        // Normal to the edge; the clear tail tapers to a third of the head.
        const nx = (-dy / length) * halfWidth;
        const ny = (dx / length) * halfWidth;
        const tx = source.x + dx * tail;
        const ty = source.y + dy * tail;
        const hx = source.x + dx * head;
        const hy = source.y + dy * head;
        const base = slot * 6;
        writeVertex(base, tx + nx / 3, ty + ny / 3, 0, color);
        writeVertex(base + 1, tx - nx / 3, ty - ny / 3, 0, color);
        writeVertex(base + 2, hx + nx, hy + ny, 1, color);
        writeVertex(base + 3, hx + nx, hy + ny, 1, color);
        writeVertex(base + 4, tx - nx / 3, ty - ny / 3, 0, color);
        writeVertex(base + 5, hx - nx, hy - ny, 1, color);
      };

      // Per-frame pulse state lives here and the visitor is created once, so
      // drawing a frame allocates nothing: no span objects, no closures.
      const pulseSpan: PropagationSpan = { head: 0, tail: 0 };
      let frameStep = 0;
      let drawn = 0;
      // The quality level's pulse cap for this frame (drawing only).
      let pulseLimit = pulseCapacity;
      const visitPulse = (event: SpikePropagationEvent) => {
        if (drawn >= pulseLimit || event.topologyDigest !== builtDigest) {
          return;
        }
        const source = nodePositions[event.sourceNeuron];
        const target = nodePositions[event.targetNeuron];
        if (
          !source ||
          !target ||
          !propagationSpanInto(pulseSpan, event.delaySteps, frameStep - Number(event.emittedStep))
        ) {
          return;
        }
        writePulse(
          drawn,
          source,
          target,
          pulseSpan.head,
          pulseSpan.tail,
          event.polarity === 0 ? excitatoryPulseColor : inhibitoryPulseColor,
        );
        drawn += 1;
      };

      const drawPulses = (time: number) => {
        drawn = 0;
        const latestStep = spikeEvents.latestStep();
        // Quality caps drawing only; every event stays buffered.
        pulseLimit = Math.min(pulseCapacity, settings.maxPulses);
        if (motionEnabled && pulseLimit > 0 && latestStep !== null && nodeCount > 0) {
          // Sub-step progress since the latest snapshot, capped at one step
          // so a stalled simulation cannot run pulses ahead of it.
          const fraction = Math.min(1, Math.max(0, (time - latestAt) / SPIKE_EVENT_STEP_MS));
          // Steps stay exact as numbers for 2^53 ticks; avoids bigint math per event.
          frameStep = Number(latestStep) + fraction;
          spikeEvents.forEach(visitPulse);
        }
        pulseGeometry.setDrawRange(0, drawn * 6);
        if (drawn > 0) {
          pulsePositionAttribute.clearUpdateRanges();
          pulsePositionAttribute.addUpdateRange(0, drawn * 6 * 3);
          pulsePositionAttribute.needsUpdate = true;
          pulseColorAttribute.clearUpdateRanges();
          pulseColorAttribute.addUpdateRange(0, drawn * 6 * 4);
          pulseColorAttribute.needsUpdate = true;
        }
        drawnPulses = drawn;
      };

      const resize = () => {
        const width = surface.clientWidth || 1;
        const height = surface.clientHeight || 1;
        pixelRatio = cappedPixelRatio(globalThis.devicePixelRatio, settings);
        renderer.setPixelRatio(pixelRatio);
        renderer.setSize(width, height, false);
        const aspect = width / height;
        const extent = 1.35;
        if (aspect >= 1) {
          camera.left = -extent * aspect;
          camera.right = extent * aspect;
          camera.top = extent;
          camera.bottom = -extent;
        } else {
          camera.left = -extent;
          camera.right = extent;
          camera.top = extent / aspect;
          camera.bottom = -extent / aspect;
        }
        camera.updateProjectionMatrix();
        worldPerPixel = (camera.top - camera.bottom) / height;
      };

      const renderFrame = (time: number) => {
        const delta = Math.min(0.1, (time - lastFrameTime) / 1000 || 0);
        lastFrameTime = time;

        if (latest && latest.topologyDigest !== builtDigest) {
          rebuildTopology(latest);
        }

        if (latest && nodeGeometry && nodeCount > 0) {
          const colors = nodeGeometry.getAttribute('color') as import('three').BufferAttribute;
          for (let node = 0; node < nodeCount; node += 1) {
            const potential = latest.membranePotentials[node] ?? 0;
            const activation = Math.min(1, Math.max(0, Math.abs(potential)));
            const flash = spikeFlash.get(node) ?? 0;
            nodeScratchColor
              .copy(mutedColor)
              .lerp(signalColor, Math.min(1, activation * 0.9 + flash))
              .toArray(colors.array as Float32Array, node * 3);
            if (flash > 0) {
              spikeFlash.set(node, Math.max(0, flash - delta * 3));
            }
          }
          colors.needsUpdate = true;
        }

        drawPulses(time);
        if (motionEnabled) {
          world.rotation.z += delta * 0.08;
        }
        renderer.render(scene, camera);
      };

      const loop = (time: number) => {
        if (disposed || paused || frozen) {
          return;
        }
        const interval = lastCallbackAt > 0 ? time - lastCallbackAt : 0;
        lastCallbackAt = time;
        let work = 0;
        // The frame-interval cap skips drawing, never simulation work.
        if (time - lastDrawnAt >= settings.minFrameIntervalMs - FRAME_CAP_TOLERANCE_MS) {
          const drawStart = performance.now();
          renderFrame(time);
          work = performance.now() - drawStart;
          lastDrawnAt = time;
          if (probe) {
            probe.record('frame-work', work);
            probe.increment('frames-drawn');
            probe.increment('pulses-drawn', drawnPulses);
            probe.mark('first-frame');
          }
        } else {
          probe?.increment('frames-skipped');
        }
        if (probe && interval > 0) {
          probe.record('frame-interval', interval);
        }
        quality?.recordFrame(interval, work);
        frame = requestAnimationFrame(loop);
      };

      const start = () => {
        if (disposed || frozen) {
          return;
        }
        paused = false;
        feed.setActive(true);
        if (frame === 0) {
          // A resumed loop's first interval spans the pause; drop it.
          lastCallbackAt = 0;
          quality?.resetWindow();
          frame = requestAnimationFrame(loop);
        }
      };
      const stop = () => {
        paused = true;
        if (frame !== 0) {
          cancelAnimationFrame(frame);
          frame = 0;
        }
      };

      const resizeObserver =
        typeof ResizeObserver === 'function'
          ? new ResizeObserver(() => {
              resize();
              if (frozen || paused) {
                renderer.render(scene, camera);
              }
            })
          : null;
      resizeObserver?.observe(surface);

      const redrawIfIdle = () => {
        if (frozen || paused) {
          renderer.render(scene, camera);
        }
      };
      // One live listener at a time: the previous query's listener is removed
      // before the next is added (the earlier inline version leaked one per
      // pixel-ratio change).
      const stopWatchingPixelRatio = watchDevicePixelRatio(globalThis, () => {
        resize();
        redrawIfIdle();
      });
      const unsubscribeQuality = quality?.subscribe((next) => {
        const pixelRatioChanged = next.maxPixelRatio !== settings.maxPixelRatio;
        settings = next;
        if (pixelRatioChanged) {
          resize();
          redrawIfIdle();
        }
      });

      canvas.addEventListener('webglcontextlost', (event) => {
        event.preventDefault();
        createOptions.onRendererError();
      });

      surface.appendChild(canvas);
      resize();
      start();
      partial = null;
      probe?.mark('renderer-ready');
      const inspect = (): TopologyRendererInspection => ({
        drawnPulses,
        bufferedEvents: spikeEvents.size(),
        motionEnabled,
        quality: settings.name,
        pixelRatio,
      });
      inspectSession = inspect;

      return {
        pause() {
          stop();
          // Paused sessions hold no spike events; the next tick starts fresh.
          feed.setActive(false);
        },
        resume() {
          start();
        },
        freeze() {
          frozen = true;
          stop();
          renderFrame(performance.now());
          feed.setActive(false);
        },
        setCameraMotionEnabled(enabled: boolean) {
          motionEnabled = enabled;
        },
        dispose() {
          if (disposed) {
            return;
          }
          disposed = true;
          stop();
          unsubscribe();
          feed.detach();
          if (inspectSession === inspect) {
            inspectSession = null;
          }
          resizeObserver?.disconnect();
          stopWatchingPixelRatio();
          unsubscribeQuality?.();
          for (const disposable of disposables) {
            disposable.dispose();
          }
          canvas.remove();
        },
      };
    },
  };
}

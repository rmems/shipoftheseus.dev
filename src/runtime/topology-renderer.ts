import type {
  RendererCreateOptions,
  RendererSeam,
  RendererSession,
  ReasonCode,
} from './demo-runtime';
import type { NeuromorphicState } from './neuromorphic-adapter';
import type { SimulationChannel } from './simulation-channel';

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
}

/**
 * Three.js renderer seam for the WASM topology projection. Loads `three` only
 * when the runtime actually attempts the live path, so static readers never
 * pay the bundle cost.
 */
export function createTopologyRendererSeam(options: TopologyRendererSeamOptions): RendererSeam {
  let partial: (() => void) | null = null;

  return {
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
      disposables.push(nodeMaterial, edgeMaterial);

      let nodeGeometry: import('three').BufferGeometry | null = null;
      let edgeGeometry: import('three').BufferGeometry | null = null;
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
      const spikeFlash = new Map<number, number>();
      let latest: NeuromorphicState | null = options.channel.latest();
      const unsubscribe = options.channel.subscribe((state) => {
        latest = state;
        for (const neuron of state.spikeNeurons) {
          spikeFlash.set(neuron, 1);
        }
      });

      function rebuildTopology(state: NeuromorphicState): void {
        builtDigest = state.topologyDigest;
        nodeCount = state.topologyNodeIds.length;
        nodePositions = layoutTopology(nodeCount);

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
        disposables.push(nodeGeometry);
        pointsObject = new THREE.Points(nodeGeometry, nodeMaterial);
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
        disposables.push(edgeGeometry);
        edgeObject = new THREE.LineSegments(edgeGeometry, edgeMaterial);
        world.add(edgeObject);
      }

      let disposed = false;
      let paused = true;
      let frozen = false;
      let cameraMotionEnabled = createOptions.cameraMotionEnabled;
      let frame = 0;
      let lastFrameTime = 0;

      const resize = () => {
        const width = surface.clientWidth || 1;
        const height = surface.clientHeight || 1;
        renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio || 1, 2));
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
            const color = mutedColor
              .clone()
              .lerp(signalColor, Math.min(1, activation * 0.9 + flash));
            color.toArray(colors.array as Float32Array, node * 3);
            if (flash > 0) {
              spikeFlash.set(node, Math.max(0, flash - delta * 3));
            }
          }
          colors.needsUpdate = true;
        }

        if (cameraMotionEnabled) {
          world.rotation.z += delta * 0.08;
        }
        renderer.render(scene, camera);
      };

      const loop = (time: number) => {
        if (disposed || paused || frozen) {
          return;
        }
        renderFrame(time);
        frame = requestAnimationFrame(loop);
      };

      const start = () => {
        if (disposed || frozen) {
          return;
        }
        paused = false;
        if (frame === 0) {
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

      let motionQuery: MediaQueryList | null = null;
      const onDprChange = () => {
        resize();
        motionQuery = globalThis.matchMedia?.(`(resolution: ${globalThis.devicePixelRatio}dppx)`) ?? null;
        motionQuery?.addEventListener('change', onDprChange);
      };
      onDprChange();

      canvas.addEventListener('webglcontextlost', (event) => {
        event.preventDefault();
        createOptions.onRendererError();
      });

      surface.appendChild(canvas);
      resize();
      start();
      partial = null;

      return {
        pause() {
          stop();
        },
        resume() {
          start();
        },
        freeze() {
          frozen = true;
          stop();
          renderFrame(performance.now());
        },
        setCameraMotionEnabled(enabled: boolean) {
          cameraMotionEnabled = enabled;
        },
        dispose() {
          if (disposed) {
            return;
          }
          disposed = true;
          stop();
          unsubscribe();
          resizeObserver?.disconnect();
          motionQuery?.removeEventListener('change', onDprChange);
          for (const disposable of disposables) {
            disposable.dispose();
          }
          canvas.remove();
        },
      };
    },
  };
}

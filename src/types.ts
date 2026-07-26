export interface Bands {
  low: number;
  mid: number;
  high: number;
}

export interface DetectedNote {
  midi: number;
  frequency: number;
  strength: number;
}

/** Contract Capa 1 → Capa 2. Every numerical feature is normalized to 0–1. */
export interface FeatureFrame {
  t: number;
  rms: number;
  bands: Bands;
  onset: boolean;
  onsetStrength: number;
  chroma: Float32Array;
  centroid: number;
  flux: number;
  noteAttacks: DetectedNote[];
}

export type GestureEvent =
  | { type: 'estalla'; intensity: number; target?: string }
  | { type: 'climax'; intensity?: number; target?: string }
  | { type: 'pulso'; count: number; target?: string }
  | { type: string; target?: string; [key: string]: unknown };

export interface GestureOutput {
  value: number;
  events: GestureEvent[];
}

export interface Gesture<Params extends Record<string, number> = Record<string, number>, State = unknown> {
  id: string;
  params: Params;
  init(params: Params): State;
  update(state: State, frame: FeatureFrame, dt: number): State;
  read(state: State): GestureOutput;
  clearEvents?(state: State): void;
}

export type Curve = 'linear' | 'exp' | 'log' | 'sCurve';

export interface Wire {
  gestureId: string;
  output: 'value' | GestureEvent['type'];
  target: string;
  curve?: Curve;
  min?: number;
  max?: number;
}

export interface SceneMapping {
  scene: number;
  wires: Wire[];
}

export interface Scene {
  id: number;
  nombre: string;
  visualScene: number;
  gestosActivos: string[];
  presets: Record<string, Record<string, number>>;
  wires: Wire[];
  transicionEntrada: { tipo: 'corte' | 'crossfade'; seg: number };
  baseParams: Record<string, number>;
  notes: string;
}

export interface ShowConfig {
  version: 2;
  scenes: Scene[];
}

export interface SceneTransition {
  type: 'corte' | 'crossfade';
  duration: number;
  fromScene: number | null;
  progress: number;
}

export type ImpulseMode = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;
export type TranscriberStatus = 'loading' | 'ready' | 'error';

export interface VisualFrame {
  params: Record<string, number>;
  events: GestureEvent[];
  scene: number;
  profile: number;
  transition: SceneTransition;
  blackout: boolean;
  impulseMode: ImpulseMode;
  noteAttacks: DetectedNote[];
  wideChord: boolean;
}

export interface AudioStatus {
  state: 'idle' | 'requesting-permission' | 'starting' | 'running' | 'suspended' | 'ended' | 'error';
  running: boolean;
  sampleRate: number;
  rawRms: number;
  latencyMs: number | null;
  error: string | null;
  calibrated: boolean;
  calibrating: boolean;
}

export interface RendererStatus {
  state: 'ready' | 'lost';
  quality: 'high' | 'safe';
  pixelRatio: number;
  width: number;
  height: number;
  drawCalls: number;
  geometries: number;
  textures: number;
  contextLosses: number;
  fpsAverage: number;
  frameTimeP95Ms: number;
  tabVisible: boolean;
  voronoiCells: number;
  packingGravityEnabled: boolean;
  hrcResolution: number;
  hrcUpdateHz: number;
  hrcFrustumsPerFrame: number;
  hrcTargetMemoryBytes: number;
  hrcDrawCalls: number;
  causticsActive: boolean;
  causticsQuality: 'high' | 'safe' | 'off';
  causticsEmitterCount: number;
  causticsMaterialCount: number;
  causticsRayCount: number;
  causticsHitCount: number;
  causticsPointCount: number;
  causticsUpdateHz: number;
  causticsCpuTimeMs: number;
  causticsDrawCalls: number;
  causticsTargetMemoryBytes: number;
}

export interface SystemStatus {
  audio: AudioStatus;
  fps: number;
  activeScene: number;
  outputs: Record<string, GestureOutput>;
  gestureParams: Record<string, Record<string, number>>;
  frozenGestures: string[];
  impulseMode: ImpulseMode;
  detectedNoteCount: number;
  detectedNotes: string[];
  nativeNoteCount: number;
  modelNoteCount: number;
  audioChunkCount: number;
  transcriberTelemetry: { inputChunks: number; receivedSamples: number; windows: number; emittedNotes: number; peakOnset: number; peakFrame: number };
  transcriber: { state: TranscriberStatus; error: string | null };
  blackout: boolean;
  overrides: Record<string, number>;
  config: ShowConfig;
  revision: number;
  notice: string | null;
  renderer: RendererStatus;
}

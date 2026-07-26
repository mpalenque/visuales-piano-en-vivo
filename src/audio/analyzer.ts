import type { AudioStatus, FeatureFrame } from '../types';
import featureWorkletUrl from './feature-worklet.js?worker&url';

type AudioListener = (status: AudioStatus) => void;
type AudioSamplesListener = (samples: Float32Array, sampleRate: number) => void;

const initialStatus: AudioStatus = {
  state: 'idle',
  running: false,
  sampleRate: 0,
  rawRms: 0,
  latencyMs: null,
  error: null,
  calibrated: false,
  calibrating: false,
};

/** Browser audio input plus a bounded feature queue consumed by the gesture engine. */
export class LiveAudioAnalyzer {
  private context: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private node: AudioWorkletNode | null = null;
  private silentGain: GainNode | null = null;
  private queue: FeatureFrame[] = [];
  private listeners = new Set<AudioListener>();
  private readonly sampleListeners = new Set<AudioSamplesListener>();
  private status: AudioStatus = { ...initialStatus };
  private starting: Promise<void> | null = null;
  private inputTrack: MediaStreamTrack | null = null;
  private runId = 0;

  subscribe(listener: AudioListener): () => void {
    this.listeners.add(listener);
    listener(this.status);
    return () => this.listeners.delete(listener);
  }

  subscribeSamples(listener: AudioSamplesListener): () => void {
    this.sampleListeners.add(listener);
    return () => this.sampleListeners.delete(listener);
  }

  async start(): Promise<void> {
    if (this.status.running) return;
    if (this.starting) return this.starting;
    if (this.context || this.stream) this.stop();
    const runId = ++this.runId;
    const start = this.open(runId);
    this.starting = start;
    try {
      await start;
    } finally {
      if (this.starting === start) this.starting = null;
    }
  }

  private async open(runId: number): Promise<void> {
    try {
      this.patchStatus({ state: 'requesting-permission', running: false, error: null });
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          autoGainControl: false,
          echoCancellation: false,
          noiseSuppression: false,
          channelCount: 1,
        },
      });
      if (runId !== this.runId) {
        this.stream.getTracks().forEach((track) => track.stop());
        return;
      }
      this.inputTrack = this.stream.getAudioTracks()[0] ?? null;
      this.inputTrack?.addEventListener('ended', this.onTrackEnded);
      this.patchStatus({ state: 'starting' });
      this.context = new AudioContext({ latencyHint: 'interactive' });
      this.context.addEventListener('statechange', this.onContextStateChange);
      await this.context.audioWorklet.addModule(featureWorkletUrl);
      if (runId !== this.runId) {
        this.stop();
        return;
      }
      const source = this.context.createMediaStreamSource(this.stream);
      this.node = new AudioWorkletNode(this.context, 'feature-processor', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      });
      this.silentGain = this.context.createGain();
      this.silentGain.gain.value = 0;
      source.connect(this.node).connect(this.silentGain).connect(this.context.destination);
      this.node.port.onmessage = ({ data }: MessageEvent) => this.receive(data);
      await this.context.resume();
      this.patchStatus({ state: 'running', running: true, sampleRate: this.context.sampleRate, error: null });
      this.recalibrate();
    } catch (error) {
      this.stop();
      this.patchStatus({ state: 'error', error: error instanceof Error ? error.message : 'No se pudo abrir el micrófono.' });
      throw error;
    }
  }

  stop(): void {
    this.runId += 1;
    this.node?.disconnect();
    this.silentGain?.disconnect();
    this.context?.removeEventListener('statechange', this.onContextStateChange);
    this.inputTrack?.removeEventListener('ended', this.onTrackEnded);
    this.stream?.getTracks().forEach((track) => track.stop());
    void this.context?.close();
    this.context = null;
    this.stream = null;
    this.node = null;
    this.silentGain = null;
    this.inputTrack = null;
    this.queue = [];
    this.patchStatus({ ...initialStatus });
  }

  takeFrames(): FeatureFrame[] {
    const frames = this.queue;
    this.queue = [];
    return frames;
  }

  recalibrate(seconds = 10): boolean {
    if (!this.node || !this.status.running) {
      this.patchStatus({ error: 'El micrófono debe estar activo antes de recalibrar.' });
      return false;
    }
    this.node.port.postMessage({ type: 'calibrate', seconds });
    this.patchStatus({ calibrated: false, calibrating: true, error: null });
    return true;
  }

  private receive(data: unknown): void {
    if (!data || typeof data !== 'object') return;
    const message = data as { type?: string; frame?: FeatureFrame & { rawRms?: number }; samples?: ArrayBuffer; state?: string };
    if (message.type === 'features' && message.frame) {
      const frame = message.frame;
      // The structured clone must become a typed array again across browsers.
      frame.chroma = new Float32Array(frame.chroma);
      this.queue.push(frame);
      if (this.queue.length > 24) this.queue.splice(0, this.queue.length - 24);
      const nowAudio = this.context?.currentTime ?? frame.t;
      this.patchStatus({ rawRms: frame.rawRms ?? 0, latencyMs: Math.max(0, (nowAudio - frame.t) * 1000) });
    }
    if (message.type === 'calibration' && message.state === 'started') this.patchStatus({ calibrated: false, calibrating: true });
    if (message.type === 'calibration' && message.state === 'complete') this.patchStatus({ calibrated: true, calibrating: false });
    if (message.type === 'audio' && message.samples instanceof ArrayBuffer && this.context) {
      const samples = new Float32Array(message.samples);
      this.sampleListeners.forEach((listener) => listener(samples, this.context!.sampleRate));
    }
  }

  private patchStatus(patch: Partial<AudioStatus>): void {
    this.status = { ...this.status, ...patch };
    this.listeners.forEach((listener) => listener(this.status));
  }

  private onTrackEnded = (): void => {
    this.queue = [];
    this.patchStatus({ state: 'ended', running: false, calibrating: false, error: 'El micrófono se desconectó o dejó de enviar audio.' });
  };

  private onContextStateChange = (): void => {
    if (!this.context) return;
    if (this.context.state === 'running') this.patchStatus({ state: 'running', running: true, error: null });
    if (this.context.state === 'suspended') this.patchStatus({ state: 'suspended', running: false, calibrating: false, error: 'El audio está suspendido. Volvé a iniciar el micrófono.' });
    if (this.context.state === 'closed' && this.status.state !== 'idle') this.patchStatus({ state: 'ended', running: false, calibrating: false, error: 'El contexto de audio se cerró.' });
  };
}

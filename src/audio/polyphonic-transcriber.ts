import type { DetectedNote } from '../types';
import PolyphonicTranscriberWorker from './polyphonic-transcriber.worker?worker';

export type TranscriberStatus = 'loading' | 'ready' | 'error';

type StatusListener = (status: TranscriberStatus, error: string | null) => void;

export interface TranscriberTelemetry {
  inputChunks: number;
  receivedSamples: number;
  windows: number;
  emittedNotes: number;
  peakOnset: number;
  peakFrame: number;
}

/**
 * Keeps machine-learning transcription out of the audio/render threads. The
 * worklet forwards short PCM chunks; inference and the rolling model window
 * live entirely in a dedicated Worker.
 */
export class PolyphonicNoteTranscriber {
  private readonly worker = new PolyphonicTranscriberWorker();
  private readonly statusListeners = new Set<StatusListener>();
  private pendingNotes: DetectedNote[] = [];
  private telemetry: TranscriberTelemetry = { inputChunks: 0, receivedSamples: 0, windows: 0, emittedNotes: 0, peakOnset: 0, peakFrame: 0 };
  private status: TranscriberStatus = 'loading';
  private error: string | null = null;
  private sourcePosition = 0;

  constructor() {
    this.worker.addEventListener('message', this.onMessage);
    this.worker.addEventListener('error', this.onError);
  }

  subscribeStatus(listener: StatusListener): () => void {
    this.statusListeners.add(listener);
    listener(this.status, this.error);
    return () => this.statusListeners.delete(listener);
  }

  push(source: Float32Array, sourceRate: number): void {
    if (!source.length || !Number.isFinite(sourceRate) || sourceRate <= 0) return;
    const samples = this.resample(source, sourceRate);
    if (samples.length) this.worker.postMessage({ type: 'audio', samples: samples.buffer }, [samples.buffer]);
  }

  /** Returns each onset exactly once on the render loop that follows it. */
  takeNotes(): DetectedNote[] {
    const notes = this.pendingNotes;
    this.pendingNotes = [];
    return notes;
  }

  getTelemetry(): TranscriberTelemetry {
    return { ...this.telemetry };
  }

  dispose(): void {
    this.worker.removeEventListener('message', this.onMessage);
    this.worker.removeEventListener('error', this.onError);
    this.worker.terminate();
    this.pendingNotes = [];
    this.statusListeners.clear();
  }

  private resample(source: Float32Array, sourceRate: number): Float32Array {
    const targetRate = 22_050;
    if (sourceRate === targetRate) return source.slice();
    const ratio = sourceRate / targetRate;
    const output = new Float32Array(Math.ceil(source.length / ratio));
    let count = 0;
    let position = this.sourcePosition;
    while (position < source.length - 1) {
      const lower = Math.floor(position);
      const fraction = position - lower;
      output[count] = source[lower] * (1 - fraction) + source[lower + 1] * fraction;
      count += 1;
      position += ratio;
    }
    this.sourcePosition = position - source.length;
    return output.slice(0, count);
  }

  private onMessage = ({ data }: MessageEvent<unknown>): void => {
    if (!data || typeof data !== 'object') return;
    const message = data as {
      type?: string;
      notes?: DetectedNote[];
      error?: string;
      windows?: number;
      inputChunks?: number;
      receivedSamples?: number;
      emittedNotes?: number;
      peakOnset?: number;
      peakFrame?: number;
    };
    if (message.type === 'ready') this.setStatus('ready', null);
    if (message.type === 'error') this.setStatus('error', message.error ?? 'No se pudo cargar la transcripción polifónica.');
    if (message.type === 'notes' && Array.isArray(message.notes)) {
      const notes = message.notes.filter((note): note is DetectedNote => Number.isInteger(note?.midi) && Number.isFinite(note.frequency) && Number.isFinite(note.strength));
      if (notes.length) this.pendingNotes.push(...notes);
    }
    if (message.type === 'stats') {
      this.telemetry = {
        inputChunks: Number.isFinite(message.inputChunks) ? message.inputChunks! : this.telemetry.inputChunks,
        receivedSamples: Number.isFinite(message.receivedSamples) ? message.receivedSamples! : this.telemetry.receivedSamples,
        windows: Number.isFinite(message.windows) ? message.windows! : this.telemetry.windows,
        emittedNotes: Number.isFinite(message.emittedNotes) ? message.emittedNotes! : this.telemetry.emittedNotes,
        peakOnset: Number.isFinite(message.peakOnset) ? message.peakOnset! : this.telemetry.peakOnset,
        peakFrame: Number.isFinite(message.peakFrame) ? message.peakFrame! : this.telemetry.peakFrame,
      };
    }
  };

  private onError = (): void => this.setStatus('error', 'El Worker de transcripción se detuvo.');

  private setStatus(status: TranscriberStatus, error: string | null): void {
    this.status = status;
    this.error = error;
    this.statusListeners.forEach((listener) => listener(status, error));
  }
}

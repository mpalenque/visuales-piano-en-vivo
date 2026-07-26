import { BasicPitch } from '@spotify/basic-pitch/esm/inference.js';
import { outputToNotesPoly } from '@spotify/basic-pitch/esm/toMidi.js';
import * as tf from '@tensorflow/tfjs';
import modelDefinition from '@spotify/basic-pitch/model/model.json';
import weightsUrl from '@spotify/basic-pitch/model/group1-shard1of1.bin?url';
import type { DetectedNote } from '../types';

const SAMPLE_RATE = 22_050;
const WINDOW_SAMPLES = 43_844;
// Basic Pitch's graph is intentionally isolated from the visual path. A full
// 2-second window is both more musical and prevents a slow CPU inference from
// repeatedly starving the Worker's incoming-audio queue.
const MIN_INFERENCE_SAMPLES = WINDOW_SAMPLES;
const INFERENCE_HOP_SAMPLES = WINDOW_SAMPLES;
const ANNOTATION_FPS = Math.floor(SAMPLE_RATE / 256);
const ONSET_THRESHOLD = 0.38;
// Inference can lag behind the incoming stream on a laptop. Keeping a generous
// source-time overlap means an attack is not discarded simply because the
// previous window was still being evaluated when more microphone chunks arrived.
const OVERLAP_SECONDS = 0.75;

type ModelDefinition = {
  format: string;
  generatedBy: string;
  convertedBy: string;
  modelTopology: tf.io.ModelJSON['modelTopology'];
  weightsManifest: Array<{ weights: tf.io.WeightsManifestEntry[] }>;
};

const definition = modelDefinition as ModelDefinition;
const ring = new Float32Array(WINDOW_SAMPLES);
const lastEmittedAt = new Float64Array(88).fill(-Infinity);
let writeIndex = 0;
let received = 0;
let samplesSinceInference = 0;
let processing = false;
let lastWindowEnd = -Infinity;
let basicPitch: BasicPitch | null = null;
let windows = 0;
let emittedNotes = 0;
let inputChunks = 0;

void bootstrap();

self.addEventListener('message', ({ data }: MessageEvent<unknown>) => {
  if (!data || typeof data !== 'object') return;
  const message = data as { type?: string; samples?: unknown };
  const samples = toFloat32(message.samples);
  if (message.type !== 'audio' || !samples) return;
  for (const sample of samples) {
    ring[writeIndex] = Number.isFinite(sample) ? sample : 0;
    writeIndex = (writeIndex + 1) % WINDOW_SAMPLES;
  }
  received += samples.length;
  samplesSinceInference += samples.length;
  inputChunks += 1;
  self.postMessage({ type: 'stats', inputChunks, receivedSamples: received });
  scheduleInference();
});

function toFloat32(value: unknown): Float32Array | null {
  if (value instanceof Float32Array) return value;
  if (value instanceof ArrayBuffer || Object.prototype.toString.call(value) === '[object ArrayBuffer]') {
    return new Float32Array(value as ArrayBuffer);
  }
  if (ArrayBuffer.isView(value)) return new Float32Array(value.buffer, value.byteOffset, Math.floor(value.byteLength / Float32Array.BYTES_PER_ELEMENT));
  return null;
}

async function bootstrap(): Promise<void> {
  try {
    await tf.ready();
    const weightData = await fetch(weightsUrl).then(async (response) => {
      if (!response.ok) throw new Error(`No se pudieron leer los pesos del modelo (${response.status}).`);
      return response.arrayBuffer();
    });
    const graphModel = await tf.loadGraphModel(tf.io.fromMemory({
      format: definition.format,
      generatedBy: definition.generatedBy,
      convertedBy: definition.convertedBy,
      modelTopology: definition.modelTopology,
      weightSpecs: definition.weightsManifest[0].weights,
      weightData,
    }));
    basicPitch = new BasicPitch(Promise.resolve(graphModel));
    self.postMessage({ type: 'ready' });
    scheduleInference();
  } catch (error) {
    self.postMessage({ type: 'error', error: error instanceof Error ? error.message : 'No se pudo iniciar Basic Pitch.' });
  }
}

function scheduleInference(): void {
  if (!basicPitch || processing || received < MIN_INFERENCE_SAMPLES || samplesSinceInference < INFERENCE_HOP_SAMPLES) return;
  samplesSinceInference = 0;
  void infer(copyWindow(), received / SAMPLE_RATE);
}

function copyWindow(): Float32Array {
  const length = Math.min(received, WINDOW_SAMPLES);
  const window = new Float32Array(length);
  const start = (writeIndex - length + WINDOW_SAMPLES) % WINDOW_SAMPLES;
  const tailLength = Math.min(length, WINDOW_SAMPLES - start);
  window.set(ring.subarray(start, start + tailLength), 0);
  if (tailLength < length) window.set(ring.subarray(0, length - tailLength), tailLength);
  return window;
}

async function infer(window: Float32Array, windowEnd: number): Promise<void> {
  if (!basicPitch) return;
  processing = true;
  const windowStart = windowEnd - window.length / SAMPLE_RATE;
  const newestStart = Math.max(windowStart, lastWindowEnd - OVERLAP_SECONDS);
  const notes: DetectedNote[] = [];
  let peakOnset = 0;
  let peakFrame = 0;
  try {
    await basicPitch.evaluateModel(window, (frames, onsets) => {
      for (const row of frames) {
        for (const value of row) peakFrame = Math.max(peakFrame, value);
      }
      for (const row of onsets) {
        for (const value of row) peakOnset = Math.max(peakOnset, value);
      }
      // This is Basic Pitch's own polyphonic note decoder. Its inferred-onset
      // path catches a played note even when the raw onset neuron is subtle.
      const decoded = outputToNotesPoly(
        frames.map((row) => row.slice()),
        onsets.map((row) => row.slice()),
        0.3,
        0.18,
        2,
        true,
        null,
        null,
        false,
      );
      for (const event of decoded) {
        const noteTime = windowStart + event.startFrame / ANNOTATION_FPS;
        if (noteTime < newestStart || noteTime - lastEmittedAt[event.pitchMidi - 21] < 0.075) continue;
        notes.push({
          midi: event.pitchMidi,
          frequency: 440 * 2 ** ((event.pitchMidi - 69) / 12),
          strength: Math.max(0.12, Math.min(1, event.amplitude)),
        });
        lastEmittedAt[event.pitchMidi - 21] = noteTime;
      }
      for (let frameIndex = 1; frameIndex < onsets.length - 1; frameIndex += 1) {
        const noteTime = windowStart + frameIndex / ANNOTATION_FPS;
        if (noteTime < newestStart) continue;
        const row = onsets[frameIndex];
        for (let pitchIndex = 0; pitchIndex < row.length; pitchIndex += 1) {
          const strength = row[pitchIndex];
          const isPeak = strength >= onsets[frameIndex - 1][pitchIndex] && strength > onsets[frameIndex + 1][pitchIndex];
          if (!isPeak || strength < ONSET_THRESHOLD || noteTime - lastEmittedAt[pitchIndex] < 0.075) continue;
          const midi = pitchIndex + 21;
          notes.push({ midi, frequency: 440 * 2 ** ((midi - 69) / 12), strength });
          lastEmittedAt[pitchIndex] = noteTime;
        }
      }
    }, () => undefined);
    windows += 1;
    emittedNotes += notes.length;
    if (notes.length) self.postMessage({ type: 'notes', notes });
    self.postMessage({ type: 'stats', inputChunks, receivedSamples: received, windows, emittedNotes, peakOnset, peakFrame });
    lastWindowEnd = windowEnd;
  } catch (error) {
    self.postMessage({ type: 'error', error: error instanceof Error ? error.message : 'Falló la inferencia de Basic Pitch.' });
  } finally {
    processing = false;
    scheduleInference();
  }
}

import type { DetectedNote, FeatureFrame } from '../types';

const LOWEST_PIANO_MIDI = 21;
const HIGHEST_PIANO_MIDI = 108;
const PIANO_NOTE_COUNT = HIGHEST_PIANO_MIDI - LOWEST_PIANO_MIDI + 1;

export interface DspState {
  frameSize: number;
  windowed: Float32Array;
  real: Float32Array;
  imag: Float32Array;
  magnitudes: Float32Array;
  previousMagnitude: Float32Array;
  noteScores: Float32Array;
  previousNoteScores: Float32Array;
  lastNoteAttackAt: Float64Array;
  chroma: Float32Array;
  fluxBaseline: number;
  noiseFloor: number;
  signalPeak: number;
}

export interface NativeFeatureFrame extends FeatureFrame {
  rawRms: number;
}

const clamp01 = (value: number): number => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));

export function createDspState(frameSize = 2048): DspState {
  if (frameSize < 2 || (frameSize & (frameSize - 1)) !== 0) throw new Error('El tamaño FFT debe ser una potencia de dos.');
  return {
    frameSize,
    windowed: new Float32Array(frameSize),
    real: new Float32Array(frameSize),
    imag: new Float32Array(frameSize),
    magnitudes: new Float32Array(frameSize / 2),
    previousMagnitude: new Float32Array(frameSize / 2),
    noteScores: new Float32Array(PIANO_NOTE_COUNT),
    previousNoteScores: new Float32Array(PIANO_NOTE_COUNT),
    lastNoteAttackAt: new Float64Array(PIANO_NOTE_COUNT).fill(-Infinity),
    chroma: new Float32Array(12),
    fluxBaseline: 0.015,
    noiseFloor: 0.002,
    signalPeak: 0.08,
  };
}

export function rmsOf(samples: Float32Array): number {
  let sumSquares = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Number.isFinite(samples[index]) ? samples[index] : 0;
    sumSquares += sample * sample;
  }
  return Math.sqrt(sumSquares / Math.max(1, samples.length));
}

/** Pure native feature extraction used both by tests and the AudioWorklet adapter. */
export function extractFeatures(samples: Float32Array, sampleRate: number, state: DspState, t = 0): NativeFeatureFrame {
  if (samples.length !== state.frameSize) throw new Error(`Se esperaban ${state.frameSize} samples y llegaron ${samples.length}.`);
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) throw new Error('sampleRate inválido.');
  const rawRms = rmsOf(samples);
  const n = state.frameSize;
  for (let index = 0; index < n; index += 1) {
    const sample = Number.isFinite(samples[index]) ? samples[index] : 0;
    state.windowed[index] = sample * (0.5 - 0.5 * Math.cos((2 * Math.PI * index) / (n - 1)));
  }
  fft(state);

  const bins = n / 2;
  const nyquist = sampleRate / 2;
  let total = 0;
  let weightedFrequency = 0;
  let low = 0;
  let mid = 0;
  let high = 0;
  let fluxSum = 0;
  state.chroma.fill(0);

  for (let bin = 1; bin < bins; bin += 1) {
    const magnitude = Math.hypot(state.real[bin], state.imag[bin]) / n;
    state.magnitudes[bin] = magnitude;
    const power = magnitude * magnitude;
    const frequency = (bin * sampleRate) / n;
    total += power;
    weightedFrequency += frequency * power;
    if (frequency < 250) low += power;
    else if (frequency < 2000) mid += power;
    else if (frequency < 8000) high += power;
    fluxSum += Math.max(0, magnitude - state.previousMagnitude[bin]);
    state.previousMagnitude[bin] = magnitude;
    if (frequency >= 27.5 && frequency <= 5000) {
      const midi = Math.round(69 + 12 * Math.log2(frequency / 440));
      const pitchClass = ((midi % 12) + 12) % 12;
      state.chroma[pitchClass] += power;
    }
  }

  let chromaTotal = 0;
  for (let index = 0; index < 12; index += 1) chromaTotal += state.chroma[index];
  if (chromaTotal > 0) {
    for (let index = 0; index < 12; index += 1) state.chroma[index] /= chromaTotal;
  }

  const flux = clamp01(fluxSum * 10);
  state.fluxBaseline = state.fluxBaseline * 0.965 + flux * 0.035;
  const onsetStrength = clamp01((flux - state.fluxBaseline * 1.45) * 7);
  const onset = rawRms > state.noiseFloor * 1.8 && onsetStrength > 0.16;
  const noteAttacks = detectNoteAttacks(state, sampleRate, onset, t);
  const bandTotal = low + mid + high + 1e-12;
  const normalizedRms = rawRms <= state.noiseFloor
    ? 0
    : clamp01(Math.sqrt((rawRms - state.noiseFloor) / (state.signalPeak - state.noiseFloor + 1e-8)));
  return {
    t,
    rawRms,
    rms: normalizedRms,
    bands: {
      low: clamp01(Math.sqrt(low / bandTotal) * 1.4),
      mid: clamp01(Math.sqrt(mid / bandTotal) * 1.4),
      high: clamp01(Math.sqrt(high / bandTotal) * 1.4),
    },
    onset,
    onsetStrength,
    chroma: new Float32Array(state.chroma),
    centroid: clamp01((weightedFrequency / (total + 1e-12)) / nyquist * 2),
    flux,
    noteAttacks,
  };
}

/**
 * Finds several piano-pitch candidates during one attack. It is deliberately
 * conservative: false positives are worse than omitting a quiet voice in a
 * visual test. A later Essentia/HPCP gate can replace this without changing
 * the FeatureFrame contract.
 */
function detectNoteAttacks(state: DspState, sampleRate: number, onset: boolean, t: number): DetectedNote[] {
  let strongest = 0;
  for (let index = 0; index < PIANO_NOTE_COUNT; index += 1) {
    const midi = LOWEST_PIANO_MIDI + index;
    const frequency = midiToFrequency(midi);
    const fundamental = interpolatedMagnitude(state, frequency, sampleRate);
    let harmonicEnergy = 0;
    let harmonicWeight = 0;
    for (let harmonic = 2; harmonic <= 5; harmonic += 1) {
      const harmonicFrequency = frequency * harmonic;
      if (harmonicFrequency >= sampleRate / 2) break;
      const weight = 1 / (harmonic * harmonic);
      harmonicEnergy += interpolatedMagnitude(state, harmonicFrequency, sampleRate) * weight;
      harmonicWeight += weight;
    }
    // The fundamental carries most of the score so a harmonic is not routinely
    // mistaken for a separate octave. Harmonics stabilize real piano timbre.
    const score = fundamental * 0.84 + harmonicEnergy / Math.max(harmonicWeight, 1e-8) * 0.16;
    state.noteScores[index] = score;
    strongest = Math.max(strongest, score);
  }

  const attacks: DetectedNote[] = [];
  if (onset && strongest > 1e-5) {
    const threshold = strongest * 0.14;
    for (let index = 0; index < PIANO_NOTE_COUNT; index += 1) {
      const score = state.noteScores[index];
      const previous = state.previousNoteScores[index];
      const left = index > 0 ? state.noteScores[index - 1] : 0;
      const right = index < PIANO_NOTE_COUNT - 1 ? state.noteScores[index + 1] : 0;
      const fresh = score > previous * 1.16 + strongest * 0.015;
      const localPeak = score >= left && score >= right;
      const notRepeated = t - state.lastNoteAttackAt[index] >= 0.075;
      if (score >= threshold && localPeak && fresh && notRepeated) {
        const midi = LOWEST_PIANO_MIDI + index;
        attacks.push({ midi, frequency: midiToFrequency(midi), strength: clamp01(score / strongest) });
        state.lastNoteAttackAt[index] = t;
      }
    }
  }
  state.previousNoteScores.set(state.noteScores);
  return attacks.sort((a, b) => a.midi - b.midi).slice(0, 10);
}

function midiToFrequency(midi: number): number {
  return 440 * 2 ** ((midi - 69) / 12);
}

function interpolatedMagnitude(state: DspState, frequency: number, sampleRate: number): number {
  const position = frequency * state.frameSize / sampleRate;
  const lower = Math.floor(position);
  if (lower < 1 || lower >= state.magnitudes.length - 1) return 0;
  const fraction = position - lower;
  return state.magnitudes[lower] * (1 - fraction) + state.magnitudes[lower + 1] * fraction;
}

function fft(state: DspState): void {
  const n = state.frameSize;
  for (let index = 0; index < n; index += 1) {
    state.real[index] = state.windowed[index];
    state.imag[index] = 0;
  }
  for (let index = 1, reversed = 0; index < n; index += 1) {
    let bit = n >> 1;
    while (reversed & bit) {
      reversed ^= bit;
      bit >>= 1;
    }
    reversed ^= bit;
    if (index < reversed) {
      const real = state.real[index]; state.real[index] = state.real[reversed]; state.real[reversed] = real;
      const imag = state.imag[index]; state.imag[index] = state.imag[reversed]; state.imag[reversed] = imag;
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const angle = -2 * Math.PI / size;
    const stepReal = Math.cos(angle);
    const stepImag = Math.sin(angle);
    for (let start = 0; start < n; start += size) {
      let unitReal = 1;
      let unitImag = 0;
      for (let index = 0; index < half; index += 1) {
        const even = start + index;
        const odd = even + half;
        const oddReal = state.real[odd] * unitReal - state.imag[odd] * unitImag;
        const oddImag = state.real[odd] * unitImag + state.imag[odd] * unitReal;
        const evenReal = state.real[even];
        const evenImag = state.imag[even];
        state.real[even] = evenReal + oddReal;
        state.imag[even] = evenImag + oddImag;
        state.real[odd] = evenReal - oddReal;
        state.imag[odd] = evenImag - oddImag;
        const nextReal = unitReal * stepReal - unitImag * stepImag;
        unitImag = unitReal * stepImag + unitImag * stepReal;
        unitReal = nextReal;
      }
    }
  }
}

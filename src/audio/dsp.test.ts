import { describe, expect, it } from 'vitest';
import { createDspState, extractFeatures, rmsOf } from './dsp';

const sampleRate = 48_000;
const frameSize = 2048;

function tone(frequency: number, amplitude = 0.4): Float32Array {
  return Float32Array.from({ length: frameSize }, (_, index) => amplitude * Math.sin(2 * Math.PI * frequency * index / sampleRate));
}

function chord(frameLength: number, frequencies: number[], amplitude = 0.28): Float32Array {
  return Float32Array.from({ length: frameLength }, (_, index) => frequencies.reduce((sum, frequency) => sum + amplitude * Math.sin(2 * Math.PI * frequency * index / sampleRate), 0));
}

const finiteFeature = (value: number): void => expect(Number.isFinite(value)).toBe(true);

describe('DSP nativo', () => {
  it('mantiene silencio normalizado y todos los campos finitos', () => {
    const result = extractFeatures(new Float32Array(frameSize), sampleRate, createDspState(frameSize));
    expect(result.rawRms).toBe(0);
    expect(result.rms).toBe(0);
    expect(result.onset).toBe(false);
    [...result.chroma, result.centroid, result.flux, result.onsetStrength, result.bands.low, result.bands.mid, result.bands.high].forEach(finiteFeature);
  });

  it('mide un impulso y detecta flujo nuevo sin NaN', () => {
    const state = createDspState(frameSize);
    extractFeatures(new Float32Array(frameSize), sampleRate, state);
    const impulse = new Float32Array(frameSize);
    impulse[10] = 1;
    const result = extractFeatures(impulse, sampleRate, state);
    expect(result.rawRms).toBeGreaterThan(0);
    expect(result.flux).toBeGreaterThan(0);
    expect(result.onsetStrength).toBeGreaterThanOrEqual(0);
  });

  it('distingue graves, medios y agudos y devuelve chroma para La 440', () => {
    const low = extractFeatures(tone(110), sampleRate, createDspState(frameSize));
    const mid = extractFeatures(tone(880), sampleRate, createDspState(frameSize));
    const high = extractFeatures(tone(4400), sampleRate, createDspState(frameSize));
    const a440 = extractFeatures(tone(440), sampleRate, createDspState(frameSize));
    expect(low.bands.low).toBeGreaterThan(low.bands.mid);
    expect(mid.bands.mid).toBeGreaterThan(mid.bands.low);
    expect(high.bands.high).toBeGreaterThan(high.bands.mid);
    expect(a440.chroma[9]).toBeGreaterThan(0.6);
    expect(a440.rms).toBeGreaterThan(0);
  });

  it('separa candidatos de altura para un ataque con varias notas', () => {
    const polyphonicFrameSize = 4096;
    const state = createDspState(polyphonicFrameSize);
    extractFeatures(new Float32Array(polyphonicFrameSize), sampleRate, state, 0);
    const result = extractFeatures(chord(polyphonicFrameSize, [130.81, 164.81, 196]), sampleRate, state, 0.1);
    const detected = result.noteAttacks.map((note) => note.midi);
    expect(result.onset).toBe(true);
    expect(detected).toContain(48);
    expect(detected).toContain(52);
    expect(detected).toContain(55);
  });

  it('tolera ruido y muestras no finitas sin salir del contrato 0–1', () => {
    const noise = Float32Array.from({ length: frameSize }, (_, index) => (Math.sin(index * 12.9898) * 43758.5453 % 1) * 0.2);
    noise[1] = Number.NaN;
    noise[2] = Number.POSITIVE_INFINITY;
    const result = extractFeatures(noise, sampleRate, createDspState(frameSize));
    expect(rmsOf(noise)).toBeGreaterThan(0);
    [...result.chroma, result.rms, result.centroid, result.flux, result.onsetStrength, result.bands.low, result.bands.mid, result.bands.high].forEach((value) => {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    });
  });

  it('rechaza tamaños o sample rates inválidos antes de analizar', () => {
    expect(() => createDspState(1000)).toThrow('potencia de dos');
    expect(() => extractFeatures(new Float32Array(12), sampleRate, createDspState(frameSize))).toThrow('Se esperaban');
    expect(() => extractFeatures(new Float32Array(frameSize), 0, createDspState(frameSize))).toThrow('sampleRate inválido');
  });
});

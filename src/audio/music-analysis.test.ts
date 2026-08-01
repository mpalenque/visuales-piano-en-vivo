import { describe, expect, it } from 'vitest';
import type { FeatureFrame } from '../types';
import { silentMusicAnalysis, summarizeMusicAnalysis } from './music-analysis';

const frame = (overrides: Partial<FeatureFrame> = {}): FeatureFrame => ({
  t: 0,
  rms: 0.6,
  bands: { low: 0.7, mid: 0.4, high: 0.2 },
  onset: true,
  onsetStrength: 0.85,
  chroma: Float32Array.from([0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0]),
  centroid: 0.42,
  flux: 0.72,
  noteAttacks: [],
  ...overrides,
});

describe('resumen musical para visuales', () => {
  it('conserva picos transitorios y extrae centro, confianza y dispersión armónica', () => {
    const result = summarizeMusicAnalysis(
      [
        frame(),
        frame({
          rms: 0.4,
          onsetStrength: 0.3,
          flux: 0.25,
          chroma: Float32Array.from([0.5, 0, 0, 0, 0.5, 0, 0, 0.5, 0, 0, 0, 0]),
        }),
      ],
      silentMusicAnalysis(),
      1 / 60,
    );

    expect(result.onset).toBe(0.85);
    expect(result.flux).toBe(0.72);
    expect(result.harmonicCenter).toBeCloseTo(9 / 11);
    expect(result.harmonicConfidence).toBeGreaterThan(0);
    expect(result.harmonicSpread).toBeGreaterThan(0);
  });

  it('decae hacia silencio sin perder de golpe el centro espectral ni armónico', () => {
    const active = summarizeMusicAnalysis([frame()], silentMusicAnalysis(), 1 / 30);
    const decayed = summarizeMusicAnalysis([], active, 1 / 30);

    expect(decayed.rms).toBeLessThan(active.rms);
    expect(decayed.onset).toBeLessThan(active.onset);
    expect(decayed.centroid).toBe(active.centroid);
    expect(decayed.harmonicCenter).toBe(active.harmonicCenter);
  });
});

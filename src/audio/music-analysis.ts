import type { FeatureFrame, MusicAnalysisFrame } from '../types';

export const silentMusicAnalysis = (): MusicAnalysisFrame => ({
  rms: 0,
  bass: 0,
  mid: 0,
  treble: 0,
  onset: 0,
  flux: 0,
  centroid: 0.5,
  harmonicCenter: 0,
  harmonicConfidence: 0,
  harmonicSpread: 0,
});

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));
const approach = (from: number, to: number, speed: number, dt: number): number => (
  from + (to - from) * (1 - Math.exp(-speed * dt))
);

/**
 * Reduces all AudioWorklet frames received during one visual frame without
 * losing short onsets. Continuous features are averaged; transient features
 * preserve their peak.
 */
export function summarizeMusicAnalysis(
  frames: readonly FeatureFrame[],
  previous: MusicAnalysisFrame,
  dt: number,
): MusicAnalysisFrame {
  const safeDt = Math.max(0.001, Math.min(0.1, dt));
  if (!frames.length) {
    return {
      rms: approach(previous.rms, 0, 4.5, safeDt),
      bass: approach(previous.bass, 0, 3.8, safeDt),
      mid: approach(previous.mid, 0, 4.2, safeDt),
      treble: approach(previous.treble, 0, 5.2, safeDt),
      onset: approach(previous.onset, 0, 12, safeDt),
      flux: approach(previous.flux, 0, 7.5, safeDt),
      centroid: previous.centroid,
      harmonicCenter: previous.harmonicCenter,
      harmonicConfidence: approach(previous.harmonicConfidence, 0, 0.7, safeDt),
      harmonicSpread: approach(previous.harmonicSpread, 0, 0.5, safeDt),
    };
  }

  const chroma = new Float32Array(12);
  let rms = 0;
  let bass = 0;
  let mid = 0;
  let treble = 0;
  let onset = 0;
  let flux = 0;
  let centroid = 0;
  for (const frame of frames) {
    rms += frame.rms;
    bass += frame.bands.low;
    mid += frame.bands.mid;
    treble += frame.bands.high;
    onset = Math.max(onset, frame.onsetStrength);
    flux = Math.max(flux, frame.flux);
    centroid += frame.centroid;
    for (let index = 0; index < chroma.length; index += 1) {
      chroma[index] += frame.chroma[index] ?? 0;
    }
  }

  const inverseCount = 1 / frames.length;
  let chromaTotal = 0;
  let strongestClass = 0;
  let strongestValue = 0;
  for (let index = 0; index < chroma.length; index += 1) {
    const value = chroma[index] * inverseCount;
    chroma[index] = value;
    chromaTotal += value;
    if (value > strongestValue) {
      strongestValue = value;
      strongestClass = index;
    }
  }

  let entropy = 0;
  if (chromaTotal > 1e-6) {
    for (const value of chroma) {
      const probability = value / chromaTotal;
      if (probability > 1e-6) entropy -= probability * Math.log(probability);
    }
  }
  const harmonicConfidence = clamp01(strongestValue / (chromaTotal + 1e-6) * 3);
  const harmonicSpread = clamp01(entropy / Math.log(12));

  return {
    rms: approach(previous.rms, clamp01(rms * inverseCount), 11, safeDt),
    bass: approach(previous.bass, clamp01(bass * inverseCount), 8, safeDt),
    mid: approach(previous.mid, clamp01(mid * inverseCount), 8, safeDt),
    treble: approach(previous.treble, clamp01(treble * inverseCount), 10, safeDt),
    onset: Math.max(onset, approach(previous.onset, 0, 12, safeDt)),
    flux: Math.max(flux, approach(previous.flux, 0, 7.5, safeDt)),
    centroid: approach(previous.centroid, clamp01(centroid * inverseCount), 6, safeDt),
    harmonicCenter: strongestClass / 11,
    harmonicConfidence: approach(previous.harmonicConfidence, harmonicConfidence, 5, safeDt),
    harmonicSpread: approach(previous.harmonicSpread, harmonicSpread, 3.5, safeDt),
  };
}

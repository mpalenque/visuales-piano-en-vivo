import { describe, expect, it } from 'vitest';
import { analyzeTransportField } from './transport-field-metrics';

describe('transport field metrics', () => {
  it('returns finite neutral metrics for an empty field', () => {
    const metrics = analyzeTransportField({
      energy: new Float32Array(6 * 4),
      width: 6,
      height: 4,
    });

    expect(metrics).toMatchObject({
      sum: 0,
      maximum: 0,
      p95: 0,
      p99: 0,
      nonZeroPixels: 0,
      boundingBox: null,
      centroid: null,
      outsideLeak: 0,
      outsideLeakRatio: 0,
      clippedPixels: 0,
      clippedRatio: 0,
      phase4Score: 0,
    });
    expect(metrics.covariance).toEqual({ xx: 0, xy: 0, yy: 0 });
    expect(metrics.majorAxis).toEqual({
      angleRadians: 0,
      majorVariance: 0,
      minorVariance: 0,
      anisotropy: 0,
    });
    expect(metrics.connectedComponents).toEqual({
      count: 0,
      largestPixels: 0,
      largestEnergy: 0,
    });
    expect(metrics.autocorrelationLagSpikes).toEqual({ 2: 0, 4: 0, 8: 0 });
  });

  it('detects the exact four-phase transport grid and its lag spikes', () => {
    const width = 32;
    const height = 32;
    const energy = new Float32Array(width * height);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        if ((x + y * 2) % 4 === 0) energy[y * width + x] = 1;
      }
    }

    const metrics = analyzeTransportField({ energy, width, height });

    expect(metrics.phase4Score).toBeCloseTo(1, 10);
    expect(metrics.autocorrelationLagSpikes[2]).toBeGreaterThan(0.4);
    expect(metrics.autocorrelationLagSpikes[4]).toBeGreaterThan(0.9);
    expect(metrics.autocorrelationLagSpikes[8]).toBeGreaterThan(0.9);
    expect(metrics.connectedComponents.count).toBe(metrics.nonZeroPixels);
    expect(metrics.connectedComponents.largestPixels).toBe(1);
  });

  it('describes one smooth anisotropic lobe without reporting a grid', () => {
    const width = 48;
    const height = 40;
    const energy = new Float32Array(width * height);
    const centreX = 24;
    const centreY = 20;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const dx = (x - centreX) / 8;
        const dy = (y - centreY) / 4;
        energy[y * width + x] = Math.exp(-0.5 * (dx * dx + dy * dy));
      }
    }

    const metrics = analyzeTransportField({
      energy,
      width,
      height,
      nonZeroThreshold: 1e-4,
      clippingThreshold: 0.9,
    });

    expect(metrics.sum).toBeGreaterThan(0);
    expect(metrics.maximum).toBeCloseTo(1);
    expect(metrics.p99).toBeGreaterThan(metrics.p95);
    expect(metrics.centroid?.x).toBeCloseTo(centreX, 1);
    expect(metrics.centroid?.y).toBeCloseTo(centreY, 1);
    expect(metrics.boundingBox?.width).toBeGreaterThan(
      metrics.boundingBox?.height ?? Number.POSITIVE_INFINITY,
    );
    expect(Math.abs(metrics.majorAxis.angleRadians)).toBeLessThan(0.02);
    expect(metrics.majorAxis.majorVariance).toBeGreaterThan(
      metrics.majorAxis.minorVariance,
    );
    expect(metrics.connectedComponents.count).toBe(1);
    expect(metrics.connectedComponents.largestPixels).toBe(
      metrics.nonZeroPixels,
    );
    expect(metrics.phase4Score).toBeLessThan(0.01);
    expect(metrics.autocorrelationLagSpikes[2]).toBeLessThan(0.02);
    expect(metrics.autocorrelationLagSpikes[4]).toBeLessThan(0.02);
    expect(metrics.autocorrelationLagSpikes[8]).toBeLessThan(0.02);
    expect(metrics.clippedPixels).toBeGreaterThan(0);
    expect(metrics.clippedRatio).toBeGreaterThan(0);
  });

  it('measures energy leaking beyond the receiver mask', () => {
    const width = 8;
    const height = 8;
    const energy = new Float32Array(width * height);
    const receiverMask = new Uint8Array(width * height);
    for (let y = 2; y < 6; y += 1) {
      for (let x = 2; x < 6; x += 1) {
        const index = y * width + x;
        energy[index] = 1;
        receiverMask[index] = 1;
      }
    }
    energy[0] = 2;
    energy[width * height - 1] = 2;

    const metrics = analyzeTransportField({
      energy,
      width,
      height,
      receiverMask,
      clippingThreshold: 1.5,
    });

    expect(metrics.sum).toBe(20);
    expect(metrics.outsideLeak).toBe(4);
    expect(metrics.outsideLeakRatio).toBeCloseTo(0.2);
    expect(metrics.outsideLeakPixels).toBe(2);
    expect(metrics.clippedPixels).toBe(2);
    expect(metrics.clippedRatio).toBeCloseTo(2 / 18);
    expect(metrics.boundingBox).toEqual({
      minX: 0,
      minY: 0,
      maxX: 7,
      maxY: 7,
      width: 8,
      height: 8,
    });
    expect(metrics.phase4Score).toBeCloseTo(0, 10);
  });

  it('rejects buffer dimensions that cannot describe the field', () => {
    expect(() => analyzeTransportField({
      energy: new Float32Array(4),
      width: 3,
      height: 2,
    })).toThrow(/energy length/);
    expect(() => analyzeTransportField({
      energy: new Float32Array(4),
      width: 2,
      height: 2,
      receiverMask: new Uint8Array(3),
    })).toThrow(/receiverMask length/);
  });
});

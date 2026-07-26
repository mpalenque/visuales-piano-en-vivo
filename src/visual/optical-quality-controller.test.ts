import { describe, expect, it } from 'vitest';
import {
  OPTICAL_QUALITY_PRESETS,
  OpticalQualityController,
  opticalRelativeLimitMs,
  type OpticalManualQuality,
  type OpticalQualitySample,
} from './optical-quality-controller';

const sample = (
  overrides: Partial<OpticalQualitySample> = {},
): OpticalQualitySample => ({
  frameTimeP95Ms: 9,
  dtSeconds: 0.5,
  baselineP95Ms: 9,
  quality: 'high',
  opticalActive: true,
  opticalAvailable: true,
  ...overrides,
});

const updateFor = (
  controller: OpticalQualityController,
  seconds: number,
  overrides: Partial<OpticalQualitySample>,
): void => {
  for (let elapsed = 0; elapsed < seconds; elapsed += 0.5) {
    controller.update(sample({ ...overrides, dtSeconds: 0.5 }));
  }
};

const activate = (
  controller: OpticalQualityController,
  quality: OpticalManualQuality = 'high',
): void => {
  controller.update(sample({ quality, dtSeconds: 0 }));
};

describe('OpticalQualityController', () => {
  it('exports the conservative degradation ladder', () => {
    expect(OPTICAL_QUALITY_PRESETS[0]).toMatchObject({
      enabled: true,
      resolution: 128,
      directionsPerPixel: 4,
      maxStepsPerSegment: 28,
      updateEveryHrcCycles: 1,
      materials: 'glass',
    });
    expect(OPTICAL_QUALITY_PRESETS[1]).toMatchObject({
      resolution: 128,
      directionsPerPixel: 2,
    });
    expect(OPTICAL_QUALITY_PRESETS[2]).toMatchObject({
      resolution: 64,
      directionsPerPixel: 2,
    });
    expect(OPTICAL_QUALITY_PRESETS[3]).toMatchObject({
      updateEveryHrcCycles: 2,
      materials: 'glass',
    });
    expect(OPTICAL_QUALITY_PRESETS[4]).toMatchObject({
      enabled: true,
      materials: 'mirror',
    });
    expect(OPTICAL_QUALITY_PRESETS[5]).toMatchObject({
      enabled: false,
      resolution: 0,
      materials: 'off',
    });
  });

  it('uses the stricter relative limit when a baseline is available', () => {
    expect(opticalRelativeLimitMs(9)).toBeCloseTo(9.45);
    expect(opticalRelativeLimitMs(30)).toBe(31);
    expect(opticalRelativeLimitMs(null)).toBeNull();
    expect(opticalRelativeLimitMs(Number.NaN)).toBeNull();
  });

  it('degrades one optical tier after a sustained relative regression', () => {
    const controller = new OpticalQualityController();
    activate(controller);

    updateFor(controller, 1, { frameTimeP95Ms: 9.6, baselineP95Ms: 9 });
    expect(controller.stats.tier).toBe(0);
    expect(controller.stats.slowElapsedSeconds).toBe(1);

    controller.update(sample({
      frameTimeP95Ms: 9.6,
      baselineP95Ms: 9,
      dtSeconds: 0.5,
    }));
    expect(controller.stats).toMatchObject({
      tier: 1,
      degradationCount: 1,
      lastTransition: 'degraded',
      slowElapsedSeconds: 0,
    });
  });

  it('degrades on the absolute limit without a baseline', () => {
    const controller = new OpticalQualityController();
    activate(controller);

    updateFor(controller, 1.5, {
      frameTimeP95Ms: 20.1,
      baselineP95Ms: null,
    });
    expect(controller.stats.tier).toBe(1);
    expect(controller.stats.relativeLimitMs).toBeNull();
  });

  it('recovers only one tier per five stable seconds', () => {
    const controller = new OpticalQualityController();
    activate(controller);
    updateFor(controller, 3, { frameTimeP95Ms: 21, baselineP95Ms: null });
    expect(controller.stats.tier).toBe(2);

    updateFor(controller, 4.5, { frameTimeP95Ms: 10, baselineP95Ms: null });
    expect(controller.stats.tier).toBe(2);
    controller.update(sample({
      frameTimeP95Ms: 10,
      baselineP95Ms: null,
      dtSeconds: 0.5,
    }));
    expect(controller.stats).toMatchObject({
      tier: 1,
      recoveryCount: 1,
      lastTransition: 'recovered',
      stableElapsedSeconds: 0,
    });

    updateFor(controller, 5, { frameTimeP95Ms: 10, baselineP95Ms: null });
    expect(controller.stats.tier).toBe(0);
    updateFor(controller, 5, { frameTimeP95Ms: 10, baselineP95Ms: null });
    expect(controller.stats.tier).toBe(0);
    expect(controller.stats.recoveryCount).toBe(2);
  });

  it('starts safe quality at tier 2 and never recovers above its manual cap', () => {
    const controller = new OpticalQualityController();
    activate(controller, 'safe');
    expect(controller.stats.tier).toBe(2);

    updateFor(controller, 10, {
      quality: 'safe',
      frameTimeP95Ms: 8,
      baselineP95Ms: null,
    });
    expect(controller.stats.tier).toBe(2);

    controller.update(sample({ quality: 'high', dtSeconds: 0.5 }));
    updateFor(controller, 5, {
      quality: 'high',
      frameTimeP95Ms: 8,
      baselineP95Ms: null,
    });
    expect(controller.stats.tier).toBe(1);
  });

  it('applies manual safe quality immediately to an active high preset', () => {
    const controller = new OpticalQualityController();
    activate(controller);
    expect(controller.stats.tier).toBe(0);

    controller.update(sample({ quality: 'safe' }));
    expect(controller.stats).toMatchObject({
      tier: 2,
      quality: 'safe',
      lastTransition: 'manual-safe',
    });
  });

  it('stays off while unavailable or unrequested and restarts from the manual preset', () => {
    const controller = new OpticalQualityController();

    controller.update(sample({ opticalAvailable: false }));
    expect(controller.stats).toMatchObject({
      tier: 5,
      operational: false,
    });

    controller.update(sample({ opticalAvailable: true, opticalActive: true }));
    expect(controller.stats).toMatchObject({
      tier: 0,
      operational: true,
      lastTransition: 'activated',
    });

    controller.update(sample({ opticalActive: false }));
    expect(controller.stats).toMatchObject({
      tier: 5,
      operational: false,
      lastTransition: 'disabled',
    });

    controller.update(sample({
      opticalActive: true,
      quality: 'safe',
    }));
    expect(controller.stats).toMatchObject({
      tier: 2,
      operational: true,
      quality: 'safe',
      lastTransition: 'activated',
    });
  });

  it('cannot mutate HRC because its decision surface contains only optical state', () => {
    const controller = new OpticalQualityController();
    activate(controller);
    updateFor(controller, 9, { frameTimeP95Ms: 25, baselineP95Ms: 9 });

    expect(controller.stats.tier).toBe(5);
    expect(Object.keys(controller.stats)).not.toContain('hrcQuality');
    expect(Object.keys(controller.stats.preset)).not.toContain('hrcResolution');
  });
});

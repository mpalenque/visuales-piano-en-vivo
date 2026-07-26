export type OpticalQualityTier = 0 | 1 | 2 | 3 | 4 | 5;
export type OpticalManualQuality = 'high' | 'safe';
export type OpticalMaterialBudget = 'glass' | 'mirror' | 'off';
export type OpticalQualityTransition =
  | 'none'
  | 'activated'
  | 'disabled'
  | 'manual-safe'
  | 'degraded'
  | 'recovered';

export interface OpticalQualityPreset {
  tier: OpticalQualityTier;
  enabled: boolean;
  resolution: number;
  directionsPerPixel: number;
  maxStepsPerSegment: number;
  updateEveryHrcCycles: number;
  materials: OpticalMaterialBudget;
}

export interface OpticalQualitySample {
  frameTimeP95Ms: number;
  dtSeconds: number;
  baselineP95Ms?: number | null;
  quality: OpticalManualQuality;
  /**
   * `opticalActive` means that directional materials are requested by the
   * scene. It remains true when the controller has temporarily selected `off`.
   */
  opticalActive: boolean;
  opticalAvailable: boolean;
}

export interface OpticalQualityStats {
  tier: OpticalQualityTier;
  preset: OpticalQualityPreset;
  operational: boolean;
  quality: OpticalManualQuality;
  frameTimeP95Ms: number;
  relativeLimitMs: number | null;
  slowElapsedSeconds: number;
  stableElapsedSeconds: number;
  degradationCount: number;
  recoveryCount: number;
  lastTransition: OpticalQualityTransition;
}

export const OPTICAL_DEGRADE_AFTER_SECONDS = 1.5;
export const OPTICAL_RECOVER_AFTER_SECONDS = 5;
export const OPTICAL_ABSOLUTE_FRAME_LIMIT_MS = 20;
export const OPTICAL_RECOVERY_FRAME_LIMIT_MS = 15;

const QUALITY_START_TIER: Readonly<Record<OpticalManualQuality, OpticalQualityTier>> = {
  high: 0,
  safe: 2,
};

export const OPTICAL_QUALITY_PRESETS: Readonly<
  Record<OpticalQualityTier, OpticalQualityPreset>
> = Object.freeze({
  0: Object.freeze({
    tier: 0,
    enabled: true,
    resolution: 128,
    directionsPerPixel: 4,
    maxStepsPerSegment: 28,
    updateEveryHrcCycles: 1,
    materials: 'glass',
  }),
  1: Object.freeze({
    tier: 1,
    enabled: true,
    resolution: 128,
    directionsPerPixel: 2,
    maxStepsPerSegment: 28,
    updateEveryHrcCycles: 1,
    materials: 'glass',
  }),
  2: Object.freeze({
    tier: 2,
    enabled: true,
    resolution: 64,
    directionsPerPixel: 2,
    maxStepsPerSegment: 28,
    updateEveryHrcCycles: 1,
    materials: 'glass',
  }),
  3: Object.freeze({
    tier: 3,
    enabled: true,
    resolution: 64,
    directionsPerPixel: 2,
    maxStepsPerSegment: 28,
    updateEveryHrcCycles: 2,
    materials: 'glass',
  }),
  4: Object.freeze({
    tier: 4,
    enabled: true,
    resolution: 64,
    directionsPerPixel: 2,
    maxStepsPerSegment: 28,
    updateEveryHrcCycles: 2,
    materials: 'mirror',
  }),
  5: Object.freeze({
    tier: 5,
    enabled: false,
    resolution: 0,
    directionsPerPixel: 0,
    maxStepsPerSegment: 0,
    updateEveryHrcCycles: 0,
    materials: 'off',
  }),
});

const nextLowerQualityTier = (tier: OpticalQualityTier): OpticalQualityTier =>
  Math.min(5, tier + 1) as OpticalQualityTier;

const nextHigherQualityTier = (
  tier: OpticalQualityTier,
  quality: OpticalManualQuality,
): OpticalQualityTier =>
  Math.max(QUALITY_START_TIER[quality], tier - 1) as OpticalQualityTier;

const finiteNonNegative = (value: number): number =>
  Number.isFinite(value) ? Math.max(0, value) : 0;

const sampleDuration = (value: number): number =>
  Math.min(1, finiteNonNegative(value));

export function opticalRelativeLimitMs(
  baselineP95Ms: number | null | undefined,
): number | null {
  if (
    typeof baselineP95Ms !== 'number'
    || !Number.isFinite(baselineP95Ms)
    || baselineP95Ms <= 0
  ) return null;
  return baselineP95Ms + Math.min(1, baselineP95Ms * 0.05);
}

export function opticalQualityPreset(
  tier: OpticalQualityTier,
): OpticalQualityPreset {
  return OPTICAL_QUALITY_PRESETS[tier];
}

/**
 * Deterministic optical-only quality controller.
 *
 * The class deliberately has no renderer or HRC dependency. The caller can
 * apply the returned optical preset, but the controller cannot lower HRC
 * quality itself.
 */
export class OpticalQualityController {
  private tier: OpticalQualityTier = 5;
  private operational = false;
  private quality: OpticalManualQuality = 'high';
  private frameTimeP95Ms = 0;
  private relativeLimitMs: number | null = null;
  private slowElapsedSeconds = 0;
  private stableElapsedSeconds = 0;
  private degradationCount = 0;
  private recoveryCount = 0;
  private lastTransition: OpticalQualityTransition = 'none';

  update(sample: OpticalQualitySample): OpticalQualityStats {
    const wasOperational = this.operational;
    this.operational = sample.opticalAvailable && sample.opticalActive;
    this.quality = sample.quality;
    this.frameTimeP95Ms = finiteNonNegative(sample.frameTimeP95Ms);
    this.relativeLimitMs = opticalRelativeLimitMs(sample.baselineP95Ms);
    this.lastTransition = 'none';

    if (!this.operational) {
      this.tier = 5;
      this.slowElapsedSeconds = 0;
      this.stableElapsedSeconds = 0;
      if (wasOperational) this.lastTransition = 'disabled';
      return this.stats;
    }

    if (!wasOperational) {
      this.tier = QUALITY_START_TIER[this.quality];
      this.slowElapsedSeconds = 0;
      this.stableElapsedSeconds = 0;
      this.lastTransition = 'activated';
      return this.stats;
    }

    const manualTier = QUALITY_START_TIER[this.quality];
    if (this.tier < manualTier) {
      this.tier = manualTier;
      this.slowElapsedSeconds = 0;
      this.stableElapsedSeconds = 0;
      this.lastTransition = 'manual-safe';
      return this.stats;
    }

    const dt = sampleDuration(sample.dtSeconds);
    const relativeLimitExceeded = this.relativeLimitMs !== null
      && this.frameTimeP95Ms > this.relativeLimitMs;
    const absoluteLimitExceeded =
      this.frameTimeP95Ms > OPTICAL_ABSOLUTE_FRAME_LIMIT_MS;
    const slow = relativeLimitExceeded || absoluteLimitExceeded;

    if (slow) {
      this.slowElapsedSeconds += dt;
      this.stableElapsedSeconds = 0;
      if (
        this.slowElapsedSeconds >= OPTICAL_DEGRADE_AFTER_SECONDS
        && this.tier < 5
      ) {
        this.tier = nextLowerQualityTier(this.tier);
        this.slowElapsedSeconds = 0;
        this.degradationCount += 1;
        this.lastTransition = 'degraded';
      }
      return this.stats;
    }

    this.slowElapsedSeconds = 0;
    const stable = this.frameTimeP95Ms > 0
      && this.frameTimeP95Ms < OPTICAL_RECOVERY_FRAME_LIMIT_MS;
    if (!stable) {
      this.stableElapsedSeconds = 0;
      return this.stats;
    }

    if (this.tier <= manualTier) {
      this.stableElapsedSeconds = 0;
      return this.stats;
    }

    this.stableElapsedSeconds += dt;
    if (
      this.stableElapsedSeconds >= OPTICAL_RECOVER_AFTER_SECONDS
    ) {
      this.tier = nextHigherQualityTier(this.tier, this.quality);
      this.stableElapsedSeconds = 0;
      this.recoveryCount += 1;
      this.lastTransition = 'recovered';
    }
    return this.stats;
  }

  reset(): void {
    this.tier = 5;
    this.operational = false;
    this.frameTimeP95Ms = 0;
    this.relativeLimitMs = null;
    this.slowElapsedSeconds = 0;
    this.stableElapsedSeconds = 0;
    this.degradationCount = 0;
    this.recoveryCount = 0;
    this.lastTransition = 'none';
  }

  get stats(): OpticalQualityStats {
    return {
      tier: this.tier,
      preset: opticalQualityPreset(this.tier),
      operational: this.operational,
      quality: this.quality,
      frameTimeP95Ms: this.frameTimeP95Ms,
      relativeLimitMs: this.relativeLimitMs,
      slowElapsedSeconds: this.slowElapsedSeconds,
      stableElapsedSeconds: this.stableElapsedSeconds,
      degradationCount: this.degradationCount,
      recoveryCount: this.recoveryCount,
      lastTransition: this.lastTransition,
    };
  }
}

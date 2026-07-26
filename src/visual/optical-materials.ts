export type OpticalMaterialKind = 'diffuse' | 'transparent' | 'mirror' | 'glass';
export type DirectionalPackingMaterialKind = 'none' | 'mirror' | 'glass';

export interface OpticalMaterial {
  kind: OpticalMaterialKind;
  tint: readonly [number, number, number];
  roughness: number;
  reflectivity: number;
  transmission: number;
  opacity: number;
  absorption: number;
  ior: number;
}

type OpticalMaterialInput = Partial<Omit<OpticalMaterial, 'kind'>> & Pick<OpticalMaterial, 'kind'>;
export type OpticalMaterialOverrides = Partial<Omit<OpticalMaterial, 'kind'>>;

const MATERIAL_DEFAULTS: Readonly<Record<OpticalMaterialKind, OpticalMaterial>> = {
  diffuse: {
    kind: 'diffuse',
    tint: [1, 1, 1],
    roughness: 1,
    reflectivity: 0,
    transmission: 0,
    opacity: 1,
    absorption: 9,
    ior: 1,
  },
  transparent: {
    kind: 'transparent',
    tint: [0.72, 0.86, 1],
    roughness: 0.08,
    reflectivity: 0.04,
    transmission: 0.84,
    opacity: 0.34,
    absorption: 0.58,
    ior: 1,
  },
  mirror: {
    kind: 'mirror',
    tint: [0.92, 0.95, 1],
    roughness: 0.02,
    reflectivity: 0.92,
    transmission: 0,
    opacity: 1,
    absorption: 9,
    ior: 1,
  },
  glass: {
    kind: 'glass',
    tint: [0.8, 0.92, 1],
    roughness: 0.02,
    reflectivity: 0.08,
    transmission: 0.9,
    opacity: 0.24,
    absorption: 0.35,
    ior: 1.5,
  },
};

const finiteOr = (value: number | undefined, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.max(minimum, Math.min(maximum, value));

const channel = (value: number | undefined, fallback: number): number =>
  clamp(finiteOr(value, fallback), 0, 1);

export function normalizeOpticalMaterial(input: OpticalMaterialInput): OpticalMaterial {
  const defaults = MATERIAL_DEFAULTS[input.kind];
  const sourceTint = input.tint ?? defaults.tint;
  return {
    kind: input.kind,
    tint: [
      channel(sourceTint[0], defaults.tint[0]),
      channel(sourceTint[1], defaults.tint[1]),
      channel(sourceTint[2], defaults.tint[2]),
    ],
    roughness: channel(input.roughness, defaults.roughness),
    reflectivity: channel(input.reflectivity, defaults.reflectivity),
    transmission: channel(input.transmission, defaults.transmission),
    opacity: channel(input.opacity, defaults.opacity),
    absorption: clamp(finiteOr(input.absorption, defaults.absorption), 0, 12),
    ior: clamp(finiteOr(input.ior, defaults.ior), 1, 1.8),
  };
}

export const diffuseOpticalMaterial = (
  overrides: OpticalMaterialOverrides = {},
): OpticalMaterial =>
  normalizeOpticalMaterial({ kind: 'diffuse', ...overrides });

export const transparentOpticalMaterial = (
  overrides: OpticalMaterialOverrides = {},
): OpticalMaterial =>
  normalizeOpticalMaterial({ kind: 'transparent', ...overrides });

export const mirrorOpticalMaterial = (
  overrides: OpticalMaterialOverrides = {},
): OpticalMaterial =>
  normalizeOpticalMaterial({ kind: 'mirror', ...overrides });

export const glassOpticalMaterial = (
  overrides: OpticalMaterialOverrides = {},
): OpticalMaterial =>
  normalizeOpticalMaterial({ kind: 'glass', ...overrides });

export const OPTICAL_MATERIAL_CODE: Readonly<Record<OpticalMaterialKind, number>> =
  Object.freeze({
    diffuse: 0,
    transparent: 1,
    mirror: 2,
    glass: 3,
  });

export const opticalMaterialCode = (material: OpticalMaterial): number =>
  OPTICAL_MATERIAL_CODE[material.kind];

export function scheduledDirectionalPackingMaterial(
  sequence: number,
  mode: number,
  mirrorCount: number,
  glassCount: number,
): DirectionalPackingMaterialKind {
  const stableSequence = Math.max(0, Math.floor(finiteOr(sequence, 0)));
  const stableMirrors = Math.max(0, Math.floor(finiteOr(mirrorCount, 0)));
  const stableGlass = Math.max(0, Math.floor(finiteOr(glassCount, 0)));
  if (
    mode === 5
    && stableGlass < 1
    && stableSequence > 0
    && stableSequence % 13 === 12
  ) return 'glass';
  if (
    (mode === 3 || mode === 5)
    && stableMirrors < 2
    && stableSequence > 0
    && stableSequence % 9 === 8
  ) return 'mirror';
  return 'none';
}

export function packingOpticalMaterial(
  sequence: number,
  materialSample: number,
  emissive: boolean,
  directionalKind: DirectionalPackingMaterialKind = 'none',
): OpticalMaterial {
  if (emissive) return diffuseOpticalMaterial();
  if (directionalKind === 'mirror') return mirrorOpticalMaterial();
  if (directionalKind === 'glass') return glassOpticalMaterial();
  const stableSequence = Math.max(0, Math.floor(finiteOr(sequence, 0)));
  const stableSample = clamp(finiteOr(materialSample, 1), 0, 1);
  const transparent = stableSequence > 0 && stableSequence % 7 === 0;
  return transparent || stableSample < 0.06
    ? transparentOpticalMaterial()
    : diffuseOpticalMaterial();
}

export const isDirectionalOpticalMaterial = (material: OpticalMaterial): boolean =>
  material.kind === 'mirror' || material.kind === 'glass';

import { describe, expect, it } from 'vitest';
import {
  glassOpticalMaterial,
  isDirectionalOpticalMaterial,
  mirrorOpticalMaterial,
  normalizeOpticalMaterial,
  opticalMaterialCode,
  packingOpticalMaterial,
  scheduledDirectionalPackingMaterial,
} from './optical-materials';

describe('optical materials', () => {
  it('normalizes unsafe values into the transport contract', () => {
    const material = normalizeOpticalMaterial({
      kind: 'glass',
      tint: [-1, 0.5, 4],
      roughness: Number.NaN,
      reflectivity: 2,
      transmission: -2,
      opacity: 3,
      absorption: -1,
      ior: 8,
    });

    expect(material).toEqual({
      kind: 'glass',
      tint: [0, 0.5, 1],
      roughness: 0.02,
      reflectivity: 1,
      transmission: 0,
      opacity: 1,
      absorption: 0,
      ior: 1.8,
    });
  });

  it('assigns transparent bodies deterministically without changing emitters', () => {
    expect(packingOpticalMaterial(7, 0.9, false).kind).toBe('transparent');
    expect(packingOpticalMaterial(8, 0.04, false).kind).toBe('transparent');
    expect(packingOpticalMaterial(8, 0.5, false).kind).toBe('diffuse');
    expect(packingOpticalMaterial(7, 0.01, true).kind).toBe('diffuse');
  });

  it('assigns explicit mirror and glass requests without converting emitters', () => {
    expect(packingOpticalMaterial(8, 0.9, false, 'mirror')).toEqual(
      mirrorOpticalMaterial(),
    );
    expect(packingOpticalMaterial(12, 0.9, false, 'glass')).toEqual(
      glassOpticalMaterial(),
    );
    expect(packingOpticalMaterial(8, 0.9, true, 'mirror').kind).toBe('diffuse');
  });

  it('packs material kinds into exact small integer codes', () => {
    expect(opticalMaterialCode(normalizeOpticalMaterial({ kind: 'diffuse' }))).toBe(0);
    expect(opticalMaterialCode(normalizeOpticalMaterial({ kind: 'transparent' }))).toBe(1);
    expect(opticalMaterialCode(mirrorOpticalMaterial())).toBe(2);
    expect(opticalMaterialCode(glassOpticalMaterial())).toBe(3);
  });

  it('schedules few directional bodies and respects the live-mode caps', () => {
    expect(scheduledDirectionalPackingMaterial(8, 3, 0, 0)).toBe('mirror');
    expect(scheduledDirectionalPackingMaterial(17, 3, 1, 0)).toBe('mirror');
    expect(scheduledDirectionalPackingMaterial(26, 3, 2, 0)).toBe('none');
    expect(scheduledDirectionalPackingMaterial(12, 5, 1, 0)).toBe('glass');
    expect(scheduledDirectionalPackingMaterial(25, 5, 1, 1)).toBe('none');
    expect(scheduledDirectionalPackingMaterial(8, 1, 0, 0)).toBe('none');
  });

  it('keeps simple transparency outside the directional transport budget', () => {
    expect(isDirectionalOpticalMaterial(normalizeOpticalMaterial({ kind: 'transparent' }))).toBe(false);
    expect(isDirectionalOpticalMaterial(normalizeOpticalMaterial({ kind: 'mirror' }))).toBe(true);
    expect(isDirectionalOpticalMaterial(normalizeOpticalMaterial({ kind: 'glass' }))).toBe(true);
  });
});

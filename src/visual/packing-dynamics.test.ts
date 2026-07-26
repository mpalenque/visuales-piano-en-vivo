import { describe, expect, it } from 'vitest';
import { polygonSidesForSound, regulatedPackingChaos } from './packing-dynamics';

describe('packing dynamics', () => {
  it('maps the piano register across polygons of 3 to 8 sides', () => {
    expect(polygonSidesForSound(21, 0.1)).toBe(3);
    expect(polygonSidesForSound(64, 0.1)).toBe(5);
    expect(polygonSidesForSound(108, 0.1)).toBe(8);
  });

  it('keeps chaos bounded and requires strong combined musical activity', () => {
    expect(regulatedPackingChaos(0.1, 0.1, 0.1)).toBeCloseTo(0.1);
    expect(regulatedPackingChaos(0.8, 0.9, 0.7)).toBeGreaterThan(0.8);
    expect(regulatedPackingChaos(4, 4, 4)).toBe(1);
  });
});

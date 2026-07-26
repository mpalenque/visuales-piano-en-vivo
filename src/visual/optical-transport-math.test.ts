import { describe, expect, it } from 'vitest';
import {
  estimateNormal,
  packOpticalSurfaceCode,
  refractDirection2d,
  signedDistanceBox,
  signedDistanceRegularPolygon,
  unpackOpticalSurfaceCode,
  worldToBodyLocal,
} from './optical-transport-math';

describe('optical transport math', () => {
  it('keeps the exact sign and distance of an oriented box', () => {
    expect(signedDistanceBox({ x: 0, y: 0 }, { x: 2, y: 1 })).toBe(-1);
    expect(signedDistanceBox({ x: 2, y: 0 }, { x: 2, y: 1 })).toBe(0);
    expect(signedDistanceBox({ x: 2.3, y: 0 }, { x: 2, y: 1 })).toBeCloseTo(0.3);
    expect(signedDistanceBox({ x: 2.3, y: 1.4 }, { x: 2, y: 1 })).toBeCloseTo(0.5);

    const local = worldToBodyLocal(
      { x: Math.SQRT2, y: Math.SQRT2 },
      { x: 0, y: 0 },
      Math.PI / 4,
    );
    expect(local.x).toBeCloseTo(2);
    expect(local.y).toBeCloseTo(0);
    expect(signedDistanceBox(local, { x: 2, y: 1 })).toBeCloseTo(0);
  });

  it('keeps polygon centres inside and vertices on the boundary', () => {
    for (const sides of [3, 5, 8]) {
      expect(signedDistanceRegularPolygon(
        { x: 0, y: 0 },
        { x: 1, y: 1 },
        sides,
      )).toBeCloseTo(-Math.cos(Math.PI / sides));
      expect(signedDistanceRegularPolygon(
        { x: 1, y: 0 },
        { x: 1, y: 1 },
        sides,
      )).toBeCloseTo(0, 6);
      expect(signedDistanceRegularPolygon(
        { x: 1.1, y: 0 },
        { x: 1, y: 1 },
        sides,
      )).toBeGreaterThan(0);
    }
  });

  it('packs body id and material kind into exact half-float-safe integers', () => {
    expect(packOpticalSurfaceCode(1, 'diffuse')).toBe(4);
    expect(packOpticalSurfaceCode(7, 'mirror')).toBe(30);
    expect(packOpticalSurfaceCode(48, 'glass')).toBe(195);
    expect(unpackOpticalSurfaceCode(30)).toEqual({ bodyId: 7, kind: 'mirror' });
    expect(unpackOpticalSurfaceCode(195)).toEqual({ bodyId: 48, kind: 'glass' });
  });

  it('derives an outward finite normal from signed distance', () => {
    const normal = estimateNormal(
      (point) => signedDistanceBox(point, { x: 2, y: 1 }),
      { x: 2, y: 0 },
    );
    expect(normal.x).toBeCloseTo(1);
    expect(normal.y).toBeCloseTo(0);
  });

  it('handles Snell refraction, IOR 1 and total internal reflection', () => {
    const normalEntry = refractDirection2d(
      { x: Math.sin(Math.PI / 6), y: -Math.cos(Math.PI / 6) },
      { x: 0, y: 1 },
      1 / 1.5,
    );
    expect(normalEntry.totalInternalReflection).toBe(false);
    expect(Math.atan2(Math.abs(normalEntry.direction.x), Math.abs(normalEntry.direction.y)))
      .toBeCloseTo(19.47 * Math.PI / 180, 3);

    const unchanged = refractDirection2d({ x: 0.4, y: -0.9 }, { x: 0, y: 1 }, 1);
    expect(unchanged.totalInternalReflection).toBe(false);
    expect(unchanged.direction.x).toBeCloseTo(0.4 / Math.hypot(0.4, 0.9));

    const tir = refractDirection2d(
      { x: Math.sin(50 * Math.PI / 180), y: Math.cos(50 * Math.PI / 180) },
      { x: 0, y: -1 },
      1.5,
    );
    expect(tir.totalInternalReflection).toBe(true);
    expect(Number.isFinite(tir.direction.x)).toBe(true);
    expect(Number.isFinite(tir.direction.y)).toBe(true);
  });
});

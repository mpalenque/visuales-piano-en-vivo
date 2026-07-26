import { describe, expect, it } from 'vitest';
import {
  forwardOpticalMaterialForIndex,
  fresnelSchlick,
  rayConvexPolygonIntersection,
  reflectDirection,
  refractDirection,
  traceForwardCaustics,
  type ForwardOpticalBody,
} from './forward-caustics';

const square = (x: number, y: number, halfWidth: number, halfHeight: number) => [
  { x: x - halfWidth, y: y - halfHeight },
  { x: x + halfWidth, y: y - halfHeight },
  { x: x + halfWidth, y: y + halfHeight },
  { x: x - halfWidth, y: y + halfHeight },
];

const body = (
  id: number,
  material: ForwardOpticalBody['material'],
  x: number,
  y: number,
  halfWidth: number,
  halfHeight: number,
): ForwardOpticalBody => ({
  id,
  order: id,
  center: { x, y },
  vertices: square(x, y, halfWidth, halfHeight),
  material,
  emission: material === 'emitter'
    ? { r: 1, g: 0.6, b: 0.2 }
    : { r: 0, g: 0, b: 0 },
  emissionStrength: material === 'emitter' ? 4 : 0,
  tint: material === 'glass'
    ? { r: 0.72, g: 0.92, b: 1 }
    : { r: 0.9, g: 0.95, b: 1 },
  reflectivity: 0.82,
  ior: 1.45,
  absorption: 0.55,
});

describe('forward caustics optics', () => {
  it('cycles visible glass, mirror and diffuse materials', () => {
    expect(Array.from(
      { length: 6 },
      (_, index) => forwardOpticalMaterialForIndex(index, false),
    )).toEqual(['glass', 'mirror', 'diffuse', 'glass', 'mirror', 'diffuse']);
    expect(forwardOpticalMaterialForIndex(0, true)).toBe('diffuse');
  });

  it('intersects a convex body and returns its outward normal', () => {
    const hit = rayConvexPolygonIntersection(
      { x: -2, y: 0 },
      { x: 1, y: 0 },
      square(0, 0, 0.5, 0.75),
    );
    expect(hit?.distance).toBeCloseTo(1.5, 6);
    expect(hit?.position.x).toBeCloseTo(-0.5, 6);
    expect(hit?.outwardNormal.x).toBeCloseTo(-1, 6);
  });

  it('obeys the mirror reflection law', () => {
    const direction = reflectDirection(
      { x: Math.SQRT1_2, y: -Math.SQRT1_2 },
      { x: 0, y: 1 },
    );
    expect(direction.x).toBeCloseTo(Math.SQRT1_2, 6);
    expect(direction.y).toBeCloseTo(Math.SQRT1_2, 6);
  });

  it('refracts toward the normal and handles total internal reflection', () => {
    const transmitted = refractDirection(
      { x: Math.SQRT1_2, y: -Math.SQRT1_2 },
      { x: 0, y: 1 },
      1 / 1.5,
    );
    expect(transmitted).not.toBeNull();
    expect(Math.abs(transmitted!.x)).toBeLessThan(Math.SQRT1_2);
    expect(refractDirection(
      { x: 0.9, y: 0.435889894 },
      { x: 0, y: -1 },
      1.5,
    )).toBeNull();
  });

  it('keeps Fresnel bounded and stronger at grazing angles', () => {
    const normal = fresnelSchlick(1, 1, 1.5);
    const grazing = fresnelSchlick(0.05, 1, 1.5);
    expect(normal).toBeCloseTo(0.04, 4);
    expect(grazing).toBeGreaterThan(normal);
    expect(grazing).toBeLessThanOrEqual(1);
  });

  it('deposits reflected energy on an opaque receiver', () => {
    const bodies = [
      body(1, 'emitter', -2.5, 0, 0.08, 0.08),
      body(2, 'mirror', 0, 0, 0.05, 0.9),
      body(3, 'diffuse', -2.4, 1.7, 2.4, 0.08),
    ];
    const result = traceForwardCaustics(bodies, 'high');
    expect(result.rayCount).toBe(192);
    expect(result.hitCount).toBeGreaterThan(0);
    expect(result.deposits.every((deposit) => deposit.material === 'mirror')).toBe(true);
  });

  it('deposits refracted energy after crossing a glass body', () => {
    const bodies = [
      body(1, 'emitter', -2.5, 0, 0.08, 0.08),
      body(2, 'glass', 0, 0, 0.32, 0.75),
      body(3, 'diffuse', 2.5, 0, 0.08, 2.2),
    ];
    const result = traceForwardCaustics(bodies, 'high');
    expect(result.rayCount).toBe(192);
    expect(result.hitCount).toBeGreaterThan(0);
    expect(result.deposits.every((deposit) => deposit.material === 'glass')).toBe(true);
  });

  it('does no tracing when the optical layer is disabled', () => {
    const result = traceForwardCaustics([
      body(1, 'emitter', -2.5, 0, 0.08, 0.08),
      body(2, 'glass', 0, 0, 0.32, 0.75),
      body(3, 'diffuse', 2.5, 0, 0.08, 2.2),
    ], 'off');
    expect(result.rayCount).toBe(0);
    expect(result.deposits).toEqual([]);
  });

  it('caps high quality to two visible material pairs', () => {
    const result = traceForwardCaustics([
      body(1, 'emitter', -4, 0, 0.08, 0.08),
      body(2, 'mirror', 0, 0, 0.2, 0.8),
      body(3, 'glass', 0, 2, 0.3, 0.7),
      body(4, 'diffuse', 3, 0, 0.1, 3),
    ], 'high');
    expect(result.materialCount).toBe(2);
    expect(result.rayCount).toBe(384);
  });
});

import { describe, expect, it } from 'vitest';
import {
  type AmitabhaBody,
  selectTransportBodies,
} from './amitabha-radiance-field';
import {
  isDirectionalOpticalMaterial,
  normalizeOpticalMaterial,
} from './optical-materials';

const body = (
  transportOrder: number,
  options: Partial<AmitabhaBody> = {},
): AmitabhaBody => ({
  x: 0,
  y: 0,
  halfWidth: 0.5,
  halfHeight: 0.5,
  angle: 0,
  emission: [0, 0, 0],
  emissionStrength: 0,
  albedo: [0.5, 0.5, 0.5],
  material: normalizeOpticalMaterial({ kind: 'diffuse' }),
  transportOrder,
  ...options,
});

describe('Amitabha transport body selection', () => {
  it('keeps floor, emitters and directional materials before recent diffuse bodies', () => {
    const oldDiffuse = body(1);
    const emitter = body(2, { emission: [1, 0, 0], emissionStrength: 2 });
    const mirror = body(3, { material: normalizeOpticalMaterial({ kind: 'mirror' }) });
    const recentDiffuse = body(4);
    const floor = body(0, { transportRole: 'floor' });

    const selected = selectTransportBodies([
      oldDiffuse,
      emitter,
      mirror,
      recentDiffuse,
      floor,
    ], 4);

    expect(selected).toEqual([emitter, mirror, recentDiffuse, floor]);
  });

  it('uses recent stable input order only to fill the remaining diffuse slots', () => {
    const selected = selectTransportBodies([
      body(1),
      body(2),
      body(3),
      body(4),
    ], 2);

    expect(selected.map((candidate) => candidate.transportOrder)).toEqual([3, 4]);
  });

  it('reserves a directional body slot when emitters exceed the budget', () => {
    const emitters = Array.from({ length: 8 }, (_, index) => body(index + 1, {
      emission: [1, 0.4, 0.1],
      emissionStrength: 8 - index,
    }));
    const mirror = body(20, {
      material: normalizeOpticalMaterial({ kind: 'mirror' }),
    });

    const selected = selectTransportBodies([...emitters, mirror], 4);

    expect(selected).toContain(mirror);
    expect(selected.filter((candidate) => candidate.emissionStrength > 0))
      .toHaveLength(3);
  });

  it('keeps recent diffuse blockers in a dense emitter scene', () => {
    const emitters = Array.from({ length: 60 }, (_, index) => body(index + 1, {
      emission: [1, 0.4, 0.1],
      emissionStrength: 60 - index,
    }));
    const blockers = Array.from({ length: 30 }, (_, index) => body(100 + index));
    const mirror = body(200, {
      material: normalizeOpticalMaterial({ kind: 'mirror' }),
    });
    const floor = body(0, { transportRole: 'floor' });

    const selected = selectTransportBodies(
      [...emitters, ...blockers, mirror, floor],
      48,
    );

    expect(selected).toHaveLength(48);
    expect(selected).toContain(mirror);
    expect(selected).toContain(floor);
    expect(selected.filter((candidate) => candidate.emissionStrength > 0).length)
      .toBeLessThanOrEqual(20);
    expect(selected.filter((candidate) => (
      candidate.transportRole !== 'floor'
      && candidate.emissionStrength === 0
      && !isDirectionalOpticalMaterial(candidate.material)
    )).length).toBeGreaterThan(0);
  });

  it('returns an empty selection for a disabled transport budget', () => {
    expect(selectTransportBodies([body(1)], 0)).toEqual([]);
  });
});

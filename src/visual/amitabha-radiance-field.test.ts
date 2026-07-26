import { describe, expect, it } from 'vitest';
import {
  type AmitabhaBody,
  selectTransportBodies,
} from './amitabha-radiance-field';

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
  transportOrder,
  ...options,
});

describe('Amitabha transport body selection', () => {
  it('keeps the floor, emitters and recent diffuse bodies', () => {
    const oldReceiver = body(1);
    const emitter = body(2, { emission: [1, 0, 0], emissionStrength: 2 });
    const recentReceiver = body(4);
    const floor = body(0, { transportRole: 'floor' });

    const selected = selectTransportBodies([
      oldReceiver,
      emitter,
      recentReceiver,
      floor,
    ], 3);

    expect(selected).toEqual([emitter, recentReceiver, floor]);
  });

  it('uses recent stable input order to fill receiver slots', () => {
    const selected = selectTransportBodies([
      body(1),
      body(2),
      body(3),
      body(4),
    ], 2);

    expect(selected.map((candidate) => candidate.transportOrder)).toEqual([3, 4]);
  });

  it('keeps recent diffuse blockers in a dense emitter scene', () => {
    const emitters = Array.from({ length: 60 }, (_, index) => body(index + 1, {
      emission: [1, 0.4, 0.1],
      emissionStrength: 60 - index,
    }));
    const blockers = Array.from({ length: 30 }, (_, index) => body(100 + index));
    const floor = body(0, { transportRole: 'floor' });

    const selected = selectTransportBodies(
      [...emitters, ...blockers, floor],
      48,
    );

    expect(selected).toHaveLength(48);
    expect(selected).toContain(floor);
    expect(selected.filter((candidate) => candidate.emissionStrength > 0).length)
      .toBeLessThanOrEqual(20);
    expect(selected.some((candidate) => (
      candidate.transportRole !== 'floor'
      && candidate.emissionStrength === 0
    ))).toBe(true);
  });

  it('returns an empty selection for a disabled transport budget', () => {
    expect(selectTransportBodies([body(1)], 0)).toEqual([]);
  });
});

import { describe, expect, it } from 'vitest';
import {
  createTransportFixture,
  createTransportReceiverMask,
} from './transport-fixtures';

describe('transport fixtures', () => {
  it('builds a low-energy mirror-law fixture with deterministic roles', () => {
    const fixture = createTransportFixture({ name: 'mirror-law' });
    expect(fixture).toHaveLength(3);
    expect(fixture[0].material.kind).toBe('diffuse');
    expect(fixture[1].material.kind).toBe('mirror');
    expect(fixture[2].emissionStrength).toBe(1);
    expect(fixture.map((candidate) => candidate.transportOrder))
      .toEqual([1, 2, 3]);
  });

  it('supports IOR and material controls without changing geometry', () => {
    const glass = createTransportFixture({
      name: 'glass-prism',
      ior: 1.33,
    });
    const control = createTransportFixture({
      name: 'glass-prism',
      ior: 1.33,
      materialOverride: 'transparent',
    });
    expect(glass[1].material.kind).toBe('glass');
    expect(glass[1].material.ior).toBeCloseTo(1.33);
    expect(control[1].material.kind).toBe('transparent');
    expect(control[1].halfWidth).toBe(glass[1].halfWidth);
    expect(control[1].halfHeight).toBe(glass[1].halfHeight);
  });

  it('can remove receiver, emitter and add an occluder independently', () => {
    const fixture = createTransportFixture({
      name: 'glass-lens',
      receiver: false,
      emitterEnabled: false,
      occluder: true,
    });
    expect(fixture).toHaveLength(2);
    expect(fixture.some((candidate) => candidate.material.kind === 'glass'))
      .toBe(true);
    expect(fixture.some((candidate) => candidate.emissionStrength > 0))
      .toBe(false);
  });

  it('marks only diffuse non-emissive receiver texels', () => {
    const bounds = { minX: -8.8, minY: -8.8, maxX: 8.8, maxY: 8.8 };
    const fixture = createTransportFixture({ name: 'mirror-law' });
    const mask = createTransportReceiverMask(fixture, 64, 64, bounds);
    const marked = [...mask].filter((value) => value > 0);
    expect(marked.length).toBeGreaterThan(0);
    expect(marked.length).toBeLessThan(mask.length * 0.05);

    const withoutReceiver = createTransportFixture({
      name: 'mirror-law',
      receiver: false,
    });
    expect(createTransportReceiverMask(
      withoutReceiver,
      64,
      64,
      bounds,
    )).toEqual(new Float32Array(64 * 64));
  });
});

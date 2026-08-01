import { describe, expect, it } from 'vitest';
import { RadianceComposition } from './radiance-composition';

describe('composición manual de Radiance', () => {
  it('construye el eclipse con un disco emisor y el anillo por delante', () => {
    const composition = new RadianceComposition();
    const bodies = composition.update(0);

    expect(composition.stats).toMatchObject({
      form: 'Eclipse',
      focus: 'Sol',
      emitterCount: 1,
    });
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toMatchObject({ sides: 32, innerRadius: 0 });
    expect(bodies.at(-1)).toMatchObject({
      sides: 32,
      innerRadius: 0.68,
      emissionStrength: 0,
    });
  });

  it('interpola la aparición de la luna en vez de mostrarla de golpe', () => {
    const composition = new RadianceComposition();
    composition.control('a');

    const start = composition.update(0);
    const middle = composition.update(1.2);
    const end = composition.update(1.2);

    expect(start).toHaveLength(2);
    expect(middle).toHaveLength(3);
    expect(middle[1].absorption).toBeGreaterThan(0);
    expect(middle[1].absorption).toBeLessThan(9);
    expect(end[1].absorption).toBe(9);
  });

  it('hace la escala progresiva durante cuatro segundos', () => {
    const composition = new RadianceComposition();
    const initial = composition.stats.scale;
    composition.control('s');

    expect(composition.stats.scale).toBe(initial);
    expect(composition.stats.scaleTarget).toBe(1.18);
    composition.update(2);
    expect(composition.stats.scale).toBeGreaterThan(initial);
    expect(composition.stats.scale).toBeLessThan(1.18);
    composition.update(2);
    expect(composition.stats.scale).toBeCloseTo(1.18, 6);
  });

  it('mantiene uno o dos focos incluso durante todos los relevos', () => {
    const composition = new RadianceComposition();
    composition.control('a');
    composition.update(2.4);
    const observed = new Set<number>([composition.stats.emitterCount]);

    for (let focus = 0; focus < 12; focus += 1) {
      composition.control('f');
      for (let sample = 0; sample < 20; sample += 1) {
        composition.update(0.1);
        const count = composition.stats.emitterCount;
        observed.add(count);
        expect(count).toBeGreaterThanOrEqual(1);
        expect(count).toBeLessThanOrEqual(2);
      }
    }

    expect(observed).toEqual(new Set([1, 2]));
  });

  it('serializa relevos incompatibles cuando el intérprete pulsa muy rápido', () => {
    const composition = new RadianceComposition();
    composition.control('a');
    composition.update(2.4);

    for (let frame = 0; frame < 180; frame += 1) {
      if (frame % 7 === 0) composition.control('f');
      if (frame % 19 === 0) composition.control('f');
      if (frame % 41 === 0) composition.control('a');
      const bodies = composition.update(0.05);
      const physicalEmitters = bodies.filter((body) => body.emissionStrength > 0);
      expect(physicalEmitters.length).toBeGreaterThanOrEqual(1);
      expect(physicalEmitters.length).toBeLessThanOrEqual(2);
      expect(composition.stats.emitterCount).toBeGreaterThanOrEqual(1);
      expect(composition.stats.emitterCount).toBeLessThanOrEqual(2);
    }
  });

  it('mueve la geometría y mezcla la gama dentro del dominio HRC', () => {
    const composition = new RadianceComposition();
    const initialBodies = composition.update(0);
    const initialSolar = initialBodies[0];
    composition.control('d');
    composition.control('g');
    const middleBodies = composition.update(2.5);
    const middleSolar = middleBodies[0];

    expect(middleSolar.x).not.toBe(initialSolar.x);
    expect(middleSolar.x).not.toBe(-0.7);
    expect(middleSolar.emission[0]).toBeGreaterThan(0.015);
    expect(middleSolar.emission[0]).toBeLessThan(1);
    for (const body of middleBodies) {
      expect(Math.abs(body.x) + body.halfWidth).toBeLessThan(8.8);
      expect(Math.abs(body.y) + body.halfHeight).toBeLessThan(8.8);
    }
  });
});

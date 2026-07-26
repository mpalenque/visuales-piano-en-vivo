import { describe, expect, it } from 'vitest';
import type { DetectedNote } from '../types';
import {
  MAX_VORONOI_CELLS,
  MIN_VORONOI_CELLS,
  UPPER_PIANO_HALF_START,
  VORONOI_SETTLE_SECONDS,
  VoronoiField,
} from './voronoi-field';

const note = (midi: number, strength = 0.8): DetectedNote => ({
  midi,
  frequency: 440 * 2 ** ((midi - 69) / 12),
  strength,
});

describe('VoronoiField', () => {
  it('divide las 88 teclas en dos mitades exactas', () => {
    expect(UPPER_PIANO_HALF_START - 21).toBe(44);
    expect(108 - UPPER_PIANO_HALF_START + 1).toBe(44);
  });

  it('suma con notas agudas y resta con notas graves sin cruzar sus límites', () => {
    const field = new VoronoiField();
    expect(field.count).toBe(MIN_VORONOI_CELLS);
    expect(field.applyImpulse(note(UPPER_PIANO_HALF_START))).toBe('added');
    expect(field.count).toBe(MIN_VORONOI_CELLS + 1);
    expect(field.applyImpulse(note(UPPER_PIANO_HALF_START - 1))).toBe('removed');
    expect(field.count).toBe(MIN_VORONOI_CELLS);
    expect(field.applyImpulse(note(21))).toBe('minimum');

    for (let index = field.count; index < MAX_VORONOI_CELLS; index += 1) field.applyImpulse(note(108));
    expect(field.count).toBe(MAX_VORONOI_CELLS);
    expect(field.applyImpulse(note(108))).toBe('maximum');
  });

  it('mueve una división durante dos segundos y después la deja fija', () => {
    const field = new VoronoiField();
    field.applyImpulse(note(84));
    const initial = field.snapshot().at(-1)!;
    expect(initial.settled).toBe(false);

    field.update(VORONOI_SETTLE_SECONDS / 2);
    const moving = field.snapshot().at(-1)!;
    expect(moving.settled).toBe(false);
    expect([moving.x, moving.y]).not.toEqual([initial.x, initial.y]);

    field.update(VORONOI_SETTLE_SECONDS / 2);
    const settled = field.snapshot().at(-1)!;
    expect(settled.settled).toBe(true);
    expect(settled.offsetX).toBe(0);
    expect(settled.offsetY).toBe(0);

    field.update(5);
    expect(field.snapshot().at(-1)).toEqual(settled);
  });
});

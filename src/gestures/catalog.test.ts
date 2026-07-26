import { describe, expect, it } from 'vitest';
import type { FeatureFrame } from '../types';
import { createAcumuladorClimax } from './catalog/acumulador-climax';
import { createCatalog } from './catalog';
import { createColorArmonico } from './catalog/color-armonico';
import { createDensidad } from './catalog/densidad';
import { createFaderCarga } from './catalog/fader-carga';
import { createTexturaBrillo } from './catalog/textura-brillo';

const frame = (overrides: Partial<FeatureFrame> = {}): FeatureFrame => ({
  t: 0,
  rms: 0,
  bands: { low: 0, mid: 0, high: 0 },
  onset: false,
  onsetStrength: 0,
  chroma: new Float32Array(12),
  centroid: 0,
  flux: 0,
  noteAttacks: [],
  ...overrides,
});

describe('catálogo de gestos', () => {
  it('expone exactamente los seis gestos de la configuración', () => {
    expect([...createCatalog().keys()]).toEqual([
      'fader-carga', 'contador-pulsos', 'acumulador-climax', 'densidad', 'color-armonico', 'textura-brillo',
    ]);
  });

  it('el fader vuelve a cargar tras completar su descarga', () => {
    const gesture = createFaderCarga({ velLlenado: 10, fuga: 0, umbralEstallido: 0.25, velDescarga: 10 });
    let state = gesture.init(gesture.params);
    state = gesture.update(state, frame({ onsetStrength: 1 }), 0.05);
    expect(gesture.read(state).events).toHaveLength(1);
    gesture.clearEvents?.(state);
    state = gesture.update(state, frame(), 1);
    expect(gesture.read(state).value).toBe(0);
    state = gesture.update(state, frame({ onsetStrength: 1 }), 0.05);
    expect(gesture.read(state).events).toHaveLength(1);
  });

  it('densidad expira ataques que quedan fuera de su ventana', () => {
    const gesture = createDensidad({ ventanaSeg: 0.2, maxOnsets: 2, suavizado: 30 });
    let state = gesture.init(gesture.params);
    state = gesture.update(state, frame({ t: 0, onset: true }), 0.1);
    state = gesture.update(state, frame({ t: 0.1, onset: true }), 0.1);
    expect(gesture.read(state).value).toBeGreaterThan(0.8);
    state = gesture.update(state, frame({ t: 1 }), 0.2);
    expect(gesture.read(state).value).toBeLessThan(0.01);
  });

  it('color armónico sigue una clase dominante sin salir de 0–1', () => {
    const gesture = createColorArmonico({ histeresis: 0.05, suavizado: 30 });
    let state = gesture.init(gesture.params);
    const highClass = new Float32Array(12);
    highClass[9] = 1;
    state = gesture.update(state, frame({ chroma: highClass }), 0.3);
    expect(gesture.read(state).value).toBeGreaterThan(0.75);
    const lowerClass = new Float32Array(12);
    lowerClass[2] = 1;
    state = gesture.update(state, frame({ chroma: lowerClass }), 0.3);
    expect(gesture.read(state).value).toBeGreaterThan(0.1);
    expect(gesture.read(state).value).toBeLessThan(0.3);
  });

  it('el acumulador dispara clímax y se reinicia', () => {
    const gesture = createAcumuladorClimax({ techo: 0.2, decayLento: 0 });
    const state = gesture.update(gesture.init(gesture.params), frame({ rms: 1 }), 0.2);
    expect(gesture.read(state)).toEqual({ value: 0, events: [{ type: 'climax', intensity: 1 }] });
    gesture.clearEvents?.(state);
    expect(gesture.read(state).events).toEqual([]);
  });

  it('textura combina centroid y flux normalizados', () => {
    const gesture = createTexturaBrillo({ suavizadoBrillo: 30, suavizadoAgitacion: 30 });
    const state = gesture.update(gesture.init(gesture.params), frame({ centroid: 1, flux: 1 }), 0.3);
    expect(gesture.read(state).value).toBeGreaterThan(0.99);
    expect(gesture.read(state).value).toBeLessThanOrEqual(1);
  });
});

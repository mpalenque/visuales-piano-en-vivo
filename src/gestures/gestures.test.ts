import { describe, expect, it } from 'vitest';
import type { FeatureFrame } from '../types';
import { SceneMachine } from '../control/scene-machine';
import { createCatalog } from './catalog';
import { createContadorPulsos } from './catalog/contador-pulsos';
import { createFaderCarga } from './catalog/fader-carga';
import { GestureEngine } from './engine';

const frame = (overrides: Partial<FeatureFrame> = {}): FeatureFrame => ({
  t: 1,
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

describe('gestos con estado', () => {
  it('el fader carga, emite un estallido y comienza la descarga', () => {
    const gesture = createFaderCarga({ velLlenado: 2, fuga: 0, umbralEstallido: 0.3, velDescarga: 2 });
    const state = gesture.update(gesture.init(gesture.params), frame({ onset: true, onsetStrength: 1 }), 0.2);
    const output = gesture.read(state);
    expect(output.value).toBeGreaterThanOrEqual(0.3);
    expect(output.events).toEqual([{ type: 'estalla', intensity: expect.any(Number) }]);
    gesture.clearEvents?.(state);
    const discharged = gesture.update(state, frame({ t: 1.2 }), 0.2);
    expect(gesture.read(discharged).value).toBeLessThan(output.value);
  });

  it('el contador de pulsos no confunde ataques consecutivos con un beat', () => {
    const gesture = createContadorPulsos({ n: 3, ventanaMax: 2 });
    let state = gesture.init(gesture.params);
    for (let index = 0; index < 2; index += 1) {
      state = gesture.update(state, frame({ t: index * 0.2, onset: true }), 0.02);
      gesture.clearEvents?.(state);
    }
    state = gesture.update(state, frame({ t: 0.4, onset: true }), 0.02);
    expect(gesture.read(state).events).toEqual([{ type: 'pulso', count: 3 }]);
  });

  it('avanza el reloj de decaimiento aunque falten frames de audio', () => {
    const engine = new GestureEngine(createCatalog());
    engine.setActive(['densidad']);
    engine.update([frame({ t: 1, onset: true })], 0.012);
    const decayed = engine.update([], 2);
    expect(decayed.densidad.value).toBeLessThan(0.001);
  });

  it('ignora frames congelados, limita dt y limpia outputs inactivos', () => {
    const engine = new GestureEngine(createCatalog());
    engine.setActive(['contador-pulsos', 'densidad', 'inexistente']);
    engine.setParams('contador-pulsos', { n: 2 });
    engine.update([frame({ t: 1, onset: true })], 1);
    engine.setFrozen('contador-pulsos', true);
    const frozen = engine.update([frame({ t: 50, onset: true })], 1);
    expect(frozen['contador-pulsos'].events).toEqual([]);
    expect(engine.isFrozen('contador-pulsos')).toBe(true);
    engine.setFrozen('contador-pulsos', false);
    expect(engine.update([frame({ t: 50.1, onset: true })], 1)['contador-pulsos'].events).toEqual([]);
    const pulsed = engine.update([frame({ t: 50.2, onset: true })], 1);
    expect(pulsed['contador-pulsos'].events).toEqual([{ type: 'pulso', count: 2 }]);
    expect(engine.getActiveIds()).toEqual(['contador-pulsos', 'densidad']);
    expect(engine.snapshotParams()['contador-pulsos'].n).toBe(2);
    engine.setActive(['densidad']);
    expect(Object.keys(engine.update([], 0.1))).toEqual(['densidad']);
    engine.reset();
    engine.clearFrozen();
    expect(engine.getFrozenIds()).toEqual([]);
  });
});

describe('mapeo de escenas', () => {
  it('aplica curvas a valores y enruta eventos al destino de la escena', () => {
    const machine = new SceneMachine();
    machine.setScene(2);
    const visual = machine.compose({
      'fader-carga': { value: 1, events: [{ type: 'estalla', intensity: 0.9 }] },
      densidad: { value: 0.5, events: [] },
      'textura-brillo': { value: 0.4, events: [] },
    });
    expect(visual.params.tension).toBe(1);
    expect(visual.events).toEqual([{ type: 'estalla', intensity: 0.9, target: 'explosion' }]);
  });

  it('respeta corte y crossfade con progreso determinista', () => {
    const machine = new SceneMachine();
    machine.setScene(3, 10);
    const start = machine.compose({}, 10);
    expect(start.transition).toEqual({ type: 'crossfade', duration: 1.2, fromScene: 1, progress: 0 });

    const middle = machine.compose({}, 10.6);
    expect(middle.transition.progress).toBeCloseTo(0.5);
    expect(middle.transition.fromScene).toBe(1);

    const end = machine.compose({}, 11.2);
    expect(end.transition).toEqual({ type: 'crossfade', duration: 1.2, fromScene: null, progress: 1 });

    machine.setScene(2, 12);
    expect(machine.compose({}, 12).transition).toEqual({ type: 'corte', duration: 0, fromScene: null, progress: 1 });
  });

  it('limpia overrides, fuerza eventos y aplica curvas y wires de forma segura', () => {
    const machine = new SceneMachine();
    const startingRevision = machine.getRevision();
    machine.setOverride('tension', 0.91);
    machine.setBlackout(true);
    machine.forceEvent('pulso');
    const first = machine.compose({ 'fader-carga': { value: 0.25, events: [] } }, 1);
    expect(first.params.tension).toBe(0.91);
    expect(first.blackout).toBe(true);
    expect(first.events).toEqual([{ type: 'pulso', count: 1 }]);
    expect(machine.compose({}, 1.1).events).toEqual([]);

    machine.setWire(0, { curve: 'exp', min: 0, max: 1 });
    machine.setOverride('tension', null);
    expect(machine.compose({ 'fader-carga': { value: 0.5, events: [] } }, 1.2).params.tension).toBeCloseTo(0.25);
    machine.setWire(99, { target: 'hue' });
    machine.setScene(2, 2);
    expect(machine.getOverrides()).toEqual({});
    expect(machine.isBlackout()).toBe(true);
    expect(machine.getRevision()).toBeGreaterThan(startingRevision);
  });

  it('reemplaza el show de forma atómica y devuelve copias no mutables de su configuración', () => {
    const machine = new SceneMachine();
    const config = machine.showConfig;
    config.scenes[0].nombre = 'Cambio importado';
    machine.replaceConfig(config, 3);
    expect(machine.scene.nombre).toBe('Cambio importado');
    const exported = machine.showConfig;
    exported.scenes[0].nombre = 'No debe filtrar';
    expect(machine.scene.nombre).toBe('Cambio importado');
    expect(machine.scenes).toHaveLength(6);
  });
});

import { describe, expect, it } from 'vitest';
import { SceneMachine } from './scene-machine';
import { createDefaultShowConfig, migrateLegacyConfig, parseShowConfig } from './show-config';

describe('configuración del show', () => {
  it('normaliza los presets completos de cada gesto activo', () => {
    const config = parseShowConfig(createDefaultShowConfig());
    expect(config.scenes).toHaveLength(6);
    expect(config.scenes[0].presets['textura-brillo']).toEqual({ suavizadoBrillo: 2.5, suavizadoAgitacion: 5 });
  });

  it('rechaza una configuración con escenas incompletas o wires incompatibles', () => {
    const tooFewScenes = createDefaultShowConfig();
    tooFewScenes.scenes.pop();
    expect(() => parseShowConfig(tooFewScenes)).toThrow('exactamente seis escenas');

    const invalidWire = createDefaultShowConfig();
    invalidWire.scenes[0].wires[0].target = 'explosion';
    expect(() => parseShowConfig(invalidWire)).toThrow('no es compatible');
  });

  it('rechaza valores numéricos no finitos y parámetros desconocidos', () => {
    const invalidNumber = createDefaultShowConfig();
    invalidNumber.scenes[0].baseParams.hue = Number.NaN;
    expect(() => parseShowConfig(invalidNumber)).toThrow('baseParams.hue');

    const invalidParam = createDefaultShowConfig() as unknown as { scenes: Array<{ presets: Record<string, Record<string, number>> }> };
    invalidParam.scenes[0].presets['fader-carga'].intruso = 1;
    expect(() => parseShowConfig(invalidParam)).toThrow('intruso no existe');
  });

  it('migra el formato heredado conservando parámetros globales conocidos', () => {
    const defaults = createDefaultShowConfig();
    const migrated = migrateLegacyConfig({ scenes: defaults.scenes, params: { 'fader-carga': { fuga: 0.47 } } });
    expect(migrated.version).toBe(2);
    expect(migrated.scenes.filter((scene) => scene.gestosActivos.includes('fader-carga')).every((scene) => scene.presets['fader-carga'].fuga === 0.47)).toBe(true);
  });

  it('guarda parámetros de forma independiente para cada escena', () => {
    const machine = new SceneMachine(createDefaultShowConfig());
    machine.setGestureParams('fader-carga', { fuga: 0.31 });
    machine.setScene(2);
    machine.setGestureParams('fader-carga', { fuga: 0.09 });
    machine.setScene(1);
    expect(machine.scene.presets['fader-carga'].fuga).toBe(0.31);
    machine.setScene(2);
    expect(machine.scene.presets['fader-carga'].fuga).toBe(0.09);
  });
});

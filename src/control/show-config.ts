import type { Curve, Scene, ShowConfig, Wire } from '../types';
import { createDefaultScenes } from './scenes';

export const SHOW_CONFIG_STORAGE_KEY = 'piano-visuales-show-config-v2';
export const LEGACY_SCENES_STORAGE_KEY = 'piano-visuales-scenes';
export const LEGACY_PARAMS_STORAGE_KEY = 'piano-visuales-params';

export const gestureParamDefinitions = {
  'fader-carga': {
    velLlenado: { min: 0.01, max: 12, step: 0.01, defaultValue: 1.35 },
    fuga: { min: 0, max: 5, step: 0.01, defaultValue: 0.13 },
    umbralEstallido: { min: 0.01, max: 1, step: 0.01, defaultValue: 0.82 },
    velDescarga: { min: 0.01, max: 12, step: 0.01, defaultValue: 2.6 },
  },
  densidad: {
    ventanaSeg: { min: 0.1, max: 8, step: 0.01, defaultValue: 1.5 },
    maxOnsets: { min: 1, max: 32, step: 1, defaultValue: 9 },
    suavizado: { min: 0.01, max: 12, step: 0.01, defaultValue: 5 },
  },
  'contador-pulsos': {
    n: { min: 1, max: 16, step: 1, defaultValue: 4 },
    ventanaMax: { min: 0.1, max: 8, step: 0.01, defaultValue: 2.5 },
  },
  'color-armonico': {
    histeresis: { min: 0, max: 1, step: 0.01, defaultValue: 0.08 },
    suavizado: { min: 0.01, max: 12, step: 0.01, defaultValue: 1.4 },
  },
  'acumulador-climax': {
    techo: { min: 0.1, max: 30, step: 0.01, defaultValue: 16 },
    decayLento: { min: 0, max: 1, step: 0.001, defaultValue: 0.018 },
  },
  'textura-brillo': {
    suavizadoBrillo: { min: 0.01, max: 12, step: 0.01, defaultValue: 2.5 },
    suavizadoAgitacion: { min: 0.01, max: 12, step: 0.01, defaultValue: 5 },
  },
} as const;

export type GestureId = keyof typeof gestureParamDefinitions;
export type GestureParamKey<G extends GestureId = GestureId> = keyof (typeof gestureParamDefinitions)[G] & string;

export const visualParameterTargets = [
  'tension',
  'density',
  'hue',
  'brightness',
  'turbulence',
  'zoom',
  'grain',
  'saturation',
  'radiance',
  'beat',
] as const;
export const visualEventTargets = ['explosion', 'pulse', 'climax', 'finale'] as const;

const curves: readonly Curve[] = ['linear', 'exp', 'log', 'sCurve'];
const eventOutputs = ['estalla', 'climax', 'pulso'] as const;

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function expectRecord(value: unknown, path: string): UnknownRecord {
  if (!isRecord(value)) throw new Error(`${path} debe ser un objeto.`);
  return value;
}

function expectString(value: unknown, path: string, maxLength: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) throw new Error(`${path} no es un texto válido.`);
  return value;
}

function expectInteger(value: unknown, path: string, min: number, max: number): number {
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) throw new Error(`${path} debe ser un entero entre ${min} y ${max}.`);
  return value as number;
}

function expectNumber(value: unknown, path: string, min: number, max: number): number {
  if (!isFiniteNumber(value) || value < min || value > max) throw new Error(`${path} debe ser un número entre ${min} y ${max}.`);
  return value;
}

function isGestureId(value: string): value is GestureId {
  return value in gestureParamDefinitions;
}

export function createDefaultShowConfig(): ShowConfig {
  return { version: 2, scenes: createDefaultScenes().map(normalizeDefaultScene) };
}

function normalizeDefaultScene(scene: Scene): Scene {
  const presets: Record<string, Record<string, number>> = {};
  for (const gestureId of scene.gestosActivos) {
    presets[gestureId] = normalizeParams(gestureId as GestureId, scene.presets[gestureId] ?? {}, `default.${gestureId}`);
  }
  return { ...scene, presets };
}

export function getGestureParamDefinition(gestureId: GestureId, key: string): { min: number; max: number; step: number; defaultValue: number } {
  const definition = gestureParamDefinitions[gestureId][key as GestureParamKey<typeof gestureId>];
  if (!definition) throw new Error(`Parámetro desconocido: ${gestureId}.${key}`);
  return definition;
}

function normalizeParams(gestureId: GestureId, value: unknown, path: string): Record<string, number> {
  const source = value === undefined ? {} : expectRecord(value, path);
  const definition = gestureParamDefinitions[gestureId] as Record<string, { min: number; max: number; defaultValue: number }>;
  for (const key of Object.keys(source)) {
    if (!(key in definition)) throw new Error(`${path}.${key} no existe.`);
  }
  return Object.fromEntries(Object.entries(definition).map(([key, metadata]) => [
    key,
    source[key] === undefined ? metadata.defaultValue : expectNumber(source[key], `${path}.${key}`, metadata.min, metadata.max),
  ]));
}

function normalizeWire(value: unknown, path: string): Wire {
  const source = expectRecord(value, path);
  const gestureId = expectString(source.gestureId, `${path}.gestureId`, 64);
  if (!isGestureId(gestureId)) throw new Error(`${path}.gestureId no existe.`);
  const output = expectString(source.output, `${path}.output`, 32);
  const isValue = output === 'value';
  if (!isValue && !eventOutputs.includes(output as (typeof eventOutputs)[number])) throw new Error(`${path}.output no existe.`);
  const target = expectString(source.target, `${path}.target`, 32);
  const allowedTargets = isValue ? visualParameterTargets : visualEventTargets;
  if (!allowedTargets.includes(target as never)) throw new Error(`${path}.target no es compatible con ${output}.`);
  const curve = source.curve === undefined ? undefined : expectString(source.curve, `${path}.curve`, 16) as Curve;
  if (curve && !curves.includes(curve)) throw new Error(`${path}.curve no existe.`);
  const min = source.min === undefined ? undefined : expectNumber(source.min, `${path}.min`, -10000, 10000);
  const max = source.max === undefined ? undefined : expectNumber(source.max, `${path}.max`, -10000, 10000);
  if (min !== undefined && max !== undefined && min > max) throw new Error(`${path}.min no puede superar max.`);
  return { gestureId, output: output as Wire['output'], target, curve, min, max };
}

function normalizeScene(value: unknown, index: number): Scene {
  const path = `scenes[${index}]`;
  const source = expectRecord(value, path);
  const id = expectInteger(source.id, `${path}.id`, 1, 10);
  const nombre = expectString(source.nombre, `${path}.nombre`, 80);
  const notes = expectString(source.notes, `${path}.notes`, 500);
  const visualScene = expectInteger(source.visualScene, `${path}.visualScene`, 1, 10);
  if (
    !Array.isArray(source.gestosActivos)
    || source.gestosActivos.length > 6
    || (id !== 10 && source.gestosActivos.length < 1)
  ) throw new Error(`${path}.gestosActivos no es válido.`);
  const gestosActivos = source.gestosActivos.map((gesture, gestureIndex) => {
    const idValue = expectString(gesture, `${path}.gestosActivos[${gestureIndex}]`, 64);
    if (!isGestureId(idValue)) throw new Error(`${path}.gestosActivos[${gestureIndex}] no existe.`);
    return idValue;
  });
  if (new Set(gestosActivos).size !== gestosActivos.length) throw new Error(`${path}.gestosActivos contiene duplicados.`);
  const sourcePresets = expectRecord(source.presets, `${path}.presets`);
  for (const gestureId of Object.keys(sourcePresets)) {
    if (!gestosActivos.includes(gestureId as GestureId)) throw new Error(`${path}.presets.${gestureId} no está activo.`);
  }
  const presets = Object.fromEntries(gestosActivos.map((gestureId) => [gestureId, normalizeParams(gestureId as GestureId, sourcePresets[gestureId], `${path}.presets.${gestureId}`)]));
  if (!Array.isArray(source.wires) || source.wires.length > 16) throw new Error(`${path}.wires no es válido.`);
  const wires = source.wires.map((wire, wireIndex) => normalizeWire(wire, `${path}.wires[${wireIndex}]`));
  if (wires.some((wire) => !gestosActivos.includes(wire.gestureId as GestureId))) throw new Error(`${path}.wires referencia un gesto inactivo.`);
  const transition = expectRecord(source.transicionEntrada, `${path}.transicionEntrada`);
  const tipo = expectString(transition.tipo, `${path}.transicionEntrada.tipo`, 16);
  if (tipo !== 'corte' && tipo !== 'crossfade') throw new Error(`${path}.transicionEntrada.tipo no existe.`);
  const seg = expectNumber(transition.seg, `${path}.transicionEntrada.seg`, 0, 10);
  if (tipo === 'crossfade' && seg === 0) throw new Error(`${path}.transicionEntrada.seg debe ser mayor a cero.`);
  const baseSource = expectRecord(source.baseParams, `${path}.baseParams`);
  for (const key of Object.keys(baseSource)) {
    if (!visualParameterTargets.includes(key as never)) throw new Error(`${path}.baseParams.${key} no existe.`);
  }
  const baseParams = Object.fromEntries(visualParameterTargets.map((target) => [
    target,
    expectNumber(
      baseSource[target] ?? (
        target === 'radiance' || target === 'beat' ? 0 : undefined
      ),
      `${path}.baseParams.${target}`,
      0,
      target === 'hue' ? 360 : target === 'zoom' ? 3 : 1,
    ),
  ]));
  return { id, nombre, visualScene, gestosActivos, presets, wires, transicionEntrada: { tipo, seg }, baseParams, notes };
}

export function parseShowConfig(value: unknown): ShowConfig {
  const source = expectRecord(value, 'configuración');
  if (source.version !== 2) throw new Error('La versión del preset no es compatible.');
  if (!Array.isArray(source.scenes) || source.scenes.length < 6 || source.scenes.length > 10) {
    throw new Error('El preset debe contener entre seis y diez escenas.');
  }
  // Los shows guardados antes de las escenas 7, 8, 9 y 10 siguen siendo válidos:
  // se añaden únicamente las escenas nuevas sin tocar las ya configuradas.
  const sourceScenes = [...source.scenes];
  for (const defaultScene of createDefaultScenes()) {
    const alreadyPresent = sourceScenes.some((scene) => isRecord(scene) && scene.id === defaultScene.id);
    if (!alreadyPresent) sourceScenes.push(defaultScene);
  }
  const scenes = sourceScenes.map(normalizeScene);
  const ids = scenes.map((scene) => scene.id);
  if (new Set(ids).size !== 10 || ![1, 2, 3, 4, 5, 6, 7, 8, 9, 10].every((id) => ids.includes(id))) {
    throw new Error('Los ids de escena deben ser únicos y cubrir 1–10.');
  }
  return { version: 2, scenes };
}

export function migrateLegacyConfig(value: unknown, legacyParams: unknown = {}): ShowConfig {
  const source = Array.isArray(value) ? { scenes: value } : expectRecord(value, 'preset heredado');
  if (!Array.isArray(source.scenes)) throw new Error('El preset heredado no contiene escenas.');
  const params = isRecord(source.params) ? source.params : isRecord(legacyParams) ? legacyParams : {};
  const migratedScenes = source.scenes.map((scene) => {
    const candidate = expectRecord(scene, 'escena heredada');
    const active = Array.isArray(candidate.gestosActivos) ? candidate.gestosActivos : [];
    const presets = isRecord(candidate.presets) ? { ...candidate.presets } : {};
    for (const gestureId of active) {
      if (typeof gestureId === 'string' && isGestureId(gestureId) && isRecord(params[gestureId])) {
        presets[gestureId] = { ...(isRecord(presets[gestureId]) ? presets[gestureId] : {}), ...params[gestureId] };
      }
    }
    return { ...candidate, presets };
  });
  return parseShowConfig({ version: 2, scenes: migratedScenes });
}

export function saveShowConfig(storage: Storage, config: ShowConfig): void {
  storage.setItem(SHOW_CONFIG_STORAGE_KEY, JSON.stringify(config));
}

export function loadShowConfig(storage: Storage): { config: ShowConfig; migrated: boolean; warning: string | null } {
  const saved = storage.getItem(SHOW_CONFIG_STORAGE_KEY);
  try {
    if (saved) return { config: parseShowConfig(JSON.parse(saved)), migrated: false, warning: null };
    const legacyScenes = storage.getItem(LEGACY_SCENES_STORAGE_KEY);
    if (legacyScenes) {
      const legacyParams = storage.getItem(LEGACY_PARAMS_STORAGE_KEY);
      const config = migrateLegacyConfig(JSON.parse(legacyScenes), legacyParams ? JSON.parse(legacyParams) : {});
      saveShowConfig(storage, config);
      return { config, migrated: true, warning: null };
    }
  } catch (error) {
    return { config: createDefaultShowConfig(), migrated: false, warning: error instanceof Error ? `Se ignoró un preset local inválido: ${error.message}` : 'Se ignoró un preset local inválido.' };
  }
  return { config: createDefaultShowConfig(), migrated: false, warning: null };
}

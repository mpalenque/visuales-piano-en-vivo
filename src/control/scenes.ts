import type { Scene } from '../types';

const sharedBase = {
  tension: 0.08,
  density: 0.16,
  hue: 210,
  brightness: 0.35,
  turbulence: 0.12,
  zoom: 1,
  grain: 0.08,
  saturation: 0.7,
};

const defaultScenes: Scene[] = [
  {
    id: 1,
    nombre: 'Umbral',
    visualScene: 1,
    gestosActivos: ['fader-carga', 'densidad', 'textura-brillo'],
    presets: {
      'fader-carga': { velLlenado: 0.9, fuga: 0.22, umbralEstallido: 0.92, velDescarga: 1.8 },
      densidad: { ventanaSeg: 2, maxOnsets: 8, suavizado: 3 },
    },
    wires: [
      { gestureId: 'fader-carga', output: 'value', target: 'tension', curve: 'sCurve', min: 0.08, max: 0.58 },
      { gestureId: 'densidad', output: 'value', target: 'density', curve: 'linear', min: 0.08, max: 0.52 },
      { gestureId: 'textura-brillo', output: 'value', target: 'brightness', curve: 'log', min: 0.16, max: 0.58 },
    ],
    transicionEntrada: { tipo: 'crossfade', seg: 1.5 },
    baseParams: { ...sharedBase, hue: 224, density: 0.12 },
    notes: 'Partículas mínimas que despiertan con el primer gesto.',
  },
  {
    id: 2,
    nombre: 'Pólvora',
    visualScene: 2,
    gestosActivos: ['fader-carga', 'densidad', 'textura-brillo'],
    presets: {
      'fader-carga': { velLlenado: 1.8, fuga: 0.08, umbralEstallido: 0.72, velDescarga: 3.7 },
      densidad: { ventanaSeg: 1.1, maxOnsets: 7, suavizado: 7 },
    },
    wires: [
      { gestureId: 'fader-carga', output: 'value', target: 'tension', curve: 'exp', min: 0.15, max: 1 },
      { gestureId: 'fader-carga', output: 'estalla', target: 'explosion' },
      { gestureId: 'densidad', output: 'value', target: 'density', curve: 'sCurve', min: 0.2, max: 1 },
      { gestureId: 'textura-brillo', output: 'value', target: 'turbulence', curve: 'linear', min: 0.1, max: 0.9 },
    ],
    transicionEntrada: { tipo: 'corte', seg: 0 },
    baseParams: { ...sharedBase, hue: 8, brightness: 0.56, saturation: 0.92 },
    notes: 'Campo de partículas que se comprime y revienta.',
  },
  {
    id: 3,
    nombre: 'Constelación',
    visualScene: 3,
    gestosActivos: ['contador-pulsos', 'densidad', 'color-armonico'],
    presets: {
      'contador-pulsos': { n: 4, ventanaMax: 2.8 },
      densidad: { ventanaSeg: 1.7, maxOnsets: 10, suavizado: 3.5 },
    },
    wires: [
      { gestureId: 'contador-pulsos', output: 'value', target: 'brightness', curve: 'exp', min: 0.23, max: 0.95 },
      { gestureId: 'contador-pulsos', output: 'pulso', target: 'pulse' },
      { gestureId: 'densidad', output: 'value', target: 'density', curve: 'linear', min: 0.12, max: 0.72 },
      { gestureId: 'color-armonico', output: 'value', target: 'hue', curve: 'linear', min: 180, max: 310 },
    ],
    transicionEntrada: { tipo: 'crossfade', seg: 1.2 },
    baseParams: { ...sharedBase, hue: 272, grain: 0.18 },
    notes: 'Pulsos rítmicos en una red de estrellas suspendidas.',
  },
  {
    id: 4,
    nombre: 'Abismo',
    visualScene: 4,
    gestosActivos: ['acumulador-climax', 'fader-carga', 'textura-brillo'],
    presets: {
      'acumulador-climax': { techo: 8, decayLento: 0.012 },
      'fader-carga': { velLlenado: 0.72, fuga: 0.05, umbralEstallido: 0.96, velDescarga: 1.3 },
    },
    wires: [
      { gestureId: 'acumulador-climax', output: 'value', target: 'zoom', curve: 'sCurve', min: 0.85, max: 1.85 },
      { gestureId: 'acumulador-climax', output: 'climax', target: 'climax' },
      { gestureId: 'fader-carga', output: 'value', target: 'tension', curve: 'log', min: 0.1, max: 0.76 },
      { gestureId: 'textura-brillo', output: 'value', target: 'grain', curve: 'sCurve', min: 0.04, max: 0.6 },
    ],
    transicionEntrada: { tipo: 'crossfade', seg: 2 },
    baseParams: { ...sharedBase, hue: 258, brightness: 0.22, density: 0.3 },
    notes: 'Descenso lento, denso y cada vez más inevitable.',
  },
  {
    id: 5,
    nombre: 'Marea armónica',
    visualScene: 5,
    gestosActivos: ['color-armonico', 'fader-carga', 'textura-brillo'],
    presets: {
      'fader-carga': { velLlenado: 0.42, fuga: 0.18, umbralEstallido: 0.98, velDescarga: 0.9 },
      'color-armonico': { histeresis: 0.12, suavizado: 0.55 },
    },
    wires: [
      { gestureId: 'color-armonico', output: 'value', target: 'hue', curve: 'linear', min: 196, max: 326 },
      { gestureId: 'fader-carga', output: 'value', target: 'brightness', curve: 'log', min: 0.18, max: 0.82 },
      { gestureId: 'textura-brillo', output: 'value', target: 'turbulence', curve: 'sCurve', min: 0.02, max: 0.38 },
      { gestureId: 'textura-brillo', output: 'value', target: 'grain', curve: 'sCurve', min: 0.02, max: 0.32 },
    ],
    transicionEntrada: { tipo: 'crossfade', seg: 3 },
    baseParams: { ...sharedBase, hue: 232, density: 0.48, brightness: 0.42 },
    notes: 'Campos de color que respiran, sin ataques bruscos.',
  },
  {
    id: 6,
    nombre: 'Coda luminosa',
    visualScene: 6,
    gestosActivos: ['fader-carga', 'contador-pulsos', 'acumulador-climax', 'color-armonico'],
    presets: {
      'fader-carga': { velLlenado: 1.05, fuga: 0.08, umbralEstallido: 0.78, velDescarga: 2.1 },
      'contador-pulsos': { n: 3, ventanaMax: 3.5 },
      'acumulador-climax': { techo: 10, decayLento: 0.008 },
    },
    wires: [
      { gestureId: 'fader-carga', output: 'value', target: 'tension', curve: 'exp', min: 0.2, max: 1 },
      { gestureId: 'fader-carga', output: 'estalla', target: 'finale' },
      { gestureId: 'contador-pulsos', output: 'pulso', target: 'pulse' },
      { gestureId: 'acumulador-climax', output: 'value', target: 'brightness', curve: 'sCurve', min: 0.35, max: 1 },
      { gestureId: 'acumulador-climax', output: 'climax', target: 'finale' },
      { gestureId: 'color-armonico', output: 'value', target: 'hue', curve: 'linear', min: 28, max: 62 },
    ],
    transicionEntrada: { tipo: 'crossfade', seg: 1 },
    baseParams: { ...sharedBase, hue: 44, density: 0.82, brightness: 0.62, saturation: 0.95 },
    notes: 'Acumulación final cálida; cada evento abre más el campo.',
  },
];

/** A fresh mutable copy is created for every visual host. */
export function createDefaultScenes(): Scene[] {
  return structuredClone(defaultScenes);
}

export function sceneById(scenes: readonly Scene[], id: number): Scene {
  const scene = scenes.find((candidate) => candidate.id === id);
  if (!scene) throw new Error(`No existe la escena ${id}.`);
  return scene;
}

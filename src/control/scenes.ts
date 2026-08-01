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
  radiance: 0,
  beat: 0,
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
    nombre: 'Laboratorio óptico',
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
    notes: 'Escena fija para verificar emisor, difuso, espejo, metal, vidrio, Fresnel y caústicas.',
  },
  {
    id: 7,
    nombre: 'Óptica cinética',
    visualScene: 7,
    gestosActivos: ['fader-carga', 'densidad', 'contador-pulsos', 'color-armonico'],
    presets: {
      'fader-carga': { velLlenado: 0.86, fuga: 0.11, umbralEstallido: 0.8, velDescarga: 1.8 },
      densidad: { ventanaSeg: 1.35, maxOnsets: 10, suavizado: 4.2 },
      'contador-pulsos': { n: 3, ventanaMax: 3.2 },
      'color-armonico': { histeresis: 0.1, suavizado: 0.8 },
    },
    wires: [
      { gestureId: 'fader-carga', output: 'value', target: 'tension', curve: 'sCurve', min: 0.16, max: 1 },
      { gestureId: 'densidad', output: 'value', target: 'density', curve: 'linear', min: 0.24, max: 1 },
      { gestureId: 'contador-pulsos', output: 'pulso', target: 'pulse' },
      { gestureId: 'color-armonico', output: 'value', target: 'hue', curve: 'linear', min: 184, max: 322 },
    ],
    transicionEntrada: { tipo: 'crossfade', seg: 0.8 },
    baseParams: { ...sharedBase, hue: 202, density: 0.64, brightness: 0.72, saturation: 0.9, grain: 0.02 },
    notes: 'Cuerpos Box2D vivos: emisores, espejos, metal y vidrio con reflexión/refracción directa sin acumulación ruidosa.',
  },
  {
    id: 8,
    nombre: 'Materia viscoelástica',
    visualScene: 8,
    gestosActivos: ['fader-carga', 'densidad', 'textura-brillo', 'color-armonico'],
    presets: {
      'fader-carga': { velLlenado: 0.92, fuga: 0.1, umbralEstallido: 0.82, velDescarga: 1.9 },
      densidad: { ventanaSeg: 1.5, maxOnsets: 11, suavizado: 4.2 },
      'textura-brillo': { suavizadoBrillo: 2.4, suavizadoAgitacion: 4.6 },
      'color-armonico': { histeresis: 0.1, suavizado: 0.72 },
    },
    wires: [
      { gestureId: 'fader-carga', output: 'value', target: 'tension', curve: 'sCurve', min: 0.12, max: 0.92 },
      { gestureId: 'fader-carga', output: 'estalla', target: 'explosion' },
      { gestureId: 'densidad', output: 'value', target: 'density', curve: 'sCurve', min: 0.28, max: 0.95 },
      { gestureId: 'textura-brillo', output: 'value', target: 'turbulence', curve: 'linear', min: 0.08, max: 0.85 },
      { gestureId: 'textura-brillo', output: 'value', target: 'brightness', curve: 'log', min: 0.35, max: 0.95 },
      { gestureId: 'color-armonico', output: 'value', target: 'hue', curve: 'linear', min: 165, max: 310 },
    ],
    transicionEntrada: { tipo: 'crossfade', seg: 0.9 },
    baseParams: { ...sharedBase, hue: 192, density: 0.62, tension: 0.42, turbulence: 0.24, brightness: 0.64, saturation: 0.9, grain: 0.01 },
    notes: 'Fluido de partículas con viscosidad, relajación de densidad y resortes plásticos. Funciona solo y el piano agita la materia.',
  },
  {
    id: 9,
    nombre: 'Materia radiante',
    visualScene: 9,
    gestosActivos: [
      'fader-carga',
      'densidad',
      'textura-brillo',
      'color-armonico',
      'contador-pulsos',
      'acumulador-climax',
    ],
    presets: {
      'fader-carga': { velLlenado: 0.98, fuga: 0.08, umbralEstallido: 0.78, velDescarga: 2.1 },
      densidad: { ventanaSeg: 1.4, maxOnsets: 12, suavizado: 4.4 },
      'textura-brillo': { suavizadoBrillo: 2.2, suavizadoAgitacion: 4.8 },
      'color-armonico': { histeresis: 0.08, suavizado: 0.68 },
      'contador-pulsos': { n: 3, ventanaMax: 2.4 },
      'acumulador-climax': { techo: 7.5, decayLento: 0.012 },
    },
    wires: [
      { gestureId: 'fader-carga', output: 'value', target: 'tension', curve: 'sCurve', min: 0.18, max: 0.96 },
      { gestureId: 'fader-carga', output: 'estalla', target: 'explosion' },
      { gestureId: 'densidad', output: 'value', target: 'density', curve: 'sCurve', min: 0.38, max: 1 },
      { gestureId: 'textura-brillo', output: 'value', target: 'turbulence', curve: 'linear', min: 0.08, max: 0.78 },
      { gestureId: 'textura-brillo', output: 'value', target: 'brightness', curve: 'log', min: 0.55, max: 1 },
      { gestureId: 'color-armonico', output: 'value', target: 'hue', curve: 'linear', min: 172, max: 322 },
      { gestureId: 'contador-pulsos', output: 'value', target: 'beat', curve: 'exp', min: 0, max: 1 },
      { gestureId: 'contador-pulsos', output: 'pulso', target: 'pulse' },
      { gestureId: 'acumulador-climax', output: 'value', target: 'radiance', curve: 'sCurve', min: 0.18, max: 1 },
      { gestureId: 'acumulador-climax', output: 'climax', target: 'finale' },
    ],
    transicionEntrada: { tipo: 'crossfade', seg: 0.7 },
    baseParams: { ...sharedBase, hue: 198, density: 0.76, tension: 0.5, turbulence: 0.2, brightness: 0.82, saturation: 0.96, grain: 0, radiance: 0.3, beat: 0 },
    notes: 'De 1 a 4 focos separados: calma concentra uno; complejidad, flux, ataques y clímax abren más objetos luminosos. Sólo una minoría de partículas emite; el resto proyecta sombras HRC nítidas.',
  },
  {
    id: 10,
    nombre: 'Órbita de Penumbra',
    visualScene: 10,
    gestosActivos: [],
    presets: {},
    wires: [],
    transicionEntrada: { tipo: 'crossfade', seg: 1.2 },
    baseParams: {
      ...sharedBase,
      hue: 36,
      density: 0.52,
      tension: 0.34,
      brightness: 0.78,
      saturation: 0.9,
      radiance: 0.72,
      grain: 0,
    },
    notes: 'Composición manual de disco, anillo y luna. A/S/D/F/G transforman apariencia, escala, posición, foco luminoso y gama con transiciones suaves.',
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

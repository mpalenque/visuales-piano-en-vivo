import type { AmitabhaBody } from './amitabha-radiance-field';

export type RadianceCompositionControl = 'a' | 's' | 'd' | 'f' | 'g';
type ElementId = 'solar' | 'ring' | 'moon';
type Colour = readonly [number, number, number];

export interface RadianceCompositionStats {
  form: string;
  scale: number;
  scaleTarget: number;
  layout: string;
  focus: string;
  palette: string;
  emitterCount: number;
}

interface ElementTarget {
  x: number;
  y: number;
  angle: number;
}

interface ElementAnimation {
  visibility: Tween;
  scale: Tween;
  x: Tween;
  y: Tween;
  angle: Tween;
  emissionWeight: Tween;
  emission: [Tween, Tween, Tween];
  albedo: [Tween, Tween, Tween];
}

interface Palette {
  label: string;
  emission: Record<ElementId, Colour>;
  albedo: Record<ElementId, Colour>;
}

const ELEMENT_IDS: readonly ElementId[] = ['solar', 'ring', 'moon'];
const FORM_DURATION = 2.4;
const SCALE_DURATION = 4;
const LAYOUT_DURATION = 5;
const FOCUS_DURATION = 2;
const PALETTE_DURATION = 3;
const VISIBLE_EPSILON = 0.002;

const FORMS: readonly { label: string; visible: readonly ElementId[] }[] = [
  { label: 'Eclipse', visible: ['solar', 'ring'] },
  { label: 'Tríada orbital', visible: ['solar', 'ring', 'moon'] },
  { label: 'Halo lunar', visible: ['ring', 'moon'] },
  { label: 'Conjunción', visible: ['solar', 'moon'] },
];

const SCALES: readonly {
  label: string;
  value: number;
  elements: Record<ElementId, number>;
}[] = [
  {
    label: 'Íntima',
    value: 0.78,
    elements: { solar: 0.82, ring: 0.78, moon: 0.88 },
  },
  {
    label: 'Equilibrada',
    value: 1,
    elements: { solar: 1, ring: 1, moon: 1 },
  },
  {
    label: 'Eclipse',
    value: 1.18,
    elements: { solar: 1.02, ring: 1.28, moon: 1.08 },
  },
  {
    label: 'Monumental',
    value: 1.42,
    elements: { solar: 1.38, ring: 1.14, moon: 1.24 },
  },
];

const LAYOUTS: readonly {
  label: string;
  elements: Record<ElementId, ElementTarget>;
}[] = [
  {
    label: 'Creciente',
    elements: {
      solar: { x: -2.6, y: 0.6, angle: 0 },
      ring: { x: -0.45, y: 0.1, angle: -12 * Math.PI / 180 },
      moon: { x: 3.45, y: -1.3, angle: 0 },
    },
  },
  {
    label: 'Eclipse centrado',
    elements: {
      solar: { x: -0.7, y: 0.18, angle: 0 },
      ring: { x: -0.22, y: 0.08, angle: 3 * Math.PI / 180 },
      moon: { x: 3.15, y: 1.45, angle: 0 },
    },
  },
  {
    label: 'Diagonal',
    elements: {
      solar: { x: -2.85, y: 1.55, angle: 0 },
      ring: { x: -0.5, y: 0.12, angle: -31 * Math.PI / 180 },
      moon: { x: 2.8, y: -1.72, angle: 0 },
    },
  },
  {
    label: 'Portal',
    elements: {
      solar: { x: 0, y: 0, angle: 0 },
      ring: { x: 0, y: 0, angle: Math.PI / 2 },
      moon: { x: 3.5, y: 0.08, angle: 0 },
    },
  },
  {
    label: 'Tensión lateral',
    elements: {
      solar: { x: 2.25, y: 0.55, angle: 0 },
      ring: { x: 0.15, y: -0.18, angle: 16 * Math.PI / 180 },
      moon: { x: -3.4, y: -1.02, angle: 0 },
    },
  },
];

/**
 * This ordering is intentional: neighbouring focus states have a union of at
 * most two elements. Crossfades therefore never create a hidden third source.
 */
const FOCUS_STATES: readonly { label: string; emitters: readonly ElementId[] }[] = [
  { label: 'Sol', emitters: ['solar'] },
  { label: 'Sol + luna', emitters: ['solar', 'moon'] },
  { label: 'Luna', emitters: ['moon'] },
  { label: 'Luna + anillo', emitters: ['moon', 'ring'] },
  { label: 'Anillo', emitters: ['ring'] },
  { label: 'Anillo + sol', emitters: ['ring', 'solar'] },
];

const PALETTES: readonly Palette[] = [
  {
    label: 'Ámbar / índigo',
    emission: {
      solar: [1, 0.22, 0.035],
      ring: [0.26, 0.055, 1],
      moon: [0.08, 0.34, 1],
    },
    albedo: {
      solar: [0.18, 0.065, 0.018],
      ring: [0.018, 0.025, 0.095],
      moon: [0.025, 0.055, 0.14],
    },
  },
  {
    label: 'Cian lunar',
    emission: {
      solar: [0.015, 0.58, 1],
      ring: [0.08, 1, 0.68],
      moon: [0.62, 0.96, 1],
    },
    albedo: {
      solar: [0.012, 0.085, 0.14],
      ring: [0.012, 0.07, 0.075],
      moon: [0.055, 0.105, 0.13],
    },
  },
  {
    label: 'Magenta mineral',
    emission: {
      solar: [1, 0.025, 0.24],
      ring: [0.48, 0.035, 1],
      moon: [1, 0.1, 0.62],
    },
    albedo: {
      solar: [0.14, 0.012, 0.045],
      ring: [0.075, 0.012, 0.085],
      moon: [0.12, 0.018, 0.072],
    },
  },
  {
    label: 'Rojo ritual',
    emission: {
      solar: [1, 0.035, 0.01],
      ring: [1, 0.22, 0.018],
      moon: [1, 0.52, 0.055],
    },
    albedo: {
      solar: [0.16, 0.018, 0.008],
      ring: [0.085, 0.012, 0.006],
      moon: [0.13, 0.045, 0.012],
    },
  },
  {
    label: 'Blanco espectral',
    emission: {
      solar: [1, 0.92, 0.72],
      ring: [0.62, 0.76, 1],
      moon: [0.35, 0.58, 1],
    },
    albedo: {
      solar: [0.15, 0.13, 0.095],
      ring: [0.032, 0.045, 0.075],
      moon: [0.055, 0.075, 0.125],
    },
  },
];

const BASE_SHAPES: Record<ElementId, {
  halfWidth: number;
  halfHeight: number;
  innerRadius: number;
}> = {
  solar: { halfWidth: 1.55, halfHeight: 1.55, innerRadius: 0 },
  ring: { halfWidth: 2.35, halfHeight: 1.2, innerRadius: 0.68 },
  moon: { halfWidth: 0.5, halfHeight: 0.5, innerRadius: 0 },
};

const EMISSION_STRENGTH: Record<ElementId, number> = {
  solar: 5.2,
  ring: 4.4,
  moon: 4.8,
};

const smootherStep = (value: number): number => {
  const clamped = Math.max(0, Math.min(1, value));
  return clamped * clamped * clamped * (clamped * (clamped * 6 - 15) + 10);
};

class Tween {
  current: number;
  target: number;
  private start: number;
  private elapsed = 0;
  private duration = 0;

  constructor(value: number) {
    this.current = value;
    this.target = value;
    this.start = value;
  }

  retarget(target: number, duration: number): void {
    if (this.target === target) return;
    this.start = this.current;
    this.target = target;
    this.elapsed = 0;
    this.duration = Math.max(0, duration);
    if (this.duration === 0) this.current = target;
  }

  step(dt: number): void {
    if (this.current === this.target) return;
    this.elapsed = Math.min(this.duration, this.elapsed + Math.max(0, dt));
    const progress = this.duration === 0 ? 1 : this.elapsed / this.duration;
    this.current = this.start + (this.target - this.start) * smootherStep(progress);
    if (progress >= 1) this.current = this.target;
  }
}

const makeColourTweens = (colour: Colour): [Tween, Tween, Tween] => [
  new Tween(colour[0]),
  new Tween(colour[1]),
  new Tween(colour[2]),
];

const colourValue = (channels: [Tween, Tween, Tween]): [number, number, number] => [
  channels[0].current,
  channels[1].current,
  channels[2].current,
];

export class RadianceComposition {
  private formIndex = 0;
  private scaleIndex = 1;
  private layoutIndex = 0;
  private focusIndex = 0;
  private paletteIndex = 0;
  private readonly displayScale = new Tween(SCALES[this.scaleIndex].value);
  private readonly elements: Record<ElementId, ElementAnimation>;

  constructor() {
    const form = FORMS[this.formIndex];
    const layout = LAYOUTS[this.layoutIndex];
    const scale = SCALES[this.scaleIndex];
    const focus = FOCUS_STATES[this.focusIndex];
    const palette = PALETTES[this.paletteIndex];
    this.elements = Object.fromEntries(ELEMENT_IDS.map((id) => {
      const target = layout.elements[id];
      return [id, {
        visibility: new Tween(form.visible.includes(id) ? 1 : 0),
        scale: new Tween(scale.elements[id]),
        x: new Tween(target.x),
        y: new Tween(target.y),
        angle: new Tween(target.angle),
        emissionWeight: new Tween(focus.emitters.includes(id) ? 1 : 0),
        emission: makeColourTweens(palette.emission[id]),
        albedo: makeColourTweens(palette.albedo[id]),
      }];
    })) as Record<ElementId, ElementAnimation>;
  }

  control(control: RadianceCompositionControl): string {
    if (control === 'a') {
      this.formIndex = (this.formIndex + 1) % FORMS.length;
      const form = FORMS[this.formIndex];
      for (const id of ELEMENT_IDS) {
        this.elements[id].visibility.retarget(
          form.visible.includes(id) ? 1 : 0,
          FORM_DURATION,
        );
      }
      this.ensureVisibleFocus(form.visible);
      return `A · Apariencia: ${form.label}. Transición suave de ${FORM_DURATION.toFixed(1)} s.`;
    }
    if (control === 's') {
      this.scaleIndex = (this.scaleIndex + 1) % SCALES.length;
      const scale = SCALES[this.scaleIndex];
      this.displayScale.retarget(scale.value, SCALE_DURATION);
      for (const id of ELEMENT_IDS) {
        this.elements[id].scale.retarget(scale.elements[id], SCALE_DURATION);
      }
      return `S · Escala: ${scale.label}, ${scale.value.toFixed(2)}× en ${SCALE_DURATION} s.`;
    }
    if (control === 'd') {
      this.layoutIndex = (this.layoutIndex + 1) % LAYOUTS.length;
      const layout = LAYOUTS[this.layoutIndex];
      for (const id of ELEMENT_IDS) {
        const target = layout.elements[id];
        this.elements[id].x.retarget(target.x, LAYOUT_DURATION);
        this.elements[id].y.retarget(target.y, LAYOUT_DURATION);
        this.elements[id].angle.retarget(target.angle, LAYOUT_DURATION);
      }
      return `D · Desplazamiento: ${layout.label}, recorrido de ${LAYOUT_DURATION} s.`;
    }
    if (control === 'f') {
      this.focusIndex = (this.focusIndex + 1) % FOCUS_STATES.length;
      this.retargetFocus();
      return `F · Foco: ${FOCUS_STATES[this.focusIndex].label}. Uno o dos emisores, relevo de ${FOCUS_DURATION} s.`;
    }

    this.paletteIndex = (this.paletteIndex + 1) % PALETTES.length;
    const palette = PALETTES[this.paletteIndex];
    for (const id of ELEMENT_IDS) {
      for (let channel = 0; channel < 3; channel += 1) {
        this.elements[id].emission[channel].retarget(
          palette.emission[id][channel],
          PALETTE_DURATION,
        );
        this.elements[id].albedo[channel].retarget(
          palette.albedo[id][channel],
          PALETTE_DURATION,
        );
      }
    }
    return `G · Gama: ${palette.label}, mezcla de ${PALETTE_DURATION} s.`;
  }

  update(dt: number): readonly AmitabhaBody[] {
    this.displayScale.step(dt);
    for (const id of ELEMENT_IDS) {
      const element = this.elements[id];
      element.visibility.step(dt);
      element.scale.step(dt);
      element.x.step(dt);
      element.y.step(dt);
      element.angle.step(dt);
      element.emissionWeight.step(dt);
      element.emission.forEach((channel) => channel.step(dt));
      element.albedo.forEach((channel) => channel.step(dt));
    }
    this.reconcileFocus();

    // Order is also compositing order in the HRC scene pass. The ring is last
    // so its dark annulus actually eclipses the two luminous discs.
    return [
      this.bodyFor('solar', 0),
      this.bodyFor('moon', 1),
      this.bodyFor('ring', 2),
    ].filter((body): body is AmitabhaBody => body !== null);
  }

  get stats(): RadianceCompositionStats {
    let emitterCount = 0;
    for (const id of ELEMENT_IDS) {
      const element = this.elements[id];
      if (
        element.visibility.current * element.emissionWeight.current
        > VISIBLE_EPSILON
      ) emitterCount += 1;
    }
    return {
      form: FORMS[this.formIndex].label,
      scale: this.displayScale.current,
      scaleTarget: this.displayScale.target,
      layout: LAYOUTS[this.layoutIndex].label,
      focus: FOCUS_STATES[this.focusIndex].label,
      palette: PALETTES[this.paletteIndex].label,
      emitterCount,
    };
  }

  private bodyFor(id: ElementId, order: number): AmitabhaBody | null {
    const element = this.elements[id];
    const coverage = Math.max(0, Math.min(1, element.visibility.current));
    if (coverage <= 0.0001) return null;
    const shape = BASE_SHAPES[id];
    const scale = Math.max(0.01, element.scale.current);
    const emissionWeight = Math.max(0, Math.min(1, element.emissionWeight.current));
    const albedo = colourValue(element.albedo);
    return {
      x: element.x.current,
      y: element.y.current,
      halfWidth: shape.halfWidth * scale,
      halfHeight: shape.halfHeight * scale,
      angle: element.angle.current,
      sides: 32,
      innerRadius: shape.innerRadius,
      emission: colourValue(element.emission),
      emissionStrength: EMISSION_STRENGTH[id] * emissionWeight * coverage,
      albedo: [
        albedo[0] * coverage,
        albedo[1] * coverage,
        albedo[2] * coverage,
      ],
      absorption: 9 * coverage,
      transportOrder: order,
    };
  }

  private retargetFocus(): void {
    this.reconcileFocus();
  }

  /**
   * Treats the two possible lights as physical slots. When a very fast series
   * of key presses would otherwise crossfade three elements at once, one old
   * source is faded out before the new one enters. A remaining source acts as
   * a bridge, so the composition also never falls completely dark.
   */
  private reconcileFocus(): void {
    const desired = FOCUS_STATES[this.focusIndex].emitters;
    const active = ELEMENT_IDS.filter((id) => (
      this.elements[id].emissionWeight.current > 0
    ));
    const common = active.filter((id) => desired.includes(id));
    const missing = desired.filter((id) => !active.includes(id));
    const obsolete = active.filter((id) => !desired.includes(id));

    for (const id of common) {
      this.elements[id].emissionWeight.retarget(1, FOCUS_DURATION);
    }

    if (missing.length > 0 && active.length < 2) {
      // Keep one obsolete source alive until the newcomer has actually begun
      // emitting; this makes disjoint single-focus changes a true crossfade.
      const bridge = common[0] ?? obsolete[0];
      if (bridge) {
        this.elements[bridge].emissionWeight.retarget(1, FOCUS_DURATION);
      }
      this.elements[missing[0]].emissionWeight.retarget(1, FOCUS_DURATION);
      return;
    }

    if (missing.length > 0) {
      if (common.length === 0 && obsolete.length > 1) {
        this.elements[obsolete[0]].emissionWeight.retarget(1, FOCUS_DURATION);
        this.elements[obsolete[1]].emissionWeight.retarget(0, FOCUS_DURATION);
      } else if (obsolete[0]) {
        this.elements[obsolete[0]].emissionWeight.retarget(0, FOCUS_DURATION);
      }
      return;
    }

    for (const id of desired) {
      this.elements[id].emissionWeight.retarget(1, FOCUS_DURATION);
    }
    for (const id of obsolete) {
      this.elements[id].emissionWeight.retarget(0, FOCUS_DURATION);
    }
  }

  private ensureVisibleFocus(visible: readonly ElementId[]): void {
    const focus = FOCUS_STATES[this.focusIndex];
    if (focus.emitters.some((id) => visible.includes(id))) return;
    const replacement = ELEMENT_IDS.find((id) => visible.includes(id)) ?? 'solar';
    const replacementIndex = FOCUS_STATES.findIndex((candidate) => (
      candidate.emitters.length === 1 && candidate.emitters[0] === replacement
    ));
    if (replacementIndex >= 0) {
      this.focusIndex = replacementIndex;
      this.retargetFocus();
    }
  }
}

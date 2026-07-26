import type { Curve, GestureEvent, GestureOutput, Scene, ShowConfig, VisualFrame, Wire } from '../types';
import { createDefaultShowConfig } from './show-config';
import { sceneById } from './scenes';

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));

function curve(value: number, type: Curve = 'linear'): number {
  const x = clamp(value, 0, 1);
  if (type === 'exp') return x * x;
  if (type === 'log') return Math.sqrt(x);
  if (type === 'sCurve') return x * x * (3 - 2 * x);
  return x;
}

export class SceneMachine {
  private config: ShowConfig;
  private current: Scene;
  private readonly overrides = new Map<string, number>();
  private blackout = false;
  private forcedEvents: GestureEvent[] = [];
  private revision = 0;
  private transition: { type: 'corte' | 'crossfade'; duration: number; fromScene: number | null; startedAt: number } = {
    type: 'corte', duration: 0, fromScene: null, startedAt: 0,
  };

  constructor(config = createDefaultShowConfig()) {
    this.config = config;
    this.current = sceneById(this.config.scenes, 1);
  }

  get scene(): Scene {
    return this.current;
  }

  get scenes(): readonly Scene[] {
    return this.config.scenes;
  }

  get showConfig(): ShowConfig {
    return structuredClone(this.config);
  }

  getRevision(): number {
    return this.revision;
  }

  setScene(id: number, now = performance.now() / 1000): Scene {
    if (id === this.current.id) return this.current;
    const previous = this.current.id;
    this.current = sceneById(this.config.scenes, id);
    this.overrides.clear();
    this.transition = {
      type: this.current.transicionEntrada.tipo,
      duration: this.current.transicionEntrada.seg,
      fromScene: previous,
      startedAt: now,
    };
    this.revision += 1;
    return this.current;
  }

  replaceConfig(config: ShowConfig, now = performance.now() / 1000): Scene {
    this.config = structuredClone(config);
    this.current = sceneById(this.config.scenes, 1);
    this.overrides.clear();
    this.forcedEvents = [];
    this.transition = { type: 'corte', duration: 0, fromScene: null, startedAt: now };
    this.revision += 1;
    return this.current;
  }

  setWire(index: number, wire: Partial<Wire>): void {
    const existing = this.current.wires[index];
    if (existing) {
      this.current.wires[index] = { ...existing, ...wire };
      this.revision += 1;
    }
  }

  setGestureParams(gestureId: string, params: Record<string, number>): void {
    const existing = this.current.presets[gestureId] ?? {};
    this.current.presets[gestureId] = { ...existing, ...params };
    this.revision += 1;
  }

  setOverride(target: string, value: number | null): void {
    if (value === null) this.overrides.delete(target);
    else this.overrides.set(target, value);
  }

  getOverrides(): Record<string, number> {
    return Object.fromEntries(this.overrides);
  }

  setBlackout(value: boolean): void {
    this.blackout = value;
  }

  isBlackout(): boolean {
    return this.blackout;
  }

  forceEvent(type: 'estalla' | 'climax' | 'pulso'): void {
    this.forcedEvents.push(type === 'pulso' ? { type, count: 1 } : { type, intensity: 1 });
  }

  compose(outputs: Record<string, GestureOutput>, now = performance.now() / 1000): VisualFrame {
    const params = { ...this.current.baseParams };
    const events: GestureEvent[] = [];
    for (const wire of this.current.wires) {
      const output = outputs[wire.gestureId];
      if (!output) continue;
      if (wire.output === 'value') {
        const min = wire.min ?? 0;
        const max = wire.max ?? 1;
        params[wire.target] = min + curve(output.value, wire.curve) * (max - min);
      } else {
        output.events
          .filter((event) => event.type === wire.output)
          .forEach((event) => events.push({ ...event, target: wire.target }));
      }
    }
    this.overrides.forEach((value, key) => { params[key] = value; });
    events.push(...this.forcedEvents);
    this.forcedEvents = [];
    const elapsed = now - this.transition.startedAt;
    const progress = this.transition.type === 'crossfade'
      ? elapsed >= this.transition.duration - 1e-6 ? 1 : clamp(elapsed / this.transition.duration, 0, 1)
      : 1;
    const transition = {
      type: this.transition.type,
      duration: this.transition.duration,
      fromScene: progress >= 1 ? null : this.transition.fromScene,
      progress,
    } as const;
    return {
      params,
      events,
      scene: this.current.id,
      profile: this.current.visualScene,
      transition,
      blackout: this.blackout,
      impulseMode: 1,
      noteAttacks: [],
      wideChord: false,
    };
  }
}

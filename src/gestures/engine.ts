import type { FeatureFrame, GestureEvent, GestureOutput } from '../types';
import type { AnyGesture } from './gesture';

export class GestureEngine {
  private readonly catalog: Map<string, AnyGesture>;
  private states = new Map<string, unknown>();
  private activeIds: string[] = [];
  private frozen = new Set<string>();
  private outputs = new Map<string, GestureOutput>();
  private lastFrame: FeatureFrame | null = null;
  private lastFeatureTime = 0;

  constructor(catalog: Map<string, AnyGesture>) {
    this.catalog = catalog;
    catalog.forEach((gesture, id) => this.states.set(id, gesture.init(gesture.params)));
  }

  setActive(ids: string[]): void {
    this.activeIds = ids.filter((id) => this.catalog.has(id));
    this.outputs = new Map([...this.outputs].filter(([id]) => this.activeIds.includes(id)));
  }

  reset(ids = this.activeIds): void {
    for (const id of ids) {
      const gesture = this.catalog.get(id);
      if (!gesture) continue;
      this.states.set(id, gesture.init(gesture.params));
      this.outputs.delete(id);
    }
  }

  setFrozen(id: string, frozen: boolean): void {
    if (frozen) this.frozen.add(id);
    else this.frozen.delete(id);
  }

  isFrozen(id: string): boolean {
    return this.frozen.has(id);
  }

  setParams(id: string, params: Record<string, number>): void {
    const gesture = this.catalog.get(id);
    if (!gesture) return;
    Object.assign(gesture.params, params);
  }

  getParams(id: string): Record<string, number> {
    return { ...(this.catalog.get(id)?.params ?? {}) };
  }

  getActiveIds(): string[] {
    return [...this.activeIds];
  }

  getFrozenIds(): string[] {
    return [...this.frozen];
  }

  clearFrozen(): void {
    this.frozen.clear();
  }

  snapshotParams(): Record<string, Record<string, number>> {
    return Object.fromEntries(this.activeIds.map((id) => [id, this.getParams(id)]));
  }

  /**
   * Feeds every pending audio frame. This preserves rapid onset events even
   * when the browser renders slower than the AudioWorklet emits frames.
   */
  update(frames: FeatureFrame[], renderDt: number): Record<string, GestureOutput> {
    const collected = new Map<string, GestureEvent[]>();
    if (frames.length) {
      for (const frame of frames) {
        const featureDt = this.lastFeatureTime ? Math.min(0.1, Math.max(0.001, frame.t - this.lastFeatureTime)) : 0.012;
        this.lastFeatureTime = frame.t;
        this.lastFrame = frame;
        this.step(frame, featureDt, collected);
      }
    } else if (this.lastFrame) {
      // No new onset can be generated from a stale input, but decays stay stable at frame rate.
      this.lastFrame = { ...this.lastFrame, t: this.lastFrame.t + renderDt, onset: false, onsetStrength: 0 };
      this.step(this.lastFrame, renderDt, collected);
    }

    this.activeIds.forEach((id) => {
      const output = this.outputs.get(id) ?? { value: 0, events: [] };
      output.events = collected.get(id) ?? [];
      this.outputs.set(id, output);
    });
    return this.snapshotOutputs();
  }

  private step(frame: FeatureFrame, dt: number, collected: Map<string, GestureEvent[]>): void {
    for (const id of this.activeIds) {
      if (this.frozen.has(id)) continue;
      const gesture = this.catalog.get(id);
      const state = this.states.get(id);
      if (!gesture || state === undefined) continue;
      const nextState = gesture.update(state, frame, dt);
      this.states.set(id, nextState);
      const result = gesture.read(nextState);
      const existing = collected.get(id) ?? [];
      if (result.events.length) existing.push(...result.events.map((event) => ({ ...event })));
      collected.set(id, existing);
      gesture.clearEvents?.(nextState);
      this.outputs.set(id, { value: result.value, events: [] });
    }
  }

  private snapshotOutputs(): Record<string, GestureOutput> {
    return Object.fromEntries(this.activeIds.map((id) => {
      const output = this.outputs.get(id) ?? { value: 0, events: [] };
      return [id, { value: output.value, events: [...output.events] }];
    }));
  }
}

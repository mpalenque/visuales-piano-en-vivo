import type { Gesture, GestureEvent } from '../../types';
import { clamp01, smooth } from '../gesture';

export interface DensityParams extends Record<string, number> {
  ventanaSeg: number;
  maxOnsets: number;
  suavizado: number;
}

interface DensityState {
  timestamps: number[];
  densidad: number;
  events: GestureEvent[];
}

export function createDensidad(params: Partial<DensityParams> = {}): Gesture<DensityParams, DensityState> {
  const gesture: Gesture<DensityParams, DensityState> = {
    id: 'densidad',
    params: { ventanaSeg: 1.5, maxOnsets: 9, suavizado: 5, ...params },
    init: () => ({ timestamps: [], densidad: 0, events: [] }),
    update(state, frame, dt) {
      state.events.length = 0;
      if (frame.onset) state.timestamps.push(frame.t);
      const cutoff = frame.t - gesture.params.ventanaSeg;
      while (state.timestamps.length && state.timestamps[0] < cutoff) state.timestamps.shift();
      const target = clamp01(state.timestamps.length / Math.max(1, gesture.params.maxOnsets));
      state.densidad = smooth(state.densidad, target, gesture.params.suavizado, dt);
      return state;
    },
    read: (state) => ({ value: state.densidad, events: state.events }),
  };
  return gesture;
}

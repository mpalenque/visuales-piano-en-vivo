import type { Gesture, GestureEvent } from '../../types';
import { clamp01 } from '../gesture';

export interface ClimaxParams extends Record<string, number> {
  techo: number;
  decayLento: number;
}

interface ClimaxState {
  acumulado: number;
  events: GestureEvent[];
}

export function createAcumuladorClimax(params: Partial<ClimaxParams> = {}): Gesture<ClimaxParams, ClimaxState> {
  const gesture: Gesture<ClimaxParams, ClimaxState> = {
    id: 'acumulador-climax',
    params: { techo: 16, decayLento: 0.018, ...params },
    init: () => ({ acumulado: 0, events: [] }),
    update(state, frame, dt) {
      state.events.length = 0;
      state.acumulado = Math.max(0, state.acumulado + frame.rms * dt - gesture.params.decayLento * dt);
      if (state.acumulado >= gesture.params.techo) {
        state.events.push({ type: 'climax', intensity: 1 });
        state.acumulado = 0;
      }
      return state;
    },
    read: (state) => ({ value: clamp01(state.acumulado / gesture.params.techo), events: state.events }),
    clearEvents: (state) => { state.events.length = 0; },
  };
  return gesture;
}

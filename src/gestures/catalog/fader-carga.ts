import type { Gesture, GestureEvent } from '../../types';
import { clamp01 } from '../gesture';

export interface FaderParams extends Record<string, number> {
  velLlenado: number;
  fuga: number;
  umbralEstallido: number;
  velDescarga: number;
}

interface FaderState {
  nivel: number;
  fase: 'cargando' | 'descargando';
  events: GestureEvent[];
}

export function createFaderCarga(params: Partial<FaderParams> = {}): Gesture<FaderParams, FaderState> {
  const gesture: Gesture<FaderParams, FaderState> = {
    id: 'fader-carga',
    params: { velLlenado: 1.35, fuga: 0.13, umbralEstallido: 0.82, velDescarga: 2.6, ...params },
    init: () => ({ nivel: 0, fase: 'cargando', events: [] }),
    update(state, frame, dt) {
      state.events.length = 0;
      if (state.fase === 'cargando') {
        const input = Math.max(frame.rms * 0.42, frame.onsetStrength);
        state.nivel = clamp01(state.nivel + gesture.params.velLlenado * input * dt - gesture.params.fuga * dt);
        if (state.nivel >= gesture.params.umbralEstallido) {
          state.events.push({ type: 'estalla', intensity: state.nivel });
          state.fase = 'descargando';
        }
      } else {
        state.nivel = Math.max(0, state.nivel - gesture.params.velDescarga * (0.35 + state.nivel * 0.65) * dt);
        if (state.nivel <= 0.001) {
          state.nivel = 0;
          state.fase = 'cargando';
        }
      }
      return state;
    },
    read: (state) => ({ value: state.nivel, events: state.events }),
    clearEvents: (state) => { state.events.length = 0; },
  };
  return gesture;
}

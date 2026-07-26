import type { Gesture, GestureEvent } from '../../types';
import { clamp01, smooth } from '../gesture';

export interface HarmonicParams extends Record<string, number> {
  histeresis: number;
  suavizado: number;
}

interface HarmonicState {
  centroActual: number;
  confianza: number;
  valor: number;
  events: GestureEvent[];
}

export function createColorArmonico(params: Partial<HarmonicParams> = {}): Gesture<HarmonicParams, HarmonicState> {
  const gesture: Gesture<HarmonicParams, HarmonicState> = {
    id: 'color-armonico',
    params: { histeresis: 0.08, suavizado: 1.4, ...params },
    init: () => ({ centroActual: 0, confianza: 0, valor: 0, events: [] }),
    update(state, frame, dt) {
      state.events.length = 0;
      let bestClass = 0;
      let best = 0;
      let total = 0;
      for (let i = 0; i < 12; i += 1) {
        const value = frame.chroma[i] ?? 0;
        total += value;
        if (value > best) {
          best = value;
          bestClass = i;
        }
      }
      const current = frame.chroma[state.centroActual] ?? 0;
      if (bestClass !== state.centroActual && best > current + gesture.params.histeresis) state.centroActual = bestClass;
      state.confianza = smooth(state.confianza, clamp01(best / (total + 1e-6) * 3), 2, dt);
      state.valor = smooth(state.valor, state.centroActual / 11, gesture.params.suavizado, dt);
      return state;
    },
    read: (state) => ({ value: state.valor, events: state.events }),
  };
  return gesture;
}

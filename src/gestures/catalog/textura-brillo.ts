import type { Gesture, GestureEvent } from '../../types';
import { clamp01, smooth } from '../gesture';

export interface TextureParams extends Record<string, number> {
  suavizadoBrillo: number;
  suavizadoAgitacion: number;
}

interface TextureState {
  brillo: number;
  agitacion: number;
  events: GestureEvent[];
}

export function createTexturaBrillo(params: Partial<TextureParams> = {}): Gesture<TextureParams, TextureState> {
  const gesture: Gesture<TextureParams, TextureState> = {
    id: 'textura-brillo',
    params: { suavizadoBrillo: 2.5, suavizadoAgitacion: 5, ...params },
    init: () => ({ brillo: 0, agitacion: 0, events: [] }),
    update(state, frame, dt) {
      state.events.length = 0;
      state.brillo = smooth(state.brillo, clamp01(frame.centroid * 1.2), gesture.params.suavizadoBrillo, dt);
      state.agitacion = smooth(state.agitacion, clamp01(frame.flux * 1.2), gesture.params.suavizadoAgitacion, dt);
      return state;
    },
    read: (state) => ({ value: clamp01(state.brillo * 0.72 + state.agitacion * 0.28), events: state.events }),
  };
  return gesture;
}

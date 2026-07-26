import type { Gesture, GestureEvent } from '../../types';

export interface PulseParams extends Record<string, number> {
  n: number;
  ventanaMax: number;
}

interface PulseState {
  cuenta: number;
  lastOnset: number;
  pulse: number;
  events: GestureEvent[];
}

export function createContadorPulsos(params: Partial<PulseParams> = {}): Gesture<PulseParams, PulseState> {
  const gesture: Gesture<PulseParams, PulseState> = {
    id: 'contador-pulsos',
    params: { n: 4, ventanaMax: 2.5, ...params },
    init: () => ({ cuenta: 0, lastOnset: 0, pulse: 0, events: [] }),
    update(state, frame, dt) {
      state.events.length = 0;
      state.pulse = Math.max(0, state.pulse - dt * 4);
      if (state.cuenta > 0 && frame.t - state.lastOnset > gesture.params.ventanaMax) state.cuenta = 0;
      if (frame.onset) {
        state.lastOnset = frame.t;
        state.cuenta += 1;
        if (state.cuenta >= Math.max(1, Math.round(gesture.params.n))) {
          state.events.push({ type: 'pulso', count: state.cuenta });
          state.cuenta = 0;
          state.pulse = 1;
        }
      }
      return state;
    },
    read: (state) => ({ value: state.pulse, events: state.events }),
    clearEvents: (state) => { state.events.length = 0; },
  };
  return gesture;
}

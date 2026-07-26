import type { Gesture, GestureEvent, GestureOutput } from '../types';

export type AnyGesture = Gesture<Record<string, number>, unknown>;

export const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

export function smooth(current: number, target: number, responsiveness: number, dt: number): number {
  return current + (target - current) * (1 - Math.exp(-responsiveness * dt));
}

export function eventOutput(value: number, events: GestureEvent[]): GestureOutput {
  return { value: clamp01(value), events };
}

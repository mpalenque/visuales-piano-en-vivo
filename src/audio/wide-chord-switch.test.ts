import { describe, expect, it } from 'vitest';
import type { DetectedNote } from '../types';
import { WideChordSwitchDetector, isWideChord } from './wide-chord-switch';

const note = (midi: number, strength = 0.8): DetectedNote => ({
  midi,
  frequency: 440 * 2 ** ((midi - 69) / 12),
  strength,
});

describe('wide chord switch', () => {
  it('requires three distinct pitches across at least a fifth', () => {
    expect(isWideChord([note(60)])).toBe(false);
    expect(isWideChord([note(60), note(64)])).toBe(false);
    expect(isWideChord([note(60), note(64), note(67)])).toBe(true);
  });

  it('groups slightly delayed voices once and applies a cooldown', () => {
    const detector = new WideChordSwitchDetector();
    expect(detector.push([note(48), note(55)], 0)).toBe(false);
    expect(detector.push([note(60)], 0.12)).toBe(true);
    expect(detector.push([note(48), note(55), note(60)], 0.3)).toBe(false);
    expect(detector.push([note(48), note(55), note(60)], 1.1)).toBe(true);
  });
});

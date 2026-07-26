import type { DetectedNote } from '../types';

const NOTE_WINDOW_SECONDS = 0.22;
const SWITCH_COOLDOWN_SECONDS = 0.72;

/**
 * Turns several near-simultaneous pitches into one intentional chord event.
 * It tolerates the small delay between the native detector and the ML worker,
 * while requiring enough pitch spread to reject one piano note's harmonics.
 */
export class WideChordSwitchDetector {
  private notes: Array<DetectedNote & { at: number }> = [];
  private lastSwitchAt = -Infinity;

  reset(): void {
    this.notes = [];
    this.lastSwitchAt = -Infinity;
  }

  push(notes: readonly DetectedNote[], now: number): boolean {
    this.notes = this.notes.filter((note) => now - note.at <= NOTE_WINDOW_SECONDS);
    for (const note of notes) this.add(note, now);
    if (now - this.lastSwitchAt < SWITCH_COOLDOWN_SECONDS || !isWideChord(this.notes)) return false;
    this.lastSwitchAt = now;
    this.notes = [];
    return true;
  }

  private add(note: DetectedNote, at: number): void {
    if (!Number.isInteger(note.midi) || !Number.isFinite(note.strength) || note.strength < 0.16) return;
    const matchingIndex = this.notes.findIndex((candidate) => candidate.midi === note.midi);
    if (matchingIndex >= 0) {
      if (note.strength >= this.notes[matchingIndex].strength) this.notes[matchingIndex] = { ...note, at };
      return;
    }
    this.notes.push({ ...note, at });
  }
}

export function isWideChord(notes: readonly Pick<DetectedNote, 'midi' | 'strength'>[]): boolean {
  const pitches = [...new Set(notes
    .filter((note) => Number.isInteger(note.midi) && Number.isFinite(note.strength) && note.strength >= 0.16)
    .map((note) => note.midi))].sort((left, right) => left - right);
  return pitches.length >= 3 && pitches[pitches.length - 1] - pitches[0] >= 7;
}

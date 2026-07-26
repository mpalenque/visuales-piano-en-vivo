import type { DetectedNote } from '../types';

export const LOWEST_PIANO_MIDI = 21;
export const HIGHEST_PIANO_MIDI = 108;
/** The 88 piano keys split into two equal groups: 21–64 and 65–108. */
export const UPPER_PIANO_HALF_START = 65;
export const VORONOI_SETTLE_SECONDS = 2;
export const MIN_VORONOI_CELLS = 5;
export const MAX_VORONOI_CELLS = 48;

export interface VoronoiCellSnapshot {
  x: number;
  y: number;
  offsetX: number;
  offsetY: number;
  settled: boolean;
}

interface VoronoiCell {
  targetX: number;
  targetY: number;
  startX: number;
  startY: number;
  x: number;
  y: number;
  age: number;
  phase: number;
  wobble: number;
  permanent: boolean;
}

export type VoronoiImpulseResult = 'added' | 'removed' | 'minimum' | 'maximum';

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));

const pseudoRandom = (seed: number): number => {
  const value = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;
  return value - Math.floor(value);
};

/**
 * Pure state for the incremental Voronoi visual. Rendering is deliberately
 * separate so pitch rules and the exact two-second settling time stay testable.
 */
export class VoronoiField {
  private cells: VoronoiCell[] = [];
  private sequence = 0;

  constructor() {
    this.reset();
  }

  get count(): number {
    return this.cells.length;
  }

  reset(): void {
    this.sequence = 0;
    const initialTargets: ReadonlyArray<readonly [number, number]> = [
      [0.18, 0.2],
      [0.8, 0.22],
      [0.5, 0.5],
      [0.2, 0.8],
      [0.82, 0.78],
    ];
    this.cells = initialTargets.map(([x, y], index) => ({
      targetX: x,
      targetY: y,
      startX: x,
      startY: y,
      x,
      y,
      age: VORONOI_SETTLE_SECONDS,
      phase: index,
      wobble: 0,
      permanent: true,
    }));
  }

  applyImpulse(note: DetectedNote): VoronoiImpulseResult {
    if (note.midi >= UPPER_PIANO_HALF_START) return this.addCell(note);
    return this.removeCell();
  }

  update(dt: number): void {
    const safeDt = Number.isFinite(dt) ? Math.max(0, dt) : 0;
    for (const cell of this.cells) {
      cell.age = Math.min(VORONOI_SETTLE_SECONDS, cell.age + safeDt);
      if (cell.age >= VORONOI_SETTLE_SECONDS) {
        cell.x = cell.targetX;
        cell.y = cell.targetY;
        continue;
      }
      const progress = cell.age / VORONOI_SETTLE_SECONDS;
      const eased = 1 - Math.pow(1 - progress, 3);
      const remaining = 1 - progress;
      const oscillation = Math.sin(progress * Math.PI * 3 + cell.phase) * remaining * cell.wobble;
      cell.x = clamp(cell.startX + (cell.targetX - cell.startX) * eased + Math.cos(cell.phase) * oscillation, 0.025, 0.975);
      cell.y = clamp(cell.startY + (cell.targetY - cell.startY) * eased + Math.sin(cell.phase) * oscillation, 0.025, 0.975);
    }
  }

  snapshot(): VoronoiCellSnapshot[] {
    return this.cells.map((cell) => ({
      x: cell.x,
      y: cell.y,
      offsetX: cell.x - cell.targetX,
      offsetY: cell.y - cell.targetY,
      settled: cell.age >= VORONOI_SETTLE_SECONDS,
    }));
  }

  private addCell(note: DetectedNote): VoronoiImpulseResult {
    if (this.cells.length >= MAX_VORONOI_CELLS) return 'maximum';
    this.sequence += 1;
    const seed = note.midi * 43.17 + note.strength * 97.3 + this.sequence * 19.71;
    const target = this.findOpenTarget(seed);
    const angle = pseudoRandom(seed + 111.4) * Math.PI * 2;
    const travel = 0.055 + clamp(note.strength, 0, 1) * 0.075;
    const startX = clamp(target.x + Math.cos(angle) * travel, 0.025, 0.975);
    const startY = clamp(target.y + Math.sin(angle) * travel, 0.025, 0.975);
    this.cells.push({
      targetX: target.x,
      targetY: target.y,
      startX,
      startY,
      x: startX,
      y: startY,
      age: 0,
      phase: angle,
      wobble: 0.018 + clamp(note.strength, 0, 1) * 0.018,
      permanent: false,
    });
    return 'added';
  }

  private removeCell(): VoronoiImpulseResult {
    if (this.cells.length <= MIN_VORONOI_CELLS) return 'minimum';
    let index = this.cells.length - 1;
    while (index >= 0 && this.cells[index].permanent) index -= 1;
    if (index < 0) return 'minimum';
    this.cells.splice(index, 1);
    this.jostleRemaining();
    return 'removed';
  }

  /**
   * Picks the emptiest of deterministic candidates, so each new site visibly
   * subdivides a large region instead of producing barely perceptible slivers.
   */
  private findOpenTarget(seed: number): { x: number; y: number } {
    let best = { x: 0.5, y: 0.5 };
    let bestDistance = -Infinity;
    for (let candidate = 0; candidate < 28; candidate += 1) {
      const x = 0.055 + pseudoRandom(seed + candidate * 17.13) * 0.89;
      const y = 0.055 + pseudoRandom(seed + candidate * 29.87 + 5.2) * 0.89;
      let nearest = Infinity;
      for (const cell of this.cells) {
        const dx = (x - cell.targetX) * 1.65;
        const dy = y - cell.targetY;
        nearest = Math.min(nearest, dx * dx + dy * dy);
      }
      if (nearest > bestDistance) {
        bestDistance = nearest;
        best = { x, y };
      }
    }
    return best;
  }

  private jostleRemaining(): void {
    this.sequence += 1;
    for (let index = 0; index < this.cells.length; index += 1) {
      const cell = this.cells[index];
      const phase = pseudoRandom(this.sequence * 13.7 + index * 31.1) * Math.PI * 2;
      const travel = 0.018 + pseudoRandom(this.sequence * 9.4 + index) * 0.018;
      cell.startX = clamp(cell.x + Math.cos(phase) * travel, 0.025, 0.975);
      cell.startY = clamp(cell.y + Math.sin(phase) * travel, 0.025, 0.975);
      cell.x = cell.startX;
      cell.y = cell.startY;
      cell.age = 0;
      cell.phase = phase;
      cell.wobble = 0.012;
    }
  }
}

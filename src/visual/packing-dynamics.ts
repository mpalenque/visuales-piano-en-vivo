const clamp01 = (value: number): number => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));

export function polygonSidesForSound(midi: number, density: number): number {
  const pitch = clamp01((midi - 21) / 87);
  return Math.max(3, Math.min(8, 3 + Math.floor(pitch * 5.25 + clamp01(density) * 0.75)));
}

export function regulatedPackingChaos(density: number, turbulence: number, tension: number): number {
  return clamp01(clamp01(density) * 0.46 + clamp01(turbulence) * 0.39 + clamp01(tension) * 0.15);
}

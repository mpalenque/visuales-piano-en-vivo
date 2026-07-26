import { describe, expect, it } from 'vitest';
import {
  buildHrcLayout,
  createHrcTexture,
  mergeRadiance,
  readHrcPixel,
  runHrcReference,
  sampleHrcTexture,
  seedHrcFrustum,
  writeHrcPixel,
  type HrcTexture,
  type HrcVec4,
} from './hrc-reference';

const scene = (extent: number): {
  emissivity: HrcTexture;
  absorption: HrcTexture;
} => ({
  emissivity: createHrcTexture(extent, extent),
  absorption: createHrcTexture(extent, extent),
});

const rgbEnergy = (texture: HrcTexture): number => {
  let energy = 0;
  for (let offset = 0; offset < texture.data.length; offset += 4) {
    energy += Math.max(0, texture.data[offset]);
    energy += Math.max(0, texture.data[offset + 1]);
    energy += Math.max(0, texture.data[offset + 2]);
  }
  return energy;
};

const expectFiniteTexture = (texture: HrcTexture): void => {
  for (const value of texture.data) expect(Number.isFinite(value)).toBe(true);
};

const rotateQuarterTurn = (source: HrcTexture): HrcTexture => {
  expect(source.width).toBe(source.height);
  const rotated = createHrcTexture(source.width, source.height);
  for (let y = 0; y < source.height; y += 1) {
    for (let x = 0; x < source.width; x += 1) {
      writeHrcPixel(
        rotated,
        source.width - 1 - y,
        x,
        readHrcPixel(source, x, y),
        false,
      );
    }
  }
  return rotated;
};

const maximumRgbDifference = (
  left: HrcTexture,
  right: HrcTexture,
  margin = 0,
): number => {
  expect(left.width).toBe(right.width);
  expect(left.height).toBe(right.height);
  let maximum = 0;
  for (let y = margin; y < left.height - margin; y += 1) {
    for (let x = margin; x < left.width - margin; x += 1) {
      const leftPixel = readHrcPixel(left, x, y);
      const rightPixel = readHrcPixel(right, x, y);
      maximum = Math.max(
        maximum,
        Math.abs(leftPixel[0] - rightPixel[0]),
        Math.abs(leftPixel[1] - rightPixel[1]),
        Math.abs(leftPixel[2] - rightPixel[2]),
      );
    }
  }
  return maximum;
};

const sourcePixel: HrcVec4 = [1, 0.55, 0.2, 1];
const absorbingPixel: HrcVec4 = [1, 1, 1, 1];

describe('HRC CPU reference', () => {
  it('builds the upstream power-of-two cascade layout', () => {
    const layout = buildHrcLayout(32);
    expect(layout.cascadeCount).toBe(5);
    expect(layout.cascades.map((cascade) => ({
      interval: cascade.interval,
      rays: cascade.raysPerProbe,
      rayWidth: cascade.rayWidth,
      mergeWidth: cascade.mergeWidth,
    }))).toEqual([
      { interval: 1, rays: 2, rayWidth: 64, mergeWidth: 32 },
      { interval: 2, rays: 3, rayWidth: 48, mergeWidth: 32 },
      { interval: 4, rays: 5, rayWidth: 40, mergeWidth: 32 },
      { interval: 8, rays: 9, rayWidth: 36, mergeWidth: 32 },
      { interval: 16, rays: 17, rayWidth: 34, mergeWidth: 32 },
    ]);
    expect(() => buildHrcLayout(24)).toThrow(/power of two/);
    expect(() => buildHrcLayout(1)).toThrow(/power of two/);
  });

  it('uses explicit radiance/transmittance defaults outside a texture', () => {
    const texture = createHrcTexture(2, 2);
    writeHrcPixel(texture, 0, 0, [0.25, 0.5, 0.75, 1], false);
    expect(sampleHrcTexture(texture, 0.1, 0.1)).toEqual([0.25, 0.5, 0.75, 1]);
    expect(sampleHrcTexture(texture, -0.01, 0.5, [0, 0, 0, 0]))
      .toEqual([0, 0, 0, 0]);
    expect(sampleHrcTexture(texture, 1, 0.5, [1, 1, 1, 1]))
      .toEqual([1, 1, 1, 1]);
  });

  it('composes straight segments as near radiance plus transmitted far radiance', () => {
    const merged = mergeRadiance(
      [0.2, 0.3, 0.4, 1],
      [0.5, 0.25, 0.75, 1],
      [0.8, 0.4, 0.2, 1],
      [0.25, 0.5, 0.8, 1],
    );
    expect(merged.radiance[0]).toBeCloseTo(0.6);
    expect(merged.radiance[1]).toBeCloseTo(0.4);
    expect(merged.radiance[2]).toBeCloseTo(0.55);
    expect(merged.radiance[3]).toBeCloseTo(2);
    expect(merged.transmit[0]).toBeCloseTo(0.125);
    expect(merged.transmit[1]).toBeCloseTo(0.125);
    expect(merged.transmit[2]).toBeCloseTo(0.6);
    expect(merged.transmit[3]).toBeCloseTo(1);
  });

  it('keeps an empty field finite and exactly dark', () => {
    const empty = scene(8);
    const result = runHrcReference(empty.emissivity, empty.absorption);

    expect(rgbEnergy(result.fluence)).toBe(0);
    expectFiniteTexture(result.fluence);
    for (const frustum of result.frustums) {
      for (const cascade of frustum.raysByLevel) {
        expect(rgbEnergy(cascade.radiance)).toBe(0);
        expectFiniteTexture(cascade.radiance);
        expectFiniteTexture(cascade.transmit);
      }
      for (const merge of frustum.mergesByLevel) {
        expect(rgbEnergy(merge.radiance)).toBe(0);
        expectFiniteTexture(merge.radiance);
        expectFiniteTexture(merge.transmit);
      }
    }
  });

  it('requires an emitting pixel to absorb before it contributes radiance', () => {
    const extent = 16;
    const lit = scene(extent);
    writeHrcPixel(lit.emissivity, 4, 7, sourcePixel);
    writeHrcPixel(lit.absorption, 4, 7, absorbingPixel);
    const litResult = runHrcReference(lit.emissivity, lit.absorption);
    expect(rgbEnergy(litResult.fluence)).toBeGreaterThan(0);

    const nonAbsorbing = scene(extent);
    writeHrcPixel(nonAbsorbing.emissivity, 4, 7, sourcePixel);
    const nonAbsorbingResult = runHrcReference(
      nonAbsorbing.emissivity,
      nonAbsorbing.absorption,
    );
    expect(rgbEnergy(nonAbsorbingResult.fluence)).toBe(0);

    const seed = seedHrcFrustum(
      lit.emissivity,
      lit.absorption,
      buildHrcLayout(extent),
      0,
    );
    expect(rgbEnergy(seed.radiance)).toBeGreaterThan(0);
    expectFiniteTexture(seed.radiance);
    expectFiniteTexture(seed.transmit);
  });

  it('attenuates a receiver when an absorbing wall blocks the emitter', () => {
    const extent = 32;
    const open = scene(extent);
    writeHrcPixel(open.emissivity, 6, 16, [1, 1, 1, 1]);
    writeHrcPixel(open.absorption, 6, 16, absorbingPixel);
    const blocked = {
      emissivity: open.emissivity,
      absorption: createHrcTexture(extent, extent),
    };
    writeHrcPixel(blocked.absorption, 6, 16, absorbingPixel);
    for (let y = 0; y < extent; y += 1) {
      writeHrcPixel(blocked.absorption, 16, y, [10, 10, 10, 1]);
    }

    const openResult = runHrcReference(open.emissivity, open.absorption);
    const blockedResult = runHrcReference(blocked.emissivity, blocked.absorption);
    const openReceiver = readHrcPixel(openResult.fluence, 25, 16);
    const blockedReceiver = readHrcPixel(blockedResult.fluence, 25, 16);

    expect(openReceiver[0]).toBeGreaterThan(0);
    expect(blockedReceiver[0]).toBeLessThan(openReceiver[0]);
    expectFiniteTexture(blockedResult.fluence);
  });

  it('is equivariant under a quarter turn away from the one-texel boundary', () => {
    const extent = 16;
    const original = scene(extent);
    writeHrcPixel(original.emissivity, 3, 5, sourcePixel);
    writeHrcPixel(original.absorption, 3, 5, absorbingPixel);
    for (let y = 4; y <= 11; y += 1) {
      writeHrcPixel(original.absorption, 9, y, [4, 2, 1, 1]);
    }
    const rotatedEmission = rotateQuarterTurn(original.emissivity);
    const rotatedAbsorption = rotateQuarterTurn(original.absorption);

    const originalResult = runHrcReference(
      original.emissivity,
      original.absorption,
    );
    const rotatedResult = runHrcReference(
      rotatedEmission,
      rotatedAbsorption,
    );
    const expectedRotation = rotateQuarterTurn(originalResult.fluence);

    expect(maximumRgbDifference(expectedRotation, rotatedResult.fluence, 2))
      .toBeLessThanOrEqual(0.01);
  });
});

import { DataUtils } from 'three';

/**
 * Independent CPU transcription of the ray-extension implementation in
 * Yaazarai/Volumetric-HRC. It intentionally does not import the production HRC
 * shaders or helpers, so parity tests can detect coordinate/indexing drift.
 */

export type HrcVec4 = readonly [number, number, number, number];

export interface HrcTexture {
  readonly width: number;
  readonly height: number;
  readonly data: Float32Array;
}

export interface HrcVolumePair {
  readonly radiance: HrcTexture;
  readonly transmit: HrcTexture;
}

export interface HrcCascadeLayout {
  readonly level: number;
  readonly interval: number;
  readonly raysPerProbe: number;
  readonly rayWidth: number;
  readonly mergeWidth: number;
  readonly height: number;
}

export interface HrcLayout {
  readonly extent: number;
  readonly cascadeCount: number;
  readonly cascades: readonly HrcCascadeLayout[];
}

export interface HrcReferenceOptions {
  /**
   * The WebGL port writes its internal targets as RGBA16F. Quantizing after
   * every pass models the value that the following pass actually samples.
   */
  quantizeHalf?: boolean;
  /**
   * GameMaker supplies sRGB sprites and linearizes them in the seed shader.
   * The WebGL port supplies an already-linear scene MRT, which is the default.
   */
  inputTransfer?: 'linear' | 'upstream-srgb';
  /**
   * The WebGL field remains linear for feedback/composition. The upstream demo
   * converts its final display surface to sRGB.
   */
  outputTransfer?: 'linear' | 'upstream-srgb';
}

export interface HrcFrustumReference {
  readonly raysByLevel: readonly HrcVolumePair[];
  readonly mergesByLevel: readonly HrcVolumePair[];
  readonly output: HrcTexture;
}

export interface HrcReferenceResult {
  readonly layout: HrcLayout;
  readonly frustums: readonly HrcFrustumReference[];
  readonly fluence: HrcTexture;
}

interface NumericPolicy {
  readonly quantizeHalf: boolean;
  readonly inputTransfer: 'linear' | 'upstream-srgb';
  readonly outputTransfer: 'linear' | 'upstream-srgb';
}

interface Point {
  readonly x: number;
  readonly y: number;
}

const ZERO: HrcVec4 = [0, 0, 0, 0];
const ONE: HrcVec4 = [1, 1, 1, 1];

const policyFor = (options: HrcReferenceOptions = {}): NumericPolicy => ({
  quantizeHalf: options.quantizeHalf ?? true,
  inputTransfer: options.inputTransfer ?? 'linear',
  outputTransfer: options.outputTransfer ?? 'linear',
});

const quantize = (value: number, enabled: boolean): number =>
  enabled ? DataUtils.fromHalfFloat(DataUtils.toHalfFloat(value)) : value;

const map4 = (
  value: HrcVec4,
  transform: (channel: number, index: number) => number,
): HrcVec4 => [
  transform(value[0], 0),
  transform(value[1], 1),
  transform(value[2], 2),
  transform(value[3], 3),
];

const add4 = (left: HrcVec4, right: HrcVec4): HrcVec4 => [
  left[0] + right[0],
  left[1] + right[1],
  left[2] + right[2],
  left[3] + right[3],
];

const multiply4 = (left: HrcVec4, right: HrcVec4): HrcVec4 => [
  left[0] * right[0],
  left[1] * right[1],
  left[2] * right[2],
  left[3] * right[3],
];

const scale4 = (value: HrcVec4, scale: number): HrcVec4 => [
  value[0] * scale,
  value[1] * scale,
  value[2] * scale,
  value[3] * scale,
];

const mix4 = (left: HrcVec4, right: HrcVec4, amount: number): HrcVec4 => [
  left[0] + (right[0] - left[0]) * amount,
  left[1] + (right[1] - left[1]) * amount,
  left[2] + (right[2] - left[2]) * amount,
  left[3] + (right[3] - left[3]) * amount,
];

const assertTextureSize = (
  texture: HrcTexture,
  width: number,
  height: number,
  label: string,
): void => {
  if (texture.width !== width || texture.height !== height) {
    throw new Error(
      `${label} must be ${width}x${height}; received ${texture.width}x${texture.height}.`,
    );
  }
};

export function buildHrcLayout(extent: number): HrcLayout {
  if (
    !Number.isInteger(extent)
    || extent < 2
    || (extent & (extent - 1)) !== 0
  ) {
    throw new Error(`HRC extent must be an integer power of two >= 2; received ${extent}.`);
  }

  const cascadeCount = Math.ceil(Math.log2(extent));
  const cascades = Array.from({ length: cascadeCount }, (_, level) => {
    const interval = 2 ** level;
    const raysPerProbe = interval + 1;
    return {
      level,
      interval,
      raysPerProbe,
      rayWidth: Math.floor(extent / interval) * raysPerProbe,
      mergeWidth: Math.floor(extent / interval) * interval,
      height: extent,
    };
  });
  return { extent, cascadeCount, cascades };
}

export function createHrcTexture(
  width: number,
  height: number,
  fill: HrcVec4 = ZERO,
): HrcTexture {
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    throw new Error(`Texture dimensions must be positive integers; received ${width}x${height}.`);
  }
  const texture: HrcTexture = {
    width,
    height,
    data: new Float32Array(width * height * 4),
  };
  if (fill.some((channel) => channel !== 0)) {
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        writeHrcPixel(texture, x, y, fill, false);
      }
    }
  }
  return texture;
}

export function readHrcPixel(texture: HrcTexture, x: number, y: number): HrcVec4 {
  if (x < 0 || x >= texture.width || y < 0 || y >= texture.height) {
    throw new Error(`Pixel ${x},${y} lies outside ${texture.width}x${texture.height}.`);
  }
  const offset = (y * texture.width + x) * 4;
  return [
    texture.data[offset],
    texture.data[offset + 1],
    texture.data[offset + 2],
    texture.data[offset + 3],
  ];
}

export function writeHrcPixel(
  texture: HrcTexture,
  x: number,
  y: number,
  value: HrcVec4,
  quantizeHalf = true,
): void {
  if (x < 0 || x >= texture.width || y < 0 || y >= texture.height) {
    throw new Error(`Pixel ${x},${y} lies outside ${texture.width}x${texture.height}.`);
  }
  const offset = (y * texture.width + x) * 4;
  texture.data[offset] = quantize(value[0], quantizeHalf);
  texture.data[offset + 1] = quantize(value[1], quantizeHalf);
  texture.data[offset + 2] = quantize(value[2], quantizeHalf);
  texture.data[offset + 3] = quantize(value[3], quantizeHalf);
}

export function sampleHrcTexture(
  texture: HrcTexture,
  u: number,
  v: number,
  outside: HrcVec4 = ZERO,
): HrcVec4 {
  if (
    !Number.isFinite(u)
    || !Number.isFinite(v)
    || u < 0
    || v < 0
    || u >= 1
    || v >= 1
  ) {
    return outside;
  }
  return readHrcPixel(
    texture,
    Math.floor(u * texture.width),
    Math.floor(v * texture.height),
  );
}

const sampleClamped = (
  texture: HrcTexture,
  u: number,
  v: number,
): HrcVec4 => readHrcPixel(
  texture,
  Math.max(0, Math.min(texture.width - 1, Math.floor(u * texture.width))),
  Math.max(0, Math.min(texture.height - 1, Math.floor(v * texture.height))),
);

const writePassPixel = (
  texture: HrcTexture,
  x: number,
  y: number,
  value: HrcVec4,
  policy: NumericPolicy,
): void => writeHrcPixel(texture, x, y, value, policy.quantizeHalf);

const createPair = (width: number, height: number): HrcVolumePair => ({
  radiance: createHrcTexture(width, height),
  transmit: createHrcTexture(width, height),
});

const cloneTexture = (
  source: HrcTexture,
  policy: NumericPolicy,
): HrcTexture => {
  const clone = createHrcTexture(source.width, source.height);
  for (let y = 0; y < source.height; y += 1) {
    for (let x = 0; x < source.width; x += 1) {
      writePassPixel(clone, x, y, readHrcPixel(source, x, y), policy);
    }
  }
  return clone;
};

const transferInput = (
  value: HrcVec4,
  policy: NumericPolicy,
): HrcVec4 => policy.inputTransfer === 'upstream-srgb'
  ? [
      Math.pow(Math.max(0, value[0]), 2.2),
      Math.pow(Math.max(0, value[1]), 2.2),
      Math.pow(Math.max(0, value[2]), 2.2),
      value[3],
    ]
  : value;

const rotatedSceneUv = (probe: Point, frustumIndex: number): Point => {
  if (frustumIndex === 0) return probe;
  if (frustumIndex === 1) return { x: 1 - probe.y, y: 1 - probe.x };
  if (frustumIndex === 2) return { x: 1 - probe.x, y: 1 - probe.y };
  return { x: probe.y, y: probe.x };
};

export function seedHrcFrustum(
  emissivity: HrcTexture,
  absorption: HrcTexture,
  layout: HrcLayout,
  frustumIndex: number,
  options: HrcReferenceOptions = {},
): HrcVolumePair {
  if (!Number.isInteger(frustumIndex) || frustumIndex < 0 || frustumIndex >= 4) {
    throw new Error(`Frustum index must be 0, 1, 2 or 3; received ${frustumIndex}.`);
  }
  assertTextureSize(emissivity, layout.extent, layout.extent, 'Emissivity');
  assertTextureSize(absorption, layout.extent, layout.extent, 'Absorption');
  const policy = policyFor(options);
  const cascade = layout.cascades[0];
  const output = createPair(cascade.rayWidth, cascade.height);

  for (let y = 0; y < output.radiance.height; y += 1) {
    for (let x = 0; x < output.radiance.width; x += 1) {
      const texelX = x + 0.5;
      const texelY = y + 0.5;
      const plane = Math.floor(texelX / cascade.raysPerProbe);
      const probe = {
        x: (plane * cascade.interval + 0.5) / layout.extent,
        y: texelY / layout.extent,
      };
      const sceneUv = rotatedSceneUv(probe, frustumIndex);
      const emission = transferInput(
        sampleHrcTexture(emissivity, sceneUv.x, sceneUv.y),
        policy,
      );
      const absorb = transferInput(
        sampleHrcTexture(absorption, sceneUv.x, sceneUv.y),
        policy,
      );
      const transmit: HrcVec4 = [
        2 ** -absorb[0],
        2 ** -absorb[1],
        2 ** -absorb[2],
        1,
      ];
      const radiance: HrcVec4 = [
        (1 - transmit[0]) * emission[0],
        (1 - transmit[1]) * emission[1],
        (1 - transmit[2]) * emission[2],
        1,
      ];
      writePassPixel(output.radiance, x, y, radiance, policy);
      writePassPixel(output.transmit, x, y, transmit, policy);
    }
  }
  return output;
}

export function mergeRadiance(
  nearRadiance: HrcVec4,
  nearTransmit: HrcVec4,
  farRadiance: HrcVec4,
  farTransmit: HrcVec4,
): { radiance: HrcVec4; transmit: HrcVec4 } {
  return {
    radiance: add4(nearRadiance, multiply4(farRadiance, nearTransmit)),
    transmit: multiply4(nearTransmit, farTransmit),
  };
}

const getPreviousRayVolume = (
  previous: HrcVolumePair,
  probe: Point,
  index: number,
  interval: number,
  lookupWidth: number,
): { radiance: HrcVec4; transmit: HrcVec4 } => {
  const u = (
    Math.floor(probe.x / interval) * lookupWidth
    + 0.5
    + index
  ) / previous.radiance.width;
  const v = probe.y / previous.radiance.height;
  return {
    radiance: sampleHrcTexture(previous.radiance, u, v, ZERO),
    transmit: sampleHrcTexture(previous.transmit, u, v, ONE),
  };
};

const extendOneRay = (
  previous: HrcVolumePair,
  probe: Point,
  lowerIndex: number,
  upperIndex: number,
  previousInterval: number,
  previousRaysPerProbe: number,
): { radiance: HrcVec4; transmit: HrcVec4 } => {
  const mergeProbe = {
    x: probe.x + previousInterval,
    y: probe.y - previousInterval + lowerIndex * 2,
  };
  const near = getPreviousRayVolume(
    previous,
    probe,
    lowerIndex,
    previousInterval,
    previousRaysPerProbe,
  );
  const far = getPreviousRayVolume(
    previous,
    mergeProbe,
    upperIndex,
    previousInterval,
    previousRaysPerProbe,
  );
  return mergeRadiance(near.radiance, near.transmit, far.radiance, far.transmit);
};

export function extendHrcCascade(
  previous: HrcVolumePair,
  cascade: HrcCascadeLayout,
  options: HrcReferenceOptions = {},
): HrcVolumePair {
  if (cascade.level < 1) throw new Error('Ray extension requires cascade level >= 1.');
  const policy = policyFor(options);
  const previousInterval = 2 ** (cascade.level - 1);
  const previousRaysPerProbe = previousInterval + 1;
  const output = createPair(cascade.rayWidth, cascade.height);

  for (let y = 0; y < output.radiance.height; y += 1) {
    for (let x = 0; x < output.radiance.width; x += 1) {
      const texelX = x + 0.5;
      const texelY = y + 0.5;
      const plane = Math.floor(texelX / cascade.raysPerProbe);
      const index = Math.floor(texelX - plane * cascade.raysPerProbe);
      const probe = {
        x: plane * cascade.interval + 0.5,
        y: texelY,
      };
      const lower = Math.floor(index * 0.5);
      const upper = Math.ceil(index * 0.5);
      const lowerRay = extendOneRay(
        previous,
        probe,
        lower,
        upper,
        previousInterval,
        previousRaysPerProbe,
      );
      const upperRay = extendOneRay(
        previous,
        probe,
        upper,
        lower,
        previousInterval,
        previousRaysPerProbe,
      );
      writePassPixel(
        output.radiance,
        x,
        y,
        mix4(lowerRay.radiance, upperRay.radiance, 0.5),
        policy,
      );
      writePassPixel(
        output.transmit,
        x,
        y,
        mix4(lowerRay.transmit, upperRay.transmit, 0.5),
        policy,
      );
    }
  }
  return output;
}

export function buildHrcRayCascades(
  emissivity: HrcTexture,
  absorption: HrcTexture,
  layout: HrcLayout,
  frustumIndex: number,
  options: HrcReferenceOptions = {},
): HrcVolumePair[] {
  const cascades = [
    seedHrcFrustum(emissivity, absorption, layout, frustumIndex, options),
  ];
  for (let level = 1; level < layout.cascadeCount; level += 1) {
    cascades.push(extendHrcCascade(cascades[level - 1], layout.cascades[level], options));
  }
  return cascades;
}

const getRayVolume = (
  rays: HrcVolumePair,
  probe: Point,
  index: number,
  interval: number,
  raysPerProbe: number,
): { radiance: HrcVec4; transmit: HrcVec4 } =>
  getPreviousRayVolume(rays, probe, index, interval, raysPerProbe);

const getFarConeVolume = (
  far: HrcVolumePair | undefined,
  probe: Point,
  index: number,
): { radiance: HrcVec4; transmit: HrcVec4 } => {
  if (!far) return { radiance: ZERO, transmit: ONE };
  const u = (Math.floor(probe.x) + 0.5 + index) / far.radiance.width;
  const v = probe.y / far.radiance.height;
  return {
    radiance: sampleHrcTexture(far.radiance, u, v, ZERO),
    transmit: sampleHrcTexture(far.transmit, u, v, ONE),
  };
};

const mergeOneCone = (
  rays: HrcVolumePair,
  far: HrcVolumePair | undefined,
  probe: Point,
  plane: number,
  cascade: HrcCascadeLayout,
  index: number,
  side: number,
): { radiance: HrcVec4; transmit: HrcVec4 } => {
  const coneIndex = index * 2 + side;
  const rayIndex = index + side;
  const limit = { x: cascade.interval, y: -cascade.interval };
  const alignment = 2 - (plane % 2);
  const mergeProbe = {
    x: probe.x + alignment * limit.x,
    y: probe.y + alignment * (limit.y + rayIndex * 2),
  };
  const leftRay = {
    x: limit.x * 2,
    y: limit.y * 2 + coneIndex * 2,
  };
  const rightRay = {
    x: limit.x * 2,
    y: limit.y * 2 + (coneIndex + 1) * 2,
  };
  const coneWeight = 0.5 * (
    Math.atan(rightRay.y / rightRay.x)
    - Math.atan(leftRay.y / leftRay.x)
  );
  const ray = getRayVolume(
    rays,
    probe,
    rayIndex,
    cascade.interval,
    cascade.raysPerProbe,
  );
  const farCone = getFarConeVolume(far, mergeProbe, coneIndex);

  if (plane % 2 === 0) {
    const farProbe = {
      x: probe.x + limit.x,
      y: probe.y + limit.y + rayIndex * 2,
    };
    const extendedRay = getRayVolume(
      rays,
      farProbe,
      rayIndex,
      cascade.interval,
      cascade.raysPerProbe,
    );
    const nearCone = getFarConeVolume(far, probe, coneIndex);
    const extended = mergeRadiance(
      ray.radiance,
      ray.transmit,
      extendedRay.radiance,
      extendedRay.transmit,
    );
    const merged = mergeRadiance(
      scale4(extended.radiance, coneWeight),
      extended.transmit,
      farCone.radiance,
      farCone.transmit,
    );
    return {
      radiance: mix4(merged.radiance, nearCone.radiance, 0.5),
      transmit: mix4(merged.transmit, nearCone.transmit, 0.5),
    };
  }

  return {
    radiance: add4(
      scale4(ray.radiance, coneWeight),
      multiply4(farCone.radiance, ray.transmit),
    ),
    transmit: multiply4(ray.transmit, farCone.transmit),
  };
};

export function mergeHrcCascades(
  raysByLevel: readonly HrcVolumePair[],
  layout: HrcLayout,
  options: HrcReferenceOptions = {},
): HrcVolumePair[] {
  if (raysByLevel.length !== layout.cascadeCount) {
    throw new Error(
      `Expected ${layout.cascadeCount} ray cascades; received ${raysByLevel.length}.`,
    );
  }
  const policy = policyFor(options);
  const mergedByLevel = Array<HrcVolumePair>(layout.cascadeCount);
  let far: HrcVolumePair | undefined;

  for (let level = layout.cascadeCount - 1; level >= 0; level -= 1) {
    const cascade = layout.cascades[level];
    const rays = raysByLevel[level];
    assertTextureSize(rays.radiance, cascade.rayWidth, cascade.height, `Rays c${level}`);
    assertTextureSize(rays.transmit, cascade.rayWidth, cascade.height, `Transmit c${level}`);
    const current = createPair(cascade.mergeWidth, cascade.height);

    for (let y = 0; y < current.radiance.height; y += 1) {
      for (let x = 0; x < current.radiance.width; x += 1) {
        const texelX = x + 0.5;
        const texelY = y + 0.5;
        const plane = Math.floor(texelX / cascade.interval);
        const index = Math.floor(texelX - plane * cascade.interval);
        const probe = {
          x: plane * cascade.interval + 0.5,
          y: texelY,
        };
        let left = mergeOneCone(rays, far, probe, plane, cascade, index, 0);
        let right = mergeOneCone(rays, far, probe, plane, cascade, index, 1);
        if (probe.x < 1) {
          left = { radiance: ZERO, transmit: ZERO };
          right = { radiance: ZERO, transmit: ZERO };
        }
        writePassPixel(
          current.radiance,
          x,
          y,
          add4(left.radiance, right.radiance),
          policy,
        );
        writePassPixel(
          current.transmit,
          x,
          y,
          add4(left.transmit, right.transmit),
          policy,
        );
      }
    }
    mergedByLevel[level] = current;
    far = current;
  }
  return mergedByLevel;
}

export function sumHrcFluence(
  frustums: readonly HrcTexture[],
  extent: number,
  options: HrcReferenceOptions = {},
): HrcTexture {
  if (frustums.length !== 4) {
    throw new Error(`HRC fluence requires four frustums; received ${frustums.length}.`);
  }
  frustums.forEach((frustum, index) => {
    assertTextureSize(frustum, extent, extent, `Frustum ${index}`);
  });
  const policy = policyFor(options);
  const output = createHrcTexture(extent, extent);
  const pixel = 1 / extent;

  for (let y = 0; y < extent; y += 1) {
    for (let x = 0; x < extent; x += 1) {
      const u = (x + 0.5) / extent;
      const v = (y + 0.5) / extent;
      const samples = [
        sampleClamped(frustums[0], u + pixel, v),
        sampleClamped(frustums[1], 1 - (v - pixel), 1 - u),
        sampleClamped(frustums[2], 1 - (u - pixel), 1 - v),
        sampleClamped(frustums[3], v + pixel, u),
      ];
      const radiance = scale4(
        samples.reduce<HrcVec4>((sum, sample) => add4(sum, sample), ZERO),
        0.25,
      );
      const linear: HrcVec4 = [
        Math.max(0, radiance[0]),
        Math.max(0, radiance[1]),
        Math.max(0, radiance[2]),
        1,
      ];
      const transferred = policy.outputTransfer === 'upstream-srgb'
        ? map4(
            linear,
            (channel, index) => index < 3
              ? Math.pow(Math.max(0, channel), 1 / 2.2)
              : channel,
          )
        : linear;
      writePassPixel(output, x, y, transferred, policy);
    }
  }
  return output;
}

export function runHrcReference(
  emissivity: HrcTexture,
  absorption: HrcTexture,
  options: HrcReferenceOptions = {},
): HrcReferenceResult {
  if (emissivity.width !== emissivity.height) {
    throw new Error('HRC scene textures must be square.');
  }
  assertTextureSize(
    absorption,
    emissivity.width,
    emissivity.height,
    'Absorption',
  );
  const layout = buildHrcLayout(emissivity.width);
  const frustums = Array.from({ length: 4 }, (_, frustumIndex) => {
    const raysByLevel = buildHrcRayCascades(
      emissivity,
      absorption,
      layout,
      frustumIndex,
      options,
    );
    const mergesByLevel = mergeHrcCascades(raysByLevel, layout, options);
    return {
      raysByLevel,
      mergesByLevel,
      output: cloneTexture(mergesByLevel[0].radiance, policyFor(options)),
    };
  });
  return {
    layout,
    frustums,
    fluence: sumHrcFluence(
      frustums.map((frustum) => frustum.output),
      layout.extent,
      options,
    ),
  };
}

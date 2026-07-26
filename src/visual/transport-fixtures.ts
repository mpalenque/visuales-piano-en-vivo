import type { AmitabhaBody } from './amitabha-radiance-field';
import {
  diffuseOpticalMaterial,
  glassOpticalMaterial,
  mirrorOpticalMaterial,
  transparentOpticalMaterial,
  type OpticalMaterialKind,
} from './optical-materials';

export type TransportFixtureName =
  | 'hrc-point'
  | 'hrc-wall'
  | 'mirror-law'
  | 'glass-prism'
  | 'glass-lens';

export interface TransportFixtureOptions {
  name: TransportFixtureName;
  materialOverride?: OpticalMaterialKind | null;
  mirrorAngle?: number;
  ior?: number;
  receiver?: boolean;
  occluder?: boolean;
  emitterEnabled?: boolean;
  emitterOffset?: readonly [number, number];
  emitterStrength?: number;
}

export interface TransportFixtureBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

const diffuse = diffuseOpticalMaterial();

const body = (
  source: Omit<AmitabhaBody, 'transportRole' | 'transportOrder'>,
  transportOrder: number,
): AmitabhaBody => ({
  ...source,
  transportRole: 'body',
  transportOrder,
});

const materialFor = (
  kind: OpticalMaterialKind,
  ior: number,
) => {
  if (kind === 'mirror') return mirrorOpticalMaterial();
  if (kind === 'glass') return glassOpticalMaterial({ ior });
  if (kind === 'transparent') return transparentOpticalMaterial();
  return diffuse;
};

const emitterBody = (
  x: number,
  y: number,
  strength: number,
  order: number,
): AmitabhaBody => body({
  x,
  y,
  halfWidth: 0.34,
  halfHeight: 0.34,
  angle: 0,
  emission: [1, 1, 1],
  emissionStrength: strength,
  albedo: [0, 0, 0],
  material: diffuse,
}, order);

const receiverBody = (): AmitabhaBody => body({
  x: 3,
  y: 0,
  halfWidth: 0.35,
  halfHeight: 2.8,
  angle: 0,
  emission: [0, 0, 0],
  emissionStrength: 0,
  albedo: [0.62, 0.62, 0.62],
  material: diffuse,
}, 1);

const occluderBody = (): AmitabhaBody => body({
  x: 1.65,
  y: -0.15,
  halfWidth: 0.16,
  halfHeight: 1.65,
  angle: 0.08,
  emission: [0, 0, 0],
  emissionStrength: 0,
  albedo: [0.18, 0.18, 0.18],
  material: diffuse,
}, 4);

export function createTransportFixture(
  options: TransportFixtureOptions,
): AmitabhaBody[] {
  const receiver = options.receiver ?? true;
  const occluder = options.occluder ?? false;
  const emitterEnabled = options.emitterEnabled ?? true;
  const emitterOffset = options.emitterOffset ?? [0, 0];
  const emitterStrength = Math.max(0, options.emitterStrength ?? 1);
  const ior = Math.max(1, Math.min(1.8, options.ior ?? 1.5));
  const bodies: AmitabhaBody[] = [];

  if (options.name === 'hrc-point' || options.name === 'hrc-wall') {
    if (emitterEnabled) {
      bodies.push(emitterBody(
        -2.7 + emitterOffset[0],
        emitterOffset[1],
        emitterStrength,
        1,
      ));
    }
    if (options.name === 'hrc-wall') {
      bodies.push(body({
        x: 0,
        y: 0,
        halfWidth: 0.16,
        halfHeight: 2.3,
        angle: 0,
        emission: [0, 0, 0],
        emissionStrength: 0,
        albedo: [0.45, 0.45, 0.45],
        material: diffuse,
      }, 2));
    }
    return bodies;
  }

  if (receiver) bodies.push(receiverBody());

  const requestedKind = options.name === 'mirror-law'
    ? 'mirror'
    : 'glass';
  const materialKind = options.materialOverride ?? requestedKind;
  const opticalMaterial = materialFor(materialKind, ior);
  const mirror = options.name === 'mirror-law';

  bodies.push(body({
    x: 0,
    y: 0,
    halfWidth: mirror ? 1.6 : 1.1,
    halfHeight: mirror ? 0.08 : options.name === 'glass-prism' ? 1.0 : 1.2,
    angle: mirror ? options.mirrorAngle ?? Math.PI / 4 : Math.PI / 12,
    emission: [0, 0, 0],
    emissionStrength: 0,
    albedo: mirror ? [0.04, 0.04, 0.045] : [0.06, 0.075, 0.09],
    material: opticalMaterial,
    sides: mirror ? undefined : options.name === 'glass-prism' ? 3 : 8,
  }, 2));

  if (emitterEnabled) {
    const emitterPosition = mirror
      ? [0 + emitterOffset[0], -3 + emitterOffset[1]] as const
      : [-3 + emitterOffset[0], 0 + emitterOffset[1]] as const;
    bodies.push(emitterBody(
      emitterPosition[0],
      emitterPosition[1],
      emitterStrength,
      3,
    ));
  }
  if (occluder) bodies.push(occluderBody());
  return bodies;
}

const signedBoxDistance = (
  x: number,
  y: number,
  halfWidth: number,
  halfHeight: number,
): number => {
  const qx = Math.abs(x) - Math.max(halfWidth, 0.0001);
  const qy = Math.abs(y) - Math.max(halfHeight, 0.0001);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0))
    + Math.min(Math.max(qx, qy), 0);
};

const signedRegularDistance = (
  x: number,
  y: number,
  halfWidth: number,
  halfHeight: number,
  sides: number,
): number => {
  const safeWidth = Math.max(halfWidth, 0.0001);
  const safeHeight = Math.max(halfHeight, 0.0001);
  const normalizedX = x / safeWidth;
  const normalizedY = y / safeHeight;
  const count = Math.max(3, Math.min(8, Math.round(sides)));
  const sector = Math.PI * 2 / count;
  const halfSector = sector * 0.5;
  const folded = (
    (Math.atan2(normalizedY, normalizedX) % sector) + sector
  ) % sector - halfSector;
  const radius = Math.hypot(normalizedX, normalizedY);
  const faceDistance = radius * Math.cos(folded) - Math.cos(halfSector);
  const endpointDistance = Math.max(
    Math.abs(radius * Math.sin(folded)) - Math.sin(halfSector),
    0,
  );
  const magnitude = Math.hypot(faceDistance, endpointDistance);
  return (faceDistance > 0 ? magnitude : -magnitude)
    * Math.min(safeWidth, safeHeight);
};

/**
 * Analytic receiver mask matching the directional scene pass. Diagnostics use
 * it to detect stored energy outside a real diffuse, non-emissive receiver.
 */
export function createTransportReceiverMask(
  bodies: readonly AmitabhaBody[],
  width: number,
  height: number,
  bounds: TransportFixtureBounds,
): Float32Array {
  const safeWidth = Math.max(0, Math.floor(width));
  const safeHeight = Math.max(0, Math.floor(height));
  const mask = new Float32Array(safeWidth * safeHeight);
  if (safeWidth === 0 || safeHeight === 0) return mask;
  const cellWidth = (bounds.maxX - bounds.minX) / safeWidth;
  const cellHeight = (bounds.maxY - bounds.minY) / safeHeight;
  const hitEpsilon = 0.45 * Math.max(cellWidth, cellHeight);

  for (let y = 0; y < safeHeight; y += 1) {
    const worldY = bounds.minY + (y + 0.5) * cellHeight;
    for (let x = 0; x < safeWidth; x += 1) {
      const worldX = bounds.minX + (x + 0.5) * cellWidth;
      let nearestDistance = 64;
      let nearestBody: AmitabhaBody | null = null;
      for (const candidate of bodies) {
        const offsetX = worldX - candidate.x;
        const offsetY = worldY - candidate.y;
        const cosine = Math.cos(candidate.angle);
        const sine = Math.sin(candidate.angle);
        const localX = cosine * offsetX + sine * offsetY;
        const localY = -sine * offsetX + cosine * offsetY;
        const distance = (candidate.sides ?? 0) >= 3
          ? signedRegularDistance(
              localX,
              localY,
              candidate.halfWidth,
              candidate.halfHeight,
              candidate.sides ?? 3,
            )
          : signedBoxDistance(
              localX,
              localY,
              candidate.halfWidth,
              candidate.halfHeight,
            );
        if (distance >= nearestDistance) continue;
        nearestDistance = distance;
        nearestBody = candidate;
      }
      if (
        nearestBody
        && nearestDistance <= hitEpsilon
        && nearestBody.material.kind === 'diffuse'
        && nearestBody.emissionStrength <= 0.0001
      ) {
        mask[y * safeWidth + x] = 1;
      }
    }
  }
  return mask;
}

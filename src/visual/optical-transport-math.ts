import type { OpticalMaterialKind } from './optical-materials';
import { OPTICAL_MATERIAL_CODE } from './optical-materials';

export interface Point2 {
  x: number;
  y: number;
}

export interface OpticalSurfaceCode {
  bodyId: number;
  kind: OpticalMaterialKind;
}

const TWO_PI = Math.PI * 2;
const MATERIAL_KIND_BY_CODE: readonly OpticalMaterialKind[] = [
  'diffuse',
  'transparent',
  'mirror',
  'glass',
];

const length = (point: Point2): number => Math.hypot(point.x, point.y);

export function worldToBodyLocal(
  point: Point2,
  centre: Point2,
  angle: number,
): Point2 {
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  const x = point.x - centre.x;
  const y = point.y - centre.y;
  return {
    x: cosine * x + sine * y,
    y: -sine * x + cosine * y,
  };
}

export function signedDistanceBox(point: Point2, halfExtent: Point2): number {
  const qx = Math.abs(point.x) - Math.max(halfExtent.x, 0.0001);
  const qy = Math.abs(point.y) - Math.max(halfExtent.y, 0.0001);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0))
    + Math.min(Math.max(qx, qy), 0);
}

/**
 * Conservative distance estimator for an anisotropically scaled regular
 * polygon. Its zero set and sign are exact; the magnitude is intentionally
 * conservative so the GPU sphere marcher cannot step through thin surfaces.
 */
export function signedDistanceRegularPolygon(
  point: Point2,
  halfExtent: Point2,
  sides: number,
): number {
  const safeSides = Math.max(3, Math.min(8, Math.round(sides)));
  const safeHalf = {
    x: Math.max(halfExtent.x, 0.0001),
    y: Math.max(halfExtent.y, 0.0001),
  };
  const normalized = {
    x: point.x / safeHalf.x,
    y: point.y / safeHalf.y,
  };
  const sector = TWO_PI / safeSides;
  const halfSector = sector * 0.5;
  const folded = ((Math.atan2(normalized.y, normalized.x) % sector) + sector)
    % sector - halfSector;
  const radius = length(normalized);
  const faceDistance = radius * Math.cos(folded) - Math.cos(halfSector);
  const endpointDistance = Math.max(
    Math.abs(radius * Math.sin(folded)) - Math.sin(halfSector),
    0,
  );
  const magnitude = Math.hypot(faceDistance, endpointDistance);
  return (faceDistance > 0 ? magnitude : -magnitude)
    * Math.min(safeHalf.x, safeHalf.y);
}

export function packOpticalSurfaceCode(
  bodyId: number,
  kind: OpticalMaterialKind,
): number {
  const stableId = Math.max(0, Math.min(48, Math.floor(bodyId)));
  if (stableId === 0) return 0;
  return stableId * 4 + OPTICAL_MATERIAL_CODE[kind];
}

export function unpackOpticalSurfaceCode(value: number): OpticalSurfaceCode {
  const packed = Math.max(0, Math.round(Number.isFinite(value) ? value : 0));
  const bodyId = Math.floor(packed / 4);
  return {
    bodyId,
    kind: MATERIAL_KIND_BY_CODE[packed % 4] ?? 'diffuse',
  };
}

export function estimateNormal(
  sampleDistance: (point: Point2) => number,
  point: Point2,
  epsilon = 0.001,
): Point2 {
  const stableEpsilon = Math.max(1e-6, Math.abs(epsilon));
  const x = sampleDistance({ x: point.x + stableEpsilon, y: point.y })
    - sampleDistance({ x: point.x - stableEpsilon, y: point.y });
  const y = sampleDistance({ x: point.x, y: point.y + stableEpsilon })
    - sampleDistance({ x: point.x, y: point.y - stableEpsilon });
  const magnitude = Math.hypot(x, y);
  return magnitude > 1e-10
    ? { x: x / magnitude, y: y / magnitude }
    : { x: 0, y: 1 };
}

export function refractDirection2d(
  incident: Point2,
  normalAgainstIncident: Point2,
  eta: number,
): { direction: Point2; totalInternalReflection: boolean } {
  const incidentLength = Math.max(length(incident), 1e-10);
  const normalLength = Math.max(length(normalAgainstIncident), 1e-10);
  const ray = {
    x: incident.x / incidentLength,
    y: incident.y / incidentLength,
  };
  const normal = {
    x: normalAgainstIncident.x / normalLength,
    y: normalAgainstIncident.y / normalLength,
  };
  const stableEta = Number.isFinite(eta) ? Math.max(0, eta) : 1;
  const cosine = Math.max(0, Math.min(1, -(ray.x * normal.x + ray.y * normal.y)));
  const discriminant = 1 - stableEta * stableEta * Math.max(0, 1 - cosine * cosine);
  if (discriminant < -1e-5) {
    const dot = ray.x * normal.x + ray.y * normal.y;
    const reflected = {
      x: ray.x - 2 * dot * normal.x,
      y: ray.y - 2 * dot * normal.y,
    };
    return { direction: reflected, totalInternalReflection: true };
  }
  const root = Math.sqrt(Math.max(0, discriminant));
  const transmitted = {
    x: stableEta * ray.x + (stableEta * cosine - root) * normal.x,
    y: stableEta * ray.y + (stableEta * cosine - root) * normal.y,
  };
  const transmittedLength = Math.max(length(transmitted), 1e-10);
  return {
    direction: {
      x: transmitted.x / transmittedLength,
      y: transmitted.y / transmittedLength,
    },
    totalInternalReflection: false,
  };
}

import * as THREE from 'three';

export type ForwardOpticalMaterial = 'diffuse' | 'emitter' | 'mirror' | 'glass';
export type ForwardCausticsQuality = 'high' | 'safe' | 'off';

export interface ForwardVec2 {
  x: number;
  y: number;
}

export interface ForwardRgb {
  r: number;
  g: number;
  b: number;
}

export interface ForwardOpticalBody {
  id: number;
  order: number;
  center: ForwardVec2;
  vertices: readonly ForwardVec2[];
  material: ForwardOpticalMaterial;
  emission: ForwardRgb;
  emissionStrength: number;
  tint: ForwardRgb;
  reflectivity: number;
  ior: number;
  absorption: number;
}

export interface ForwardRayHit {
  body: ForwardOpticalBody;
  distance: number;
  position: ForwardVec2;
  outwardNormal: ForwardVec2;
}

export interface ForwardCausticDeposit {
  position: ForwardVec2;
  colour: ForwardRgb;
  alpha: number;
  size: number;
  material: 'mirror' | 'glass';
}

export interface ForwardCausticsTraceResult {
  deposits: ForwardCausticDeposit[];
  emitterCount: number;
  materialCount: number;
  rayCount: number;
  hitCount: number;
}

export interface ForwardCausticsStats {
  active: boolean;
  quality: ForwardCausticsQuality;
  emitterCount: number;
  materialCount: number;
  rayCount: number;
  hitCount: number;
  pointCount: number;
  updateHz: number;
  cpuTimeMs: number;
  drawCalls: number;
  targetMemoryBytes: number;
}

export function forwardOpticalMaterialForIndex(
  nonEmitterIndex: number,
  emissive: boolean,
): Exclude<ForwardOpticalMaterial, 'emitter'> {
  if (emissive) return 'diffuse';
  const cycle = Math.max(0, Math.floor(nonEmitterIndex)) % 3;
  if (cycle === 0) return 'glass';
  if (cycle === 1) return 'mirror';
  return 'diffuse';
}

interface ForwardCausticsBudget {
  raysPerPair: number;
  maxPairs: number;
  maxMaterials: number;
  updateHz: number;
}

interface RedirectedRay {
  origin: ForwardVec2;
  direction: ForwardVec2;
  colour: ForwardRgb;
  throughput: number;
  pathDistance: number;
}

const EPSILON = 0.0015;
const MAX_DEPOSITS = 1024;

const BUDGETS: Readonly<Record<ForwardCausticsQuality, ForwardCausticsBudget>> = {
  high: Object.freeze({
    raysPerPair: 192,
    maxPairs: 2,
    maxMaterials: 2,
    updateHz: 30,
  }),
  safe: Object.freeze({
    raysPerPair: 96,
    maxPairs: 2,
    maxMaterials: 2,
    updateHz: 20,
  }),
  off: Object.freeze({
    raysPerPair: 0,
    maxPairs: 0,
    maxMaterials: 0,
    updateHz: 0,
  }),
};

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.max(minimum, Math.min(maximum, value));

const add = (left: ForwardVec2, right: ForwardVec2): ForwardVec2 => ({
  x: left.x + right.x,
  y: left.y + right.y,
});

const subtract = (left: ForwardVec2, right: ForwardVec2): ForwardVec2 => ({
  x: left.x - right.x,
  y: left.y - right.y,
});

const multiply = (value: ForwardVec2, scalar: number): ForwardVec2 => ({
  x: value.x * scalar,
  y: value.y * scalar,
});

const dot = (left: ForwardVec2, right: ForwardVec2): number =>
  left.x * right.x + left.y * right.y;

const cross = (left: ForwardVec2, right: ForwardVec2): number =>
  left.x * right.y - left.y * right.x;

const length = (value: ForwardVec2): number => Math.hypot(value.x, value.y);

const normalize = (
  value: ForwardVec2,
  fallback: ForwardVec2 = { x: 1, y: 0 },
): ForwardVec2 => {
  const magnitude = length(value);
  if (magnitude <= 1e-9) return fallback;
  return multiply(value, 1 / magnitude);
};

const multiplyRgb = (left: ForwardRgb, right: ForwardRgb): ForwardRgb => ({
  r: left.r * right.r,
  g: left.g * right.g,
  b: left.b * right.b,
});

const scaleRgb = (value: ForwardRgb, scalar: number): ForwardRgb => ({
  r: value.r * scalar,
  g: value.g * scalar,
  b: value.b * scalar,
});

const polygonSignedArea = (vertices: readonly ForwardVec2[]): number => {
  let twiceArea = 0;
  for (let index = 0; index < vertices.length; index += 1) {
    const current = vertices[index];
    const next = vertices[(index + 1) % vertices.length];
    twiceArea += cross(current, next);
  }
  return twiceArea * 0.5;
};

export function rayConvexPolygonIntersection(
  origin: ForwardVec2,
  directionInput: ForwardVec2,
  vertices: readonly ForwardVec2[],
  minimumDistance = EPSILON,
): Omit<ForwardRayHit, 'body'> | null {
  if (vertices.length < 3) return null;
  const direction = normalize(directionInput);
  const counterClockwise = polygonSignedArea(vertices) >= 0;
  let nearestDistance = Number.POSITIVE_INFINITY;
  let nearestPosition: ForwardVec2 | null = null;
  let nearestNormal: ForwardVec2 | null = null;

  for (let index = 0; index < vertices.length; index += 1) {
    const start = vertices[index];
    const end = vertices[(index + 1) % vertices.length];
    const edge = subtract(end, start);
    const denominator = cross(direction, edge);
    if (Math.abs(denominator) <= 1e-9) continue;
    const offset = subtract(start, origin);
    const distanceAlongRay = cross(offset, edge) / denominator;
    const distanceAlongEdge = cross(offset, direction) / denominator;
    if (
      distanceAlongRay < minimumDistance
      || distanceAlongRay >= nearestDistance
      || distanceAlongEdge < -1e-6
      || distanceAlongEdge > 1 + 1e-6
    ) continue;

    nearestDistance = distanceAlongRay;
    nearestPosition = add(origin, multiply(direction, distanceAlongRay));
    const rawNormal = counterClockwise
      ? { x: edge.y, y: -edge.x }
      : { x: -edge.y, y: edge.x };
    nearestNormal = normalize(rawNormal);
  }

  if (!nearestPosition || !nearestNormal) return null;
  return {
    distance: nearestDistance,
    position: nearestPosition,
    outwardNormal: nearestNormal,
  };
}

export function reflectDirection(
  incidentInput: ForwardVec2,
  normalInput: ForwardVec2,
): ForwardVec2 {
  const incident = normalize(incidentInput);
  const normal = normalize(normalInput, { x: 0, y: 1 });
  return normalize(subtract(incident, multiply(normal, 2 * dot(incident, normal))));
}

export function refractDirection(
  incidentInput: ForwardVec2,
  normalAgainstIncidentInput: ForwardVec2,
  eta: number,
): ForwardVec2 | null {
  const incident = normalize(incidentInput);
  const normal = normalize(normalAgainstIncidentInput, multiply(incident, -1));
  const cosine = clamp(-dot(incident, normal), 0, 1);
  const discriminant = 1 - eta * eta * Math.max(0, 1 - cosine * cosine);
  if (discriminant < 0) return null;
  return normalize(add(
    multiply(incident, eta),
    multiply(normal, eta * cosine - Math.sqrt(discriminant)),
  ));
}

export function fresnelSchlick(
  cosine: number,
  firstIor: number,
  secondIor: number,
): number {
  const denominator = Math.max(1e-6, firstIor + secondIor);
  const ratio = (firstIor - secondIor) / denominator;
  const base = ratio * ratio;
  return base + (1 - base) * Math.pow(1 - clamp(cosine, 0, 1), 5);
}

const nearestRayHit = (
  origin: ForwardVec2,
  direction: ForwardVec2,
  bodies: readonly ForwardOpticalBody[],
  excludedBodyId: number,
): ForwardRayHit | null => {
  let nearest: ForwardRayHit | null = null;
  for (const body of bodies) {
    if (body.id === excludedBodyId) continue;
    const hit = rayConvexPolygonIntersection(origin, direction, body.vertices);
    if (!hit || (nearest && hit.distance >= nearest.distance)) continue;
    nearest = { ...hit, body };
  }
  return nearest;
};

const bodyRadius = (body: ForwardOpticalBody): number =>
  body.vertices.reduce(
    (maximum, vertex) => Math.max(maximum, length(subtract(vertex, body.center))),
    0,
  );

const redirectMirror = (
  emitter: ForwardOpticalBody,
  hit: ForwardRayHit,
  incident: ForwardVec2,
): RedirectedRay => {
  const direction = reflectDirection(incident, hit.outwardNormal);
  return {
    origin: add(hit.position, multiply(direction, EPSILON)),
    direction,
    colour: multiplyRgb(emitter.emission, hit.body.tint),
    throughput: clamp(hit.body.reflectivity, 0, 1),
    pathDistance: hit.distance,
  };
};

const redirectGlass = (
  emitter: ForwardOpticalBody,
  entry: ForwardRayHit,
  incident: ForwardVec2,
): RedirectedRay | null => {
  const glass = entry.body;
  const ior = clamp(glass.ior, 1.01, 1.8);
  const entryNormal = dot(incident, entry.outwardNormal) < 0
    ? entry.outwardNormal
    : multiply(entry.outwardNormal, -1);
  const insideDirection = refractDirection(incident, entryNormal, 1 / ior);
  if (!insideDirection) return null;
  const entryCosine = clamp(-dot(incident, entryNormal), 0, 1);
  const entryTransmission = 1 - fresnelSchlick(entryCosine, 1, ior);

  let insideOrigin = add(entry.position, multiply(insideDirection, EPSILON));
  let currentInsideDirection = insideDirection;
  let totalInsideDistance = 0;
  let exit = rayConvexPolygonIntersection(
    insideOrigin,
    currentInsideDirection,
    glass.vertices,
  );
  if (!exit) return null;
  totalInsideDistance += exit.distance;

  let exitNormalAgainstIncident = dot(currentInsideDirection, exit.outwardNormal) > 0
    ? multiply(exit.outwardNormal, -1)
    : exit.outwardNormal;
  let outsideDirection = refractDirection(
    currentInsideDirection,
    exitNormalAgainstIncident,
    ior,
  );

  if (!outsideDirection) {
    currentInsideDirection = reflectDirection(
      currentInsideDirection,
      exitNormalAgainstIncident,
    );
    insideOrigin = add(exit.position, multiply(currentInsideDirection, EPSILON));
    exit = rayConvexPolygonIntersection(
      insideOrigin,
      currentInsideDirection,
      glass.vertices,
    );
    if (!exit) return null;
    totalInsideDistance += exit.distance;
    exitNormalAgainstIncident = dot(currentInsideDirection, exit.outwardNormal) > 0
      ? multiply(exit.outwardNormal, -1)
      : exit.outwardNormal;
    outsideDirection = refractDirection(
      currentInsideDirection,
      exitNormalAgainstIncident,
      ior,
    );
    if (!outsideDirection) return null;
  }

  const exitCosine = clamp(
    -dot(currentInsideDirection, exitNormalAgainstIncident),
    0,
    1,
  );
  const exitTransmission = 1 - fresnelSchlick(exitCosine, ior, 1);
  const absorption = Math.max(0, glass.absorption);
  const absorbedTint: ForwardRgb = {
    r: Math.pow(clamp(glass.tint.r, 0.001, 1), absorption * totalInsideDistance),
    g: Math.pow(clamp(glass.tint.g, 0.001, 1), absorption * totalInsideDistance),
    b: Math.pow(clamp(glass.tint.b, 0.001, 1), absorption * totalInsideDistance),
  };

  return {
    origin: add(exit.position, multiply(outsideDirection, EPSILON)),
    direction: outsideDirection,
    colour: multiplyRgb(emitter.emission, absorbedTint),
    throughput: entryTransmission * exitTransmission,
    pathDistance: entry.distance + totalInsideDistance,
  };
};

const tracePair = (
  emitter: ForwardOpticalBody,
  opticalBody: ForwardOpticalBody,
  bodies: readonly ForwardOpticalBody[],
  raysPerPair: number,
  deposits: ForwardCausticDeposit[],
): { rayCount: number; hitCount: number } => {
  const toTarget = subtract(opticalBody.center, emitter.center);
  const targetDistance = length(toTarget);
  const radius = bodyRadius(opticalBody);
  if (targetDistance <= radius + EPSILON) return { rayCount: 0, hitCount: 0 };

  const centreAngle = Math.atan2(toTarget.y, toTarget.x);
  const angularRadius = Math.asin(clamp(radius / targetDistance, 0, 0.999)) + 0.015;
  let hitCount = 0;

  for (let rayIndex = 0; rayIndex < raysPerPair; rayIndex += 1) {
    const progress = (rayIndex + 0.5) / raysPerPair;
    const angle = centreAngle + (progress * 2 - 1) * angularRadius;
    const incident = { x: Math.cos(angle), y: Math.sin(angle) };
    const firstHit = nearestRayHit(emitter.center, incident, bodies, emitter.id);
    if (!firstHit || firstHit.body.id !== opticalBody.id) continue;

    const redirected = opticalBody.material === 'mirror'
      ? redirectMirror(emitter, firstHit, incident)
      : redirectGlass(emitter, firstHit, incident);
    if (!redirected) continue;

    const receiver = nearestRayHit(
      redirected.origin,
      redirected.direction,
      bodies,
      opticalBody.id,
    );
    if (
      !receiver
      || (receiver.body.material !== 'diffuse' && receiver.body.material !== 'emitter')
    ) continue;

    const incidence = clamp(-dot(redirected.direction, receiver.outwardNormal), 0, 1);
    if (incidence <= 0.001) continue;
    const totalDistance = redirected.pathDistance + receiver.distance;
    const attenuation = 1 / (1 + 0.045 * totalDistance * totalDistance);
    const energy = emitter.emissionStrength
      * redirected.throughput
      * attenuation
      * (0.28 + incidence * 0.72);
    if (energy <= 0.002) continue;

    const colourScale = 0.78 + clamp(energy, 0, 3.5) * 0.16;
    deposits.push({
      position: add(receiver.position, multiply(receiver.outwardNormal, 0.006)),
      colour: scaleRgb(redirected.colour, colourScale),
      alpha: clamp(0.02 + energy * 0.03, 0.02, 0.12),
      size: clamp(12 + energy * 3.2, 12, 24),
      material: opticalBody.material === 'mirror' ? 'mirror' : 'glass',
    });
    hitCount += 1;
    if (deposits.length >= MAX_DEPOSITS) break;
  }

  return { rayCount: raysPerPair, hitCount };
};

const pairVisibilityScore = (
  emitter: ForwardOpticalBody,
  opticalBody: ForwardOpticalBody,
  bodies: readonly ForwardOpticalBody[],
): number => {
  const toTarget = subtract(opticalBody.center, emitter.center);
  const targetDistance = length(toTarget);
  const radius = bodyRadius(opticalBody);
  if (targetDistance <= radius + EPSILON) return Number.NEGATIVE_INFINITY;
  const centreAngle = Math.atan2(toTarget.y, toTarget.x);
  const angularRadius = Math.asin(clamp(radius / targetDistance, 0, 0.999));
  let visibleSamples = 0;

  for (const offset of [-0.8, -0.4, 0, 0.4, 0.8]) {
    const angle = centreAngle + angularRadius * offset;
    const direction = { x: Math.cos(angle), y: Math.sin(angle) };
    const hit = nearestRayHit(emitter.center, direction, bodies, emitter.id);
    if (hit?.body.id === opticalBody.id) visibleSamples += 1;
  }

  const distanceAttenuation = emitter.emissionStrength
    / (1 + 0.045 * targetDistance * targetDistance);
  return visibleSamples * 1000 + distanceAttenuation;
};

export function traceForwardCaustics(
  bodies: readonly ForwardOpticalBody[],
  quality: ForwardCausticsQuality,
): ForwardCausticsTraceResult {
  const budget = BUDGETS[quality];
  if (quality === 'off') {
    return {
      deposits: [],
      emitterCount: 0,
      materialCount: 0,
      rayCount: 0,
      hitCount: 0,
    };
  }

  const emitters = bodies
    .filter((body) => body.material === 'emitter' && body.emissionStrength > 0)
    .sort((left, right) => right.emissionStrength - left.emissionStrength)
    .slice(0, 8);
  const materials = bodies
    .filter((body) => body.material === 'mirror' || body.material === 'glass')
    .sort((left, right) => right.order - left.order)
    .slice(0, Math.min(budget.maxMaterials, budget.maxPairs));
  const deposits: ForwardCausticDeposit[] = [];
  const selectedEmitterIds = new Set<number>();
  let rayCount = 0;
  let hitCount = 0;

  for (const material of materials) {
    const emitter = emitters
      .map((candidate) => ({
        candidate,
        score: pairVisibilityScore(candidate, material, bodies),
      }))
      .sort((left, right) => right.score - left.score)[0]?.candidate;
    if (!emitter) continue;
    selectedEmitterIds.add(emitter.id);
    const traced = tracePair(
      emitter,
      material,
      bodies,
      budget.raysPerPair,
      deposits,
    );
    rayCount += traced.rayCount;
    hitCount += traced.hitCount;
    if (deposits.length >= MAX_DEPOSITS) break;
  }

  return {
    deposits,
    emitterCount: selectedEmitterIds.size,
    materialCount: materials.length,
    rayCount,
    hitCount,
  };
}

const causticsVertexShader = /* glsl */ `
  attribute vec3 aCausticColour;
  attribute float aCausticAlpha;
  attribute float aCausticSize;
  varying vec3 vCausticColour;
  varying float vCausticAlpha;

  void main() {
    vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * viewPosition;
    gl_PointSize = aCausticSize * (8.5 / max(1.0, -viewPosition.z));
    vCausticColour = aCausticColour;
    vCausticAlpha = aCausticAlpha;
  }
`;

const causticsFragmentShader = /* glsl */ `
  varying vec3 vCausticColour;
  varying float vCausticAlpha;

  void main() {
    vec2 point = gl_PointCoord * 2.0 - 1.0;
    float radiusSquared = dot(point, point);
    if (radiusSquared > 1.0) discard;
    float core = exp(-radiusSquared * 4.8);
    float edge = 1.0 - smoothstep(0.62, 1.0, radiusSquared);
    gl_FragColor = vec4(vCausticColour, core * edge * vCausticAlpha);
  }
`;

export class ForwardCaustics {
  readonly points: THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial>;

  private readonly geometry = new THREE.BufferGeometry();
  private readonly positions = new Float32Array(MAX_DEPOSITS * 3);
  private readonly colours = new Float32Array(MAX_DEPOSITS * 3);
  private readonly alphas = new Float32Array(MAX_DEPOSITS);
  private readonly sizes = new Float32Array(MAX_DEPOSITS);
  private readonly positionAttribute = new THREE.BufferAttribute(this.positions, 3);
  private readonly colourAttribute = new THREE.BufferAttribute(this.colours, 3);
  private readonly alphaAttribute = new THREE.BufferAttribute(this.alphas, 1);
  private readonly sizeAttribute = new THREE.BufferAttribute(this.sizes, 1);
  private readonly material = new THREE.ShaderMaterial({
    vertexShader: causticsVertexShader,
    fragmentShader: causticsFragmentShader,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
  });
  private quality: ForwardCausticsQuality = 'high';
  private updateAccumulator = 0;
  private updateWindowStartedAt = 0;
  private completedUpdates = 0;
  private measuredUpdateHz = 0;
  private currentStats: ForwardCausticsStats = {
    active: false,
    quality: 'high',
    emitterCount: 0,
    materialCount: 0,
    rayCount: 0,
    hitCount: 0,
    pointCount: 0,
    updateHz: 0,
    cpuTimeMs: 0,
    drawCalls: 0,
    targetMemoryBytes: 0,
  };

  constructor() {
    this.positionAttribute.setUsage(THREE.DynamicDrawUsage);
    this.colourAttribute.setUsage(THREE.DynamicDrawUsage);
    this.alphaAttribute.setUsage(THREE.DynamicDrawUsage);
    this.sizeAttribute.setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute('position', this.positionAttribute);
    this.geometry.setAttribute('aCausticColour', this.colourAttribute);
    this.geometry.setAttribute('aCausticAlpha', this.alphaAttribute);
    this.geometry.setAttribute('aCausticSize', this.sizeAttribute);
    this.geometry.setDrawRange(0, 0);
    this.points = new THREE.Points(this.geometry, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 3;
    this.points.visible = false;
  }

  get stats(): ForwardCausticsStats {
    return this.currentStats;
  }

  setQuality(quality: ForwardCausticsQuality): void {
    if (this.quality === quality) return;
    this.quality = quality;
    this.updateAccumulator = 0;
    if (quality === 'off') this.clear();
    this.currentStats = { ...this.currentStats, quality };
  }

  update(dt: number, bodies: readonly ForwardOpticalBody[]): void {
    const budget = BUDGETS[this.quality];
    if (this.quality === 'off' || budget.updateHz <= 0) {
      this.clear();
      return;
    }
    this.updateAccumulator += Math.min(0.1, Math.max(0, dt));
    if (this.updateAccumulator < 1 / budget.updateHz) return;
    this.updateAccumulator %= 1 / budget.updateHz;

    const startedAt = performance.now();
    const result = traceForwardCaustics(bodies, this.quality);
    this.writeDeposits(result.deposits);
    this.recordUpdate();
    this.currentStats = {
      active: result.deposits.length > 0,
      quality: this.quality,
      emitterCount: result.emitterCount,
      materialCount: result.materialCount,
      rayCount: result.rayCount,
      hitCount: result.hitCount,
      pointCount: result.deposits.length,
      updateHz: this.measuredUpdateHz,
      cpuTimeMs: performance.now() - startedAt,
      drawCalls: result.deposits.length > 0 ? 1 : 0,
      targetMemoryBytes: 0,
    };
  }

  reset(): void {
    this.updateAccumulator = 0;
    this.updateWindowStartedAt = 0;
    this.completedUpdates = 0;
    this.measuredUpdateHz = 0;
    this.clear();
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }

  private writeDeposits(deposits: readonly ForwardCausticDeposit[]): void {
    const count = Math.min(MAX_DEPOSITS, deposits.length);
    for (let index = 0; index < count; index += 1) {
      const deposit = deposits[index];
      this.positions[index * 3] = deposit.position.x;
      this.positions[index * 3 + 1] = deposit.position.y;
      this.positions[index * 3 + 2] = 0.08;
      this.colours[index * 3] = deposit.colour.r;
      this.colours[index * 3 + 1] = deposit.colour.g;
      this.colours[index * 3 + 2] = deposit.colour.b;
      this.alphas[index] = deposit.alpha;
      this.sizes[index] = deposit.size;
    }
    this.geometry.setDrawRange(0, count);
    this.positionAttribute.needsUpdate = true;
    this.colourAttribute.needsUpdate = true;
    this.alphaAttribute.needsUpdate = true;
    this.sizeAttribute.needsUpdate = true;
    this.points.visible = count > 0;
  }

  private clear(): void {
    this.geometry.setDrawRange(0, 0);
    this.points.visible = false;
    this.currentStats = {
      ...this.currentStats,
      active: false,
      emitterCount: 0,
      materialCount: 0,
      rayCount: 0,
      hitCount: 0,
      pointCount: 0,
      updateHz: this.measuredUpdateHz,
      cpuTimeMs: 0,
      drawCalls: 0,
    };
  }

  private recordUpdate(): void {
    const now = performance.now();
    if (this.updateWindowStartedAt <= 0) this.updateWindowStartedAt = now;
    this.completedUpdates += 1;
    const elapsedSeconds = (now - this.updateWindowStartedAt) / 1000;
    if (elapsedSeconds < 0.5) return;
    this.measuredUpdateHz = this.completedUpdates / elapsedSeconds;
    this.completedUpdates = 0;
    this.updateWindowStartedAt = now;
  }
}

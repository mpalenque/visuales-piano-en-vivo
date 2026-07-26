import * as THREE from 'three';
import {
  OPTICAL_QUALITY_PRESETS,
  type OpticalMaterialBudget,
  type OpticalQualityPreset,
} from './optical-quality-controller';

const MAX_BODIES = 48;
const HIGH_OPTICAL_EXTENT = 128;
const LOW_OPTICAL_EXTENT = 64;
const MAX_DIRECTIONS = 4;
const MAX_STEPS = 28;
const MAX_INSIDE_STEPS = 32;

type PairTarget = THREE.WebGLRenderTarget<THREE.Texture>;
type SingleTarget = THREE.WebGLRenderTarget<THREE.Texture>;

interface OpticalTargetSet {
  scene: PairTarget;
  raw: SingleTarget;
  resolved: SingleTarget;
}

interface OpticalTargets {
  high: OpticalTargetSet;
  low: OpticalTargetSet;
}

export interface DirectionalBodySnapshot {
  count: number;
  shape: readonly THREE.Vector4[];
  frame: readonly THREE.Vector4[];
  emission: readonly THREE.Vector4[];
  albedo: readonly THREE.Vector4[];
  meta: readonly THREE.Vector4[];
}

export interface DirectionalMaterialFieldStats {
  supported: boolean;
  allocated: boolean;
  active: boolean;
  resolution: number;
  directionsPerPixel: number;
  maxStepsPerSegment: number;
  updateEveryHrcCycles: number;
  materials: OpticalMaterialBudget;
  targetMemoryBytes: number;
  targetTextureCount: number;
  drawCalls: number;
  updateHz: number;
  requestedCycles: number;
  renderedCycles: number;
  skippedCycles: number;
  mirrorCount: number;
  glassCount: number;
}

export interface DirectionalEnergyProbe {
  width: number;
  height: number;
  sum: number;
  maximum: number;
  nonZeroPixels: number;
  centroidX: number;
  centroidY: number;
}

const passVertexShader = /* glsl */ `
  out vec2 vUv;

  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const opticalSceneFragmentShader = /* glsl */ `
  precision highp float;
  precision highp int;

  in vec2 vUv;
  layout(location = 0) out vec4 outGeometryMaterial;
  layout(location = 1) out vec4 outOpticalProperties;

  uniform int uBodyCount;
  uniform vec4 uBodyShape[${MAX_BODIES}];
  uniform vec4 uBodyFrame[${MAX_BODIES}];
  uniform vec4 uBodyEmission[${MAX_BODIES}];
  uniform vec4 uBodyMeta[${MAX_BODIES}];
  uniform vec4 uWorldBounds;
  uniform bool uGlassEnabled;

  const float PI = 3.141592653589793;
  const float TWO_PI = 6.283185307179586;

  vec2 worldToLocal(vec2 worldPosition, vec4 shape, vec4 frame) {
    vec2 offset = worldPosition - shape.xy;
    return vec2(
      frame.x * offset.x + frame.y * offset.y,
      -frame.y * offset.x + frame.x * offset.y
    );
  }

  float sdBox(vec2 point, vec2 halfExtent) {
    vec2 q = abs(point) - max(halfExtent, vec2(0.0001));
    return length(max(q, vec2(0.0))) + min(max(q.x, q.y), 0.0);
  }

  float sdRegularUnit(vec2 point, int sides) {
    float sector = TWO_PI / float(sides);
    float halfSector = 0.5 * sector;
    float folded = mod(atan(point.y, point.x), sector) - halfSector;
    float radius = length(point);
    float faceDistance = radius * cos(folded) - cos(halfSector);
    float endpointDistance = max(
      abs(radius * sin(folded)) - sin(halfSector),
      0.0
    );
    float magnitude = length(vec2(faceDistance, endpointDistance));
    return faceDistance > 0.0 ? magnitude : -magnitude;
  }

  float bodyDistance(int bodyIndex, vec2 worldPosition) {
    vec4 shape = uBodyShape[bodyIndex];
    vec2 local = worldToLocal(worldPosition, shape, uBodyFrame[bodyIndex]);
    int sides = int(floor(uBodyMeta[bodyIndex].x + 0.5));
    if (sides < 3) return sdBox(local, shape.zw);
    vec2 safeExtent = max(shape.zw, vec2(0.0001));
    return sdRegularUnit(local / safeExtent, clamp(sides, 3, 8))
      * min(safeExtent.x, safeExtent.y);
  }

  void main() {
    vec2 worldPosition = mix(uWorldBounds.xy, uWorldBounds.zw, vUv);
    float nearestDistance = 64.0;
    float surfaceCode = 0.0;
    float surfaceRoughness = 0.0;
    float surfaceIor = 1.0;
    vec3 surfaceTint = vec3(1.0);
    float surfaceWeight = 0.0;

    for (int bodyIndex = 0; bodyIndex < ${MAX_BODIES}; bodyIndex++) {
      if (bodyIndex >= uBodyCount) break;
      float distanceToBody = bodyDistance(bodyIndex, worldPosition);
      if (distanceToBody >= nearestDistance) continue;

      vec4 meta = uBodyMeta[bodyIndex];
      float materialKind = floor(meta.y + 0.5);
      float effectiveKind = materialKind;
      if (!uGlassEnabled && effectiveKind > 2.5) effectiveKind = 1.0;
      vec4 opticalSource = uBodyEmission[bodyIndex];

      nearestDistance = distanceToBody;
      surfaceCode = float((bodyIndex + 1) * 4) + effectiveKind;
      surfaceRoughness = meta.z;
      surfaceIor = meta.w;
      // Diffuse emitters use this same slot for direct emission colour/strength.
      // Non-emissive diffuse bodies already carry zeroes.
      surfaceTint = opticalSource.rgb;
      surfaceWeight = opticalSource.a;
    }

    outGeometryMaterial = vec4(
      clamp(nearestDistance, -64.0, 64.0),
      surfaceCode,
      surfaceRoughness,
      surfaceIor
    );
    outOpticalProperties = vec4(surfaceTint, surfaceWeight);
  }
`;

const directionalFragmentShader = /* glsl */ `
  precision highp float;
  precision highp int;

  in vec2 vUv;
  out vec4 outColour;

  uniform sampler2D uGeometryMaterial;
  uniform sampler2D uOpticalProperties;
  uniform int uBodyCount;
  uniform vec4 uBodyShape[${MAX_BODIES}];
  uniform vec4 uBodyFrame[${MAX_BODIES}];
  uniform vec4 uBodyAlbedo[${MAX_BODIES}];
  uniform vec4 uBodyMeta[${MAX_BODIES}];
  uniform vec4 uWorldBounds;
  uniform int uDirectionCount;
  uniform int uMaxSteps;

  const float TWO_PI = 6.283185307179586;
  const int MATERIAL_TRANSPARENT = 1;
  const int MATERIAL_MIRROR = 2;
  const int MATERIAL_GLASS = 3;

  struct Hit {
    vec2 position;
    float distanceTravelled;
    int bodyId;
    int kind;
    vec4 geometry;
    vec4 properties;
  };

  vec2 worldSize() {
    return uWorldBounds.zw - uWorldBounds.xy;
  }

  bool outsideWorld(vec2 point) {
    return any(lessThan(point, uWorldBounds.xy))
      || any(greaterThanEqual(point, uWorldBounds.zw));
  }

  vec2 safeNormalize(vec2 value, vec2 fallback) {
    float magnitudeSquared = dot(value, value);
    if (magnitudeSquared <= 1e-12) return fallback;
    return value * inversesqrt(magnitudeSquared);
  }

  ivec2 worldTexel(vec2 point, ivec2 size) {
    vec2 uv = (point - uWorldBounds.xy) / worldSize();
    return clamp(
      ivec2(floor(uv * vec2(size))),
      ivec2(0),
      size - ivec2(1)
    );
  }

  vec4 geometryAt(vec2 point) {
    if (outsideWorld(point)) return vec4(64.0, 0.0, 0.0, 1.0);
    ivec2 size = textureSize(uGeometryMaterial, 0);
    return texelFetch(uGeometryMaterial, worldTexel(point, size), 0);
  }

  vec4 propertiesAt(vec2 point) {
    if (outsideWorld(point)) return vec4(1.0, 1.0, 1.0, 0.0);
    ivec2 size = textureSize(uOpticalProperties, 0);
    return texelFetch(uOpticalProperties, worldTexel(point, size), 0);
  }

  int packedBodyId(float surfaceCode) {
    return int(floor(surfaceCode + 0.5)) / 4;
  }

  int packedKind(float surfaceCode) {
    return int(floor(surfaceCode + 0.5)) % 4;
  }

  vec2 cellSize() {
    return worldSize() / vec2(textureSize(uGeometryMaterial, 0));
  }

  float cellExtent() {
    vec2 cell = cellSize();
    return max(cell.x, cell.y);
  }

  float samplingRadius() {
    return 0.5 * length(cellSize());
  }

  float hitEpsilon() {
    return 0.45 * cellExtent();
  }

  float minimumStep() {
    return 0.15 * cellExtent();
  }

  float surfaceBias() {
    return 1.25 * cellExtent();
  }

  float opticalInterfaceBias(int bodyId) {
    int bodyIndex = clamp(bodyId - 1, 0, ${MAX_BODIES - 1});
    float halfThickness = min(
      uBodyShape[bodyIndex].z,
      uBodyShape[bodyIndex].w
    );
    return max(
      0.001,
      min(minimumStep(), max(halfThickness, 0.005) * 0.2)
    );
  }

  vec2 worldToLocal(vec2 worldPosition, vec4 shape, vec4 frame) {
    vec2 offset = worldPosition - shape.xy;
    return vec2(
      frame.x * offset.x + frame.y * offset.y,
      -frame.y * offset.x + frame.x * offset.y
    );
  }

  float sdBox(vec2 point, vec2 halfExtent) {
    vec2 q = abs(point) - max(halfExtent, vec2(0.0001));
    return length(max(q, vec2(0.0))) + min(max(q.x, q.y), 0.0);
  }

  float sdRegularUnit(vec2 point, int sides) {
    float sector = TWO_PI / float(sides);
    float halfSector = 0.5 * sector;
    float folded = mod(atan(point.y, point.x), sector) - halfSector;
    float radius = length(point);
    float faceDistance = radius * cos(folded) - cos(halfSector);
    float endpointDistance = max(
      abs(radius * sin(folded)) - sin(halfSector),
      0.0
    );
    float magnitude = length(vec2(faceDistance, endpointDistance));
    return faceDistance > 0.0 ? magnitude : -magnitude;
  }

  float bodyDistanceById(int bodyId, vec2 worldPosition) {
    int bodyIndex = clamp(bodyId - 1, 0, ${MAX_BODIES - 1});
    vec4 shape = uBodyShape[bodyIndex];
    vec2 local = worldToLocal(worldPosition, shape, uBodyFrame[bodyIndex]);
    int sides = int(floor(uBodyMeta[bodyIndex].x + 0.5));
    if (sides < 3) return sdBox(local, shape.zw);
    vec2 safeExtent = max(shape.zw, vec2(0.0001));
    return sdRegularUnit(local / safeExtent, clamp(sides, 3, 8))
      * min(safeExtent.x, safeExtent.y);
  }

  vec2 analyticBodyNormal(int bodyId, vec2 point, vec2 fallback) {
    float epsilon = max(minimumStep(), 0.0001);
    vec2 gradient = vec2(
      bodyDistanceById(bodyId, point + vec2(epsilon, 0.0))
        - bodyDistanceById(bodyId, point - vec2(epsilon, 0.0)),
      bodyDistanceById(bodyId, point + vec2(0.0, epsilon))
        - bodyDistanceById(bodyId, point - vec2(0.0, epsilon))
    );
    return safeNormalize(gradient, fallback);
  }

  vec2 globalSurfaceNormal(int bodyId, vec2 point, vec2 fallback) {
    ivec2 size = textureSize(uGeometryMaterial, 0);
    ivec2 pixel = worldTexel(point, size);
    ivec2 x0 = ivec2(max(pixel.x - 1, 0), pixel.y);
    ivec2 x1 = ivec2(min(pixel.x + 1, size.x - 1), pixel.y);
    ivec2 y0 = ivec2(pixel.x, max(pixel.y - 1, 0));
    ivec2 y1 = ivec2(pixel.x, min(pixel.y + 1, size.y - 1));
    vec2 cell = cellSize();
    vec2 denominator = vec2(
      float(x1.x - x0.x) * cell.x,
      float(y1.y - y0.y) * cell.y
    );
    vec2 gradient = vec2(
      (
        texelFetch(uGeometryMaterial, x1, 0).r
        - texelFetch(uGeometryMaterial, x0, 0).r
      ) / max(denominator.x, 0.000001),
      (
        texelFetch(uGeometryMaterial, y1, 0).r
        - texelFetch(uGeometryMaterial, y0, 0).r
      ) / max(denominator.y, 0.000001)
    );
    return safeNormalize(
      gradient,
      analyticBodyNormal(bodyId, point, fallback)
    );
  }

  float exteriorAdvance(float distanceToScene) {
    float halfFloatError = max(abs(distanceToScene) * 0.0006, 0.00001);
    float safeDistance = distanceToScene - samplingRadius() - halfFloatError;
    return max(minimumStep(), 0.9 * max(safeDistance, 0.0));
  }

  void populateHit(
    vec2 position,
    float distanceTravelled,
    vec4 geometry,
    out Hit hit
  ) {
    hit.position = position;
    hit.distanceTravelled = distanceTravelled;
    hit.bodyId = packedBodyId(geometry.g);
    hit.kind = packedKind(geometry.g);
    hit.geometry = geometry;
    hit.properties = propertiesAt(position);
  }

  bool isDirectEmitter(Hit hit) {
    return hit.kind == 0 && hit.properties.a > 0.0001;
  }

  bool marchExteriorIgnoringBody(
    vec2 origin,
    vec2 direction,
    int ignoredBodyId,
    out Hit hit
  ) {
    float distanceTravelled = 0.0;
    bool ignoreActive = ignoredBodyId > 0;
    for (int stepIndex = 0; stepIndex < ${MAX_STEPS}; stepIndex++) {
      if (stepIndex >= uMaxSteps) break;
      vec2 point = origin + direction * distanceTravelled;
      if (outsideWorld(point)) return false;
      vec4 geometry = geometryAt(point);
      int bodyId = geometry.g > 0.5
        ? packedBodyId(geometry.g)
        : 0;
      if (
        ignoreActive
        && (
          bodyId != ignoredBodyId
          || geometry.r > hitEpsilon()
        )
      ) {
        ignoreActive = false;
      }
      if (
        !ignoreActive
        &&
        geometry.g > 0.5
        && geometry.r <= hitEpsilon()
        && distanceTravelled > minimumStep()
      ) {
        populateHit(point, distanceTravelled, geometry, hit);
        return true;
      }
      distanceTravelled += exteriorAdvance(max(geometry.r, 0.0));
    }
    return false;
  }

  bool marchExterior(vec2 origin, vec2 direction, out Hit hit) {
    return marchExteriorIgnoringBody(origin, direction, 0, hit);
  }

  bool escapeBody(
    int bodyId,
    vec2 origin,
    vec2 direction,
    out vec2 escaped
  ) {
    float distanceTravelled = 0.0;
    for (int stepIndex = 0; stepIndex < ${MAX_INSIDE_STEPS}; stepIndex++) {
      vec2 point = origin + direction * distanceTravelled;
      if (outsideWorld(point)) return false;
      float distanceToBody = bodyDistanceById(bodyId, point);
      if (stepIndex > 0 && distanceToBody >= 0.0) {
        vec2 normal = analyticBodyNormal(bodyId, point, direction);
        float side = dot(direction, normal) >= 0.0 ? 1.0 : -1.0;
        escaped = point
          + normal * side * surfaceBias()
          + direction * minimumStep();
        return !outsideWorld(escaped);
      }
      distanceTravelled += max(
        minimumStep(),
        0.9 * max(-distanceToBody, 0.0)
      );
    }
    return false;
  }

  bool escapeInitialReceiver(
    vec2 origin,
    vec2 direction,
    out vec2 escaped,
    out int receiverBodyId
  ) {
    escaped = origin;
    vec4 receiverGeometry = geometryAt(origin);
    receiverBodyId = receiverGeometry.g > 0.5
      ? packedBodyId(receiverGeometry.g)
      : 0;
    for (int overlapIndex = 0; overlapIndex < 2; overlapIndex++) {
      vec4 geometry = geometryAt(escaped);
      if (geometry.r >= -hitEpsilon() || geometry.g < 0.5) return true;
      int bodyId = packedBodyId(geometry.g);
      vec2 nextOrigin;
      if (bodyId <= 0 || !escapeBody(bodyId, escaped, direction, nextOrigin)) {
        return false;
      }
      escaped = nextOrigin;
    }
    return geometryAt(escaped).r >= -hitEpsilon();
  }

  bool marchPastTransparent(
    inout vec2 origin,
    vec2 direction,
    inout vec3 throughput,
    inout float pathDistance,
    int initialIgnoredBodyId,
    out Hit hit
  ) {
    int ignoredBodyId = initialIgnoredBodyId;
    for (int transparentLayer = 0; transparentLayer < 3; transparentLayer++) {
      if (!marchExteriorIgnoringBody(
        origin,
        direction,
        ignoredBodyId,
        hit
      )) return false;
      pathDistance += hit.distanceTravelled;
      if (hit.kind != MATERIAL_TRANSPARENT) return true;
      ignoredBodyId = hit.bodyId;

      throughput *= hit.properties.rgb * clamp(
        hit.properties.a,
        0.0,
        1.0
      );
      vec2 outwardEntry = analyticBodyNormal(
        hit.bodyId,
        hit.position,
        -direction
      );
      vec2 entryNormal = dot(direction, outwardEntry) < 0.0
        ? outwardEntry
        : -outwardEntry;
      float interfaceBias = opticalInterfaceBias(hit.bodyId);
      float entryDistance = bodyDistanceById(hit.bodyId, hit.position);
      vec2 entrySurface = hit.position - outwardEntry * entryDistance;
      vec2 insideOrigin = entrySurface
        - entryNormal * interfaceBias
        + direction * interfaceBias;

      float insideDistance = 0.0;
      bool exited = false;
      vec2 exitPosition = insideOrigin;
      vec2 outwardExit = -entryNormal;
      for (
        int insideStep = 0;
        insideStep < ${MAX_INSIDE_STEPS};
        insideStep++
      ) {
        vec2 point = insideOrigin + direction * insideDistance;
        if (outsideWorld(point)) return false;
        float distanceToBody = bodyDistanceById(hit.bodyId, point);
        if (insideStep > 0 && distanceToBody >= 0.0) {
          exitPosition = point;
          outwardExit = analyticBodyNormal(hit.bodyId, point, direction);
          exited = true;
          break;
        }
        insideDistance += max(
          minimumStep(),
          0.9 * max(-distanceToBody, 0.0)
        );
      }
      if (!exited) return false;

      float exitDistance = bodyDistanceById(hit.bodyId, exitPosition);
      vec2 exitSurface = exitPosition - outwardExit * exitDistance;
      float exitSide = dot(direction, outwardExit) >= 0.0 ? 1.0 : -1.0;
      origin = exitSurface
        + outwardExit * exitSide * interfaceBias
        + direction * interfaceBias;
      pathDistance += insideDistance;
    }

    // Resolve the surface after the third supported transparent layer. A
    // fourth transparent hit is outside the live budget.
    if (!marchExteriorIgnoringBody(
      origin,
      direction,
      ignoredBodyId,
      hit
    )) return false;
    pathDistance += hit.distanceTravelled;
    return hit.kind != MATERIAL_TRANSPARENT;
  }

  bool refract2d(
    vec2 incident,
    vec2 normalAgainstIncident,
    float eta,
    out vec2 transmitted
  ) {
    vec2 ray = safeNormalize(incident, vec2(1.0, 0.0));
    vec2 normal = safeNormalize(normalAgainstIncident, -ray);
    float cosine = clamp(-dot(ray, normal), 0.0, 1.0);
    float discriminant = 1.0
      - eta * eta * max(0.0, 1.0 - cosine * cosine);
    if (discriminant < -0.00001) {
      transmitted = safeNormalize(reflect(ray, normal), -ray);
      return false;
    }
    transmitted = safeNormalize(
      eta * ray
        + (eta * cosine - sqrt(max(discriminant, 0.0))) * normal,
      ray
    );
    return true;
  }

  float fresnelSchlick(float cosine, float firstIor, float secondIor) {
    float base = (firstIor - secondIor) / (firstIor + secondIor);
    base *= base;
    float complement = 1.0 - clamp(cosine, 0.0, 1.0);
    return base + (1.0 - base)
      * complement * complement * complement * complement * complement;
  }

  bool marchInsideGlass(
    int bodyId,
    vec2 origin,
    vec2 direction,
    out vec2 exitPosition,
    out vec2 outwardNormal,
    out float insideDistance
  ) {
    insideDistance = 0.0;
    for (int stepIndex = 0; stepIndex < ${MAX_INSIDE_STEPS}; stepIndex++) {
      vec2 point = origin + direction * insideDistance;
      if (outsideWorld(point)) return false;
      float distanceToBody = bodyDistanceById(bodyId, point);
      if (stepIndex > 0 && distanceToBody >= 0.0) {
        exitPosition = point;
        outwardNormal = analyticBodyNormal(bodyId, point, -direction);
        return true;
      }
      insideDistance += max(
        minimumStep(),
        0.9 * max(-distanceToBody, 0.0)
      );
    }
    return false;
  }

  vec3 finalEmitterContribution(
    vec2 origin,
    vec2 direction,
    vec3 throughput,
    float pathDistance,
    int ignoredBodyId
  ) {
    Hit finalHit;
    if (!marchPastTransparent(
      origin,
      direction,
      throughput,
      pathDistance,
      ignoredBodyId,
      finalHit
    )) return vec3(0.0);
    if (!isDirectEmitter(finalHit)) return vec3(0.0);
    float attenuation = 1.0 / (
      1.0 + 0.035 * pathDistance * pathDistance
    );
    return finalHit.properties.rgb
      * finalHit.properties.a
      * throughput
      * attenuation;
  }

  vec3 traceMirror(
    Hit opticalHit,
    vec2 incident,
    vec3 throughput,
    float pathDistance
  ) {
    // The union SDF can inherit the gradient of a neighbouring packed body.
    // A directional material must use the normal of the body it actually hit.
    vec2 outwardNormal = analyticBodyNormal(
      opticalHit.bodyId,
      opticalHit.position,
      -incident
    );
    float mirrorDistance = bodyDistanceById(
      opticalHit.bodyId,
      opticalHit.position
    );
    vec2 mirrorSurface = opticalHit.position
      - outwardNormal * mirrorDistance;
    outwardNormal = analyticBodyNormal(
      opticalHit.bodyId,
      mirrorSurface,
      outwardNormal
    );
    vec2 facingNormal = dot(incident, outwardNormal) < 0.0
      ? outwardNormal
      : -outwardNormal;
    vec2 reflected = safeNormalize(
      reflect(incident, facingNormal),
      -incident
    );
    throughput *= opticalHit.properties.rgb
      * clamp(opticalHit.properties.a, 0.0, 1.0);
    float interfaceBias = opticalInterfaceBias(opticalHit.bodyId);
    vec2 nextOrigin = mirrorSurface
      + facingNormal * interfaceBias
      + reflected * interfaceBias;
    return finalEmitterContribution(
      nextOrigin,
      reflected,
      throughput,
      pathDistance,
      opticalHit.bodyId
    );
  }

  vec3 traceGlass(
    Hit opticalHit,
    vec2 incident,
    vec3 throughput,
    float pathDistance
  ) {
    float ior = clamp(opticalHit.geometry.a, 1.0, 1.8);
    vec2 outwardEntry = analyticBodyNormal(
      opticalHit.bodyId,
      opticalHit.position,
      -incident
    );
    vec2 entryNormal = dot(incident, outwardEntry) < 0.0
      ? outwardEntry
      : -outwardEntry;
    vec2 insideDirection;
    if (!refract2d(incident, entryNormal, 1.0 / ior, insideDirection)) {
      return vec3(0.0);
    }
    float entryCosine = clamp(-dot(incident, entryNormal), 0.0, 1.0);
    float entryTransmission = 1.0 - fresnelSchlick(entryCosine, 1.0, ior);
    float interfaceBias = opticalInterfaceBias(opticalHit.bodyId);
    float entryDistance = bodyDistanceById(
      opticalHit.bodyId,
      opticalHit.position
    );
    vec2 entrySurface = opticalHit.position - outwardEntry * entryDistance;
    vec2 insideOrigin = entrySurface
      - entryNormal * interfaceBias
      + insideDirection * interfaceBias;
    vec2 exitPosition;
    vec2 outwardExit;
    float firstInsideDistance;
    if (!marchInsideGlass(
      opticalHit.bodyId,
      insideOrigin,
      insideDirection,
      exitPosition,
      outwardExit,
      firstInsideDistance
    )) return vec3(0.0);

    vec2 exitNormal = dot(insideDirection, outwardExit) < 0.0
      ? outwardExit
      : -outwardExit;
    vec2 outsideDirection;
    bool exited = refract2d(
      insideDirection,
      exitNormal,
      ior,
      outsideDirection
    );
    float totalInsideDistance = firstInsideDistance;

    if (!exited) {
      vec2 reflectedInside = outsideDirection;
      float firstExitDistance = bodyDistanceById(
        opticalHit.bodyId,
        exitPosition
      );
      vec2 firstExitSurface = exitPosition
        - outwardExit * firstExitDistance;
      vec2 secondInsideOrigin = firstExitSurface
        + exitNormal * interfaceBias
        + reflectedInside * interfaceBias;
      float secondInsideDistance;
      if (!marchInsideGlass(
        opticalHit.bodyId,
        secondInsideOrigin,
        reflectedInside,
        exitPosition,
        outwardExit,
        secondInsideDistance
      )) return vec3(0.0);
      totalInsideDistance += secondInsideDistance;
      exitNormal = dot(reflectedInside, outwardExit) < 0.0
        ? outwardExit
        : -outwardExit;
      insideDirection = reflectedInside;
      if (!refract2d(
        insideDirection,
        exitNormal,
        ior,
        outsideDirection
      )) return vec3(0.0);
    }

    float exitCosine = clamp(-dot(insideDirection, exitNormal), 0.0, 1.0);
    float exitTransmission = 1.0 - fresnelSchlick(exitCosine, ior, 1.0);
    int bodyIndex = clamp(opticalHit.bodyId - 1, 0, ${MAX_BODIES - 1});
    float absorption = max(uBodyAlbedo[bodyIndex].a, 0.0);
    vec3 tint = clamp(
      opticalHit.properties.rgb,
      vec3(0.001),
      vec3(1.0)
    );
    vec3 sigma = -log(tint) * absorption;
    throughput *= exp(-sigma * totalInsideDistance)
      * clamp(opticalHit.properties.a, 0.0, 1.0)
      * entryTransmission
      * exitTransmission;
    pathDistance += totalInsideDistance;
    float exitDistance = bodyDistanceById(opticalHit.bodyId, exitPosition);
    vec2 exitSurface = exitPosition - outwardExit * exitDistance;
    vec2 nextOrigin = exitSurface
      - exitNormal * interfaceBias
      + outsideDirection * interfaceBias;
    return finalEmitterContribution(
      nextOrigin,
      outsideDirection,
      throughput,
      pathDistance,
      opticalHit.bodyId
    );
  }

  vec3 traceOpticalSample(vec2 origin, vec2 direction) {
    vec2 escapedOrigin;
    int receiverBodyId;
    if (!escapeInitialReceiver(
      origin,
      direction,
      escapedOrigin,
      receiverBodyId
    )) {
      return vec3(0.0);
    }

    vec3 throughput = vec3(1.0);
    float pathDistance = length(escapedOrigin - origin);
    Hit firstHit;
    if (!marchPastTransparent(
      escapedOrigin,
      direction,
      throughput,
      pathDistance,
      receiverBodyId,
      firstHit
    )) return vec3(0.0);

    // A direct emitter hit belongs to HRC, never to this field.
    if (isDirectEmitter(firstHit)) return vec3(0.0);
    if (firstHit.kind == MATERIAL_MIRROR) {
      return traceMirror(firstHit, direction, throughput, pathDistance);
    }
    if (firstHit.kind == MATERIAL_GLASS) {
      return traceGlass(firstHit, direction, throughput, pathDistance);
    }
    return vec3(0.0);
  }

  void main() {
    vec2 worldPosition = mix(uWorldBounds.xy, uWorldBounds.zw, vUv);
    vec4 receiverGeometry = geometryAt(worldPosition);
    vec4 receiverProperties = propertiesAt(worldPosition);

    // This texture is irradiance received by real diffuse surfaces. Empty
    // space is not a participating medium: painting valid light paths there
    // produced the huge volumetric fans/checkerboard that visually overwhelmed
    // the HRC background. Emitters and directional materials are not receivers
    // either.
    if (
      receiverGeometry.g < 0.5
      || receiverGeometry.r > hitEpsilon()
      || packedKind(receiverGeometry.g) != 0
      || receiverProperties.a > 0.0001
    ) {
      outColour = vec4(0.0, 0.0, 0.0, 1.0);
      return;
    }

    float directionCount = float(max(uDirectionCount, 1));
    ivec2 pixel = ivec2(gl_FragCoord.xy);
    float phaseIndex = mod(float(pixel.x + pixel.y * 2), 4.0);
    float phase = phaseIndex * 0.25 * TWO_PI / directionCount;
    vec3 radiance = vec3(0.0);

    for (int directionIndex = 0; directionIndex < ${MAX_DIRECTIONS}; directionIndex++) {
      if (directionIndex >= uDirectionCount) break;
      float angle = phase
        + TWO_PI * float(directionIndex) / directionCount;
      vec2 direction = vec2(cos(angle), sin(angle));
      radiance += traceOpticalSample(worldPosition, direction);
    }

    // The four spatial phases are reconstructed in a separate 128²/64²
    // resolve pass. Keep the raw estimator deliberately restrained so a
    // newly spawned optical body cannot wash out the established HRC image.
    radiance *= (TWO_PI / directionCount) * 0.12;
    if (any(isnan(radiance)) || any(isinf(radiance))) radiance = vec3(0.0);
    outColour = vec4(clamp(radiance, vec3(0.0), vec3(10.0)), 1.0);
  }
`;

const directionalResolveFragmentShader = /* glsl */ `
  precision highp float;
  precision highp int;

  in vec2 vUv;
  out vec4 outColour;
  uniform sampler2D uRawDirectional;

  ivec2 clampedPixel(ivec2 pixel, ivec2 size) {
    return clamp(pixel, ivec2(0), size - ivec2(1));
  }

  vec3 rawAt(ivec2 pixel, ivec2 size) {
    return texelFetch(
      uRawDirectional,
      clampedPixel(pixel, size),
      0
    ).rgb;
  }

  void main() {
    ivec2 size = textureSize(uRawDirectional, 0);
    ivec2 pixel = ivec2(gl_FragCoord.xy);

    // The raw shader rotates its ray set with phase
    // (x + 2*y) mod 4. This symmetric five-tap kernel gives each of those
    // four angular phases exactly the same total weight:
    // centre=2, left/right=2, up/down=1. It is an angular reconstruction,
    // not a full-screen cosmetic post-process, and runs only at 128²/64².
    vec3 resolved = (
      rawAt(pixel, size) * 2.0
      + rawAt(pixel + ivec2(-1, 0), size) * 2.0
      + rawAt(pixel + ivec2(1, 0), size) * 2.0
      + rawAt(pixel + ivec2(0, -1), size)
      + rawAt(pixel + ivec2(0, 1), size)
    ) * 0.125;

    if (any(isnan(resolved)) || any(isinf(resolved))) {
      resolved = vec3(0.0);
    }
    outColour = vec4(clamp(resolved, vec3(0.0), vec3(4.0)), 1.0);
  }
`;

const makeMaterial = (
  fragmentShader: string,
  uniforms: Record<string, THREE.IUniform>,
): THREE.ShaderMaterial => new THREE.ShaderMaterial({
  uniforms,
  vertexShader: passVertexShader,
  fragmentShader,
  glslVersion: THREE.GLSL3,
  depthTest: false,
  depthWrite: false,
  blending: THREE.NoBlending,
});

const pairTarget = (extent: number): PairTarget =>
  new THREE.WebGLRenderTarget<THREE.Texture>(extent, extent, {
    count: 2,
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
  });

const singleTarget = (extent: number): SingleTarget =>
  new THREE.WebGLRenderTarget<THREE.Texture>(extent, extent, {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
  });

const targetSet = (extent: number): OpticalTargetSet => ({
  scene: pairTarget(extent),
  raw: singleTarget(extent),
  resolved: singleTarget(extent),
});

const makeVectorArray = (): THREE.Vector4[] =>
  Array.from({ length: MAX_BODIES }, () => new THREE.Vector4());

export class DirectionalMaterialField {
  private readonly snapshotShape = makeVectorArray();
  private readonly snapshotFrame = makeVectorArray();
  private readonly snapshotEmission = makeVectorArray();
  private readonly snapshotAlbedo = makeVectorArray();
  private readonly snapshotMeta = makeVectorArray();
  private readonly snapshotCount = { value: 0 };
  private readonly quadGeometry = new THREE.PlaneGeometry(2, 2);
  private readonly passScene = new THREE.Scene();
  private readonly passCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly sceneMaterial: THREE.ShaderMaterial;
  private readonly directionalMaterial: THREE.ShaderMaterial;
  private readonly directionalResolveMaterial: THREE.ShaderMaterial;
  private readonly passMesh: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  private targets: OpticalTargets | null = null;
  private preset: OpticalQualityPreset = OPTICAL_QUALITY_PRESETS[5];
  private presetRevision = 0;
  private capturedPresetRevision = -1;
  private capturedTarget: OpticalTargetSet | null = null;
  private capturePending = false;
  private outputTarget: SingleTarget | null = null;
  private supported: boolean;
  private active = false;
  private outputsCleared = true;
  private targetMemoryBytes = 0;
  private drawCalls = 0;
  private cycleDrawCalls = 0;
  private requestedCycles = 0;
  private renderedCycles = 0;
  private skippedCycles = 0;
  private mirrorCount = 0;
  private glassCount = 0;
  private updateWindowStartedAt = 0;
  private completedUpdates = 0;
  private updateHz = 0;

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    worldBounds: THREE.Vector4,
  ) {
    const context = renderer.getContext() as WebGL2RenderingContext;
    this.supported = renderer.capabilities.isWebGL2
      && context.getParameter(context.MAX_DRAW_BUFFERS) >= 2
      && context.getParameter(context.MAX_COLOR_ATTACHMENTS) >= 2
      && context.getExtension('EXT_color_buffer_float') !== null;

    this.sceneMaterial = makeMaterial(opticalSceneFragmentShader, {
      uBodyCount: this.snapshotCount,
      uBodyShape: { value: this.snapshotShape },
      uBodyFrame: { value: this.snapshotFrame },
      uBodyEmission: { value: this.snapshotEmission },
      uBodyMeta: { value: this.snapshotMeta },
      uWorldBounds: { value: worldBounds.clone() },
      uGlassEnabled: { value: true },
    });
    this.directionalMaterial = makeMaterial(directionalFragmentShader, {
      uGeometryMaterial: { value: null },
      uOpticalProperties: { value: null },
      uBodyCount: this.snapshotCount,
      uBodyShape: { value: this.snapshotShape },
      uBodyFrame: { value: this.snapshotFrame },
      uBodyAlbedo: { value: this.snapshotAlbedo },
      uBodyMeta: { value: this.snapshotMeta },
      uWorldBounds: { value: worldBounds.clone() },
      uDirectionCount: { value: 0 },
      uMaxSteps: { value: 0 },
    });
    this.directionalResolveMaterial = makeMaterial(
      directionalResolveFragmentShader,
      {
        uRawDirectional: { value: null },
      },
    );
    this.passMesh = new THREE.Mesh(this.quadGeometry, this.sceneMaterial);
    this.passMesh.frustumCulled = false;
    this.passScene.add(this.passMesh);
  }

  get texture(): THREE.Texture | null {
    return this.outputTarget?.texture ?? null;
  }

  get isSupported(): boolean {
    return this.supported;
  }

  get isRequested(): boolean {
    return this.mirrorCount + this.glassCount > 0;
  }

  get stats(): DirectionalMaterialFieldStats {
    return {
      supported: this.supported,
      allocated: this.targets !== null,
      active: this.active,
      resolution: this.active ? this.outputTarget?.width ?? 0 : 0,
      directionsPerPixel: this.preset.directionsPerPixel,
      maxStepsPerSegment: this.preset.maxStepsPerSegment,
      updateEveryHrcCycles: this.preset.updateEveryHrcCycles,
      materials: this.preset.materials,
      targetMemoryBytes: this.targetMemoryBytes,
      targetTextureCount: this.targets ? 8 : 0,
      drawCalls: this.drawCalls,
      updateHz: this.updateHz,
      requestedCycles: this.requestedCycles,
      renderedCycles: this.renderedCycles,
      skippedCycles: this.skippedCycles,
      mirrorCount: this.mirrorCount,
      glassCount: this.glassCount,
    };
  }

  setPreset(preset: OpticalQualityPreset): void {
    if (this.preset.tier === preset.tier) return;
    const invalidatesOutput = this.preset.resolution !== preset.resolution
      || this.preset.materials !== preset.materials
      || !preset.enabled;
    this.preset = preset;
    this.presetRevision += 1;
    this.capturePending = false;
    if (invalidatesOutput) this.clearOutput();
  }

  precompile(): void {
    if (!this.supported) return;
    const previousMaterial = this.passMesh.material;
    this.passMesh.material = this.sceneMaterial;
    this.renderer.compile(this.passScene, this.passCamera);
    this.passMesh.material = this.directionalMaterial;
    this.renderer.compile(this.passScene, this.passCamera);
    this.passMesh.material = this.directionalResolveMaterial;
    this.renderer.compile(this.passScene, this.passCamera);
    this.passMesh.material = previousMaterial;
  }

  capture(
    snapshot: DirectionalBodySnapshot,
    mirrorCount: number,
    glassCount: number,
  ): void {
    this.cycleDrawCalls = 0;
    this.capturePending = false;
    this.mirrorCount = Math.max(0, Math.floor(mirrorCount));
    this.glassCount = Math.max(0, Math.floor(glassCount));

    const effectiveGlassCount = this.preset.materials === 'glass'
      ? this.glassCount
      : 0;
    const directionalCount = this.mirrorCount + effectiveGlassCount;
    if (directionalCount === 0) {
      this.clearOutput();
      return;
    }
    this.requestedCycles += 1;
    if (!this.supported || !this.preset.enabled) {
      this.clearOutput();
      return;
    }

    const updateInterval = Math.max(1, this.preset.updateEveryHrcCycles);
    if ((this.requestedCycles - 1) % updateInterval !== 0) {
      this.skippedCycles += 1;
      return;
    }
    if (!this.ensureTargets()) return;

    this.copySnapshot(snapshot);
    const target = this.preset.resolution <= LOW_OPTICAL_EXTENT
      ? this.targets!.low
      : this.targets!.high;
    this.sceneMaterial.uniforms.uGlassEnabled.value =
      this.preset.materials === 'glass';
    this.renderPass(this.sceneMaterial, target.scene);
    this.capturedTarget = target;
    this.capturedPresetRevision = this.presetRevision;
    this.capturePending = true;
  }

  renderCaptured(): void {
    if (!this.capturePending) return;
    this.capturePending = false;
    if (
      this.capturedPresetRevision !== this.presetRevision
      || !this.preset.enabled
      || !this.capturedTarget
    ) {
      this.clearOutput();
      return;
    }

    this.directionalMaterial.uniforms.uGeometryMaterial.value =
      this.capturedTarget.scene.textures[0];
    this.directionalMaterial.uniforms.uOpticalProperties.value =
      this.capturedTarget.scene.textures[1];
    this.directionalMaterial.uniforms.uDirectionCount.value =
      Math.min(MAX_DIRECTIONS, this.preset.directionsPerPixel);
    this.directionalMaterial.uniforms.uMaxSteps.value =
      Math.min(MAX_STEPS, this.preset.maxStepsPerSegment);
    this.renderPass(this.directionalMaterial, this.capturedTarget.raw);
    this.directionalResolveMaterial.uniforms.uRawDirectional.value =
      this.capturedTarget.raw.texture;
    this.renderPass(
      this.directionalResolveMaterial,
      this.capturedTarget.resolved,
    );
    this.drawCalls = this.cycleDrawCalls;
    this.outputTarget = this.capturedTarget.resolved;
    this.active = true;
    this.outputsCleared = false;
    this.renderedCycles += 1;
    this.recordCompletedUpdate();
  }

  reset(): void {
    this.capturePending = false;
    this.outputTarget = null;
    this.active = false;
    this.drawCalls = 0;
    this.cycleDrawCalls = 0;
    this.requestedCycles = 0;
    this.renderedCycles = 0;
    this.skippedCycles = 0;
    this.mirrorCount = 0;
    this.glassCount = 0;
    this.updateWindowStartedAt = 0;
    this.completedUpdates = 0;
    this.updateHz = 0;
    this.clearAllocatedTargets();
  }

  /**
   * Explicit diagnostic readback for development/E2E only. It is never called
   * by the live render loop.
   */
  readEnergyProbe(): DirectionalEnergyProbe {
    if (!this.outputTarget || !this.active) {
      return {
        width: 0,
        height: 0,
        sum: 0,
        maximum: 0,
        nonZeroPixels: 0,
        centroidX: 0,
        centroidY: 0,
      };
    }
    const { width, height } = this.outputTarget;
    const pixels = new Uint16Array(width * height * 4);
    this.renderer.readRenderTargetPixels(
      this.outputTarget,
      0,
      0,
      width,
      height,
      pixels,
    );
    let sum = 0;
    let maximum = 0;
    let nonZeroPixels = 0;
    let weightedX = 0;
    let weightedY = 0;
    for (let index = 0; index < width * height; index += 1) {
      const red = THREE.DataUtils.fromHalfFloat(pixels[index * 4]);
      const green = THREE.DataUtils.fromHalfFloat(pixels[index * 4 + 1]);
      const blue = THREE.DataUtils.fromHalfFloat(pixels[index * 4 + 2]);
      const energy = Math.max(0, red) + Math.max(0, green) + Math.max(0, blue);
      if (!Number.isFinite(energy)) continue;
      sum += energy;
      maximum = Math.max(maximum, energy);
      if (energy <= 1e-5) continue;
      nonZeroPixels += 1;
      weightedX += (index % width) * energy;
      weightedY += Math.floor(index / width) * energy;
    }
    return {
      width,
      height,
      sum,
      maximum,
      nonZeroPixels,
      centroidX: sum > 0 ? weightedX / sum / Math.max(1, width - 1) : 0,
      centroidY: sum > 0 ? weightedY / sum / Math.max(1, height - 1) : 0,
    };
  }

  dispose(): void {
    this.quadGeometry.dispose();
    this.sceneMaterial.dispose();
    this.directionalMaterial.dispose();
    this.directionalResolveMaterial.dispose();
    this.disposeTargets();
  }

  private copySnapshot(snapshot: DirectionalBodySnapshot): void {
    const count = Math.max(0, Math.min(MAX_BODIES, Math.floor(snapshot.count)));
    this.snapshotCount.value = count;
    for (let index = 0; index < count; index += 1) {
      this.snapshotShape[index].copy(snapshot.shape[index]);
      this.snapshotFrame[index].copy(snapshot.frame[index]);
      this.snapshotEmission[index].copy(snapshot.emission[index]);
      this.snapshotAlbedo[index].copy(snapshot.albedo[index]);
      this.snapshotMeta[index].copy(snapshot.meta[index]);
    }
  }

  private ensureTargets(): boolean {
    if (this.targets) return true;
    const targets: OpticalTargets = {
      high: targetSet(HIGH_OPTICAL_EXTENT),
      low: targetSet(LOW_OPTICAL_EXTENT),
    };
    const previousTarget = this.renderer.getRenderTarget();
    const context = this.renderer.getContext();
    let complete = true;
    for (const target of [
      targets.high.scene,
      targets.high.raw,
      targets.high.resolved,
      targets.low.scene,
      targets.low.raw,
      targets.low.resolved,
    ]) {
      this.renderer.setRenderTarget(target);
      complete = complete
        && context.checkFramebufferStatus(context.FRAMEBUFFER)
          === context.FRAMEBUFFER_COMPLETE;
    }
    this.renderer.setRenderTarget(previousTarget);
    if (!complete) {
      targets.high.scene.dispose();
      targets.high.raw.dispose();
      targets.high.resolved.dispose();
      targets.low.scene.dispose();
      targets.low.raw.dispose();
      targets.low.resolved.dispose();
      this.supported = false;
      return false;
    }

    this.targets = targets;
    const bytesPerHalfFloatRgbaPixel = 8;
    this.targetMemoryBytes = (
      HIGH_OPTICAL_EXTENT * HIGH_OPTICAL_EXTENT
      + LOW_OPTICAL_EXTENT * LOW_OPTICAL_EXTENT
    ) * bytesPerHalfFloatRgbaPixel * 4;
    this.clearAllocatedTargets();
    return true;
  }

  private renderPass(
    material: THREE.ShaderMaterial,
    target: PairTarget | SingleTarget,
  ): void {
    this.cycleDrawCalls += 1;
    this.passMesh.material = material;
    this.renderer.setRenderTarget(target);
    this.renderer.clear();
    this.renderer.render(this.passScene, this.passCamera);
  }

  private clearOutput(): void {
    this.capturePending = false;
    this.active = false;
    this.outputTarget = null;
    this.drawCalls = 0;
    if (!this.targets || this.outputsCleared) return;
    const previousTarget = this.renderer.getRenderTarget();
    const previousColour = this.renderer.getClearColor(new THREE.Color()).clone();
    const previousAlpha = this.renderer.getClearAlpha();
    this.renderer.setClearColor(0x000000, 0);
    for (const target of [
      this.targets.high.raw,
      this.targets.high.resolved,
      this.targets.low.raw,
      this.targets.low.resolved,
    ]) {
      this.renderer.setRenderTarget(target);
      this.renderer.clear();
    }
    this.renderer.setRenderTarget(previousTarget);
    this.renderer.setClearColor(previousColour, previousAlpha);
    this.outputsCleared = true;
  }

  private clearAllocatedTargets(): void {
    if (!this.targets) return;
    const previousTarget = this.renderer.getRenderTarget();
    const previousColour = this.renderer.getClearColor(new THREE.Color()).clone();
    const previousAlpha = this.renderer.getClearAlpha();
    this.renderer.setClearColor(0x000000, 0);
    for (const target of [
      this.targets.high.scene,
      this.targets.high.raw,
      this.targets.high.resolved,
      this.targets.low.scene,
      this.targets.low.raw,
      this.targets.low.resolved,
    ]) {
      this.renderer.setRenderTarget(target);
      this.renderer.clear();
    }
    this.renderer.setRenderTarget(previousTarget);
    this.renderer.setClearColor(previousColour, previousAlpha);
    this.outputsCleared = true;
  }

  private disposeTargets(): void {
    if (!this.targets) return;
    this.targets.high.scene.dispose();
    this.targets.high.raw.dispose();
    this.targets.high.resolved.dispose();
    this.targets.low.scene.dispose();
    this.targets.low.raw.dispose();
    this.targets.low.resolved.dispose();
    this.targets = null;
    this.targetMemoryBytes = 0;
    this.outputTarget = null;
    this.outputsCleared = true;
  }

  private recordCompletedUpdate(): void {
    const now = performance.now();
    if (this.updateWindowStartedAt === 0) this.updateWindowStartedAt = now;
    this.completedUpdates += 1;
    const elapsed = now - this.updateWindowStartedAt;
    if (elapsed < 1000) return;
    this.updateHz = this.completedUpdates * 1000 / elapsed;
    this.completedUpdates = 0;
    this.updateWindowStartedAt = now;
  }
}

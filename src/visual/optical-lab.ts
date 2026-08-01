import * as THREE from 'three';

export type OpticalLabQuality = 'high' | 'safe';

export interface OpticalLabStats {
  active: boolean;
  quality: OpticalLabQuality;
  width: number;
  height: number;
  samplesPerPixel: number;
  accumulatedFrames: number;
  drawCalls: number;
  cpuTimeMs: number;
  targetMemoryBytes: number;
}

export const OPTICAL_LAB_MATERIALS = [
  'emitter',
  'diffuse',
  'mirror',
  'rough-metal',
  'dielectric-glass',
] as const;

const HIGH_TARGET_HEIGHT = 360;
const SAFE_TARGET_HEIGHT = 240;
const MAX_TARGET_WIDTH = 768;
const HIGH_SAMPLES = 8;
const SAFE_SAMPLES = 4;

const fullscreenVertexShader = /* glsl */ `
  out vec2 vUv;

  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

// GPU adaptation of miloyip/light2d's transport:
// - signed-distance ray marching
// - specular reflection
// - Snell refraction, Fresnel and total internal reflection
// - Beer-Lambert absorption while a path is inside glass
//
// The original reference integrates hundreds of directions per pixel offline.
// This live version uses a small stratified set and converges it temporally.
const opticalFragmentShader = /* glsl */ `
  precision highp float;
  precision highp int;

  in vec2 vUv;
  out vec4 outColour;

  uniform vec2 uResolution;
  uniform float uAspect;
  uniform float uFrame;
  uniform int uSampleCount;

  const float PI = 3.141592653589793;
  const float TWO_PI = 6.283185307179586;
  const float EPSILON = 0.004;
  const float BIAS = 0.016;
  const float MAX_DISTANCE = 13.0;
  const int MAX_STEPS = 38;
  const int MAX_BOUNCES = 3;
  const int MAX_SAMPLES = 8;

  const float MAT_NONE = 0.0;
  const float MAT_EMITTER = 1.0;
  const float MAT_DIFFUSE = 2.0;
  const float MAT_MIRROR = 3.0;
  const float MAT_METAL = 4.0;
  const float MAT_GLASS = 5.0;

  struct SceneHit {
    float distance;
    float material;
  };

  float hash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }

  mat2 rotation(float angle) {
    float c = cos(angle);
    float s = sin(angle);
    return mat2(c, s, -s, c);
  }

  float sdCircle(vec2 p, vec2 centre, float radius) {
    return length(p - centre) - radius;
  }

  float sdBox(vec2 p, vec2 centre, vec2 halfSize, float angle) {
    vec2 local = rotation(-angle) * (p - centre);
    vec2 d = abs(local) - halfSize;
    return length(max(d, vec2(0.0))) + min(max(d.x, d.y), 0.0);
  }

  float emitterSdf(vec2 p) {
    return sdCircle(p, vec2(-4.28, 0.42), 0.34);
  }

  float mirrorSdf(vec2 p) {
    return sdBox(p, vec2(-2.23, 1.25), vec2(0.075, 0.92), 1.18);
  }

  float metalSdf(vec2 p) {
    return sdBox(p, vec2(-2.80, -1.30), vec2(0.62, 0.38), 0.16);
  }

  float glassSdf(vec2 p) {
    // Intersection of two circles: a biconvex dielectric lens. Unlike a
    // simple prism, its changing normals converge transmitted rays into a
    // caustic that is easy to verify in a fixed scene.
    float leftSurface = sdCircle(p, vec2(-0.25, 0.04), 1.08);
    float rightSurface = sdCircle(p, vec2(0.95, 0.04), 1.08);
    return max(leftSurface, rightSurface);
  }

  float diffuseBlockSdf(vec2 p) {
    return sdBox(p, vec2(3.72, 1.20), vec2(0.52, 0.52), -0.12);
  }

  float receiverSdf(vec2 p) {
    return sdBox(p, vec2(0.60, -2.47), vec2(4.75, 0.10), 0.0);
  }

  SceneHit nearer(SceneHit a, float distance, float material) {
    if (distance < a.distance) {
      return SceneHit(distance, material);
    }
    return a;
  }

  SceneHit mapScene(vec2 p) {
    SceneHit hit = SceneHit(1000.0, MAT_NONE);
    hit = nearer(hit, emitterSdf(p), MAT_EMITTER);
    hit = nearer(hit, mirrorSdf(p), MAT_MIRROR);
    hit = nearer(hit, metalSdf(p), MAT_METAL);
    hit = nearer(hit, glassSdf(p), MAT_GLASS);
    hit = nearer(hit, diffuseBlockSdf(p), MAT_DIFFUSE);
    hit = nearer(hit, receiverSdf(p), MAT_DIFFUSE);
    return hit;
  }

  float materialDistance(vec2 p, float material) {
    if (material == MAT_EMITTER) return emitterSdf(p);
    if (material == MAT_MIRROR) return mirrorSdf(p);
    if (material == MAT_METAL) return metalSdf(p);
    if (material == MAT_GLASS) return glassSdf(p);
    if (material == MAT_DIFFUSE) {
      return min(diffuseBlockSdf(p), receiverSdf(p));
    }
    return mapScene(p).distance;
  }

  vec2 materialNormal(vec2 p, float material) {
    vec2 ex = vec2(EPSILON, 0.0);
    vec2 ey = vec2(0.0, EPSILON);
    return normalize(vec2(
      materialDistance(p + ex, material) - materialDistance(p - ex, material),
      materialDistance(p + ey, material) - materialDistance(p - ey, material)
    ));
  }

  float fresnelSchlick(float cosine, float etaOutside, float etaInside) {
    float r0 = (etaOutside - etaInside) / (etaOutside + etaInside);
    r0 *= r0;
    return r0 + (1.0 - r0) * pow(1.0 - clamp(cosine, 0.0, 1.0), 5.0);
  }

  vec3 environmentRadiance(vec2 direction) {
    float horizon = 0.5 + 0.5 * direction.y;
    return mix(vec3(0.002, 0.004, 0.009), vec3(0.010, 0.015, 0.028), horizon);
  }

  vec3 tracePath(vec2 origin, vec2 direction, float seed) {
    vec3 radiance = vec3(0.0);
    vec3 throughput = vec3(1.0);

    for (int bounce = 0; bounce < MAX_BOUNCES; bounce++) {
      SceneHit originScene = mapScene(origin);
      float mediumSign = originScene.distance < 0.0 ? -1.0 : 1.0;
      float distanceTravelled = 0.0;
      bool found = false;
      SceneHit hit = SceneHit(1000.0, MAT_NONE);
      vec2 position = origin;

      for (int step = 0; step < MAX_STEPS; step++) {
        position = origin + direction * distanceTravelled;
        hit = mapScene(position);
        float signedDistance = hit.distance * mediumSign;
        if (signedDistance < EPSILON) {
          found = true;
          break;
        }
        distanceTravelled += clamp(signedDistance, EPSILON * 0.75, 0.34);
        if (distanceTravelled >= MAX_DISTANCE) break;
      }

      if (!found) {
        radiance += throughput * environmentRadiance(direction);
        break;
      }

      if (mediumSign < 0.0 && originScene.material == MAT_GLASS) {
        // Cyan glass absorbs red more strongly. This is Beer-Lambert
        // attenuation over the measured distance travelled inside the prism.
        throughput *= exp(-vec3(0.34, 0.105, 0.045) * distanceTravelled);
      }

      if (hit.material == MAT_EMITTER) {
        float core = 16.0 + 5.0 * (1.0 - smoothstep(-0.34, 0.0, emitterSdf(position)));
        radiance += throughput * vec3(1.0, 0.84, 0.56) * core;
        break;
      }

      vec2 normal = materialNormal(position, hit.material) * mediumSign;

      if (hit.material == MAT_MIRROR || hit.material == MAT_METAL) {
        direction = reflect(direction, normal);
        if (hit.material == MAT_METAL) {
          float roughJitter = hash12(vec2(seed + float(bounce) * 9.71, uFrame * 0.73)) - 0.5;
          direction = rotation(roughJitter * 0.34) * direction;
          throughput *= vec3(0.82, 0.62, 0.34) * 0.86;
        } else {
          throughput *= vec3(0.93, 0.97, 1.0) * 0.96;
        }
        origin = position + normal * BIAS;
        continue;
      }

      if (hit.material == MAT_GLASS) {
        const float ior = 1.52;
        float eta = mediumSign < 0.0 ? ior : 1.0 / ior;
        vec2 transmitted = refract(direction, normal, eta);
        float cosine = clamp(dot(-direction, normal), 0.0, 1.0);
        float fresnel = fresnelSchlick(
          cosine,
          mediumSign < 0.0 ? ior : 1.0,
          mediumSign < 0.0 ? 1.0 : ior
        );
        bool totalInternalReflection = dot(transmitted, transmitted) < 0.0001;
        float branch = hash12(vec2(seed * 1.37 + float(bounce) * 17.13, uFrame + 3.1));
        if (totalInternalReflection || branch < fresnel) {
          direction = reflect(direction, normal);
          origin = position + normal * BIAS;
        } else {
          direction = normalize(transmitted);
          throughput *= vec3(0.92, 0.985, 1.0);
          origin = position - normal * BIAS;
        }
        continue;
      }

      // Diffuse bodies receive light but terminate a specular transport path.
      break;
    }

    return radiance;
  }

  vec3 integrateRadiance(vec2 p) {
    vec3 sum = vec3(0.0);
    float pixelNoise = hash12(gl_FragCoord.xy + vec2(17.0, 41.0));
    float temporalRotation = fract(uFrame * 0.61803398875 + pixelNoise);

    for (int sampleIndex = 0; sampleIndex < MAX_SAMPLES; sampleIndex++) {
      if (sampleIndex >= uSampleCount) break;
      float samplePhase = (
        float(sampleIndex) + temporalRotation
      ) / float(uSampleCount);
      float angle = TWO_PI * samplePhase;
      vec2 direction = vec2(cos(angle), sin(angle));
      sum += tracePath(
        p,
        direction,
        pixelNoise * 97.0 + float(sampleIndex) * 13.7
      );
    }

    return sum / float(uSampleCount);
  }

  vec3 backdrop(vec2 p) {
    vec2 cell = floor((p + vec2(5.4, 3.0)) * 2.25);
    float checker = mod(cell.x + cell.y, 2.0);
    vec3 a = vec3(0.018, 0.024, 0.040);
    vec3 b = vec3(0.042, 0.049, 0.070);
    vec3 colour = mix(a, b, checker);
    float vertical = 1.0 - smoothstep(0.015, 0.035, abs(fract((p.x + 5.4) * 0.45) - 0.5));
    float horizontal = 1.0 - smoothstep(0.015, 0.035, abs(fract((p.y + 3.0) * 0.55) - 0.5));
    return colour + vec3(0.018, 0.021, 0.028) * max(vertical, horizontal);
  }

  float cross2(vec2 a, vec2 b) {
    return a.x * b.y - a.y * b.x;
  }

  float rayDeposit(vec2 p, vec2 origin, vec2 direction, float width) {
    vec2 offset = p - origin;
    float along = dot(offset, direction);
    if (along <= 0.0) return 0.0;
    float perpendicular = abs(cross2(offset, direction));
    float beam = exp(-perpendicular * perpendicular / max(width * width, 0.00001));
    return beam / (1.0 + along * along * 0.025);
  }

  float positiveCircleExit(vec2 origin, vec2 direction, vec2 centre, float radius) {
    vec2 offset = origin - centre;
    float projection = dot(offset, direction);
    float discriminant = projection * projection
      - dot(offset, offset)
      + radius * radius;
    if (discriminant <= 0.0) return -1.0;
    float root = sqrt(discriminant);
    float nearDistance = -projection - root;
    float farDistance = -projection + root;
    if (nearDistance > BIAS) return nearDistance;
    return farDistance > BIAS ? farDistance : -1.0;
  }

  vec3 forwardOpticalTransport(vec2 p) {
    const vec2 emitter = vec2(-4.28, 0.42);
    float mirrorDensity = 0.0;
    float metalDensity = 0.0;
    float glassDensity = 0.0;

    // Perfect mirror: a narrow family of reflected rays stays sharp.
    const int mirrorRays = 14;
    vec2 mirrorCentre = vec2(-2.23, 1.25);
    float mirrorAngle = 1.18;
    vec2 mirrorTangent = rotation(mirrorAngle) * vec2(0.0, 1.0);
    vec2 mirrorBaseNormal = rotation(mirrorAngle) * vec2(1.0, 0.0);
    for (int rayIndex = 0; rayIndex < mirrorRays; rayIndex++) {
      float progress = (float(rayIndex) + 0.5) / float(mirrorRays);
      vec2 hit = mirrorCentre + mirrorTangent * mix(-0.88, 0.88, progress);
      vec2 incident = normalize(hit - emitter);
      vec2 normal = dot(incident, mirrorBaseNormal) < 0.0
        ? mirrorBaseNormal
        : -mirrorBaseNormal;
      vec2 reflected = reflect(incident, normal);
      mirrorDensity += rayDeposit(p, hit + normal * BIAS, reflected, 0.035);
    }

    // Rough metal: the same reflection law with a deterministic angular
    // distribution produces a broad, warm lobe rather than a mirror line.
    const int metalRays = 12;
    vec2 metalCentre = vec2(-2.80, -1.30);
    float metalAngle = 0.16;
    vec2 metalTangent = rotation(metalAngle) * vec2(0.0, 1.0);
    vec2 metalNormal = rotation(metalAngle) * vec2(-1.0, 0.0);
    for (int rayIndex = 0; rayIndex < metalRays; rayIndex++) {
      float progress = (float(rayIndex) + 0.5) / float(metalRays);
      vec2 hit = metalCentre + metalTangent * mix(-0.36, 0.36, progress)
        + metalNormal * 0.62;
      vec2 incident = normalize(hit - emitter);
      vec2 reflected = reflect(incident, metalNormal);
      float roughness = (hash12(vec2(float(rayIndex) * 7.31, 19.4)) - 0.5) * 0.46;
      reflected = rotation(roughness) * reflected;
      metalDensity += rayDeposit(p, hit + metalNormal * BIAS, reflected, 0.075);
    }

    // Dielectric lens: trace entry and exit explicitly. Each ray applies
    // Snell at both boundaries, Fresnel transmission and Beer-Lambert loss.
    const int glassRays = 24;
    const float glassIor = 1.52;
    const vec2 leftCircle = vec2(-0.25, 0.04);
    const vec2 rightCircle = vec2(0.95, 0.04);
    const float lensRadius = 1.08;
    for (int rayIndex = 0; rayIndex < glassRays; rayIndex++) {
      float progress = (float(rayIndex) + 0.5) / float(glassRays);
      float entryY = mix(-0.82, 0.90, progress);
      float entryOffsetY = entryY - rightCircle.y;
      float entryX = rightCircle.x - sqrt(max(
        lensRadius * lensRadius - entryOffsetY * entryOffsetY,
        0.0
      ));
      vec2 entry = vec2(entryX, entryY);
      vec2 entryOutwardNormal = normalize(entry - rightCircle);
      vec2 incident = normalize(entry - emitter);
      vec2 insideDirection = refract(incident, entryOutwardNormal, 1.0 / glassIor);
      if (dot(insideDirection, insideDirection) < 0.0001) continue;

      vec2 originInside = entry - entryOutwardNormal * BIAS;
      float exitDistance = positiveCircleExit(
        originInside,
        insideDirection,
        leftCircle,
        lensRadius
      );
      if (exitDistance <= 0.0) continue;
      vec2 exit = originInside + insideDirection * exitDistance;
      vec2 exitOutwardNormal = normalize(exit - leftCircle);
      vec2 transmitted = refract(insideDirection, -exitOutwardNormal, glassIor);
      if (dot(transmitted, transmitted) < 0.0001) continue;
      transmitted = normalize(transmitted);

      float entryFresnel = fresnelSchlick(
        clamp(dot(-incident, entryOutwardNormal), 0.0, 1.0),
        1.0,
        glassIor
      );
      float exitFresnel = fresnelSchlick(
        clamp(dot(-insideDirection, -exitOutwardNormal), 0.0, 1.0),
        glassIor,
        1.0
      );
      float absorption = exp(-0.12 * exitDistance);
      float transmission = (1.0 - entryFresnel) * (1.0 - exitFresnel) * absorption;
      glassDensity += rayDeposit(
        p,
        exit + exitOutwardNormal * BIAS,
        transmitted,
        0.043
      ) * transmission;
    }

    float mirrorBeam = mirrorDensity * 0.024
      + pow(max(mirrorDensity - 1.15, 0.0), 1.35) * 0.082;
    float metalBeam = metalDensity * 0.010
      + pow(max(metalDensity - 1.05, 0.0), 1.22) * 0.025;
    float glassBeam = glassDensity * 0.010
      + pow(max(glassDensity - 1.20, 0.0), 1.42) * 0.085;

    return vec3(0.72, 0.86, 1.0) * mirrorBeam
      + vec3(1.0, 0.38, 0.075) * metalBeam
      + vec3(0.16, 0.86, 1.0) * glassBeam;
  }

  float outlineMask(float distanceToSurface, float pixels) {
    float width = max(fwidth(distanceToSurface), pixels / max(uResolution.y, 1.0) * 6.0);
    return 1.0 - smoothstep(width * 0.25, width * 1.6, abs(distanceToSurface));
  }

  vec3 materialAppearance(vec2 p, SceneHit local, vec3 transported) {
    vec3 base = backdrop(p);
    float mirrorDistance = mirrorSdf(p);
    float metalDistance = metalSdf(p);
    float glassDistance = glassSdf(p);
    float diffuseDistance = min(diffuseBlockSdf(p), receiverSdf(p));

    if (local.material == MAT_EMITTER && local.distance < 0.0) {
      float radial = clamp(1.0 + local.distance / 0.34, 0.0, 1.0);
      return mix(vec3(1.0, 0.52, 0.14), vec3(1.0), pow(radial, 0.32)) * 4.4;
    }

    if (local.material == MAT_GLASS && glassDistance < 0.0) {
      vec2 normal = materialNormal(p, MAT_GLASS);
      vec2 incident = normalize(vec2(0.31, -0.95));
      vec2 insideDirection = refract(incident, normal, 1.0 / 1.52);
      float fresnel = fresnelSchlick(clamp(dot(-incident, normal), 0.0, 1.0), 1.0, 1.52);
      vec2 displaced = p + insideDirection * 0.48 + normal * 0.16;
      vec3 transmittedBackdrop = backdrop(displaced) * vec3(0.62, 0.94, 1.0);
      return transmittedBackdrop * (1.0 - fresnel)
        + transported * 1.45
        + vec3(0.22, 0.82, 1.0) * fresnel * 1.8;
    }

    if (local.material == MAT_MIRROR && mirrorDistance < 0.0) {
      vec2 normal = materialNormal(p, MAT_MIRROR);
      vec2 reflectedView = reflect(normalize(vec2(0.34, -0.94)), normal);
      vec3 reflectedBackdrop = backdrop(p + reflectedView * 1.8);
      return reflectedBackdrop * vec3(0.82, 0.91, 1.0) * 2.1
        + transported * 1.8;
    }

    if (local.material == MAT_METAL && metalDistance < 0.0) {
      vec2 localPosition = rotation(-0.16) * (p - vec2(-2.80, -1.30));
      float brushed = 0.5 + 0.5 * sin(localPosition.y * 62.0);
      vec3 bronze = mix(vec3(0.10, 0.045, 0.018), vec3(0.78, 0.40, 0.12), brushed);
      return bronze * 0.62 + transported * vec3(1.0, 0.68, 0.32) * 1.15;
    }

    if (local.material == MAT_DIFFUSE && diffuseDistance < 0.0) {
      return vec3(0.21, 0.23, 0.27) + transported * vec3(0.92, 0.88, 0.82) * 1.35;
    }

    vec3 result = base + transported * 1.62;
    float mirrorOutline = outlineMask(mirrorDistance, 1.0);
    float metalOutline = outlineMask(metalDistance, 1.0);
    float glassOutline = outlineMask(glassDistance, 1.0);
    float diffuseOutline = outlineMask(diffuseDistance, 1.0);
    result = mix(result, vec3(0.72, 0.85, 1.0), mirrorOutline * 0.75);
    result = mix(result, vec3(0.95, 0.48, 0.14), metalOutline * 0.62);
    result = mix(result, vec3(0.15, 0.88, 1.0), glassOutline * 0.82);
    result = mix(result, vec3(0.62), diffuseOutline * 0.55);
    return result;
  }

  vec3 acesToneMap(vec3 colour) {
    const float a = 2.51;
    const float b = 0.03;
    const float c = 2.43;
    const float d = 0.59;
    const float e = 0.14;
    return clamp(
      (colour * (a * colour + b))
      / (colour * (c * colour + d) + e),
      0.0,
      1.0
    );
  }

  void main() {
    vec2 screen = vUv * 2.0 - 1.0;
    vec2 p = vec2(screen.x * uAspect, screen.y) * 3.0;
    SceneHit local = mapScene(p);
    vec3 transported = integrateRadiance(p);
    if (local.distance >= 0.0 || local.material == MAT_DIFFUSE) {
      transported += forwardOpticalTransport(p);
    }

    // A direct halo identifies the physical emitter before the Monte Carlo
    // history has converged; it does not create reflected/refracted energy.
    float emitterDistance = length(p - vec2(-4.28, 0.42));
    transported += vec3(1.0, 0.56, 0.20)
      * 0.018 / max(emitterDistance * emitterDistance, 0.08);

    vec3 colour = materialAppearance(p, local, transported);
    float vignette = 1.0 - smoothstep(0.30, 1.34, length(screen * vec2(0.72, 0.92)));
    colour *= 0.72 + vignette * 0.28;
    colour = acesToneMap(colour);
    outColour = vec4(pow(colour, vec3(1.0 / 2.2)), 1.0);
  }
`;

const accumulateFragmentShader = /* glsl */ `
  precision highp float;

  in vec2 vUv;
  out vec4 outColour;

  uniform sampler2D uCurrent;
  uniform sampler2D uHistory;
  uniform float uHistoryWeight;

  void main() {
    vec4 current = texture(uCurrent, vUv);
    vec4 history = texture(uHistory, vUv);
    outColour = mix(current, history, uHistoryWeight);
  }
`;

const displayFragmentShader = /* glsl */ `
  precision highp float;

  in vec2 vUv;
  out vec4 outColour;

  uniform sampler2D uSource;
  uniform vec2 uTexel;

  void main() {
    vec3 centre = texture(uSource, vUv).rgb;
    vec3 neighbours = (
      texture(uSource, vUv + vec2(uTexel.x, 0.0)).rgb
      + texture(uSource, vUv - vec2(uTexel.x, 0.0)).rgb
      + texture(uSource, vUv + vec2(0.0, uTexel.y)).rgb
      + texture(uSource, vUv - vec2(0.0, uTexel.y)).rgb
    ) * 0.25;
    // The lab is static: a small reconstruction average is a much better
    // trade than a sharpened Monte-Carlo speckle. It is not bloom and never
    // creates extra light; it only resolves the bounded internal grid.
    vec3 resolved = mix(centre, neighbours, 0.34);
    outColour = vec4(clamp(resolved, 0.0, 1.0), 1.0);
  }
`;

const makeTarget = (width: number, height: number): THREE.WebGLRenderTarget =>
  new THREE.WebGLRenderTarget(width, height, {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
  });

const makeMaterial = (
  fragmentShader: string,
  uniforms: Record<string, THREE.IUniform>,
): THREE.ShaderMaterial => new THREE.ShaderMaterial({
  uniforms,
  vertexShader: fullscreenVertexShader,
  fragmentShader,
  glslVersion: THREE.GLSL3,
  depthTest: false,
  depthWrite: false,
  blending: THREE.NoBlending,
  toneMapped: false,
});

export class OpticalLab {
  private readonly geometry = new THREE.PlaneGeometry(2, 2);
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly opticalMaterial: THREE.ShaderMaterial;
  private readonly accumulateMaterial: THREE.ShaderMaterial;
  private readonly displayMaterial: THREE.ShaderMaterial;
  private readonly mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  private rawTarget: THREE.WebGLRenderTarget;
  private historyTargets: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget];
  private historyReadIndex = 0;
  private quality: OpticalLabQuality = 'high';
  private width = 1;
  private height = 1;
  private frameIndex = 0;
  private resetHistory = true;
  private lastCpuTimeMs = 0;
  private active = false;

  constructor(private readonly renderer: THREE.WebGLRenderer) {
    this.rawTarget = makeTarget(1, 1);
    this.historyTargets = [makeTarget(1, 1), makeTarget(1, 1)];
    this.opticalMaterial = makeMaterial(opticalFragmentShader, {
      uResolution: { value: new THREE.Vector2(1, 1) },
      uAspect: { value: 1 },
      uFrame: { value: 0 },
      uSampleCount: { value: HIGH_SAMPLES },
    });
    this.accumulateMaterial = makeMaterial(accumulateFragmentShader, {
      uCurrent: { value: this.rawTarget.texture },
      uHistory: { value: this.historyTargets[0].texture },
      uHistoryWeight: { value: 0 },
    });
    this.displayMaterial = makeMaterial(displayFragmentShader, {
      uSource: { value: this.historyTargets[0].texture },
      uTexel: { value: new THREE.Vector2(1, 1) },
    });
    this.mesh = new THREE.Mesh(this.geometry, this.opticalMaterial);
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);
  }

  get stats(): OpticalLabStats {
    const samplesPerPixel = this.quality === 'high' ? HIGH_SAMPLES : SAFE_SAMPLES;
    return {
      active: this.active,
      quality: this.quality,
      width: this.width,
      height: this.height,
      samplesPerPixel,
      accumulatedFrames: this.frameIndex,
      drawCalls: this.active ? 3 : 0,
      cpuTimeMs: this.lastCpuTimeMs,
      targetMemoryBytes: this.width * this.height * 8 * 3,
    };
  }

  setQuality(quality: OpticalLabQuality): void {
    if (quality === this.quality) return;
    this.quality = quality;
    this.resizeTargets();
  }

  setSize(canvasWidth: number, canvasHeight: number): void {
    const safeHeight = Math.max(1, canvasHeight);
    const aspect = Math.max(0.5, canvasWidth / safeHeight);
    const targetHeight = this.quality === 'high'
      ? HIGH_TARGET_HEIGHT
      : SAFE_TARGET_HEIGHT;
    const nextHeight = Math.max(1, Math.min(targetHeight, Math.round(safeHeight)));
    const nextWidth = Math.max(
      1,
      Math.min(MAX_TARGET_WIDTH, Math.round(nextHeight * aspect)),
    );
    if (nextWidth === this.width && nextHeight === this.height) return;
    this.width = nextWidth;
    this.height = nextHeight;
    this.allocateTargets();
  }

  reset(): void {
    this.frameIndex = 0;
    this.resetHistory = true;
  }

  setActive(active: boolean): void {
    if (active && !this.active) this.reset();
    this.active = active;
  }

  render(): void {
    if (!this.active) return;
    const startedAt = performance.now();
    const previousTarget = this.renderer.getRenderTarget();
    const previousColour = this.renderer.getClearColor(new THREE.Color()).clone();
    const previousAlpha = this.renderer.getClearAlpha();
    const previousAutoClear = this.renderer.autoClear;
    const writeIndex = 1 - this.historyReadIndex;

    this.opticalMaterial.uniforms.uFrame.value = this.frameIndex;
    this.opticalMaterial.uniforms.uSampleCount.value =
      this.quality === 'high' ? HIGH_SAMPLES : SAFE_SAMPLES;
    this.renderPass(this.opticalMaterial, this.rawTarget, true);

    this.accumulateMaterial.uniforms.uCurrent.value = this.rawTarget.texture;
    this.accumulateMaterial.uniforms.uHistory.value =
      this.historyTargets[this.historyReadIndex].texture;
    this.accumulateMaterial.uniforms.uHistoryWeight.value =
      this.resetHistory ? 0 : 0.98;
    this.renderPass(this.accumulateMaterial, this.historyTargets[writeIndex], false);
    this.historyReadIndex = writeIndex;

    this.displayMaterial.uniforms.uSource.value =
      this.historyTargets[this.historyReadIndex].texture;
    this.mesh.material = this.displayMaterial;
    this.renderer.setRenderTarget(null);
    this.renderer.setClearColor(0x020308, 1);
    this.renderer.autoClear = true;
    this.renderer.clear();
    this.renderer.render(this.scene, this.camera);

    this.mesh.material = this.opticalMaterial;
    this.renderer.setRenderTarget(previousTarget);
    this.renderer.setClearColor(previousColour, previousAlpha);
    this.renderer.autoClear = previousAutoClear;
    this.frameIndex += 1;
    this.resetHistory = false;
    this.lastCpuTimeMs = performance.now() - startedAt;
  }

  dispose(): void {
    this.geometry.dispose();
    this.opticalMaterial.dispose();
    this.accumulateMaterial.dispose();
    this.displayMaterial.dispose();
    this.rawTarget.dispose();
    this.historyTargets.forEach((target) => target.dispose());
  }

  private renderPass(
    material: THREE.ShaderMaterial,
    target: THREE.WebGLRenderTarget,
    clear: boolean,
  ): void {
    this.mesh.material = material;
    this.renderer.setRenderTarget(target);
    this.renderer.autoClear = clear;
    if (clear) this.renderer.clear();
    this.renderer.render(this.scene, this.camera);
  }

  private resizeTargets(): void {
    const canvas = this.renderer.domElement;
    this.setSize(canvas.clientWidth || canvas.width, canvas.clientHeight || canvas.height);
    this.reset();
  }

  private allocateTargets(): void {
    this.rawTarget.dispose();
    this.historyTargets.forEach((target) => target.dispose());
    this.rawTarget = makeTarget(this.width, this.height);
    this.historyTargets = [
      makeTarget(this.width, this.height),
      makeTarget(this.width, this.height),
    ];
    this.historyReadIndex = 0;
    this.opticalMaterial.uniforms.uResolution.value.set(this.width, this.height);
    this.opticalMaterial.uniforms.uAspect.value = this.width / this.height;
    this.accumulateMaterial.uniforms.uCurrent.value = this.rawTarget.texture;
    this.accumulateMaterial.uniforms.uHistory.value = this.historyTargets[0].texture;
    this.displayMaterial.uniforms.uSource.value = this.historyTargets[0].texture;
    this.displayMaterial.uniforms.uTexel.value.set(1 / this.width, 1 / this.height);
    this.reset();
  }
}

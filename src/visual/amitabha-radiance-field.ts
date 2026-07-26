import * as THREE from 'three';
import {
  DirectionalMaterialField,
  type DirectionalEnergyProbe,
  type DirectionalMaterialFieldStats,
} from './directional-material-field';
import {
  isDirectionalOpticalMaterial,
  opticalMaterialCode,
  type OpticalMaterial,
} from './optical-materials';
import type { OpticalQualityPreset } from './optical-quality-controller';

// WebGL2 port of Yaazarai/Volumetric-HRC's ray-extension implementation:
// https://github.com/Yaazarai/Volumetric-HRC (Unlicense).
//
// HRC requires a square power-of-two field. The visible 16:10 region is
// represented inside that square by AMITABHA_WORLD_BOUNDS.
const MAX_BODIES = 48;
const HIGH_FIELD_EXTENT = 512;
const SAFE_FIELD_EXTENT = 256;
const FRUSTUM_COUNT = 4;
const DEFAULT_FRUSTUMS_PER_STEP = 2;

// The smallest square domain that covers the visible 16:9 camera throughout
// a 90° roll. It keeps the radiance map continuous at every turn angle.
export const AMITABHA_WORLD_BOUNDS = new THREE.Vector4(-8.8, -8.8, 8.8, 8.8);

export interface AmitabhaBody {
  x: number;
  y: number;
  halfWidth: number;
  halfHeight: number;
  angle: number;
  emission: readonly [number, number, number];
  emissionStrength: number;
  albedo: readonly [number, number, number];
  material: OpticalMaterial;
  sides?: number;
  transportRole?: 'body' | 'floor';
  transportOrder?: number;
}

export function selectTransportBodies(
  bodies: readonly AmitabhaBody[],
  limit = MAX_BODIES,
): AmitabhaBody[] {
  const selectedLimit = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : MAX_BODIES;
  if (bodies.length <= selectedLimit) return [...bodies];
  if (selectedLimit === 0) return [];

  const selected = new Set<AmitabhaBody>();
  const addUntilFull = (
    candidates: readonly AmitabhaBody[],
    maximumToAdd = Number.POSITIVE_INFINITY,
  ): void => {
    let added = 0;
    for (const candidate of candidates) {
      if (selected.size >= selectedLimit || added >= maximumToAdd) return;
      const sizeBefore = selected.size;
      selected.add(candidate);
      if (selected.size > sizeBefore) added += 1;
    }
  };
  const recentFirst = (left: AmitabhaBody, right: AmitabhaBody): number =>
    (right.transportOrder ?? 0) - (left.transportOrder ?? 0);

  addUntilFull(bodies.filter((body) => body.transportRole === 'floor'));
  addUntilFull(
    bodies
      .filter((body) => (
        body.transportRole !== 'floor'
        && body.emissionStrength <= 0
        && isDirectionalOpticalMaterial(body.material)
      ))
      .sort(recentFirst),
  );
  const emitterBudget = Math.min(
    20,
    Math.max(1, Math.floor((selectedLimit - selected.size) * 0.55)),
  );
  addUntilFull(
    bodies
      .filter((body) => body.transportRole !== 'floor' && body.emissionStrength > 0)
      .sort((left, right) => right.emissionStrength - left.emissionStrength || recentFirst(left, right)),
    emitterBudget,
  );
  addUntilFull(
    bodies
      .filter((body) => (
        body.transportRole !== 'floor'
        && body.emissionStrength <= 0
        && !isDirectionalOpticalMaterial(body.material)
      ))
      .sort(recentFirst),
  );

  // If a synthetic or very sparse scene has no ordinary receivers, use any
  // remaining bodies rather than leaving transport slots idle.
  for (let index = bodies.length - 1; index >= 0 && selected.size < selectedLimit; index -= 1) {
    selected.add(bodies[index]);
  }
  return bodies.filter((body) => selected.has(body));
}

type PairTarget = THREE.WebGLRenderTarget<THREE.Texture>;
type SingleTarget = THREE.WebGLRenderTarget<THREE.Texture>;

export interface AmitabhaRadianceStats {
  resolution: number;
  frustumsPerFrame: number;
  updateHz: number;
  targetMemoryBytes: number;
  drawCalls: number;
  optical: DirectionalMaterialFieldStats;
}

const passVertexShader = /* glsl */ `
  out vec2 vUv;

  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const displayVertexShader = /* glsl */ `
  out vec2 vUv;

  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const sceneFragmentShader = /* glsl */ `
  precision highp float;
  precision highp int;

  in vec2 vUv;
  layout(location = 0) out vec4 outEmissivity;
  layout(location = 1) out vec4 outAbsorption;

  uniform int uBodyCount;
  uniform vec4 uBodyShape[${MAX_BODIES}];
  uniform vec4 uBodyFrame[${MAX_BODIES}];
  uniform vec4 uBodyEmission[${MAX_BODIES}];
  uniform vec4 uBodyAlbedo[${MAX_BODIES}];
  uniform vec4 uBodyMeta[${MAX_BODIES}];
  uniform sampler2D uPreviousIrradiance;
  uniform float uBounceGain;

  const float PI = 3.141592653589793;
  const float TWO_PI = 6.283185307179586;

  bool insideBody(vec2 worldPosition, vec4 shape, vec4 frame, float sides) {
    vec2 offset = worldPosition - shape.xy;
    vec2 local = vec2(
      frame.x * offset.x + frame.y * offset.y,
      -frame.y * offset.x + frame.x * offset.y
    );
    vec2 normalizedPosition = local / max(shape.zw, vec2(0.0001));

    if (sides < 2.5) {
      return all(lessThanEqual(abs(normalizedPosition), vec2(1.0)));
    }

    float count = clamp(floor(sides + 0.5), 3.0, 8.0);
    float angle = atan(normalizedPosition.y, normalizedPosition.x);
    float sector = TWO_PI / count;
    float boundary = cos(PI / count)
      / max(cos(mod(angle + PI / count, sector) - PI / count), 0.0001);
    return length(normalizedPosition) <= boundary;
  }

  void main() {
    vec3 emissivity = vec3(0.0);
    vec3 absorption = vec3(0.0);
    float directEmissionStrength = 0.0;
    vec3 previousLight = texture(uPreviousIrradiance, vUv).rgb;

    for (int bodyIndex = 0; bodyIndex < ${MAX_BODIES}; bodyIndex++) {
      if (bodyIndex >= uBodyCount) break;
      if (!insideBody(
        mix(
          vec2(${AMITABHA_WORLD_BOUNDS.x.toFixed(4)}, ${AMITABHA_WORLD_BOUNDS.y.toFixed(4)}),
          vec2(${AMITABHA_WORLD_BOUNDS.z.toFixed(4)}, ${AMITABHA_WORLD_BOUNDS.w.toFixed(4)}),
          vUv
        ),
        uBodyShape[bodyIndex],
        uBodyFrame[bodyIndex],
        uBodyMeta[bodyIndex].x
      )) continue;

      vec4 source = uBodyEmission[bodyIndex];
      float materialKind = floor(uBodyMeta[bodyIndex].y + 0.5);
      float sourceStrength = materialKind < 0.5 ? source.a : 0.0;
      vec3 diffuseBounce = previousLight
        * uBodyAlbedo[bodyIndex].rgb
        * uBounceGain;
      emissivity = min(source.rgb * sourceStrength + diffuseBounce, vec3(12.0));
      absorption = vec3(max(uBodyAlbedo[bodyIndex].a, 0.0));
      if (sourceStrength > 0.0) {
        directEmissionStrength = max(directEmissionStrength, sourceStrength);
      }
    }

    outEmissivity = vec4(emissivity, directEmissionStrength);
    outAbsorption = vec4(absorption, 1.0);
  }
`;

const frustumSeedFragmentShader = /* glsl */ `
  precision highp float;
  precision highp int;

  in vec2 vUv;
  layout(location = 0) out vec4 outRadiance;
  layout(location = 1) out vec4 outTransmit;

  uniform sampler2D uEmissivity;
  uniform sampler2D uAbsorption;
  uniform vec2 uWorldSize;
  uniform vec2 uCascadeSize;
  uniform int uFrustumIndex;

  void main() {
    vec2 texel = vUv * uCascadeSize;
    float interval = 1.0;
    float verticalRays = 2.0;
    float plane = floor(texel.x / verticalRays);
    vec2 probe = vec2(plane * interval + 0.5, texel.y) / uWorldSize;

    vec2 samplePosition;
    if (uFrustumIndex == 0) samplePosition = probe;
    else if (uFrustumIndex == 1) samplePosition = 1.0 - probe.yx;
    else if (uFrustumIndex == 2) samplePosition = 1.0 - probe;
    else samplePosition = probe.yx;

    vec3 emissivity = texture(uEmissivity, samplePosition).rgb;
    vec3 absorption = texture(uAbsorption, samplePosition).rgb;
    vec3 transmit = exp2(-absorption);
    vec3 radiance = (vec3(1.0) - transmit) * emissivity;

    outRadiance = vec4(radiance, 1.0);
    outTransmit = vec4(transmit, 1.0);
  }
`;

const extensionFragmentShader = /* glsl */ `
  precision highp float;

  in vec2 vUv;
  layout(location = 0) out vec4 outRadiance;
  layout(location = 1) out vec4 outTransmit;

  uniform sampler2D uPreviousRadiance;
  uniform sampler2D uPreviousTransmit;
  uniform vec2 uPreviousSize;
  uniform vec2 uCascadeSize;
  uniform float uCascadeIndex;

  void mergeRadiance(
    vec4 nearRadiance,
    vec4 nearTransmit,
    vec4 farRadiance,
    vec4 farTransmit,
    out vec4 radiance,
    out vec4 transmit
  ) {
    radiance = nearRadiance + farRadiance * nearTransmit;
    transmit = nearTransmit * farTransmit;
  }

  void getPreviousVolume(
    vec2 probe,
    float index,
    float interval,
    float lookupWidth,
    out vec4 radiance,
    out vec4 transmit
  ) {
    vec2 samplePosition = vec2(
      floor(probe.x / interval) * lookupWidth + 0.5 + index,
      probe.y
    ) / uPreviousSize;
    bool outside = any(lessThan(samplePosition, vec2(0.0)))
      || any(greaterThanEqual(samplePosition, vec2(1.0)));
    radiance = outside ? vec4(0.0) : texture(uPreviousRadiance, samplePosition);
    transmit = outside ? vec4(1.0) : texture(uPreviousTransmit, samplePosition);
  }

  void extendRay(
    vec2 probe,
    float lowerIndex,
    float upperIndex,
    float previousInterval,
    float previousVerticalRays,
    out vec4 radiance,
    out vec4 transmit
  ) {
    vec2 mergeProbe = probe
      + vec2(previousInterval, -previousInterval + lowerIndex * 2.0);

    vec4 nearRadiance;
    vec4 nearTransmit;
    vec4 farRadiance;
    vec4 farTransmit;
    getPreviousVolume(
      probe,
      lowerIndex,
      previousInterval,
      previousVerticalRays,
      nearRadiance,
      nearTransmit
    );
    getPreviousVolume(
      mergeProbe,
      upperIndex,
      previousInterval,
      previousVerticalRays,
      farRadiance,
      farTransmit
    );
    mergeRadiance(
      nearRadiance,
      nearTransmit,
      farRadiance,
      farTransmit,
      radiance,
      transmit
    );
  }

  void main() {
    vec2 texel = vUv * uCascadeSize;
    float interval = exp2(uCascadeIndex);
    float verticalRays = interval + 1.0;
    float plane = floor(texel.x / verticalRays);
    float index = floor(texel.x - plane * verticalRays);
    vec2 probe = vec2(plane * interval, texel.y) + vec2(0.5, 0.0);

    float previousInterval = exp2(uCascadeIndex - 1.0);
    float previousVerticalRays = previousInterval + 1.0;
    float lower = floor(index * 0.5);
    float upper = ceil(index * 0.5);

    vec4 radianceLower;
    vec4 transmitLower;
    vec4 radianceUpper;
    vec4 transmitUpper;
    extendRay(
      probe,
      lower,
      upper,
      previousInterval,
      previousVerticalRays,
      radianceLower,
      transmitLower
    );
    extendRay(
      probe,
      upper,
      lower,
      previousInterval,
      previousVerticalRays,
      radianceUpper,
      transmitUpper
    );

    outRadiance = mix(radianceLower, radianceUpper, 0.5);
    outTransmit = mix(transmitLower, transmitUpper, 0.5);
  }
`;

const mergeConesFragmentShader = /* glsl */ `
  precision highp float;

  in vec2 vUv;
  layout(location = 0) out vec4 outRadiance;
  layout(location = 1) out vec4 outTransmit;

  uniform sampler2D uRayRadiance;
  uniform sampler2D uRayTransmit;
  uniform vec2 uRaySize;
  uniform sampler2D uFarRadiance;
  uniform sampler2D uFarTransmit;
  uniform vec2 uFarSize;
  uniform vec2 uCascadeSize;
  uniform float uCascadeIndex;
  uniform bool uHasFar;

  void mergeRadiance(
    vec4 nearRadiance,
    vec4 nearTransmit,
    vec4 farRadiance,
    vec4 farTransmit,
    out vec4 radiance,
    out vec4 transmit
  ) {
    radiance = nearRadiance + farRadiance * nearTransmit;
    transmit = nearTransmit * farTransmit;
  }

  void getRayVolume(
    vec2 probe,
    float index,
    float interval,
    float lookupWidth,
    out vec4 radiance,
    out vec4 transmit
  ) {
    vec2 samplePosition = vec2(
      floor(probe.x / interval) * lookupWidth + 0.5 + index,
      probe.y
    ) / uRaySize;
    bool outside = any(lessThan(samplePosition, vec2(0.0)))
      || any(greaterThanEqual(samplePosition, vec2(1.0)));
    radiance = outside ? vec4(0.0) : texture(uRayRadiance, samplePosition);
    transmit = outside ? vec4(1.0) : texture(uRayTransmit, samplePosition);
  }

  void getFarVolume(
    vec2 probe,
    float index,
    out vec4 radiance,
    out vec4 transmit
  ) {
    vec2 samplePosition = vec2(
      floor(probe.x) + 0.5 + index,
      probe.y
    ) / uFarSize;
    bool outside = any(lessThan(samplePosition, vec2(0.0)))
      || any(greaterThanEqual(samplePosition, vec2(1.0)));
    if (!uHasFar || outside) {
      radiance = vec4(0.0);
      transmit = vec4(1.0);
      return;
    }
    radiance = texture(uFarRadiance, samplePosition);
    transmit = texture(uFarTransmit, samplePosition);
  }

  void mergeCone(
    vec2 probe,
    float plane,
    float interval,
    float verticalRays,
    float index,
    float side,
    out vec4 radiance,
    out vec4 transmit
  ) {
    float coneIndex = index * 2.0 + side;
    float rayIndex = index + side;
    vec2 limit = vec2(interval, -interval);
    float alignment = 2.0 - mod(plane, 2.0);

    vec2 mergeProbe = probe
      + alignment * (limit + vec2(0.0, rayIndex * 2.0));
    vec2 leftRay = limit * 2.0 + vec2(0.0, coneIndex * 2.0);
    vec2 rightRay = limit * 2.0 + vec2(0.0, (coneIndex + 1.0) * 2.0);
    float coneWeight = 0.5 * (
      atan(rightRay.y / rightRay.x)
      - atan(leftRay.y / leftRay.x)
    );

    vec4 rayRadiance;
    vec4 rayTransmit;
    vec4 farConeRadiance;
    vec4 farConeTransmit;
    getRayVolume(
      probe,
      rayIndex,
      interval,
      verticalRays,
      rayRadiance,
      rayTransmit
    );
    getFarVolume(
      mergeProbe,
      coneIndex,
      farConeRadiance,
      farConeTransmit
    );

    if (mod(plane, 2.0) == 0.0) {
      vec2 farProbe = probe + limit + vec2(0.0, rayIndex * 2.0);
      vec4 extendedRayRadiance;
      vec4 extendedRayTransmit;
      vec4 nearConeRadiance;
      vec4 nearConeTransmit;
      getRayVolume(
        farProbe,
        rayIndex,
        interval,
        verticalRays,
        extendedRayRadiance,
        extendedRayTransmit
      );
      getFarVolume(
        probe,
        coneIndex,
        nearConeRadiance,
        nearConeTransmit
      );

      mergeRadiance(
        rayRadiance,
        rayTransmit,
        extendedRayRadiance,
        extendedRayTransmit,
        rayRadiance,
        rayTransmit
      );
      mergeRadiance(
        rayRadiance * coneWeight,
        rayTransmit,
        farConeRadiance,
        farConeTransmit,
        radiance,
        transmit
      );
      radiance = mix(radiance, nearConeRadiance, 0.5);
      transmit = mix(transmit, nearConeTransmit, 0.5);
    } else {
      radiance = rayRadiance * coneWeight + farConeRadiance * rayTransmit;
      transmit = rayTransmit * farConeTransmit;
    }
  }

  void main() {
    vec2 texel = vUv * uCascadeSize;
    float interval = exp2(uCascadeIndex);
    float verticalRays = interval + 1.0;
    float plane = floor(texel.x / interval);
    float index = floor(texel.x - plane * interval);
    vec2 probe = vec2(plane * interval, texel.y) + vec2(0.5, 0.0);

    vec4 leftRadiance;
    vec4 leftTransmit;
    vec4 rightRadiance;
    vec4 rightTransmit;
    mergeCone(
      probe,
      plane,
      interval,
      verticalRays,
      index,
      0.0,
      leftRadiance,
      leftTransmit
    );
    mergeCone(
      probe,
      plane,
      interval,
      verticalRays,
      index,
      1.0,
      rightRadiance,
      rightTransmit
    );

    outRadiance = leftRadiance + rightRadiance;
    outTransmit = leftTransmit + rightTransmit;

    if (probe.x < 1.0) {
      outRadiance = vec4(0.0);
      outTransmit = vec4(0.0);
    }
  }
`;

const copyFragmentShader = /* glsl */ `
  precision highp float;
  in vec2 vUv;
  out vec4 outColour;
  uniform sampler2D uSource;

  void main() {
    outColour = texture(uSource, vUv);
  }
`;

const fluenceFragmentShader = /* glsl */ `
  precision highp float;
  in vec2 vUv;
  out vec4 outColour;

  uniform vec2 uWorldSize;
  uniform sampler2D uFrustum0;
  uniform sampler2D uFrustum1;
  uniform sampler2D uFrustum2;
  uniform sampler2D uFrustum3;

  void main() {
    vec2 pixel = vec2(1.0, 0.0) / uWorldSize;
    vec2 offset0 = vUv + pixel.xy;
    vec2 offset1 = vUv - pixel.yx;
    vec2 offset2 = vUv - pixel.xy;
    vec2 offset3 = vUv + pixel.yx;

    vec3 radiance = vec3(0.0);
    radiance += texture(uFrustum0, offset0).rgb;
    radiance += texture(uFrustum1, 1.0 - offset1.yx).rgb;
    radiance += texture(uFrustum2, 1.0 - offset2).rgb;
    radiance += texture(uFrustum3, offset3.yx).rgb;
    outColour = vec4(max(radiance * 0.25, vec3(0.0)), 1.0);
  }
`;

const displayFragmentShader = /* glsl */ `
  precision highp float;
  in vec2 vUv;
  out vec4 outColour;
  uniform sampler2D uIrradiance;
  uniform sampler2D uDirectionalIrradiance;
  uniform float uDirectionalEnabled;
  uniform float uDisplayRoll;
  uniform vec4 uWorldBounds;

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
    float c = cos(uDisplayRoll);
    float s = sin(uDisplayRoll);
    vec2 screenPosition = mix(uWorldBounds.xy, uWorldBounds.zw, vUv);
    vec2 sourcePosition = vec2(
      c * screenPosition.x - s * screenPosition.y,
      s * screenPosition.x + c * screenPosition.y
    );
    vec2 fieldUv = (sourcePosition - uWorldBounds.xy)
      / (uWorldBounds.zw - uWorldBounds.xy);
    bool outsideField = any(lessThan(fieldUv, vec2(0.0)))
      || any(greaterThan(fieldUv, vec2(1.0)));
    vec3 radiance = outsideField
      ? vec3(0.0)
      : texture(uIrradiance, fieldUv).rgb
        + texture(uDirectionalIrradiance, fieldUv).rgb * uDirectionalEnabled;
    vec3 exposed = radiance * 1.7;
    vec3 mapped = acesToneMap(exposed);
    outColour = vec4(pow(mapped, vec3(1.0 / 2.2)), 1.0);
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

const pairTarget = (width: number, height: number): PairTarget =>
  new THREE.WebGLRenderTarget<THREE.Texture>(width, height, {
    count: 2,
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
  });

const singleTarget = (
  width: number,
  height: number,
  linear = false,
): SingleTarget => new THREE.WebGLRenderTarget<THREE.Texture>(width, height, {
  type: THREE.HalfFloatType,
  format: THREE.RGBAFormat,
  minFilter: linear ? THREE.LinearFilter : THREE.NearestFilter,
  magFilter: linear ? THREE.LinearFilter : THREE.NearestFilter,
  depthBuffer: false,
  stencilBuffer: false,
  generateMipmaps: false,
});

export class AmitabhaRadianceField {
  private readonly bodyShape = Array.from({ length: MAX_BODIES }, () => new THREE.Vector4());
  private readonly bodyFrame = Array.from({ length: MAX_BODIES }, () => new THREE.Vector4());
  private readonly bodyEmission = Array.from({ length: MAX_BODIES }, () => new THREE.Vector4());
  private readonly bodyAlbedo = Array.from({ length: MAX_BODIES }, () => new THREE.Vector4());
  private readonly bodyMeta = Array.from({ length: MAX_BODIES }, () => new THREE.Vector4());
  private readonly bodyCount = { value: 0 };
  private readonly quadGeometry = new THREE.PlaneGeometry(2, 2);
  private readonly passScene = new THREE.Scene();
  private readonly passCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private fieldExtent = HIGH_FIELD_EXTENT;
  private cascadeCount = Math.ceil(Math.log2(HIGH_FIELD_EXTENT));
  private sceneTarget!: PairTarget;
  private rayTargets: PairTarget[] = [];
  private mergeTargets!: [PairTarget, PairTarget];
  private frustumTargets: SingleTarget[] = [];
  private fieldTargets!: [SingleTarget, SingleTarget];
  private readonly sceneMaterial: THREE.ShaderMaterial;
  private readonly seedMaterial: THREE.ShaderMaterial;
  private readonly extensionMaterial: THREE.ShaderMaterial;
  private readonly mergeMaterial: THREE.ShaderMaterial;
  private readonly copyMaterial: THREE.ShaderMaterial;
  private readonly fluenceMaterial: THREE.ShaderMaterial;
  private readonly directionalField: DirectionalMaterialField;
  private readonly passMesh: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  private fieldReadIndex = 0;
  private nextFrustum = 0;
  private cycleActive = false;
  private initialized = false;
  private frustumsPerStep = DEFAULT_FRUSTUMS_PER_STEP;
  private completedCycles = 0;
  private updateWindowStartedAt = 0;
  private updateHz = 0;
  private targetMemoryBytes = 0;
  private drawCalls = 0;
  private mirrorCount = 0;
  private glassCount = 0;
  readonly displayMaterial: THREE.ShaderMaterial;

  constructor(private readonly renderer: THREE.WebGLRenderer) {
    this.allocateTargets(HIGH_FIELD_EXTENT);
    this.directionalField = new DirectionalMaterialField(
      renderer,
      AMITABHA_WORLD_BOUNDS,
    );
    this.sceneMaterial = makeMaterial(sceneFragmentShader, {
      uBodyCount: this.bodyCount,
      uBodyShape: { value: this.bodyShape },
      uBodyFrame: { value: this.bodyFrame },
      uBodyEmission: { value: this.bodyEmission },
      uBodyAlbedo: { value: this.bodyAlbedo },
      uBodyMeta: { value: this.bodyMeta },
      uPreviousIrradiance: { value: this.fieldTargets[0].texture },
      uBounceGain: { value: 0.24 },
    });
    this.seedMaterial = makeMaterial(frustumSeedFragmentShader, {
      uEmissivity: { value: this.sceneTarget.textures[0] },
      uAbsorption: { value: this.sceneTarget.textures[1] },
      uWorldSize: { value: new THREE.Vector2(this.fieldExtent, this.fieldExtent) },
      uCascadeSize: {
        value: new THREE.Vector2(
          this.rayTargets[0].width,
          this.rayTargets[0].height,
        ),
      },
      uFrustumIndex: { value: 0 },
    });
    this.extensionMaterial = makeMaterial(extensionFragmentShader, {
      uPreviousRadiance: { value: this.rayTargets[0].textures[0] },
      uPreviousTransmit: { value: this.rayTargets[0].textures[1] },
      uPreviousSize: { value: new THREE.Vector2() },
      uCascadeSize: { value: new THREE.Vector2() },
      uCascadeIndex: { value: 1 },
    });
    this.mergeMaterial = makeMaterial(mergeConesFragmentShader, {
      uRayRadiance: { value: this.rayTargets[0].textures[0] },
      uRayTransmit: { value: this.rayTargets[0].textures[1] },
      uRaySize: { value: new THREE.Vector2() },
      uFarRadiance: { value: this.mergeTargets[0].textures[0] },
      uFarTransmit: { value: this.mergeTargets[0].textures[1] },
      uFarSize: { value: new THREE.Vector2(this.fieldExtent, this.fieldExtent) },
      uCascadeSize: { value: new THREE.Vector2(this.fieldExtent, this.fieldExtent) },
      uCascadeIndex: { value: this.cascadeCount - 1 },
      uHasFar: { value: false },
    });
    this.copyMaterial = makeMaterial(copyFragmentShader, {
      uSource: { value: this.mergeTargets[0].textures[0] },
    });
    this.fluenceMaterial = makeMaterial(fluenceFragmentShader, {
      uWorldSize: { value: new THREE.Vector2(this.fieldExtent, this.fieldExtent) },
      uFrustum0: { value: this.frustumTargets[0].texture },
      uFrustum1: { value: this.frustumTargets[1].texture },
      uFrustum2: { value: this.frustumTargets[2].texture },
      uFrustum3: { value: this.frustumTargets[3].texture },
    });
    this.displayMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uIrradiance: { value: this.fieldTargets[0].texture },
        uDirectionalIrradiance: { value: this.fieldTargets[0].texture },
        uDirectionalEnabled: { value: 0 },
        uDisplayRoll: { value: 0 },
        uWorldBounds: { value: AMITABHA_WORLD_BOUNDS.clone() },
      },
      vertexShader: displayVertexShader,
      fragmentShader: displayFragmentShader,
      glslVersion: THREE.GLSL3,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
    });
    this.passMesh = new THREE.Mesh(this.quadGeometry, this.sceneMaterial);
    this.passMesh.frustumCulled = false;
    this.passScene.add(this.passMesh);
    this.directionalField.precompile();
  }

  get texture(): THREE.Texture {
    return this.fieldTargets[this.fieldReadIndex].texture;
  }

  get directionalTexture(): THREE.Texture | null {
    return this.directionalField.texture;
  }

  get opticalSupported(): boolean {
    return this.directionalField.isSupported;
  }

  get opticalRequested(): boolean {
    return this.directionalField.isRequested;
  }

  get stats(): AmitabhaRadianceStats {
    return {
      resolution: this.fieldExtent,
      frustumsPerFrame: this.frustumsPerStep,
      updateHz: this.updateHz,
      targetMemoryBytes: this.targetMemoryBytes,
      drawCalls: this.drawCalls,
      optical: this.directionalField.stats,
    };
  }

  setDisplayRoll(radians: number): void {
    this.displayMaterial.uniforms.uDisplayRoll.value = radians;
  }

  setOpticalPreset(preset: OpticalQualityPreset): void {
    this.directionalField.setPreset(preset);
    this.updateDirectionalDisplayUniforms();
  }

  readDirectionalEnergyProbe(): DirectionalEnergyProbe {
    return this.directionalField.readEnergyProbe();
  }

  setQuality(quality: 'high' | 'safe'): void {
    const resolution = quality === 'high' ? HIGH_FIELD_EXTENT : SAFE_FIELD_EXTENT;
    this.frustumsPerStep = quality === 'high' ? DEFAULT_FRUSTUMS_PER_STEP : 1;
    if (resolution === this.fieldExtent) return;

    this.disposeTargets();
    this.allocateTargets(resolution);
    this.fieldReadIndex = 0;
    this.nextFrustum = 0;
    this.cycleActive = false;
    this.initialized = false;
    this.completedCycles = 0;
    this.updateWindowStartedAt = 0;
    this.updateHz = 0;
    this.directionalField.reset();
    this.updateTargetUniforms();
    this.clearTargets();
  }

  createDisplayMesh(): THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial> {
    const width = AMITABHA_WORLD_BOUNDS.z - AMITABHA_WORLD_BOUNDS.x;
    const height = AMITABHA_WORLD_BOUNDS.w - AMITABHA_WORLD_BOUNDS.y;
    const geometry = new THREE.PlaneGeometry(width, height);
    const mesh = new THREE.Mesh(geometry, this.displayMaterial);
    mesh.position.set(
      (AMITABHA_WORLD_BOUNDS.x + AMITABHA_WORLD_BOUNDS.z) * 0.5,
      (AMITABHA_WORLD_BOUNDS.y + AMITABHA_WORLD_BOUNDS.w) * 0.5,
      -0.22,
    );
    mesh.frustumCulled = false;
    mesh.renderOrder = 0;
    return mesh;
  }

  setBodies(bodies: readonly AmitabhaBody[]): void {
    const selected = selectTransportBodies(bodies);
    this.bodyCount.value = selected.length;
    this.mirrorCount = 0;
    this.glassCount = 0;
    selected.forEach((body, index) => {
      const materialCode = opticalMaterialCode(body.material);
      const opticalWeight = body.material.kind === 'mirror'
        ? body.material.reflectivity
        : body.material.transmission;
      const sourceColour = body.material.kind === 'diffuse'
        ? body.emission
        : body.material.tint;
      const sourceStrength = body.material.kind === 'diffuse'
        ? body.emissionStrength
        : opticalWeight;
      this.bodyShape[index].set(body.x, body.y, body.halfWidth, body.halfHeight);
      this.bodyFrame[index].set(Math.cos(body.angle), Math.sin(body.angle), 0, 0);
      this.bodyEmission[index].set(
        sourceColour[0],
        sourceColour[1],
        sourceColour[2],
        sourceStrength,
      );
      this.bodyAlbedo[index].set(
        body.albedo[0],
        body.albedo[1],
        body.albedo[2],
        body.material.absorption,
      );
      this.bodyMeta[index].set(
        body.sides ?? 0,
        materialCode,
        body.material.roughness,
        body.material.ior,
      );
      if (body.material.kind === 'mirror') this.mirrorCount += 1;
      if (body.material.kind === 'glass') this.glassCount += 1;
    });
  }

  render(frustaPerStep = this.frustumsPerStep): void {
    if (!this.initialized) this.clearTargets();
    this.drawCalls = 0;
    const previousTarget = this.renderer.getRenderTarget();
    const previousColour = this.renderer.getClearColor(new THREE.Color()).clone();
    const previousAlpha = this.renderer.getClearAlpha();
    this.renderer.setClearColor(0x000000, 0);

    if (!this.cycleActive) {
      this.renderSceneInputs();
      this.directionalField.capture(
        {
          count: this.bodyCount.value,
          shape: this.bodyShape,
          frame: this.bodyFrame,
          emission: this.bodyEmission,
          albedo: this.bodyAlbedo,
          meta: this.bodyMeta,
        },
        this.mirrorCount,
        this.glassCount,
      );
      this.nextFrustum = 0;
      this.cycleActive = true;
    }

    const stepCount = Math.max(1, Math.min(FRUSTUM_COUNT, Math.floor(frustaPerStep)));
    for (
      let step = 0;
      step < stepCount && this.nextFrustum < FRUSTUM_COUNT;
      step += 1
    ) {
      this.renderFrustum(this.nextFrustum);
      this.nextFrustum += 1;
    }

    if (this.nextFrustum >= FRUSTUM_COUNT) {
      const writeIndex = 1 - this.fieldReadIndex;
      this.renderPass(this.fluenceMaterial, this.fieldTargets[writeIndex]);
      this.fieldReadIndex = writeIndex;
      this.directionalField.renderCaptured();
      this.displayMaterial.uniforms.uIrradiance.value = this.texture;
      this.updateDirectionalDisplayUniforms();
      this.cycleActive = false;
      this.recordCompletedCycle();
    }

    this.renderer.setRenderTarget(previousTarget);
    this.renderer.setClearColor(previousColour, previousAlpha);
  }

  reset(): void {
    this.bodyCount.value = 0;
    this.mirrorCount = 0;
    this.glassCount = 0;
    this.cycleActive = false;
    this.nextFrustum = 0;
    this.directionalField.reset();
    this.clearTargets();
  }

  dispose(): void {
    this.quadGeometry.dispose();
    this.sceneMaterial.dispose();
    this.seedMaterial.dispose();
    this.extensionMaterial.dispose();
    this.mergeMaterial.dispose();
    this.copyMaterial.dispose();
    this.fluenceMaterial.dispose();
    this.directionalField.dispose();
    this.displayMaterial.dispose();
    this.disposeTargets();
  }

  private renderSceneInputs(): void {
    this.sceneMaterial.uniforms.uPreviousIrradiance.value = this.texture;
    this.renderPass(this.sceneMaterial, this.sceneTarget);
  }

  private renderFrustum(frustumIndex: number): void {
    this.seedMaterial.uniforms.uFrustumIndex.value = frustumIndex;
    this.renderPass(this.seedMaterial, this.rayTargets[0]);

    for (let level = 1; level < this.cascadeCount; level += 1) {
      const previous = this.rayTargets[level - 1];
      const current = this.rayTargets[level];
      this.extensionMaterial.uniforms.uPreviousRadiance.value = previous.textures[0];
      this.extensionMaterial.uniforms.uPreviousTransmit.value = previous.textures[1];
      this.extensionMaterial.uniforms.uPreviousSize.value.set(previous.width, previous.height);
      this.extensionMaterial.uniforms.uCascadeSize.value.set(current.width, current.height);
      this.extensionMaterial.uniforms.uCascadeIndex.value = level;
      this.renderPass(this.extensionMaterial, current);
    }

    let previousMerge: PairTarget | null = null;
    for (let level = this.cascadeCount - 1; level >= 0; level -= 1) {
      const rays = this.rayTargets[level];
      const currentMerge = this.mergeTargets[level % 2];
      this.mergeMaterial.uniforms.uRayRadiance.value = rays.textures[0];
      this.mergeMaterial.uniforms.uRayTransmit.value = rays.textures[1];
      this.mergeMaterial.uniforms.uRaySize.value.set(rays.width, rays.height);
      this.mergeMaterial.uniforms.uCascadeIndex.value = level;
      this.mergeMaterial.uniforms.uHasFar.value = previousMerge !== null;
      if (previousMerge) {
        this.mergeMaterial.uniforms.uFarRadiance.value = previousMerge.textures[0];
        this.mergeMaterial.uniforms.uFarTransmit.value = previousMerge.textures[1];
      }
      this.renderPass(this.mergeMaterial, currentMerge);
      previousMerge = currentMerge;
    }

    if (!previousMerge) return;
    this.copyMaterial.uniforms.uSource.value = previousMerge.textures[0];
    this.renderPass(this.copyMaterial, this.frustumTargets[frustumIndex]);
  }

  private renderPass(
    material: THREE.ShaderMaterial,
    target: SingleTarget | PairTarget,
  ): void {
    this.drawCalls += 1;
    this.passMesh.material = material;
    this.renderer.setRenderTarget(target);
    this.renderer.clear();
    this.renderer.render(this.passScene, this.passCamera);
  }

  private clearTargets(): void {
    const previousTarget = this.renderer.getRenderTarget();
    const previousColour = this.renderer.getClearColor(new THREE.Color()).clone();
    const previousAlpha = this.renderer.getClearAlpha();
    this.renderer.setClearColor(0x000000, 0);
    [
      this.sceneTarget,
      ...this.rayTargets,
      ...this.mergeTargets,
      ...this.frustumTargets,
      ...this.fieldTargets,
    ].forEach((target) => {
      this.renderer.setRenderTarget(target);
      this.renderer.clear();
    });
    this.renderer.setRenderTarget(previousTarget);
    this.renderer.setClearColor(previousColour, previousAlpha);
    this.fieldReadIndex = 0;
    this.displayMaterial.uniforms.uIrradiance.value = this.texture;
    this.updateDirectionalDisplayUniforms();
    this.initialized = true;
  }

  private allocateTargets(resolution: number): void {
    this.fieldExtent = resolution;
    this.cascadeCount = Math.ceil(Math.log2(resolution));
    this.sceneTarget = pairTarget(resolution, resolution);
    this.rayTargets = Array.from({ length: this.cascadeCount }, (_, level) => {
      const interval = 2 ** level;
      const verticalRays = interval + 1;
      return pairTarget(Math.floor(resolution / interval) * verticalRays, resolution);
    });
    this.mergeTargets = [
      pairTarget(resolution, resolution),
      pairTarget(resolution, resolution),
    ];
    this.frustumTargets = Array.from(
      { length: FRUSTUM_COUNT },
      () => singleTarget(resolution, resolution),
    );
    this.fieldTargets = [
      singleTarget(resolution, resolution, true),
      singleTarget(resolution, resolution, true),
    ];

    const bytesPerHalfFloatRgbaPixel = 8;
    const pairBytes = (target: PairTarget): number => target.width * target.height * bytesPerHalfFloatRgbaPixel * 2;
    const singleBytes = (target: SingleTarget): number => target.width * target.height * bytesPerHalfFloatRgbaPixel;
    this.targetMemoryBytes = pairBytes(this.sceneTarget)
      + this.rayTargets.reduce((sum, target) => sum + pairBytes(target), 0)
      + this.mergeTargets.reduce((sum, target) => sum + pairBytes(target), 0)
      + this.frustumTargets.reduce((sum, target) => sum + singleBytes(target), 0)
      + this.fieldTargets.reduce((sum, target) => sum + singleBytes(target), 0);
  }

  private disposeTargets(): void {
    this.sceneTarget?.dispose();
    this.rayTargets.forEach((target) => target.dispose());
    this.mergeTargets?.forEach((target) => target.dispose());
    this.frustumTargets.forEach((target) => target.dispose());
    this.fieldTargets?.forEach((target) => target.dispose());
    this.rayTargets = [];
    this.frustumTargets = [];
  }

  private updateTargetUniforms(): void {
    this.sceneMaterial.uniforms.uPreviousIrradiance.value = this.fieldTargets[0].texture;
    this.seedMaterial.uniforms.uEmissivity.value = this.sceneTarget.textures[0];
    this.seedMaterial.uniforms.uAbsorption.value = this.sceneTarget.textures[1];
    this.seedMaterial.uniforms.uWorldSize.value.set(this.fieldExtent, this.fieldExtent);
    this.seedMaterial.uniforms.uCascadeSize.value.set(this.rayTargets[0].width, this.rayTargets[0].height);
    this.extensionMaterial.uniforms.uPreviousRadiance.value = this.rayTargets[0].textures[0];
    this.extensionMaterial.uniforms.uPreviousTransmit.value = this.rayTargets[0].textures[1];
    this.mergeMaterial.uniforms.uRayRadiance.value = this.rayTargets[0].textures[0];
    this.mergeMaterial.uniforms.uRayTransmit.value = this.rayTargets[0].textures[1];
    this.mergeMaterial.uniforms.uFarRadiance.value = this.mergeTargets[0].textures[0];
    this.mergeMaterial.uniforms.uFarTransmit.value = this.mergeTargets[0].textures[1];
    this.mergeMaterial.uniforms.uFarSize.value.set(this.fieldExtent, this.fieldExtent);
    this.mergeMaterial.uniforms.uCascadeSize.value.set(this.fieldExtent, this.fieldExtent);
    this.mergeMaterial.uniforms.uCascadeIndex.value = this.cascadeCount - 1;
    this.copyMaterial.uniforms.uSource.value = this.mergeTargets[0].textures[0];
    this.fluenceMaterial.uniforms.uWorldSize.value.set(this.fieldExtent, this.fieldExtent);
    this.fluenceMaterial.uniforms.uFrustum0.value = this.frustumTargets[0].texture;
    this.fluenceMaterial.uniforms.uFrustum1.value = this.frustumTargets[1].texture;
    this.fluenceMaterial.uniforms.uFrustum2.value = this.frustumTargets[2].texture;
    this.fluenceMaterial.uniforms.uFrustum3.value = this.frustumTargets[3].texture;
    this.displayMaterial.uniforms.uIrradiance.value = this.fieldTargets[0].texture;
    this.updateDirectionalDisplayUniforms();
  }

  private updateDirectionalDisplayUniforms(): void {
    const directionalTexture = this.directionalField.texture;
    this.displayMaterial.uniforms.uDirectionalIrradiance.value =
      directionalTexture ?? this.texture;
    this.displayMaterial.uniforms.uDirectionalEnabled.value =
      directionalTexture && this.directionalField.stats.active ? 1 : 0;
  }

  private recordCompletedCycle(): void {
    const now = performance.now();
    if (this.updateWindowStartedAt === 0) this.updateWindowStartedAt = now;
    this.completedCycles += 1;
    const elapsed = now - this.updateWindowStartedAt;
    if (elapsed >= 1000) {
      this.updateHz = this.completedCycles * 1000 / elapsed;
      this.completedCycles = 0;
      this.updateWindowStartedAt = now;
    }
  }
}

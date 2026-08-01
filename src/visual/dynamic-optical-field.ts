import * as THREE from 'three';

export type DynamicOpticalMaterial = 'diffuse' | 'emitter' | 'mirror' | 'metal' | 'glass';
export type DynamicOpticalQuality = 'high' | 'safe';

export interface DynamicOpticalBody {
  x: number;
  y: number;
  width: number;
  height: number;
  angle: number;
  material: DynamicOpticalMaterial;
  color: number;
  emissionStrength: number;
  order: number;
  // Reference objects stay in the optical budget even after note-driven
  // bodies enter the Box2D world. They are still physical, just damped.
  pinned?: boolean;
}

export interface DynamicOpticalStats {
  active: boolean;
  quality: DynamicOpticalQuality;
  width: number;
  height: number;
  bodyCount: number;
  emitterCount: number;
  opticalCount: number;
  rayCount: number;
  drawCalls: number;
  cpuTimeMs: number;
  targetMemoryBytes: number;
}

const MAX_BODIES = 18;
const MAX_EMITTERS = 3;
const MAX_OPTICS = 8;
const RAYS_PER_PAIR = 7;
const HIGH_TARGET_HEIGHT = 360;
const SAFE_TARGET_HEIGHT = 240;
const MAX_TARGET_WIDTH = 768;

const fullscreenVertexShader = /* glsl */ `
  out vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

// This is deliberately a deterministic forward transport pass.  Each ray is
// generated from an emitter and intersected with a moving Box2D box, then
// reflected or refracted with its actual surface normal.  Unlike the static
// lab's Monte-Carlo integrator it does not use a per-frame random sequence,
// which keeps moving objects clean instead of accumulating grain.
const opticalFieldFragmentShader = /* glsl */ `
  precision highp float;
  precision highp int;

  in vec2 vUv;
  out vec4 outColour;

  uniform vec2 uResolution;
  uniform float uAspect;
  uniform int uBodyCount;
  uniform int uEmitterCount;
  uniform int uOpticalCount;
  uniform vec4 uBodyShape[${MAX_BODIES}];
  uniform vec4 uBodyMeta[${MAX_BODIES}];
  uniform vec4 uBodyColour[${MAX_BODIES}];
  uniform vec4 uEmitterShape[${MAX_EMITTERS}];
  uniform vec4 uEmitterColour[${MAX_EMITTERS}];
  uniform vec4 uOpticalShape[${MAX_OPTICS}];
  uniform vec4 uOpticalMeta[${MAX_OPTICS}];
  uniform vec4 uOpticalColour[${MAX_OPTICS}];

  const float PI = 3.141592653589793;
  const float MAT_DIFFUSE = 0.0;
  const float MAT_EMITTER = 1.0;
  const float MAT_MIRROR = 2.0;
  const float MAT_METAL = 3.0;
  const float MAT_GLASS = 4.0;

  mat2 rotation(float angle) {
    float c = cos(angle);
    float s = sin(angle);
    return mat2(c, s, -s, c);
  }

  vec2 worldFromUv(vec2 uv) {
    return (uv - 0.5) * vec2(uAspect * 6.4, 6.4);
  }

  vec2 uvFromWorld(vec2 p) {
    return p / vec2(uAspect * 6.4, 6.4) + 0.5;
  }

  float boxSdf(vec2 p, vec4 shape, float angle) {
    vec2 local = rotation(-angle) * (p - shape.xy);
    vec2 d = abs(local) - shape.zw;
    return length(max(d, vec2(0.0))) + min(max(d.x, d.y), 0.0);
  }

  vec2 boxNormal(vec2 p, vec4 shape, float angle) {
    vec2 local = rotation(-angle) * (p - shape.xy);
    vec2 remain = shape.zw - abs(local);
    vec2 normalLocal = remain.x < remain.y
      ? vec2(sign(local.x == 0.0 ? 1.0 : local.x), 0.0)
      : vec2(0.0, sign(local.y == 0.0 ? 1.0 : local.y));
    return rotation(angle) * normalLocal;
  }

  bool rayBox(vec2 origin, vec2 direction, vec4 shape, float angle, out float hitT, out vec2 hitNormal) {
    vec2 localOrigin = rotation(-angle) * (origin - shape.xy);
    vec2 localDirection = rotation(-angle) * direction;
    vec2 safeDirection = sign(localDirection) * max(abs(localDirection), vec2(0.00001));
    vec2 tA = (-shape.zw - localOrigin) / safeDirection;
    vec2 tB = ( shape.zw - localOrigin) / safeDirection;
    vec2 nearT = min(tA, tB);
    vec2 farT = max(tA, tB);
    float entry = max(nearT.x, nearT.y);
    float exit = min(farT.x, farT.y);
    if (exit < max(entry, 0.0)) return false;
    hitT = entry > 0.001 ? entry : exit;
    vec2 localHit = localOrigin + localDirection * hitT;
    vec2 normalLocal = abs(abs(localHit.x) - shape.z) < abs(abs(localHit.y) - shape.w)
      ? vec2(sign(localHit.x == 0.0 ? 1.0 : localHit.x), 0.0)
      : vec2(0.0, sign(localHit.y == 0.0 ? 1.0 : localHit.y));
    hitNormal = rotation(angle) * normalLocal;
    return true;
  }

  float beam(vec2 point, vec2 origin, vec2 direction, float energy) {
    vec2 delta = point - origin;
    float along = dot(delta, direction);
    if (along < 0.0 || along > 10.5) return 0.0;
    float distanceToRay = length(delta - direction * along);
    float pixelWorld = 6.4 / max(uResolution.y, 1.0);
    float width = 0.022 + pixelWorld * 1.5;
    float core = exp(-distanceToRay * distanceToRay / (width * width));
    return core * energy * exp(-along * 0.075);
  }

  float hash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }

  float fresnelSchlick(float cosine, float etaI, float etaT) {
    float r0 = (etaI - etaT) / (etaI + etaT);
    r0 *= r0;
    return r0 + (1.0 - r0) * pow(1.0 - clamp(cosine, 0.0, 1.0), 5.0);
  }

  vec3 background(vec2 p) {
    vec2 cell = floor(p * vec2(1.25, 1.25));
    float checker = mod(cell.x + cell.y, 2.0);
    float vignette = smoothstep(7.0, 1.1, length(p * vec2(0.82, 1.0)));
    return mix(vec3(0.012, 0.018, 0.032), vec3(0.024, 0.032, 0.053), checker) * (0.58 + vignette * 0.72);
  }

  void main() {
    vec2 p = worldFromUv(vUv);
    vec3 direct = vec3(0.0);
    for (int emitterIndex = 0; emitterIndex < ${MAX_EMITTERS}; emitterIndex++) {
      if (emitterIndex >= uEmitterCount) break;
      vec2 delta = uEmitterShape[emitterIndex].xy - p;
      float distanceSquared = max(dot(delta, delta), 0.08);
      direct += uEmitterColour[emitterIndex].rgb * uEmitterColour[emitterIndex].a * 0.23 / distanceSquared;
    }

    vec3 transport = vec3(0.0);
    for (int emitterIndex = 0; emitterIndex < ${MAX_EMITTERS}; emitterIndex++) {
      if (emitterIndex >= uEmitterCount) break;
      vec2 source = uEmitterShape[emitterIndex].xy;
      vec3 sourceColour = uEmitterColour[emitterIndex].rgb * uEmitterColour[emitterIndex].a;
      for (int opticIndex = 0; opticIndex < ${MAX_OPTICS}; opticIndex++) {
        if (opticIndex >= uOpticalCount) break;
        vec4 opticalShape = uOpticalShape[opticIndex];
        vec4 opticalMeta = uOpticalMeta[opticIndex];
        vec3 opticalColour = uOpticalColour[opticIndex].rgb;
        float opticalAngle = atan(opticalMeta.y, opticalMeta.x);
        vec2 spanAxis = rotation(opticalAngle) * vec2(0.0, 1.0);
        float span = max(opticalShape.z, opticalShape.w) * 1.24;
        for (int rayIndex = 0; rayIndex < ${RAYS_PER_PAIR}; rayIndex++) {
          float offset = (float(rayIndex) / float(${RAYS_PER_PAIR - 1}) - 0.5) * span * 2.0;
          vec2 aimedPoint = opticalShape.xy + spanAxis * offset;
          vec2 incoming = normalize(aimedPoint - source);
          float incomingT;
          vec2 entryNormal;
          if (!rayBox(source, incoming, opticalShape, opticalAngle, incomingT, entryNormal)) continue;
          vec2 hitPoint = source + incoming * incomingT;
          float rayEnergy = 0.18 / float(${RAYS_PER_PAIR});
          transport += sourceColour * beam(p, source, incoming, rayEnergy * 0.34);

          vec2 outgoing = incoming;
          float outputEnergy = rayEnergy;
          vec3 transmissionTint = vec3(1.0);
          if (opticalMeta.z < 2.5) {
            outgoing = reflect(incoming, entryNormal);
            outputEnergy *= 1.25;
          } else if (opticalMeta.z < 3.5) {
            // A deterministic microfacet lobe: reads as rough metal without
            // stochastic noise or a temporal accumulation buffer.
            outgoing = reflect(incoming, entryNormal);
            float rough = (hash12(opticalShape.xy + float(rayIndex)) - 0.5) * 0.22;
            outgoing = rotation(rough) * outgoing;
            outputEnergy *= 0.78;
          } else {
            // Dielectric transport is deliberately split in two: the small
            // Fresnel reflection stays outside while the rest crosses the
            // block, bends at both interfaces and is tinted by its thickness.
            // This makes glass visibly unlike a mirror without stochastic
            // sampling or an additional render pass.
            float entryFresnel = fresnelSchlick(abs(dot(incoming, entryNormal)), 1.0, 1.52);
            vec2 entryReflection = normalize(reflect(incoming, entryNormal));
            transport += sourceColour * opticalColour
              * beam(p, hitPoint + entryReflection * 0.018, entryReflection, rayEnergy * entryFresnel * 0.84);
            vec2 inside = refract(incoming, entryNormal, 1.0 / 1.52);
            if (length(inside) < 0.01) {
              outgoing = reflect(incoming, entryNormal);
              outputEnergy *= 1.15;
            } else {
              float exitT;
              vec2 exitNormal;
              if (rayBox(hitPoint + inside * 0.014, inside, opticalShape, opticalAngle, exitT, exitNormal)) {
                vec2 refracted = refract(inside, -exitNormal, 1.52);
                float exitFresnel = fresnelSchlick(abs(dot(inside, exitNormal)), 1.52, 1.0);
                vec2 exitReflection = normalize(reflect(inside, -exitNormal));
                transport += sourceColour * opticalColour
                  * beam(p, hitPoint + inside * exitT + exitReflection * 0.018, exitReflection, rayEnergy * (1.0 - entryFresnel) * exitFresnel * 0.68);
                outgoing = length(refracted) < 0.01 ? exitReflection : refracted;
                hitPoint += inside * exitT;
                outputEnergy *= (1.0 - entryFresnel) * (1.0 - exitFresnel) * 1.34;
                // Beer-Lambert-style colour loss: cyan glass keeps blue/green
                // longer than red, so its transmitted beam is visibly tinted.
                transmissionTint = exp(-vec3(0.88, 0.16, 0.06) * exitT);
              } else {
                outgoing = inside;
                outputEnergy *= (1.0 - entryFresnel) * 0.78;
              }
            }
          }
          transport += sourceColour * opticalColour * transmissionTint
            * beam(p, hitPoint + outgoing * 0.018, normalize(outgoing), outputEnergy);
        }
      }
    }

    float nearest = 100.0;
    int nearestIndex = -1;
    for (int bodyIndex = 0; bodyIndex < ${MAX_BODIES}; bodyIndex++) {
      if (bodyIndex >= uBodyCount) break;
      float angle = atan(uBodyMeta[bodyIndex].y, uBodyMeta[bodyIndex].x);
      float distance = boxSdf(p, uBodyShape[bodyIndex], angle);
      if (distance < nearest) {
        nearest = distance;
        nearestIndex = bodyIndex;
      }
    }

    vec3 colour = background(p) + direct * 0.32 + transport;
    if (nearestIndex >= 0) {
      vec4 shape = uBodyShape[nearestIndex];
      vec4 meta = uBodyMeta[nearestIndex];
      vec4 materialColour = uBodyColour[nearestIndex];
      float bodyAngle = atan(meta.y, meta.x);
      vec2 normal = boxNormal(p, shape, bodyAngle);
      float edge = max(fwidth(nearest) * 1.25, 0.008);
      float inside = 1.0 - smoothstep(-edge, edge, nearest);
      float rim = 1.0 - smoothstep(0.0, edge * 2.4, abs(nearest));
      vec3 bodyColour = materialColour.rgb;
      if (meta.z > 0.5 && meta.z < 1.5) {
        bodyColour = materialColour.rgb * (1.1 + materialColour.a * 0.7);
        bodyColour += transport * 0.26;
      } else if (meta.z > 1.5 && meta.z < 2.5) {
        vec2 reflected = reflect(normalize(vec2(0.28, 0.9)), normal);
        bodyColour = mix(vec3(0.10, 0.15, 0.23), materialColour.rgb, 0.78 + reflected.y * 0.12);
        bodyColour += direct * 0.55 + transport * 0.18;
      } else if (meta.z > 2.5 && meta.z < 3.5) {
        float grain = sin(dot(rotation(-bodyAngle) * (p - shape.xy), vec2(17.0, 3.0)) + shape.x * 3.1) * 0.08;
        bodyColour = materialColour.rgb * (0.52 + max(0.0, dot(normal, normalize(vec2(-0.35, 0.9)))) * 0.56 + grain);
        bodyColour += direct * 0.42 + transport * 0.08;
      } else if (meta.z > 3.5) {
        float fresnel = pow(1.0 - abs(dot(normal, normalize(vec2(0.2, 0.98)))), 5.0);
        vec2 refractedView = refract(normalize(vec2(-0.14, -1.0)), normal, 1.0 / 1.52);
        vec3 seen = background(p + refractedView * 0.12) + direct * 0.25 + transport * 0.18;
        bodyColour = mix(seen * materialColour.rgb + materialColour.rgb * 0.24, vec3(0.75, 0.96, 1.0), 0.28 + fresnel * 0.7);
        bodyColour += transport * 0.12;
      } else {
        bodyColour = materialColour.rgb * (0.42 + direct * 0.62 + transport * 0.18);
      }
      colour = mix(colour, bodyColour, inside);
      colour += materialColour.rgb * rim * 0.18;
    }

    // Soft filmic compression keeps dense ray crossings readable instead of
    // relying on bloom or a noisy denoiser.
    colour = colour / (vec3(1.0) + colour);
    outColour = vec4(colour, 1.0);
  }
`;

const displayFragmentShader = /* glsl */ `
  precision highp float;
  in vec2 vUv;
  out vec4 outColour;
  uniform sampler2D uField;
  uniform vec2 uTexel;

  void main() {
    vec3 centre = texture(uField, vUv).rgb;
    vec3 neighbours = (
      texture(uField, vUv + vec2(uTexel.x, 0.0)).rgb +
      texture(uField, vUv - vec2(uTexel.x, 0.0)).rgb +
      texture(uField, vUv + vec2(0.0, uTexel.y)).rgb +
      texture(uField, vUv - vec2(0.0, uTexel.y)).rgb
    ) * 0.25;
    // Five samples were already needed for reconstruction. Reusing them as a
    // small unsharp mask preserves crisp material silhouettes on a 4K output
    // without raising transport resolution or adding a third pass.
    vec3 colour = max(centre + (centre - neighbours) * 0.48, vec3(0.0));
    colour = pow(max(colour, 0.0), vec3(1.0 / 1.08));
    outColour = vec4(colour, 1.0);
  }
`;

const materialCode = (material: DynamicOpticalMaterial): number => (
  material === 'emitter' ? 1
    : material === 'mirror' ? 2
      : material === 'metal' ? 3
        : material === 'glass' ? 4
          : 0
);

export class DynamicOpticalField {
  private readonly fieldScene = new THREE.Scene();
  private readonly displayScene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly fieldMaterial: THREE.ShaderMaterial;
  private readonly displayMaterial: THREE.ShaderMaterial;
  private readonly fieldMesh: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  private readonly displayMesh: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  private readonly target: THREE.WebGLRenderTarget;
  private readonly bodyShape = Array.from({ length: MAX_BODIES }, () => new THREE.Vector4());
  private readonly bodyMeta = Array.from({ length: MAX_BODIES }, () => new THREE.Vector4());
  private readonly bodyColour = Array.from({ length: MAX_BODIES }, () => new THREE.Vector4());
  private readonly emitterShape = Array.from({ length: MAX_EMITTERS }, () => new THREE.Vector4());
  private readonly emitterColour = Array.from({ length: MAX_EMITTERS }, () => new THREE.Vector4());
  private readonly opticalShape = Array.from({ length: MAX_OPTICS }, () => new THREE.Vector4());
  private readonly opticalMeta = Array.from({ length: MAX_OPTICS }, () => new THREE.Vector4());
  private readonly opticalColour = Array.from({ length: MAX_OPTICS }, () => new THREE.Vector4());
  private readonly colour = new THREE.Color();
  private active = false;
  private quality: DynamicOpticalQuality = 'high';
  private viewportWidth = 1;
  private viewportHeight = 1;
  private targetWidth = 1;
  private targetHeight = 1;
  private bodyCount = 0;
  private emitterCount = 0;
  private opticalCount = 0;
  private cpuTimeMs = 0;

  constructor(private readonly renderer: THREE.WebGLRenderer) {
    this.fieldMaterial = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: fullscreenVertexShader,
      fragmentShader: opticalFieldFragmentShader,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
      uniforms: {
        uResolution: { value: new THREE.Vector2(1, 1) },
        uAspect: { value: 1 },
        uBodyCount: { value: 0 },
        uEmitterCount: { value: 0 },
        uOpticalCount: { value: 0 },
        uBodyShape: { value: this.bodyShape },
        uBodyMeta: { value: this.bodyMeta },
        uBodyColour: { value: this.bodyColour },
        uEmitterShape: { value: this.emitterShape },
        uEmitterColour: { value: this.emitterColour },
        uOpticalShape: { value: this.opticalShape },
        uOpticalMeta: { value: this.opticalMeta },
        uOpticalColour: { value: this.opticalColour },
      },
    });
    this.displayMaterial = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: fullscreenVertexShader,
      fragmentShader: displayFragmentShader,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
      uniforms: {
        uField: { value: null },
        uTexel: { value: new THREE.Vector2(1, 1) },
      },
    });
    const geometry = new THREE.PlaneGeometry(2, 2);
    this.fieldMesh = new THREE.Mesh(geometry, this.fieldMaterial);
    this.displayMesh = new THREE.Mesh(geometry.clone(), this.displayMaterial);
    this.fieldScene.add(this.fieldMesh);
    this.displayScene.add(this.displayMesh);
    this.target = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
      stencilBuffer: false,
    });
    this.displayMaterial.uniforms.uField.value = this.target.texture;
  }

  setActive(active: boolean): void {
    this.active = active;
  }

  setQuality(quality: DynamicOpticalQuality): void {
    if (this.quality === quality) return;
    this.quality = quality;
    this.resizeTarget();
  }

  setSize(width: number, height: number): void {
    this.viewportWidth = Math.max(1, width);
    this.viewportHeight = Math.max(1, height);
    this.resizeTarget();
  }

  setBodies(bodies: readonly DynamicOpticalBody[]): void {
    const ordered = [...bodies].sort((a, b) => (
      Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || b.order - a.order
    ));
    const emitters = ordered.filter((body) => body.material === 'emitter').slice(0, MAX_EMITTERS);
    const optics = ordered.filter((body) => body.material === 'mirror' || body.material === 'metal' || body.material === 'glass').slice(0, MAX_OPTICS);
    const selected = [...emitters, ...optics, ...ordered.filter((body) => body.material === 'diffuse')]
      .filter((body, index, all) => all.findIndex((candidate) => candidate.order === body.order) === index)
      .slice(0, MAX_BODIES);
    this.bodyCount = selected.length;
    this.emitterCount = emitters.length;
    this.opticalCount = optics.length;

    selected.forEach((body, index) => this.writeBody(this.bodyShape[index], this.bodyMeta[index], this.bodyColour[index], body));
    emitters.forEach((body, index) => {
      this.writeBody(this.emitterShape[index], undefined, this.emitterColour[index], body);
    });
    optics.forEach((body, index) => this.writeBody(this.opticalShape[index], this.opticalMeta[index], this.opticalColour[index], body));
    for (let index = selected.length; index < MAX_BODIES; index += 1) this.bodyShape[index].set(0, 0, 0, 0);
    for (let index = emitters.length; index < MAX_EMITTERS; index += 1) this.emitterShape[index].set(0, 0, 0, 0);
    for (let index = optics.length; index < MAX_OPTICS; index += 1) this.opticalShape[index].set(0, 0, 0, 0);
    this.fieldMaterial.uniforms.uBodyCount.value = this.bodyCount;
    this.fieldMaterial.uniforms.uEmitterCount.value = this.emitterCount;
    this.fieldMaterial.uniforms.uOpticalCount.value = this.opticalCount;
  }

  render(): void {
    if (!this.active) return;
    const startedAt = performance.now();
    this.renderer.setRenderTarget(this.target);
    this.renderer.setClearColor(0x010207, 1);
    this.renderer.clear();
    this.renderer.render(this.fieldScene, this.camera);
    this.renderer.setRenderTarget(null);
    this.renderer.render(this.displayScene, this.camera);
    this.cpuTimeMs = performance.now() - startedAt;
  }

  get stats(): DynamicOpticalStats {
    return {
      active: this.active,
      quality: this.quality,
      width: this.targetWidth,
      height: this.targetHeight,
      bodyCount: this.bodyCount,
      emitterCount: this.emitterCount,
      opticalCount: this.opticalCount,
      rayCount: this.emitterCount * this.opticalCount * RAYS_PER_PAIR,
      drawCalls: this.active ? 2 : 0,
      cpuTimeMs: this.cpuTimeMs,
      targetMemoryBytes: this.targetWidth * this.targetHeight * 8,
    };
  }

  dispose(): void {
    this.fieldMesh.geometry.dispose();
    this.displayMesh.geometry.dispose();
    this.fieldMaterial.dispose();
    this.displayMaterial.dispose();
    this.target.dispose();
  }

  private resizeTarget(): void {
    const targetHeight = this.quality === 'safe' ? SAFE_TARGET_HEIGHT : HIGH_TARGET_HEIGHT;
    const targetWidth = Math.min(MAX_TARGET_WIDTH, Math.max(1, Math.round(targetHeight * this.viewportWidth / this.viewportHeight)));
    if (this.targetWidth === targetWidth && this.targetHeight === targetHeight) return;
    this.targetWidth = targetWidth;
    this.targetHeight = targetHeight;
    this.target.setSize(targetWidth, targetHeight);
    this.fieldMaterial.uniforms.uResolution.value.set(targetWidth, targetHeight);
    this.fieldMaterial.uniforms.uAspect.value = this.viewportWidth / this.viewportHeight;
    this.displayMaterial.uniforms.uTexel.value.set(1 / targetWidth, 1 / targetHeight);
  }

  private writeBody(shape: THREE.Vector4, meta: THREE.Vector4 | undefined, colour: THREE.Vector4, body: DynamicOpticalBody): void {
    shape.set(body.x, body.y, Math.max(0.03, body.width * 0.5), Math.max(0.03, body.height * 0.5));
    if (meta) meta.set(Math.cos(body.angle), Math.sin(body.angle), materialCode(body.material), body.emissionStrength);
    this.colour.setHex(body.color);
    colour.set(this.colour.r, this.colour.g, this.colour.b, body.emissionStrength);
  }
}

import * as THREE from 'three';
import type { DetectedNote, MusicAnalysisFrame, RendererStatus } from '../../types';
import { AMITABHA_WORLD_BOUNDS } from '../amitabha-radiance-field';
import { ViscoelasticFluidSimulation } from './simulation';

const HIGH_PARTICLE_COUNT = 1_200;
const SAFE_PARTICLE_COUNT = 650;
// The inexpensive emissivity/absorption mask is supersampled before HRC.
// This keeps particle silhouettes and their shadows crisp without paying the
// 4× memory/transport cost of a full 1024² cascade.
const HIGH_TRANSPORT_EXTENT = 1_024;
const SAFE_TRANSPORT_EXTENT = 512;
const FIXED_STEP = 1 / 60;

const vertexShader = `
  attribute float aSpeed;
  attribute float aPhase;
  uniform float uPointSize;
  uniform float uPixelRatio;
  uniform float uTime;
  uniform float uRadianceMode;
  uniform float uEmitterOffset;
  uniform float uEmitterThreshold;
  uniform float uBass;
  uniform float uTreble;
  uniform float uFlux;
  uniform float uOnset;
  uniform vec4 uEmitterLobes[4];
  uniform float uEmitterClusterFill;
  uniform float uEmitterDrift;
  varying float vSpeed;
  varying float vPhase;
  varying float vEmitter;

  void main() {
    vSpeed = aSpeed;
    vPhase = aPhase;
    float emitterKey = fract(aPhase * 17.0 + uEmitterOffset);
    float keyedEmitter = smoothstep(
      uEmitterThreshold - 0.018,
      uEmitterThreshold + 0.018,
      emitterKey
    );
    float spatialEmitter = 0.0;
    for (int lobeIndex = 0; lobeIndex < 4; lobeIndex++) {
      vec4 lobe = uEmitterLobes[lobeIndex];
      float lobePhase = float(lobeIndex) * 2.17;
      vec2 lobeDrift = vec2(
        sin(uTime * (0.31 + float(lobeIndex) * 0.037) + lobePhase),
        cos(uTime * (0.27 + float(lobeIndex) * 0.043) + lobePhase)
      ) * uEmitterDrift * (0.72 + float(lobeIndex) * 0.09);
      float radial = 1.0 - smoothstep(
        max(0.08, lobe.z * 0.18),
        max(0.1, lobe.z),
        distance(position.xy, lobe.xy + lobeDrift)
      );
      spatialEmitter = max(spatialEmitter, radial * lobe.w);
    }
    // Keep the role sparse: the lobe chooses *where* emitters may live, while
    // the phase key still guarantees that only a minority of its particles
    // becomes luminous.
    float clusterThreshold = max(
      0.78,
      uEmitterThreshold - uEmitterClusterFill * 0.16 * spatialEmitter
    );
    float clusteredEmitter = smoothstep(
      clusterThreshold - 0.018,
      clusterThreshold + 0.018,
      emitterKey
    );
    vEmitter = spatialEmitter * max(keyedEmitter, clusteredEmitter);
    vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * viewPosition;
    float shimmerRate = 1.7 + uFlux * 8.0 + uTreble * 3.0;
    float shimmer = 0.9 + (0.1 + uTreble * 0.08)
      * sin(uTime * shimmerRate + aPhase * 18.0);
    float absorberScale = 0.88 + uBass * 0.16;
    float emitterScale = 1.12 + uTreble * 0.34 + uOnset * 0.28;
    float roleScale = mix(
      1.0,
      mix(absorberScale, emitterScale, vEmitter),
      uRadianceMode
    );
    gl_PointSize = uPointSize * uPixelRatio * shimmer
      * (1.0 + aSpeed * 0.72) * roleScale;
  }
`;

const fragmentShader = `
  uniform vec3 uColdColour;
  uniform vec3 uHotColour;
  uniform vec3 uAccentColour;
  uniform float uTime;
  uniform float uOpacity;
  uniform float uRadianceMode;
  uniform float uMusicEnergy;
  uniform float uBass;
  uniform float uTreble;
  uniform float uFlux;
  uniform float uOnset;
  uniform float uHarmonicSpread;
  varying float vSpeed;
  varying float vPhase;
  varying float vEmitter;

  void main() {
    vec2 centered = gl_PointCoord * 2.0 - 1.0;
    float radius = length(centered);
    float coverage = 1.0 - smoothstep(0.58, 1.0, radius);
    float core = 1.0 - smoothstep(0.0, 0.42, radius);
    float heat = clamp(vSpeed * 0.78 + vPhase * 0.08, 0.0, 1.0);
    vec3 colour = mix(uColdColour, uHotColour, heat);
    colour *= 0.82 + core * 1.4 + vSpeed * 0.5;

    float spectralVariation = fract(
      vPhase * (5.1 + uHarmonicSpread * 4.0) + uHarmonicSpread * 1.7
    );
    vec3 absorberColour = mix(
      uColdColour * (0.48 + uBass * 0.18),
      uHotColour * (0.3 + uTreble * 0.16),
      heat
    );
    absorberColour *= 0.68 + core * 0.72;
    vec3 emitterColour = mix(
      uHotColour,
      uAccentColour,
      0.18 + spectralVariation * (0.52 + uHarmonicSpread * 0.22)
    );
    emitterColour = mix(
      emitterColour,
      vec3(1.0, 0.98, 0.9),
      core * (0.34 + uTreble * 0.28)
    );
    float flicker = 0.88 + (0.1 + uFlux * 0.14)
      * sin(vPhase * 61.0 + uTime * (2.0 + uFlux * 13.0));
    emitterColour *= flicker * (
      0.82 + uMusicEnergy * 1.05 + uOnset * 0.72
      + core * 1.2 + vSpeed * 0.42
    );

    colour = mix(colour, absorberColour, uRadianceMode);
    colour = mix(colour, emitterColour, vEmitter * uRadianceMode);
    float roleOpacity = mix(
      1.0,
      mix(0.66 + uBass * 0.12, 1.0, vEmitter),
      uRadianceMode
    );
    gl_FragColor = vec4(colour, coverage * uOpacity * roleOpacity);
  }
`;

const transportVertexShader = `
  attribute float aSpeed;
  attribute float aPhase;
  uniform vec4 uWorldBounds;
  uniform float uPointSize;
  uniform float uTime;
  uniform float uEmitterOffset;
  uniform float uEmitterThreshold;
  uniform float uBass;
  uniform float uTreble;
  uniform float uOnset;
  uniform vec4 uEmitterLobes[4];
  uniform float uEmitterClusterFill;
  uniform float uEmitterDrift;
  varying float vSpeed;
  varying float vPhase;
  varying float vEmitter;

  void main() {
    vSpeed = aSpeed;
    vPhase = aPhase;
    float emitterKey = fract(aPhase * 17.0 + uEmitterOffset);
    float keyedEmitter = smoothstep(
      uEmitterThreshold - 0.018,
      uEmitterThreshold + 0.018,
      emitterKey
    );
    float spatialEmitter = 0.0;
    for (int lobeIndex = 0; lobeIndex < 4; lobeIndex++) {
      vec4 lobe = uEmitterLobes[lobeIndex];
      float lobePhase = float(lobeIndex) * 2.17;
      vec2 lobeDrift = vec2(
        sin(uTime * (0.31 + float(lobeIndex) * 0.037) + lobePhase),
        cos(uTime * (0.27 + float(lobeIndex) * 0.043) + lobePhase)
      ) * uEmitterDrift * (0.72 + float(lobeIndex) * 0.09);
      float radial = 1.0 - smoothstep(
        max(0.08, lobe.z * 0.18),
        max(0.1, lobe.z),
        distance(position.xy, lobe.xy + lobeDrift)
      );
      spatialEmitter = max(spatialEmitter, radial * lobe.w);
    }
    float clusterThreshold = max(
      0.78,
      uEmitterThreshold - uEmitterClusterFill * 0.16 * spatialEmitter
    );
    float clusteredEmitter = smoothstep(
      clusterThreshold - 0.018,
      clusterThreshold + 0.018,
      emitterKey
    );
    vEmitter = spatialEmitter * max(keyedEmitter, clusteredEmitter);
    vec2 uv = (position.xy - uWorldBounds.xy)
      / (uWorldBounds.zw - uWorldBounds.xy);
    gl_Position = vec4(uv * 2.0 - 1.0, 0.0, 1.0);
    gl_PointSize = uPointSize * (1.0 + aSpeed * 0.28)
      * mix(0.92 + uBass * 0.16, 1.08 + uTreble * 0.28 + uOnset * 0.2, vEmitter);
  }
`;

const transportFragmentShader = `
  uniform vec3 uColdColour;
  uniform vec3 uHotColour;
  uniform vec3 uAccentColour;
  uniform float uEmission;
  uniform float uMusicEnergy;
  uniform float uOnset;
  uniform float uHarmonicSpread;
  varying float vSpeed;
  varying float vPhase;
  varying float vEmitter;

  void main() {
    vec2 centered = gl_PointCoord * 2.0 - 1.0;
    float radius = length(centered);
    float coverage = 1.0 - smoothstep(0.56, 1.0, radius);
    if (coverage <= 0.001) discard;
    float heat = clamp(vSpeed * 0.72 + vPhase * 0.08, 0.0, 1.0);
    float spectralVariation = fract(
      vPhase * (5.1 + uHarmonicSpread * 4.0) + uHarmonicSpread * 1.7
    );
    vec3 colour = mix(
      mix(uColdColour, uHotColour, 0.55 + heat * 0.3),
      uAccentColour,
      0.2 + spectralVariation * 0.68
    );
    colour *= 0.72 + uMusicEnergy * 0.72 + uOnset * 0.42;
    float emitterRole = smoothstep(0.06, 0.72, vEmitter);
    gl_FragColor = vec4(
      colour * coverage * uEmission * vEmitter,
      coverage * mix(1.0, 0.52, emitterRole)
    );
  }
`;

const makeTransportTarget = (extent: number): THREE.WebGLRenderTarget =>
  new THREE.WebGLRenderTarget(extent, extent, {
    type: THREE.UnsignedByteType,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
  });

interface FluidVisualParams {
  density: number;
  turbulence: number;
  tension: number;
  brightness: number;
  hue: number;
  zoom: number;
  radiance: number;
  beat: number;
}

export interface ViscoelasticFluidStats {
  active: boolean;
  particleCount: number;
  springCount: number;
}

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));
const wrap01 = (value: number): number => ((value % 1) + 1) % 1;
const pseudoRandom = (seed: number): number => (
  Math.sin(seed * 12.9898 + 78.233) * 43_758.5453
  - Math.floor(Math.sin(seed * 12.9898 + 78.233) * 43_758.5453)
);
const damp = (current: number, target: number, speed: number, dt: number): number => (
  current + (target - current) * (1 - Math.exp(-speed * dt))
);
const dampWrapped01 = (current: number, target: number, speed: number, dt: number): number => {
  const delta = ((target - current + 1.5) % 1) - 0.5;
  return wrap01(current + delta * (1 - Math.exp(-speed * dt)));
};
const emptyMusicAnalysis = (): MusicAnalysisFrame => ({
  rms: 0,
  bass: 0,
  mid: 0,
  treble: 0,
  onset: 0,
  flux: 0,
  centroid: 0.5,
  harmonicCenter: 0,
  harmonicConfidence: 0,
  harmonicSpread: 0,
});

export class ViscoelasticFluidField {
  readonly points: THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial>;
  private readonly simulation = new ViscoelasticFluidSimulation(
    960,
    540,
    HIGH_PARTICLE_COUNT,
  );
  private readonly geometry = new THREE.BufferGeometry();
  private readonly material: THREE.ShaderMaterial;
  private readonly transportMaterial: THREE.ShaderMaterial;
  private readonly transportScene = new THREE.Scene();
  private readonly transportCamera = new THREE.Camera();
  private transportTarget = makeTransportTarget(HIGH_TRANSPORT_EXTENT);
  private readonly positions = new Float32Array(HIGH_PARTICLE_COUNT * 3);
  private readonly speeds = new Float32Array(HIGH_PARTICLE_COUNT);
  private readonly phases = new Float32Array(HIGH_PARTICLE_COUNT);
  private readonly coldColour = new THREE.Color();
  private readonly hotColour = new THREE.Color();
  private readonly accentColour = new THREE.Color();
  private readonly emitterLobes = Array.from(
    { length: 4 },
    (_, index) => new THREE.Vector4(0, 0, 1.45, index === 0 ? 1 : 0),
  );
  private readonly emitterLobeTargets = this.emitterLobes.map((lobe) => lobe.clone());
  private readonly target: FluidVisualParams = {
    density: 0.62,
    turbulence: 0.24,
    tension: 0.42,
    brightness: 0.62,
    hue: 192,
    zoom: 1,
    radiance: 0.3,
    beat: 0,
  };
  private readonly current: FluidVisualParams = { ...this.target };
  private readonly musicTarget = emptyMusicAnalysis();
  private readonly musicCurrent = emptyMusicAnalysis();
  private quality: RendererStatus['quality'] = 'high';
  private active = false;
  private radianceMode = false;
  private accumulator = 0;
  private pulse = 0;
  private emitterOffset = 0.13;
  private emitterOffsetTarget = 0.13;
  private emitterSequence = 0;
  private notePitch = 0.5;
  private notePitchTarget = 0.5;
  private previousOnset = 0;
  private emitterObjectCount = 1;
  private emitterTopologyHold = 0;
  private emitterTopologySeed = 0.13;

  constructor() {
    for (let index = 0; index < HIGH_PARTICLE_COUNT; index += 1) {
      this.phases[index] = ((index * 0.61803398875) % 1 + 1) % 1;
    }
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    this.geometry.setAttribute('aSpeed', new THREE.BufferAttribute(this.speeds, 1));
    this.geometry.setAttribute('aPhase', new THREE.BufferAttribute(this.phases, 1));
    this.geometry.setDrawRange(0, HIGH_PARTICLE_COUNT);
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uPointSize: { value: 4.2 },
        uPixelRatio: { value: 1.2 },
        uTime: { value: 0 },
        uColdColour: { value: this.coldColour },
        uHotColour: { value: this.hotColour },
        uAccentColour: { value: this.accentColour },
        uOpacity: { value: 0.82 },
        uRadianceMode: { value: 0 },
        uEmitterOffset: { value: this.emitterOffset },
        uEmitterThreshold: { value: 0.94 },
        uMusicEnergy: { value: 0 },
        uBass: { value: 0 },
        uTreble: { value: 0 },
        uFlux: { value: 0 },
        uOnset: { value: 0 },
        uHarmonicSpread: { value: 0 },
        uEmitterLobes: { value: this.emitterLobes },
        uEmitterClusterFill: { value: 0.22 },
        uEmitterDrift: { value: 0.12 },
      },
      vertexShader,
      fragmentShader,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
    });
    this.points = new THREE.Points(this.geometry, this.material);
    this.points.visible = false;
    this.points.frustumCulled = false;
    this.points.renderOrder = 2;
    this.transportMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uWorldBounds: { value: AMITABHA_WORLD_BOUNDS.clone() },
        uPointSize: { value: 9 },
        uTime: { value: 0 },
        uColdColour: { value: this.coldColour },
        uHotColour: { value: this.hotColour },
        uAccentColour: { value: this.accentColour },
        uEmission: { value: 0.9 },
        uEmitterOffset: { value: this.emitterOffset },
        uEmitterThreshold: { value: 0.94 },
        uMusicEnergy: { value: 0 },
        uBass: { value: 0 },
        uTreble: { value: 0 },
        uOnset: { value: 0 },
        uHarmonicSpread: { value: 0 },
        uEmitterLobes: { value: this.emitterLobes },
        uEmitterClusterFill: { value: 0.22 },
        uEmitterDrift: { value: 0.12 },
      },
      vertexShader: transportVertexShader,
      fragmentShader: transportFragmentShader,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
    });
    const transportPoints = new THREE.Points(this.geometry, this.transportMaterial);
    transportPoints.frustumCulled = false;
    this.transportScene.add(transportPoints);
    this.writeRenderData();
  }

  get radianceSourceTexture(): THREE.Texture {
    return this.transportTarget.texture;
  }

  get stats(): ViscoelasticFluidStats {
    return {
      active: this.active,
      particleCount: this.simulation.particleCount,
      springCount: this.simulation.springCount,
    };
  }

  setActive(active: boolean): void {
    if (active === this.active) return;
    this.active = active;
    this.points.visible = active;
    this.accumulator = 0;
    this.pulse = 0;
    if (active) {
      this.simulation.reset(this.quality === 'safe' ? SAFE_PARTICLE_COUNT : HIGH_PARTICLE_COUNT);
      this.retargetEmitterLobes(1, this.emitterTopologySeed);
      this.writeRenderData();
    }
  }

  setParams(params: Record<string, number>): void {
    this.target.density = clamp01(params.density ?? this.target.density);
    this.target.turbulence = clamp01(params.turbulence ?? this.target.turbulence);
    this.target.tension = clamp01(params.tension ?? this.target.tension);
    this.target.brightness = clamp01(params.brightness ?? this.target.brightness);
    this.target.hue = ((params.hue ?? this.target.hue) % 360 + 360) % 360;
    this.target.zoom = Math.max(0.4, Math.min(3, params.zoom ?? this.target.zoom));
    this.target.radiance = clamp01(params.radiance ?? this.target.radiance);
    this.target.beat = clamp01(params.beat ?? this.target.beat);
  }

  setMusicAnalysis(analysis?: MusicAnalysisFrame): void {
    const next = analysis ?? emptyMusicAnalysis();
    Object.assign(this.musicTarget, next);
    if (
      this.radianceMode
      && next.onset > 0.2
      && next.onset > this.previousOnset + 0.12
    ) {
      const complexity = clamp01(
        next.onset * 0.34
        + next.flux * 0.24
        + next.mid * 0.18
        + next.treble * 0.12
        + next.harmonicSpread * 0.32,
      );
      const objectCount = 1 + Math.min(3, Math.floor(complexity * 4));
      this.advanceEmitterFamily(
        next.onset * 0.29
        + next.flux * 0.23
        + next.harmonicCenter * 0.37,
        objectCount,
      );
    }
    this.previousOnset = next.onset;
  }

  setRadianceMode(active: boolean): void {
    this.radianceMode = active;
    this.material.uniforms.uRadianceMode.value = active ? 1 : 0;
    if (!active) this.previousOnset = 0;
  }

  setQuality(quality: RendererStatus['quality']): void {
    if (quality === this.quality) return;
    this.quality = quality;
    this.simulation.reset(quality === 'safe' ? SAFE_PARTICLE_COUNT : HIGH_PARTICLE_COUNT);
    this.transportTarget.dispose();
    this.transportTarget = makeTransportTarget(
      quality === 'safe' ? SAFE_TRANSPORT_EXTENT : HIGH_TRANSPORT_EXTENT,
    );
    this.geometry.setDrawRange(0, this.simulation.particleCount);
    this.writeRenderData();
  }

  setPixelRatio(pixelRatio: number): void {
    this.material.uniforms.uPixelRatio.value = Math.max(0.5, Math.min(2, pixelRatio));
  }

  splash(note: DetectedNote): void {
    if (!this.active) return;
    const pitch = clamp01((note.midi - 21) / 87);
    this.notePitchTarget = pitch;
    if (this.radianceMode) {
      const topologyVariation = pseudoRandom(
        note.midi * 0.731
        + this.emitterSequence * 1.913
        + note.strength * 5.17,
      );
      const objectCount = 1 + Math.min(3, Math.floor(topologyVariation * 4));
      this.advanceEmitterFamily(
        pitch * 0.53
        + (note.midi % 12) / 12 * 0.31
        + clamp01(note.strength) * 0.19,
        objectCount,
      );
    }
    const x = this.simulation.width * (0.1 + pitch * 0.8);
    const y = this.simulation.height * (0.28 + (1 - pitch) * 0.34);
    this.simulation.applyRadialImpulse(
      x,
      y,
      5 + clamp01(note.strength) * 10,
      this.simulation.height * 0.31,
    );
    this.pulse = Math.max(this.pulse, 0.55 + clamp01(note.strength) * 0.45);
  }

  burst(intensity = 1): void {
    if (!this.active) return;
    const amount = clamp01(intensity);
    if (this.radianceMode) {
      const variedCount = amount > 0.82
        ? 4
        : 1 + Math.min(2, Math.floor(pseudoRandom(
          this.emitterSequence * 2.47 + amount * 7.31,
        ) * 3));
      this.advanceEmitterFamily(0.41 + amount * 0.37, variedCount);
    }
    this.simulation.applyRadialImpulse(
      this.simulation.width * 0.5,
      this.simulation.height * 0.5,
      10 + amount * 15,
      this.simulation.height * 0.62,
    );
    this.pulse = Math.max(this.pulse, amount);
  }

  update(dt: number, elapsed: number): void {
    if (!this.active) return;
    const frameDt = Math.min(0.1, Math.max(0, dt));
    this.current.density = damp(this.current.density, this.target.density, 2.8, frameDt);
    this.current.turbulence = damp(this.current.turbulence, this.target.turbulence, 3.4, frameDt);
    this.current.tension = damp(this.current.tension, this.target.tension, 2.5, frameDt);
    this.current.brightness = damp(this.current.brightness, this.target.brightness, 3.2, frameDt);
    this.current.hue = damp(this.current.hue, this.target.hue, 2.2, frameDt);
    this.current.zoom = damp(this.current.zoom, this.target.zoom, 2.8, frameDt);
    this.current.radiance = damp(this.current.radiance, this.target.radiance, 3.4, frameDt);
    this.current.beat = damp(this.current.beat, this.target.beat, 10, frameDt);
    this.musicCurrent.rms = damp(this.musicCurrent.rms, this.musicTarget.rms, 10, frameDt);
    this.musicCurrent.bass = damp(this.musicCurrent.bass, this.musicTarget.bass, 7, frameDt);
    this.musicCurrent.mid = damp(this.musicCurrent.mid, this.musicTarget.mid, 8, frameDt);
    this.musicCurrent.treble = damp(this.musicCurrent.treble, this.musicTarget.treble, 10, frameDt);
    this.musicCurrent.onset = damp(this.musicCurrent.onset, this.musicTarget.onset, 14, frameDt);
    this.musicCurrent.flux = damp(this.musicCurrent.flux, this.musicTarget.flux, 10, frameDt);
    this.musicCurrent.centroid = damp(this.musicCurrent.centroid, this.musicTarget.centroid, 5, frameDt);
    this.musicCurrent.harmonicCenter = damp(
      this.musicCurrent.harmonicCenter,
      this.musicTarget.harmonicCenter,
      4,
      frameDt,
    );
    this.musicCurrent.harmonicConfidence = damp(
      this.musicCurrent.harmonicConfidence,
      this.musicTarget.harmonicConfidence,
      4,
      frameDt,
    );
    this.musicCurrent.harmonicSpread = damp(
      this.musicCurrent.harmonicSpread,
      this.musicTarget.harmonicSpread,
      3,
      frameDt,
    );
    this.emitterOffset = dampWrapped01(
      this.emitterOffset,
      this.emitterOffsetTarget,
      12 + this.musicCurrent.onset * 12,
      frameDt,
    );
    this.notePitch = damp(this.notePitch, this.notePitchTarget, 5.5, frameDt);
    this.pulse = Math.max(0, this.pulse - frameDt * 1.45);
    this.emitterTopologyHold = Math.max(
      0,
      this.emitterTopologyHold - frameDt,
    );
    if (this.radianceMode && this.emitterTopologyHold <= 0) {
      const topologyActivity = clamp01(
        this.musicCurrent.rms * 0.38
        + this.musicCurrent.mid * 0.24
        + this.musicCurrent.treble * 0.28
        + this.musicCurrent.flux * 0.3
        + this.musicCurrent.harmonicSpread * 0.24
        + this.current.beat * 0.46,
      );
      const desiredCount = topologyActivity < 0.14
        ? 1
        : topologyActivity < 0.36
          ? 2
          : topologyActivity < 0.64
            ? 3
            : 4;
      if (desiredCount !== this.emitterObjectCount) {
        this.retargetEmitterLobes(
          desiredCount,
          this.emitterTopologySeed
            + this.musicCurrent.harmonicCenter * 0.47
            + this.musicCurrent.flux * 0.31,
        );
      }
    }
    this.emitterLobes.forEach((lobe, index) => {
      const targetLobe = this.emitterLobeTargets[index];
      lobe.x = damp(lobe.x, targetLobe.x, 3.6, frameDt);
      lobe.y = damp(lobe.y, targetLobe.y, 3.6, frameDt);
      lobe.z = damp(lobe.z, targetLobe.z, 3, frameDt);
      lobe.w = damp(
        lobe.w,
        targetLobe.w,
        targetLobe.w > lobe.w ? 7 : 1.8,
        frameDt,
      );
    });

    const musicMix = this.radianceMode ? 1 : 0;
    const musicalTurbulence = musicMix * (
      this.musicCurrent.flux * 0.42
      + this.musicCurrent.treble * 0.16
      + this.musicCurrent.onset * 0.18
    );
    this.simulation.setMaterial({
      restDensity: 2.7 + this.current.density * 3.2
        + musicMix * this.musicCurrent.bass * 0.42,
      stiffness: 0.28 + this.current.density * 0.62
        + musicMix * this.musicCurrent.mid * 0.12,
      nearStiffness: 0.4 + this.current.density * 0.82
        + musicMix * this.musicCurrent.onset * 0.16,
      springStiffness: 0.018 + this.current.tension * 0.25
        + musicMix * this.musicCurrent.mid * 0.045,
      plasticity: 0.2 + (1 - this.current.tension) * 0.46,
      yieldRatio: 0.14 + (1 - this.current.tension) * 0.28,
      linearViscosity: 0.025 + (1 - this.current.turbulence) * 0.11
        + musicMix * this.musicCurrent.bass * 0.035,
      quadraticViscosity: 0.055 + (1 - this.current.turbulence) * 0.2
        - musicalTurbulence * 0.05,
      timeStep: 0.78 + this.current.turbulence * 0.12
        + musicalTurbulence * 0.08,
    });

    this.accumulator += frameDt;
    let steps = 0;
    while (this.accumulator >= FIXED_STEP && steps < 2) {
      const gravityAngle = elapsed * (
        0.2 + this.current.turbulence * 0.22
        + musicMix * (this.musicCurrent.treble * 0.32 + this.musicCurrent.flux * 0.24)
      );
      const gravityStrength = 0.22 + this.current.turbulence * 0.34
        + musicMix * (this.musicCurrent.bass * 0.25 + this.musicCurrent.onset * 0.12);
      this.simulation.step({
        gravityX: Math.sin(gravityAngle) * gravityStrength,
        gravityY: Math.cos(gravityAngle * 0.91) * gravityStrength,
        attractorX: this.simulation.width * (
          0.5 + Math.cos(elapsed * (
            0.27 + musicMix * this.musicCurrent.flux * 0.16
          )) * (
            0.1 + this.current.turbulence * 0.08
            + musicMix * this.musicCurrent.mid * 0.08
          )
        ),
        attractorY: this.simulation.height * (
          0.5 + Math.sin(elapsed * (
            0.23 + musicMix * this.musicCurrent.treble * 0.13
          )) * (
            0.12 + this.current.turbulence * 0.08
            + musicMix * this.musicCurrent.bass * 0.06
          )
        ),
        attraction: 0.025 + this.current.turbulence * 0.16
          + musicMix * (
            this.musicCurrent.rms * 0.11
            + this.musicCurrent.flux * 0.07
          ),
      });
      this.accumulator -= FIXED_STEP;
      steps += 1;
    }
    if (steps === 2) this.accumulator = Math.min(this.accumulator, FIXED_STEP);
    this.writeRenderData();
    this.updateMaterial(elapsed);
  }

  renderRadianceSource(renderer: THREE.WebGLRenderer): void {
    if (!this.active) return;
    const previousTarget = renderer.getRenderTarget();
    const previousColour = renderer.getClearColor(new THREE.Color()).clone();
    const previousAlpha = renderer.getClearAlpha();
    renderer.setClearColor(0x000000, 0);
    renderer.setRenderTarget(this.transportTarget);
    renderer.clear();
    renderer.render(this.transportScene, this.transportCamera);
    renderer.setRenderTarget(previousTarget);
    renderer.setClearColor(previousColour, previousAlpha);
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
    this.transportMaterial.dispose();
    this.transportTarget.dispose();
  }

  private advanceEmitterFamily(
    musicalSeed: number,
    requestedObjectCount = this.emitterObjectCount,
  ): void {
    this.emitterSequence += 1;
    this.emitterOffsetTarget = wrap01(
      this.emitterOffsetTarget
      + 0.173
      + musicalSeed * 0.37
      + this.emitterSequence * 0.071,
    );
    this.retargetEmitterLobes(
      requestedObjectCount,
      musicalSeed + this.emitterSequence * 0.193,
    );
  }

  private retargetEmitterLobes(objectCount: number, seed: number): void {
    const count = Math.max(1, Math.min(4, Math.round(objectCount)));
    const particles = this.simulation.particles;
    if (!particles.length) return;
    this.emitterObjectCount = count;
    this.emitterTopologySeed = wrap01(seed);
    this.emitterTopologyHold = 2.4 + count * 0.72;

    const worldWidth = 10.8 * this.current.zoom;
    const worldHeight = 6.1 * this.current.zoom;
    const candidateCount = Math.min(72, particles.length);
    const candidates: THREE.Vector2[] = [];
    for (let candidateIndex = 0; candidateIndex < candidateCount; candidateIndex += 1) {
      const particleSeed = pseudoRandom(
        seed * 23.41 + candidateIndex * 7.93,
      );
      const particle = particles[Math.min(
        particles.length - 1,
        Math.floor(particleSeed * particles.length),
      )];
      const candidate = new THREE.Vector2(
        (particle.x / this.simulation.width - 0.5) * worldWidth,
        (0.5 - particle.y / this.simulation.height) * worldHeight,
      );
      // The control panel overlays the right edge in performance mode. Keep
      // generated light objects in the exposed stage so none of the requested
      // variety is hidden behind the UI.
      if (candidate.x < worldWidth * 0.18) candidates.push(candidate);
    }
    if (candidates.length === 0) {
      candidates.push(new THREE.Vector2(0, 0));
    }

    const selected: THREE.Vector2[] = [];
    for (let lobeIndex = 0; lobeIndex < this.emitterLobeTargets.length; lobeIndex += 1) {
      const targetLobe = this.emitterLobeTargets[lobeIndex];
      if (lobeIndex >= count) {
        targetLobe.set(
          this.emitterLobes[lobeIndex].x,
          this.emitterLobes[lobeIndex].y,
          Math.max(0.72, this.emitterLobes[lobeIndex].z * 0.88),
          0,
        );
        continue;
      }

      const targetPosition = selected.length === 0
        ? candidates[Math.floor(
          pseudoRandom(seed * 11.73 + lobeIndex) * candidates.length,
        )]
        : candidates.reduce((farthest, candidate) => {
          const candidateDistance = Math.min(...selected.map(
            (position) => position.distanceToSquared(candidate),
          ));
          const farthestDistance = Math.min(...selected.map(
            (position) => position.distanceToSquared(farthest),
          ));
          return candidateDistance > farthestDistance ? candidate : farthest;
        }, candidates[0]);
      const targetX = targetPosition.x;
      const targetY = targetPosition.y;
      selected.push(targetPosition.clone());
      const radiusVariation = pseudoRandom(
        seed * 31.7 + lobeIndex * 13.1 + targetX * 0.17 + targetY * 0.23,
      );
      const radius = count === 1
        ? 1.35 + radiusVariation * 0.55 + this.musicCurrent.bass * 0.28
        : 0.96 + radiusVariation * 0.42 + this.musicCurrent.bass * 0.2;
      targetLobe.set(targetX, targetY, radius, 1);
    }
  }

  private writeRenderData(): void {
    const worldWidth = 10.8 * this.current.zoom;
    const worldHeight = 6.1 * this.current.zoom;
    const particles = this.simulation.particles;
    for (let index = 0; index < particles.length; index += 1) {
      const particle = particles[index];
      const speed = Math.min(
        1,
        Math.hypot(particle.velocityX, particle.velocityY) / 8,
      );
      this.positions[index * 3] = (particle.x / this.simulation.width - 0.5) * worldWidth;
      this.positions[index * 3 + 1] = (0.5 - particle.y / this.simulation.height) * worldHeight;
      this.positions[index * 3 + 2] = (this.phases[index] - 0.5) * 0.14 + speed * 0.08;
      this.speeds[index] = speed;
    }
    this.geometry.setDrawRange(0, particles.length);
    this.geometry.getAttribute('position').needsUpdate = true;
    this.geometry.getAttribute('aSpeed').needsUpdate = true;
  }

  private updateMaterial(elapsed: number): void {
    const music = this.musicCurrent;
    const musicMix = this.radianceMode ? 1 : 0;
    const harmonicShift = (
      (music.harmonicCenter - 0.5)
      * music.harmonicConfidence
      * 76
      + (this.notePitch - 0.5) * 48
    ) * musicMix;
    const hue = (
      (this.current.hue + harmonicShift) % 360 + 360
    ) % 360;
    const musicEnergy = clamp01(
      music.rms * 0.34
      + music.bass * 0.12
      + music.mid * 0.16
      + music.treble * 0.15
      + music.flux * 0.1
      + this.current.radiance * 0.18
      + this.current.beat * 0.24
      + this.pulse * 0.3
    ) * musicMix;
    this.coldColour.setHSL(
      ((hue - music.bass * 26 * musicMix + 360) % 360) / 360,
      0.72 + this.current.density * 0.2,
      0.22 + this.current.brightness * 0.18
        + music.mid * 0.08 * musicMix,
    );
    this.hotColour.setHSL(
      ((
        hue + 34 + this.current.turbulence * 38
        + music.treble * 92 * musicMix
        + music.centroid * 28 * musicMix
      ) % 360) / 360,
      0.9,
      Math.min(
        0.86,
        0.54 + this.current.brightness * 0.2
          + music.treble * 0.12 * musicMix,
      ),
    );
    this.accentColour.setHSL(
      ((
        hue + 82
        + music.harmonicSpread * 142 * musicMix
        + this.notePitch * 54 * musicMix
      ) % 360) / 360,
      0.86 + music.harmonicConfidence * 0.14 * musicMix,
      Math.min(
        0.84,
        0.56 + this.current.brightness * 0.16 + musicEnergy * 0.16,
      ),
    );

    const emitterFraction = Math.max(
      0.035,
      Math.min(
        0.15,
        0.035
          + this.current.density * 0.025
          + music.treble * 0.035 * musicMix
          + music.mid * 0.015 * musicMix
          + this.current.radiance * 0.02 * musicMix
          + this.current.beat * 0.025 * musicMix
          + this.pulse * 0.025 * musicMix,
      ),
    );
    const emitterThreshold = 1 - emitterFraction;
    const travellingEmitterOffset = wrap01(
      this.emitterOffset
      + elapsed * musicMix * (
        music.flux * 0.025 + music.treble * 0.008
      ),
    );
    const onset = clamp01(
      music.onset + this.current.beat * 0.6 + this.pulse * 0.42
    ) * musicMix;
    const emitterDrift = musicMix * (
      0.07
      + this.current.turbulence * 0.16
      + music.flux * 0.34
      + music.treble * 0.15
    );
    const clusterFill = musicMix * Math.min(
      0.62,
      (this.emitterObjectCount === 1 ? 0.46 : 0.36)
        + musicEnergy * 0.14
        + onset * 0.08,
    );

    this.material.uniforms.uTime.value = elapsed;
    this.material.uniforms.uEmitterOffset.value = travellingEmitterOffset;
    this.material.uniforms.uEmitterThreshold.value = emitterThreshold;
    this.material.uniforms.uMusicEnergy.value = musicEnergy;
    this.material.uniforms.uBass.value = music.bass * musicMix;
    this.material.uniforms.uTreble.value = music.treble * musicMix;
    this.material.uniforms.uFlux.value = music.flux * musicMix;
    this.material.uniforms.uOnset.value = onset;
    this.material.uniforms.uHarmonicSpread.value = (
      music.harmonicSpread * musicMix
    );
    this.material.uniforms.uEmitterDrift.value = emitterDrift;
    this.material.uniforms.uEmitterClusterFill.value = clusterFill;
    this.material.uniforms.uPointSize.value = (
      3.2
      + this.current.density * 2.2
      + this.pulse * 1.8
      + music.bass * 0.8 * musicMix
    ) * (this.quality === 'safe' ? 0.9 : 1)
      * (this.radianceMode ? 3.2 : 1);
    this.material.uniforms.uOpacity.value = Math.min(
      1,
      0.46 + this.current.brightness * 0.42
        + this.pulse * 0.12
        + music.rms * 0.12 * musicMix,
    );

    const transportScale = this.quality === 'safe' ? 1 : 2;
    this.transportMaterial.uniforms.uTime.value = elapsed;
    this.transportMaterial.uniforms.uEmitterOffset.value = travellingEmitterOffset;
    this.transportMaterial.uniforms.uEmitterThreshold.value = emitterThreshold;
    this.transportMaterial.uniforms.uMusicEnergy.value = musicEnergy;
    this.transportMaterial.uniforms.uBass.value = music.bass * musicMix;
    this.transportMaterial.uniforms.uTreble.value = music.treble * musicMix;
    this.transportMaterial.uniforms.uOnset.value = onset;
    this.transportMaterial.uniforms.uHarmonicSpread.value = (
      music.harmonicSpread * musicMix
    );
    this.transportMaterial.uniforms.uEmitterDrift.value = emitterDrift;
    this.transportMaterial.uniforms.uEmitterClusterFill.value = clusterFill;
    this.transportMaterial.uniforms.uPointSize.value = Math.max(
      3,
      (
        8 + this.current.density * 4.5 + this.pulse * 2.4
        + music.bass * 2.2 * musicMix
      ) * transportScale,
    );
    this.transportMaterial.uniforms.uEmission.value = Math.min(
      1.15,
      0.28
        + this.current.brightness * 0.22
        + this.current.radiance * 0.18 * musicMix
        + music.rms * 0.16 * musicMix
        + music.onset * 0.14 * musicMix
        + music.flux * 0.09 * musicMix
        + this.pulse * 0.16,
    );
  }
}

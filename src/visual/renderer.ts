import * as THREE from 'three';
import radianceBackgroundUrl from '../../nube.webp';
import { Box, Circle, Edge, Polygon, Vec2, World, type Fixture } from 'planck-js';
import type { DetectedNote, GestureEvent, ImpulseMode, RendererStatus, VisualFrame } from '../types';
import forestAtlasUrl from '../assets/forest-satellite-atlas-8x8.jpg';
import {
  AMITABHA_DISPLAY_Z,
  AMITABHA_WORLD_BOUNDS,
  AmitabhaRadianceField,
  type AmitabhaBody,
} from './amitabha-radiance-field';
import {
  ForwardCaustics,
  forwardOpticalMaterialForIndex,
  type ForwardCausticsQuality,
  type ForwardOpticalBody,
  type ForwardOpticalMaterial,
  type ForwardVec2,
} from './forward-caustics';
import { DynamicOpticalField, type DynamicOpticalBody, type DynamicOpticalMaterial } from './dynamic-optical-field';
import { OpticalLab } from './optical-lab';
import { polygonSidesForSound, regulatedPackingChaos } from './packing-dynamics';
import { visualProfileById } from './profiles';
import {
  RadianceComposition,
  type RadianceCompositionControl,
} from './radiance-composition';
import { ViscoelasticFluidField } from './viscoelastic-fluid/field';
import { MAX_VORONOI_CELLS, VoronoiField, type VoronoiCellSnapshot } from './voronoi-field';

// The point budget stays deliberately compact so the high-resolution canvas
// and radiance transport retain headroom for audio analysis and the panel.
const MVP_POINTS = 900;
const SAFE_POINTS = 320;
const MAX_NOTE_PARTICLES = 96;
const NOTE_PARTICLE_LIFETIME = 3;
const MAX_ACCUMULATION_PARTICLES = 360;
const ACCUMULATION_COLUMNS = 18;
const MAX_PACKING_BLOCKS = 220;
const BLOCK_HALF_WIDTH = 4.45;
const BLOCK_BOTTOM = -2.75;
const BLOCK_TOP = 2.85;
const PACKING_FLOOR_HALF_WIDTH = 4.8;
const PACKING_ROTATION_DURATION = 0.82;
const PACKING_FLOOR_WAVE_DURATION = 5;
const PACKING_FLOOR_WAVE_AMPLITUDE = 0.34;
const MAX_FRAME_SAMPLES = 180;
const LEGACY_MATERIAL_CYCLE_SECONDS = 12;
const LEGACY_EMITTER_MIN = 3;
const LEGACY_EMITTER_MAX = 7;
const LEGACY_EMITTER_SCALE_DURATION = 10;
const LEGACY_EMITTER_SCALE_MIN = 1;
const LEGACY_EMITTER_SCALE_MAX = 3;
const LEGACY_PHYSICS_SCALE_STEP = 0.025;
const LEGACY_OPAQUE_COLOURS = [0x7d8795, 0x8b6f7e, 0x657d83, 0x897d62] as const;
const LEGACY_EMITTER_COLOURS = [
  { body: 0xff6b50, emission: [1, 0.08, 0.025] as const },
  { body: 0x599fff, emission: [0.035, 0.15, 1] as const },
  { body: 0xffce68, emission: [1, 0.72, 0.24] as const },
  { body: 0x78e7c7, emission: [0.08, 1, 0.62] as const },
] as const;

const damp = (current: number, target: number, speed: number, dt: number): number => current + (target - current) * (1 - Math.exp(-speed * dt));
const pseudoRandom = (seed: number): number => {
  const value = Math.sin(seed * 12.9898) * 43758.5453;
  return value - Math.floor(value);
};
const opticalMaterialCode = (
  material: Exclude<ForwardOpticalMaterial, 'emitter'>,
): number => material === 'mirror' ? 1 : material === 'glass' ? 2 : 0;

const opticalMaterialColour = (
  material: Exclude<ForwardOpticalMaterial, 'emitter'>,
): number => material === 'mirror'
  ? 0xc8d5e9
  : material === 'glass'
    ? 0x42ddff
    : 0x77727d;

const packingPolygonGeometry = (sides: number): THREE.BufferGeometry => {
  const geometry = new THREE.CircleGeometry(1, sides).toNonIndexed();
  const vertexCount = geometry.getAttribute('position').count;
  const boundaryDistance = new Float32Array(vertexCount);
  for (let triangle = 0; triangle < vertexCount; triangle += 3) {
    // CircleGeometry triangles are [outer, outer, centre]. Interpolating this
    // value resolves only the silhouette, without seams in the triangle fan.
    boundaryDistance[triangle] = 0;
    boundaryDistance[triangle + 1] = 0;
    boundaryDistance[triangle + 2] = 1;
  }
  geometry.setAttribute(
    'aPackingBoundary',
    new THREE.BufferAttribute(boundaryDistance, 1),
  );
  return geometry;
};

interface NoteParticle {
  age: number;
  note: DetectedNote;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
}

interface AccumulationParticle {
  age: number;
  note: DetectedNote;
  x: number;
  y: number;
  z: number;
  targetX: number;
  targetY: number;
  targetZ: number;
}

interface PackingBlock {
  kind: 'block' | 'circle' | 'polygon';
  note: DetectedNote;
  body: PhysicsBody;
  fixture: Fixture | null;
  physicsScale: number;
  baseMass: number;
  width: number;
  height: number;
  color: number;
  sides: number;
  morphScale: number;
  morphAspect: number;
  morphPhase: number;
  morphSeed: number;
  // The world point the body sampled when it was born.  Keeping this fixed
  // lets a moving shape carry a displaced piece of the full-screen image.
  imageAnchorX: number;
  imageAnchorY: number;
  emissive: boolean;
  emissionRed: number;
  emissionGreen: number;
  emissionBlue: number;
  emissionStrength: number;
  opticalMaterial: Exclude<ForwardOpticalMaterial, 'emitter'>;
  dynamicMaterial?: DynamicOpticalMaterial;
  dynamicPinned?: boolean;
  transportOrder: number;
}

type PhysicsBody = ReturnType<World['createDynamicBody']>;

const noteVertexShader = /* glsl */ `
  attribute float aAlpha;
  attribute float aSize;
  varying float vAlpha;
  void main() {
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    gl_PointSize = aSize;
    vAlpha = aAlpha;
  }
`;

const noteFragmentShader = /* glsl */ `
  varying float vAlpha;
  void main() {
    float edge = 1.0 - smoothstep(0.05, 0.5, length(gl_PointCoord - 0.5));
    gl_FragColor = vec4(vec3(1.0), edge * vAlpha);
  }
`;

const voronoiVertexShader = /* glsl */ `
  uniform vec2 uFrameScale;
  uniform vec2 uFrameOffset;
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy * uFrameScale + uFrameOffset, 0.0, 1.0);
  }
`;

const voronoiFragmentShader = /* glsl */ `
  uniform sampler2D uForestAtlas;
  uniform int uSeedCount;
  uniform vec2 uSeeds[${MAX_VORONOI_CELLS}];
  uniform float uCellLight[${MAX_VORONOI_CELLS}];
  uniform float uFrameAspect;
  uniform vec2 uFramePixels;
  uniform float uTime;
  uniform float uTextureMotion;
  uniform float uForestExposure;
  varying vec2 vUv;

  void main() {
    float nearest = 1000.0;
    float secondNearest = 1000.0;
    float nearestIndex = 0.0;
    float nearestLight = 0.0;
    for (int index = 0; index < ${MAX_VORONOI_CELLS}; index++) {
      if (index < uSeedCount) {
        vec2 delta = vUv - uSeeds[index];
        delta.x *= uFrameAspect;
        float distanceSquared = dot(delta, delta);
        if (distanceSquared < nearest) {
          secondNearest = nearest;
          nearest = distanceSquared;
          nearestIndex = float(index);
          nearestLight = uCellLight[index];
        } else if (distanceSquared < secondNearest) {
          secondNearest = distanceSquared;
        }
      }
    }

    // Analytic antialiasing keeps the edges continuous during movement.
    float edgeGap = sqrt(secondNearest) - sqrt(nearest);
    float minimumCellWidth = 2.0 / max(uFramePixels.y, 1.0);
    float cellWidth = max(fwidth(edgeGap) * 1.55, minimumCellWidth);
    float cellLine = 1.0 - smoothstep(cellWidth * 0.04, cellWidth * 1.16, edgeGap);
    vec2 edgePixels = min(vUv, 1.0 - vUv) * uFramePixels;
    float frameDistance = abs(min(edgePixels.x, edgePixels.y) - 1.1);
    float frameWidth = max(fwidth(frameDistance), 0.5);
    float frameLine = 1.0 - smoothstep(0.05, frameWidth, frameDistance);

    // The CPU walks between spatial neighbours and leaves a fading light trail.
    float chase = clamp(nearestLight, 0.0, 1.0);
    float pulse = 0.92 + 0.08 * sin(uTime * 1.72 + nearestIndex * 2.31);

    // Each site owns a 512 px crop from the 4096 px satellite atlas.
    float tileIndex = mod(nearestIndex, 64.0);
    vec2 tile = vec2(mod(tileIndex, 8.0), 7.0 - floor(tileIndex / 8.0));
    float phase = nearestIndex * 1.6180339;
    vec2 drift = vec2(
      sin(uTime * 0.083 + phase),
      cos(uTime * 0.067 + phase * 1.37)
    ) * uTextureMotion;
    float textureZoom = 1.075 + 0.022 * sin(uTime * 0.094 + phase);
    vec2 tileLocal = (vUv - 0.5) / textureZoom + 0.5 + drift;
    tileLocal = clamp(tileLocal, vec2(0.035), vec2(0.965));
    vec2 atlasUv = (tile + tileLocal) / 8.0;
    vec3 forest = texture2D(uForestAtlas, atlasUv).rgb;
    forest = pow(forest, vec3(0.76));
    forest *= chase * pulse * uForestExposure;

    // A restrained trailing glow gives the travelling image a readable tail.
    float edgeHalo = 1.0 - smoothstep(cellWidth * 1.2, cellWidth * 6.0, edgeGap);
    forest *= 1.0 + edgeHalo * chase * 0.22;

    float white = max(cellLine, frameLine);
    vec3 colour = mix(forest, vec3(1.0), white);
    gl_FragColor = vec4(colour, 1.0);
  }
`;

export class ReactiveVisualRenderer {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
  private readonly material: THREE.PointsMaterial;
  private readonly points: THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial>;
  private readonly noteGeometry = new THREE.BufferGeometry();
  private readonly notePositions = new Float32Array(MAX_NOTE_PARTICLES * 3);
  private readonly noteAlphas = new Float32Array(MAX_NOTE_PARTICLES);
  private readonly noteSizes = new Float32Array(MAX_NOTE_PARTICLES);
  private readonly notePositionAttribute = new THREE.BufferAttribute(this.notePositions, 3);
  private readonly noteAlphaAttribute = new THREE.BufferAttribute(this.noteAlphas, 1);
  private readonly noteSizeAttribute = new THREE.BufferAttribute(this.noteSizes, 1);
  private readonly noteMaterial = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: THREE.AdditiveBlending,
    vertexShader: noteVertexShader,
    fragmentShader: noteFragmentShader,
  });
  private readonly notePoints = new THREE.Points(this.noteGeometry, this.noteMaterial);
  private noteParticles: NoteParticle[] = [];
  private readonly accumulationGeometry = new THREE.BufferGeometry();
  private readonly accumulationPositions = new Float32Array(MAX_ACCUMULATION_PARTICLES * 3);
  private readonly accumulationAlphas = new Float32Array(MAX_ACCUMULATION_PARTICLES);
  private readonly accumulationSizes = new Float32Array(MAX_ACCUMULATION_PARTICLES);
  private readonly accumulationPositionAttribute = new THREE.BufferAttribute(this.accumulationPositions, 3);
  private readonly accumulationAlphaAttribute = new THREE.BufferAttribute(this.accumulationAlphas, 1);
  private readonly accumulationSizeAttribute = new THREE.BufferAttribute(this.accumulationSizes, 1);
  private readonly accumulationMaterial = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: THREE.AdditiveBlending,
    vertexShader: noteVertexShader,
    fragmentShader: noteFragmentShader,
  });
  private readonly accumulationPoints = new THREE.Points(this.accumulationGeometry, this.accumulationMaterial);
  private accumulationParticles: AccumulationParticle[] = [];
  private readonly packingIrradiance = { value: null as THREE.Texture | null };
  // The same full-screen cloud image is sampled again by every Box2D body.
  // The same texture that is drawn by the full-screen HRC display. Blocks use
  // it as a projected mask, offset by their Box2D displacement.
  private readonly packingImage = { value: null as THREE.Texture | null };
  private readonly packingImageRoll = { value: 0 };
  // Mode 03 deliberately keeps the pre-optics diffuse block look. This is a
  // uniform switch in the packing shader, so it has no extra draw calls.
  private readonly legacyBlocksUniform = { value: 0 };
  private readonly blockGeometry = new THREE.PlaneGeometry(1, 1);
  private readonly circleGeometry = new THREE.CircleGeometry(0.5, 32);
  private readonly blockMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.97, depthWrite: false });
  private readonly polygonMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.97, depthWrite: false });
  private readonly polygonMorphTime = { value: 0 };
  private readonly blockMesh = new THREE.InstancedMesh(this.blockGeometry, this.blockMaterial, MAX_PACKING_BLOCKS);
  private readonly circleMesh = new THREE.InstancedMesh(this.circleGeometry, this.blockMaterial, MAX_PACKING_BLOCKS);
  private readonly polygonGeometries = Array.from(
    { length: 6 },
    (_, index) => packingPolygonGeometry(index + 3),
  );
  private readonly polygonMorphSeeds = Array.from({ length: 6 }, () => new Float32Array(MAX_PACKING_BLOCKS));
  private readonly polygonMorphAmounts = Array.from({ length: 6 }, () => new Float32Array(MAX_PACKING_BLOCKS));
  private readonly blockEmissionData = new Float32Array(MAX_PACKING_BLOCKS * 4);
  private readonly blockOpticalData = new Float32Array(MAX_PACKING_BLOCKS);
  private readonly blockImageAnchorData = new Float32Array(MAX_PACKING_BLOCKS * 2);
  private readonly circleEmissionData = new Float32Array(MAX_PACKING_BLOCKS * 4);
  private readonly circleOpticalData = new Float32Array(MAX_PACKING_BLOCKS);
  private readonly circleImageAnchorData = new Float32Array(MAX_PACKING_BLOCKS * 2);
  private readonly polygonEmissionData = Array.from({ length: 6 }, () => new Float32Array(MAX_PACKING_BLOCKS * 4));
  private readonly polygonOpticalData = Array.from({ length: 6 }, () => new Float32Array(MAX_PACKING_BLOCKS));
  private readonly polygonImageAnchorData = Array.from(
    { length: 6 },
    () => new Float32Array(MAX_PACKING_BLOCKS * 2),
  );
  private readonly polygonMeshes = this.polygonGeometries.map((geometry) => new THREE.InstancedMesh(geometry, this.polygonMaterial, MAX_PACKING_BLOCKS));
  private readonly amitabhaField: AmitabhaRadianceField;
  private readonly amitabhaDisplay: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  private readonly forwardCaustics = new ForwardCaustics();
  private readonly opticalLab: OpticalLab;
  private readonly dynamicOpticalField: DynamicOpticalField;
  private readonly viscoelasticFluid = new ViscoelasticFluidField();
  private readonly radianceComposition = new RadianceComposition();
  private readonly blockFrameGeometry = new THREE.BufferGeometry();
  private readonly blockFrameMaterial = new THREE.LineBasicMaterial({ color: 0x8c879f, transparent: true, opacity: 0.55 });
  private readonly blockFrame = new THREE.Line(this.blockFrameGeometry, this.blockFrameMaterial);
  private readonly blockMatrix = new THREE.Matrix4();
  private readonly blockColor = new THREE.Color();
  private readonly packingGroup = new THREE.Group();
  private packingBlocks: PackingBlock[] = [];
  private blockSequence = 0;
  private packingCycleElapsed = 0;
  private packingTurnElapsed = 0;
  private packingTurnActive = false;
  private packingTurnAngle = 0;
  private packingCameraRotation = 0;
  private packingTurnStartRotation = 0;
  private packingTurnDirection = 1;
  private packingIdleDirection = 1;
  private packingReceivedNoteSinceTurn = false;
  private lastPackingMidi = 60;
  private packingGravityEnabled = true;
  private packingDensity = 0.2;
  private packingDensityTarget = 0.2;
  private packingTurbulence = 0.1;
  private packingTurbulenceTarget = 0.1;
  private packingTension = 0.1;
  private packingTensionTarget = 0.1;
  private legacyMaterialCycleElapsed = 0;
  private legacyMaterialCycle = 0;
  private legacyEmitterScale = LEGACY_EMITTER_SCALE_MIN;
  private legacyEmitterScaleStart = LEGACY_EMITTER_SCALE_MIN;
  private legacyEmitterScaleTarget: 1 | 3 = LEGACY_EMITTER_SCALE_MIN;
  private legacyEmitterScaleStartedAt = -Infinity;
  private hrcSlowElapsed = 0;
  private hrcStableElapsed = 0;
  private hrcQuality: RendererStatus['quality'] = 'high';
  private causticsSlowElapsed = 0;
  private causticsStableElapsed = 0;
  private causticsQuality: ForwardCausticsQuality = 'high';
  private modeFiveCameraPhase: 'idle' | 'focus' | 'return' = 'idle';
  private modeFiveCameraElapsed = 0;
  private modeFiveCameraDelay = 4.2;
  private modeFiveCameraDuration = 2.2;
  private modeFiveCameraTarget: PackingBlock | null = null;
  private modeFiveCameraX = 0;
  private modeFiveCameraY = 0;
  private modeFiveCameraAmount = 0;
  private readonly packingWorld = new World(Vec2(0, -14));
  private readonly packingFloor = this.packingWorld.createKinematicBody({
    position: Vec2(0, BLOCK_BOTTOM),
    userData: { kind: 'floor' },
  });
  private packingFloorY = BLOCK_BOTTOM;
  private packingFloorWaveActive = false;
  private packingFloorWaveElapsed = 0;
  private packingFloorWaitElapsed = 0;
  private packingFloorNextWave = 8.5;
  private physicsAccumulator = 0;
  private readonly blockPosition = new THREE.Vector3();
  private readonly blockQuaternion = new THREE.Quaternion();
  private readonly blockScale = new THREE.Vector3();
  private readonly blockRotationAxis = new THREE.Vector3(0, 0, 1);
  private readonly voronoiField = new VoronoiField();
  private readonly voronoiSeeds = Array.from({ length: MAX_VORONOI_CELLS }, () => new THREE.Vector2());
  private readonly voronoiGeometry = new THREE.PlaneGeometry(2, 2);
  private readonly voronoiFrameScale = new THREE.Vector2(0.6, 0.6);
  private readonly voronoiBaseFrameScale = new THREE.Vector2(0.6, 0.6);
  private readonly voronoiFramePixels = new THREE.Vector2(640, 400);
  private readonly voronoiBaseFramePixels = new THREE.Vector2(640, 400);
  private readonly voronoiCellLight = new Float32Array(MAX_VORONOI_CELLS);
  private readonly voronoiCellLightTargets = new Float32Array(MAX_VORONOI_CELLS);
  private readonly voronoiChaseTrail: number[] = [];
  private voronoiChaseIndex = 0;
  private voronoiChaseElapsed = 0;
  private voronoiChaseSequence = 0;
  private voronoiLastCellCount = 0;
  private readonly forestTexture: THREE.Texture;
  private readonly radianceBackgroundTexture: THREE.Texture;
  private readonly voronoiMaterial: THREE.ShaderMaterial;
  private readonly voronoiMesh: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  private impulseMode: ImpulseMode = 1;
  private legacyBlocksActive = false;
  private readonly target: Record<string, number> = {};
  private readonly current: Record<string, number> = {};
  private readonly colour = new THREE.Color();
  private flash = 0;
  private pulse = 0;
  private blackout = false;
  private outgoing: THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial> | null = null;
  private activeScene: number | null = null;
  private transitionProgress = 1;
  private contextState: RendererStatus['state'] = 'ready';
  private contextLosses = 0;
  private quality: RendererStatus['quality'];
  private readonly frameTimes: number[] = [];
  private hrcP95SampleElapsed = 0;
  private hrcFrameTimeP95Ms = 0;
  private frameTimeAverageMs = 0;
  private restorePending = false;

  constructor(canvas: HTMLCanvasElement, quality: RendererStatus['quality'] = 'high') {
    this.quality = quality;
    this.configurePackingMaterial(this.blockMaterial, false);
    this.configurePackingMaterial(this.polygonMaterial, true);
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance',
      precision: 'highp',
    });
    this.opticalLab = new OpticalLab(this.renderer);
    this.dynamicOpticalField = new DynamicOpticalField(this.renderer);
    this.applyQuality();
    this.renderer.setClearColor(0x030307, 1);
    this.amitabhaField = new AmitabhaRadianceField(this.renderer);
    this.amitabhaField.setQuality(this.quality);
    this.radianceBackgroundTexture = new THREE.TextureLoader().load(radianceBackgroundUrl);
    this.radianceBackgroundTexture.colorSpace = THREE.SRGBColorSpace;
    this.radianceBackgroundTexture.minFilter = THREE.LinearFilter;
    this.radianceBackgroundTexture.magFilter = THREE.LinearFilter;
    this.radianceBackgroundTexture.generateMipmaps = true;
    this.amitabhaField.setBackgroundTexture(this.radianceBackgroundTexture);
    this.packingImage.value = this.radianceBackgroundTexture;
    this.causticsQuality = this.quality === 'safe' ? 'safe' : 'high';
    this.forwardCaustics.setQuality(this.causticsQuality);
    this.amitabhaDisplay = this.amitabhaField.createDisplayMesh();
    this.packingIrradiance.value = this.amitabhaField.texture;
    this.camera.position.z = 8.5;
    this.forestTexture = new THREE.TextureLoader().load(forestAtlasUrl);
    this.forestTexture.colorSpace = THREE.SRGBColorSpace;
    this.forestTexture.minFilter = THREE.LinearMipmapLinearFilter;
    this.forestTexture.magFilter = THREE.LinearFilter;
    this.forestTexture.generateMipmaps = true;
    this.forestTexture.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
    this.voronoiMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uForestAtlas: { value: this.forestTexture },
        uSeedCount: { value: this.voronoiField.count },
        uSeeds: { value: this.voronoiSeeds },
        uCellLight: { value: this.voronoiCellLight },
        uFrameScale: { value: this.voronoiFrameScale },
        uFrameOffset: { value: new THREE.Vector2(-0.25, 0) },
        uFrameAspect: { value: 1.6 },
        uFramePixels: { value: this.voronoiFramePixels },
        uTime: { value: 0 },
        uTextureMotion: { value: 0.008 },
        uForestExposure: { value: 1.35 },
      },
      vertexShader: voronoiVertexShader,
      fragmentShader: voronoiFragmentShader,
      depthTest: false,
      depthWrite: false,
    });
    this.voronoiMesh = new THREE.Mesh(this.voronoiGeometry, this.voronoiMaterial);
    this.voronoiMesh.frustumCulled = false;
    this.voronoiMesh.visible = false;
    this.scene.add(this.voronoiMesh);

    const positions = new Float32Array(MVP_POINTS * 3);
    for (let i = 0; i < MVP_POINTS; i += 1) {
      const radius = Math.pow(Math.random(), 0.72) * 3.65;
      const angle = Math.random() * Math.PI * 2;
      positions[i * 3] = Math.cos(angle) * radius;
      positions[i * 3 + 1] = Math.sin(angle) * radius * 0.64;
      positions[i * 3 + 2] = (Math.random() - 0.5) * 1.8;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    this.material = new THREE.PointsMaterial({
      color: 0x9f8cff,
      size: 0.055,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.7,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.points = new THREE.Points(geometry, this.material);
    this.scene.add(this.points);
    this.scene.add(this.viscoelasticFluid.points);
    this.noteGeometry.setAttribute('position', this.notePositionAttribute);
    this.noteGeometry.setAttribute('aAlpha', this.noteAlphaAttribute);
    this.noteGeometry.setAttribute('aSize', this.noteSizeAttribute);
    this.noteGeometry.setDrawRange(0, 0);
    this.scene.add(this.notePoints);
    this.accumulationGeometry.setAttribute('position', this.accumulationPositionAttribute);
    this.accumulationGeometry.setAttribute('aAlpha', this.accumulationAlphaAttribute);
    this.accumulationGeometry.setAttribute('aSize', this.accumulationSizeAttribute);
    this.accumulationGeometry.setDrawRange(0, 0);
    this.scene.add(this.accumulationPoints);
    this.blockGeometry.setAttribute('aEmission', new THREE.InstancedBufferAttribute(this.blockEmissionData, 4));
    this.blockGeometry.setAttribute('aOpticalKind', new THREE.InstancedBufferAttribute(this.blockOpticalData, 1));
    this.blockGeometry.setAttribute('aPackingImageAnchor', new THREE.InstancedBufferAttribute(this.blockImageAnchorData, 2));
    this.circleGeometry.setAttribute('aEmission', new THREE.InstancedBufferAttribute(this.circleEmissionData, 4));
    this.circleGeometry.setAttribute('aOpticalKind', new THREE.InstancedBufferAttribute(this.circleOpticalData, 1));
    this.circleGeometry.setAttribute('aPackingImageAnchor', new THREE.InstancedBufferAttribute(this.circleImageAnchorData, 2));
    this.polygonGeometries.forEach((geometry, index) => {
      geometry.setAttribute('aMorphSeed', new THREE.InstancedBufferAttribute(this.polygonMorphSeeds[index], 1));
      geometry.setAttribute('aMorphAmount', new THREE.InstancedBufferAttribute(this.polygonMorphAmounts[index], 1));
      geometry.setAttribute('aEmission', new THREE.InstancedBufferAttribute(this.polygonEmissionData[index], 4));
      geometry.setAttribute('aOpticalKind', new THREE.InstancedBufferAttribute(this.polygonOpticalData[index], 1));
      geometry.setAttribute('aPackingImageAnchor', new THREE.InstancedBufferAttribute(this.polygonImageAnchorData[index], 2));
    });
    this.amitabhaDisplay.visible = false;
    this.scene.add(this.amitabhaDisplay);
    this.blockMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.blockMesh.count = 0;
    this.blockMesh.visible = false;
    this.blockMesh.frustumCulled = false;
    this.blockMesh.renderOrder = 1;
    this.packingGroup.add(this.blockMesh);
    this.circleMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.circleMesh.count = 0;
    this.circleMesh.visible = false;
    this.circleMesh.frustumCulled = false;
    this.circleMesh.renderOrder = 1;
    this.packingGroup.add(this.circleMesh);
    this.polygonMeshes.forEach((mesh) => {
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.count = 0;
      mesh.visible = false;
      mesh.frustumCulled = false;
      mesh.renderOrder = 1;
      this.packingGroup.add(mesh);
    });
    this.packingGroup.add(this.forwardCaustics.points);
    this.blockFrameGeometry.setFromPoints([
      new THREE.Vector3(-PACKING_FLOOR_HALF_WIDTH, BLOCK_BOTTOM, -0.1),
      new THREE.Vector3(PACKING_FLOOR_HALF_WIDTH, BLOCK_BOTTOM, -0.1),
    ]);
    this.blockFrame.visible = false;
    this.packingGroup.add(this.blockFrame);
    this.packingGroup.visible = false;
    this.scene.add(this.packingGroup);
    this.packingFloor.createFixture(
      Edge(Vec2(-PACKING_FLOOR_HALF_WIDTH, 0), Vec2(PACKING_FLOOR_HALF_WIDTH, 0)),
      { friction: 0.82, restitution: 0.04 },
    );
    this.packingWorld.on('begin-contact', (contact) => this.onPackingContact(contact.getFixtureA().getBody(), contact.getFixtureB().getBody()));
    this.resize();
    window.addEventListener('resize', this.resize);
    canvas.addEventListener('webglcontextlost', this.onContextLost);
    canvas.addEventListener('webglcontextrestored', this.onContextRestored);
  }

  apply(frame: VisualFrame): void {
    this.blackout = frame.blackout;
    const opticalLabActive = frame.scene === 6;
    const dynamicOpticalActive = frame.scene === 7;
    const viscoelasticActive = frame.scene === 8 || frame.scene === 9;
    const viscoelasticRadianceActive = frame.scene === 9;
    const radianceCompositionActive = frame.scene === 10;
    const enteringRadianceComposition =
      radianceCompositionActive && this.activeScene !== 10;
    this.legacyBlocksActive = !opticalLabActive
      && !dynamicOpticalActive
      && !viscoelasticActive
      && !radianceCompositionActive
      && frame.impulseMode === 3;
    this.legacyBlocksUniform.value = this.legacyBlocksActive ? 1 : 0;
    this.opticalLab.setActive(opticalLabActive);
    this.dynamicOpticalField.setActive(dynamicOpticalActive);
    this.viscoelasticFluid.setActive(viscoelasticActive);
    this.viscoelasticFluid.setRadianceMode(viscoelasticRadianceActive);
    this.viscoelasticFluid.setParams(frame.params);
    this.viscoelasticFluid.setMusicAnalysis(frame.music);
    this.amitabhaField.setDisplaySharpness(
      viscoelasticRadianceActive ? 0.55 : 0.25,
    );
    // The cloud remains available to the Box2D mask shader, but never paints
    // the full-screen background in any scene (including the fluid pass).
    this.amitabhaField.setBackgroundEnabled(false);
    this.amitabhaField.setExternalScene(
      viscoelasticRadianceActive
        ? this.viscoelasticFluid.radianceSourceTexture
        : null,
    );
    if (enteringRadianceComposition) {
      this.clearPackingBlocks();
      this.amitabhaField.reset();
    }
    if (!dynamicOpticalActive && this.activeScene === 7) {
      // Scene 7 changes Box2D gravity and creates its own material rig. Its
      // bodies must never survive into the original diffuse HRC block mode.
      this.clearPackingBlocks();
    } else if (dynamicOpticalActive && this.activeScene !== 7) {
      this.clearPackingBlocks();
      this.seedDynamicOpticalScene();
    }
    const modeChanged = this.impulseMode !== frame.impulseMode;
    this.impulseMode = frame.impulseMode;
    if (modeChanged && this.impulseMode === 2) this.clearAccumulation();
    if (modeChanged && (this.impulseMode === 3 || this.impulseMode === 5)) {
      this.clearPackingBlocks();
      if (this.impulseMode === 3) this.forwardCaustics.reset();
    }
    if (modeChanged && this.impulseMode !== 3 && this.impulseMode !== 5) this.resetPackingCamera();
    if (modeChanged && this.impulseMode === 4) {
      this.voronoiField.reset();
      this.resetVoronoiChaser();
      this.flash = 0;
      this.pulse = 0;
    }
    const baseFieldVisible = !opticalLabActive && !dynamicOpticalActive
      && !viscoelasticActive
      && !radianceCompositionActive
      && ![1, 2, 3, 4, 5].includes(this.impulseMode);
    this.points.visible = baseFieldVisible;
    if (this.outgoing) this.outgoing.visible = baseFieldVisible;
    this.packingDensityTarget = Math.max(0, Math.min(1, frame.params.density ?? 0.2));
    this.packingTurbulenceTarget = Math.max(0, Math.min(1, frame.params.turbulence ?? 0.1));
    this.packingTensionTarget = Math.max(0, Math.min(1, frame.params.tension ?? 0.1));
    if (!viscoelasticActive && !radianceCompositionActive && this.impulseMode === 1) frame.noteAttacks.forEach((note) => this.spawnNoteParticle(note));
    if (!viscoelasticActive && !radianceCompositionActive && this.impulseMode === 2) frame.noteAttacks.forEach((note) => this.spawnAccumulationParticle(note));
    if (!dynamicOpticalActive && !viscoelasticActive && !radianceCompositionActive && this.impulseMode === 3) frame.noteAttacks.forEach((note) => this.spawnPackingBurst(note));
    if (!dynamicOpticalActive && !viscoelasticActive && !radianceCompositionActive && this.impulseMode === 5) frame.noteAttacks.forEach((note) => this.spawnPackingPolygon(note));
    if (dynamicOpticalActive) frame.noteAttacks.forEach((note) => this.spawnPackingBlock(note));
    if (viscoelasticActive) frame.noteAttacks.forEach((note) => this.viscoelasticFluid.splash(note));
    if (!dynamicOpticalActive && !viscoelasticActive && !radianceCompositionActive && (this.impulseMode === 3 || this.impulseMode === 5) && frame.wideChord) this.togglePackingGravity();
    if (dynamicOpticalActive && frame.wideChord) this.togglePackingGravity();
    if (!viscoelasticActive && !radianceCompositionActive && this.impulseMode === 4) frame.noteAttacks.forEach((note) => this.applyVoronoiImpulse(note));
    const packingVisible = !opticalLabActive && !dynamicOpticalActive
      && !viscoelasticActive
      && !radianceCompositionActive
      && (this.impulseMode === 3 || this.impulseMode === 5);
    this.blockFrame.visible = packingVisible;
    this.packingGroup.visible = packingVisible;
    this.amitabhaDisplay.visible = packingVisible
      || viscoelasticRadianceActive
      || radianceCompositionActive;
    this.forwardCaustics.points.visible = packingVisible && !this.legacyBlocksActive;
    this.voronoiMesh.visible = !opticalLabActive && !dynamicOpticalActive
      && !viscoelasticActive
      && !radianceCompositionActive
      && this.impulseMode === 4;
    if (viscoelasticActive || radianceCompositionActive) {
      this.notePoints.visible = false;
      this.accumulationPoints.visible = false;
      this.resetPackingCamera();
    }
    const changedScene = this.activeScene !== null && this.activeScene !== frame.scene;
    if (changedScene) {
      this.disposeOutgoing();
      if (frame.transition.type === 'crossfade' && frame.transition.fromScene === this.activeScene) {
        const previous = new THREE.Points(this.points.geometry, this.material.clone());
        previous.position.copy(this.points.position);
        previous.rotation.copy(this.points.rotation);
        previous.scale.copy(this.points.scale);
        previous.visible = baseFieldVisible;
        this.outgoing = previous;
        this.scene.add(previous);
      }
      Object.assign(this.current, frame.params, { profile: frame.profile });
    }
    this.activeScene = frame.scene;
    this.transitionProgress = frame.transition.progress;
    visualProfileById(frame.profile);
    Object.assign(this.target, frame.params, { profile: frame.profile });
    for (const event of frame.events) this.onEvent(event);
  }

  render(dt: number, elapsed: number): void {
    if (this.contextState === 'lost') return;
    this.frameTimes.push(dt * 1000);
    if (this.frameTimes.length > MAX_FRAME_SAMPLES) this.frameTimes.shift();
    this.updateTransportQuality(dt);
    if (this.restorePending) {
      this.amitabhaField.reset();
      this.forwardCaustics.reset();
      this.opticalLab.reset();
      this.resetFrameTimingWindow();
      this.packingIrradiance.value = this.amitabhaField.texture;
      this.renderer.compile(this.scene, this.camera);
      this.resize();
      this.restorePending = false;
    }

    if (this.activeScene === 6) {
      if (this.blackout) {
        this.renderer.setClearColor(0x000000, 1);
        this.renderer.clear();
        return;
      }
      this.opticalLab.render(elapsed);
      return;
    }

    if (this.activeScene === 10) {
      if (this.blackout) {
        this.renderer.setClearColor(0x000000, 1);
        this.renderer.clear();
        return;
      }
      this.camera.position.set(0, 0, 8.5);
      this.camera.rotation.set(0, 0, 0);
      this.amitabhaField.setExternalScene(null);
      this.amitabhaField.setBodies(this.radianceComposition.update(dt));
      this.amitabhaField.render();
      this.packingIrradiance.value = this.amitabhaField.texture;
      this.syncAmitabhaDisplayToCamera();
      this.renderer.setClearColor(0x000107, 1);
      this.renderer.render(this.scene, this.camera);
      return;
    }

    if (this.activeScene === 8 || this.activeScene === 9) {
      if (this.blackout) {
        this.renderer.setClearColor(0x000000, 1);
        this.renderer.clear();
        return;
      }
      this.camera.position.set(0, 0, 8.5);
      this.camera.rotation.set(0, 0, 0);
      this.viscoelasticFluid.update(dt, elapsed);
      if (this.activeScene === 9) {
        this.viscoelasticFluid.renderRadianceSource(this.renderer);
        this.amitabhaField.setBodies([]);
        this.amitabhaField.setExternalScene(
          this.viscoelasticFluid.radianceSourceTexture,
        );
        this.amitabhaField.render();
        this.packingIrradiance.value = this.amitabhaField.texture;
        this.syncAmitabhaDisplayToCamera();
      }
      this.renderer.setClearColor(0x01050b, 1);
      this.renderer.render(this.scene, this.camera);
      return;
    }

    this.flash = Math.max(0, this.flash - dt * 3.4);
    this.pulse = Math.max(0, this.pulse - dt * 2.8);
    this.updateNoteParticles(dt);
    this.updateAccumulationParticles(dt);
    this.updatePackingBlocks(dt, elapsed);
    if (this.activeScene === 7) {
      if (this.blackout) {
        this.renderer.setClearColor(0x000000, 1);
        this.renderer.clear();
        return;
      }
      this.dynamicOpticalField.render();
      return;
    }
    const defaults: Record<string, number> = { tension: 0.1, density: 0.2, turbulence: 0.1, zoom: 1, hue: 220, brightness: 0.35, saturation: 0.8, profile: 1 };
    for (const [key, fallback] of Object.entries(defaults)) {
      this.current[key] = key === 'profile'
        ? this.target[key] ?? fallback
        : damp(this.current[key] ?? fallback, this.target[key] ?? fallback, 5.2, dt);
    }
    this.updateVoronoi(dt, elapsed);

    const profile = Math.round(this.current.profile);
    const direction = profile % 2 === 0 ? -1 : 1;
    const spin = 0.055 + this.current.turbulence * 0.3 + profile * 0.008;
    this.points.rotation.z = elapsed * spin * direction;
    this.points.rotation.x = Math.sin(elapsed * (0.13 + profile * 0.01)) * (0.08 + this.current.tension * 0.22);
    this.points.scale.setScalar(0.82 + this.current.density * 0.58 + this.pulse * 0.14);
    this.updateModeFiveCamera(dt);
    const cameraTargetZ = 8.9 - (this.current.zoom - 1) * 2.2 - this.modeFiveCameraAmount * 1.05;
    this.camera.position.z = damp(this.camera.position.z, cameraTargetZ, 3.6, dt);

    const hue = ((this.current.hue + (profile - 1) * 17) % 360 + 360) % 360;
    const lightness = Math.min(0.82, 0.22 + this.current.brightness * 0.48 + this.flash * 0.3);
    this.colour.setHSL(hue / 360, Math.min(1, this.current.saturation), lightness);
    this.material.color.copy(this.colour);
    this.material.size = 0.026 + this.current.density * 0.07 + this.pulse * 0.06;
    this.material.opacity = 0.32 + this.current.density * 0.52 + this.flash * 0.16;

    if (this.outgoing) {
      this.outgoing.material.opacity = Math.max(0, 1 - this.transitionProgress) * 0.65;
      if (this.transitionProgress >= 1) this.disposeOutgoing();
    }
    const pointLimit = this.quality === 'safe' ? SAFE_POINTS : MVP_POINTS;
    this.points.geometry.setDrawRange(0, Math.max(120, Math.round(pointLimit * (0.28 + this.current.density * 0.72))));

    if (this.blackout) {
      this.renderer.setClearColor(0x000000, 1);
      this.renderer.clear();
      return;
    }
    this.syncAmitabhaDisplayToCamera();
    this.renderer.setClearColor(this.impulseMode === 4 ? 0x000000 : 0x030307, 1);
    this.renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    window.removeEventListener('resize', this.resize);
    this.renderer.domElement.removeEventListener('webglcontextlost', this.onContextLost);
    this.renderer.domElement.removeEventListener('webglcontextrestored', this.onContextRestored);
    this.points.geometry.dispose();
    this.material.dispose();
    this.noteGeometry.dispose();
    this.noteMaterial.dispose();
    this.accumulationGeometry.dispose();
    this.accumulationMaterial.dispose();
    this.blockGeometry.dispose();
    this.circleGeometry.dispose();
    this.polygonGeometries.forEach((geometry) => geometry.dispose());
    this.blockMaterial.dispose();
    this.polygonMaterial.dispose();
    this.amitabhaDisplay.geometry.dispose();
    this.amitabhaField.dispose();
    this.forwardCaustics.dispose();
    this.opticalLab.dispose();
    this.dynamicOpticalField.dispose();
    this.viscoelasticFluid.dispose();
    this.blockFrameGeometry.dispose();
    this.blockFrameMaterial.dispose();
    this.voronoiGeometry.dispose();
    this.voronoiMaterial.dispose();
    this.forestTexture.dispose();
    this.disposeOutgoing();
    this.renderer.dispose();
  }

  getStatus(): RendererStatus {
    const canvas = this.renderer.domElement;
    const opticalLab = this.opticalLab.stats;
    const opticalLabActive = this.activeScene === 6 && opticalLab.active;
    const dynamicOptics = this.dynamicOpticalField.stats;
    const dynamicOpticsActive = this.activeScene === 7 && dynamicOptics.active;
    const viscoelastic = this.viscoelasticFluid.stats;
    const radianceComposition = this.radianceComposition.stats;
    const legacyEmitter = this.packingBlocks.find((block) => block.emissive);
    return {
      state: this.contextState,
      quality: this.quality,
      pixelRatio: this.renderer.getPixelRatio(),
      width: canvas.width,
      height: canvas.height,
      drawCalls: this.renderer.info.render.calls,
      geometries: this.renderer.info.memory.geometries,
      textures: this.renderer.info.memory.textures,
      contextLosses: this.contextLosses,
      fpsAverage: this.frameTimeAverageMs > 0 ? 1000 / this.frameTimeAverageMs : 0,
      frameTimeP95Ms: this.hrcFrameTimeP95Ms,
      tabVisible: document.visibilityState === 'visible',
      voronoiCells: this.voronoiField.count,
      packingGravityEnabled: this.packingGravityEnabled,
      packingCameraRotationDegrees: this.packingCameraRotation * 180 / Math.PI,
      packingEmitterScale: this.legacyEmitterScale,
      packingEmitterScaleTarget: this.legacyEmitterScaleTarget,
      packingEmitterPhysicsScale: legacyEmitter?.physicsScale ?? 1,
      packingEmitterMassScale: legacyEmitter && legacyEmitter.baseMass > 0
        ? legacyEmitter.body.getMass() / legacyEmitter.baseMass
        : 1,
      fluidActive: (this.activeScene === 8 || this.activeScene === 9)
        && viscoelastic.active,
      fluidParticleCount: viscoelastic.particleCount,
      fluidSpringCount: viscoelastic.springCount,
      radianceCompositionActive: this.activeScene === 10,
      radianceCompositionForm: radianceComposition.form,
      radianceCompositionScale: radianceComposition.scale,
      radianceCompositionScaleTarget: radianceComposition.scaleTarget,
      radianceCompositionLayout: radianceComposition.layout,
      radianceCompositionFocus: radianceComposition.focus,
      radianceCompositionPalette: radianceComposition.palette,
      radianceCompositionEmitterCount: radianceComposition.emitterCount,
      hrcResolution: this.amitabhaField.stats.resolution,
      hrcUpdateHz: this.amitabhaField.stats.updateHz,
      hrcFrustumsPerFrame: this.amitabhaField.stats.frustumsPerFrame,
      hrcTargetMemoryBytes: this.amitabhaField.stats.targetMemoryBytes,
      hrcDrawCalls: this.amitabhaField.stats.drawCalls,
      causticsActive: opticalLabActive || dynamicOpticsActive || this.forwardCaustics.stats.active,
      causticsQuality: opticalLabActive
        ? opticalLab.quality
        : dynamicOpticsActive
          ? dynamicOptics.quality
        : this.forwardCaustics.stats.quality,
      causticsEmitterCount: opticalLabActive
        ? 1
        : dynamicOpticsActive
          ? dynamicOptics.emitterCount
        : this.forwardCaustics.stats.emitterCount,
      causticsMaterialCount: opticalLabActive
        ? 4
        : dynamicOpticsActive
          ? dynamicOptics.opticalCount
        : this.forwardCaustics.stats.materialCount,
      causticsRayCount: opticalLabActive
        ? opticalLab.samplesPerPixel
        : dynamicOpticsActive
          ? dynamicOptics.rayCount
        : this.forwardCaustics.stats.rayCount,
      causticsHitCount: opticalLabActive
        ? opticalLab.accumulatedFrames
        : dynamicOpticsActive
          ? dynamicOptics.bodyCount
        : this.forwardCaustics.stats.hitCount,
      causticsPointCount: opticalLabActive
        ? 0
        : dynamicOpticsActive
          ? 0
        : this.forwardCaustics.stats.pointCount,
      causticsUpdateHz: opticalLabActive
        ? (this.frameTimeAverageMs > 0 ? 1000 / this.frameTimeAverageMs : 0)
        : dynamicOpticsActive
          ? (this.frameTimeAverageMs > 0 ? 1000 / this.frameTimeAverageMs : 0)
        : this.forwardCaustics.stats.updateHz,
      causticsCpuTimeMs: opticalLabActive
        ? opticalLab.cpuTimeMs
        : dynamicOpticsActive
          ? dynamicOptics.cpuTimeMs
        : this.forwardCaustics.stats.cpuTimeMs,
      causticsDrawCalls: opticalLabActive
        ? opticalLab.drawCalls
        : dynamicOpticsActive
          ? dynamicOptics.drawCalls
        : this.forwardCaustics.stats.drawCalls,
      causticsTargetMemoryBytes: opticalLabActive
        ? opticalLab.targetMemoryBytes
        : dynamicOpticsActive
          ? dynamicOptics.targetMemoryBytes
        : this.forwardCaustics.stats.targetMemoryBytes,
    };
  }

  setQuality(quality: RendererStatus['quality']): void {
    if (this.quality === quality) return;
    this.quality = quality;
    this.applyQuality();
    this.hrcQuality = quality;
    this.causticsQuality = quality === 'safe' ? 'safe' : 'high';
    this.causticsSlowElapsed = 0;
    this.causticsStableElapsed = 0;
    this.forwardCaustics.setQuality(this.causticsQuality);
    this.opticalLab.setQuality(quality);
    this.dynamicOpticalField.setQuality(quality);
    this.viscoelasticFluid.setQuality(quality);
    this.resetFrameTimingWindow();
    this.amitabhaField.setQuality(quality);
    this.resize();
  }

  resetPackingBlocks(): void {
    this.clearPackingBlocks();
  }

  controlRadianceComposition(
    control: RadianceCompositionControl,
  ): string | undefined {
    if (this.activeScene !== 10) return undefined;
    return this.radianceComposition.control(control);
  }

  private configurePackingMaterial(material: THREE.MeshBasicMaterial, morphPolygon: boolean): void {
    material.onBeforeCompile = (shader) => {
      shader.uniforms.uPackingIrradiance = this.packingIrradiance;
      shader.uniforms.uPackingImage = this.packingImage;
      shader.uniforms.uPackingImageRoll = this.packingImageRoll;
      shader.uniforms.uPackingWorldBounds = { value: AMITABHA_WORLD_BOUNDS.clone() };
      shader.uniforms.uLegacyBlocks = this.legacyBlocksUniform;
      if (morphPolygon) shader.uniforms.uMorphTime = this.polygonMorphTime;

      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
          attribute vec4 aEmission;
          attribute float aOpticalKind;
          attribute vec2 aPackingImageAnchor;
          uniform float uPackingImageRoll;
          uniform vec4 uPackingWorldBounds;
          varying vec2 vPackingPosition;
          varying vec2 vPackingLocal;
          varying vec4 vPackingEmission;
          varying float vPackingOpticalKind;
          varying float vPackingBoundary;
          varying vec2 vPackingImageUv;
          ${morphPolygon
            ? `attribute float aMorphSeed;
          attribute float aMorphAmount;
          attribute float aPackingBoundary;
          uniform float uMorphTime;`
            : ''}`,
        )
        .replace(
          '#include <begin_vertex>',
          morphPolygon
            ? `vec3 transformed = vec3(position);
          float perimeter = smoothstep(0.3, 0.82, length(position.xy));
          float polygonAngle = atan(position.y, position.x);
          float staticWarp =
            sin(polygonAngle * 2.0 + aMorphSeed * 17.3) * (0.08 + aMorphSeed * 0.09)
            + sin(polygonAngle * 5.0 - aMorphSeed * 11.7) * 0.075;
          float liveWarp = sin(
            uMorphTime * (0.7 + aMorphSeed * 1.4)
            + polygonAngle * (2.0 + floor(aMorphSeed * 4.0))
          ) * aMorphAmount;
          float radialScale = max(0.5, 1.0 + staticWarp + liveWarp);
          transformed.xy *= mix(1.0, radialScale, perimeter);
          float shear = (aMorphSeed - 0.5) * 0.38;
          transformed.x += perimeter * transformed.y * shear;
          transformed.y += perimeter * position.x * sin(aMorphSeed * 23.0) * 0.13;`
            : '#include <begin_vertex>',
        )
        .replace(
          '#include <project_vertex>',
          `vPackingEmission = aEmission;
          vPackingOpticalKind = aOpticalKind;
          vPackingLocal = transformed.xy;
          vPackingBoundary = ${morphPolygon ? 'aPackingBoundary' : '1.0'};
          #ifdef USE_INSTANCING
            vec4 packingPosition = instanceMatrix * vec4(transformed, 1.0);
            vec2 packingCenter = (instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xy;
          #else
            vec4 packingPosition = vec4(transformed, 1.0);
            vec2 packingCenter = vec2(0.0);
          #endif
          vPackingPosition = packingPosition.xy;
          // Project the very same full-screen image through the shape. Its
          // anchor is frozen at birth, so Box2D motion displaces the image
          // underneath this silhouette instead of choosing an unrelated crop.
          float imageRollCos = cos(uPackingImageRoll);
          float imageRollSin = sin(uPackingImageRoll);
          vec2 screenPosition = vec2(
            imageRollCos * packingPosition.x + imageRollSin * packingPosition.y,
            -imageRollSin * packingPosition.x + imageRollCos * packingPosition.y
          );
          vec2 anchorOffset = aPackingImageAnchor - packingCenter;
          vec2 screenAnchorOffset = vec2(
            imageRollCos * anchorOffset.x + imageRollSin * anchorOffset.y,
            -imageRollSin * anchorOffset.x + imageRollCos * anchorOffset.y
          );
          vPackingImageUv = clamp(
            (screenPosition + screenAnchorOffset - uPackingWorldBounds.xy)
              / (uPackingWorldBounds.zw - uPackingWorldBounds.xy),
            vec2(0.001),
            vec2(0.999)
          );
          #include <project_vertex>`,
        );

      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
          varying vec2 vPackingPosition;
          varying vec2 vPackingLocal;
       varying vec4 vPackingEmission;
       varying float vPackingOpticalKind;
       varying float vPackingBoundary;
       varying vec2 vPackingImageUv;
       uniform sampler2D uPackingIrradiance;
       uniform sampler2D uPackingImage;
          uniform vec4 uPackingWorldBounds;
          uniform float uLegacyBlocks;

          float packingOpticalEdge() {
            ${morphPolygon
              ? 'return 1.0 - clamp(vPackingBoundary, 0.0, 1.0);'
              : 'return clamp(max(abs(vPackingLocal.x), abs(vPackingLocal.y)) * 2.0, 0.0, 1.0);'}
          }

          float packingShapeCoverage() {
            ${morphPolygon
              ? `float width = max(fwidth(vPackingBoundary) * 1.35, 0.0005);
            return smoothstep(0.0, width, vPackingBoundary);`
              : `float interior = 0.5 - max(abs(vPackingLocal.x), abs(vPackingLocal.y));
            float width = max(fwidth(interior) * 1.35, 0.0005);
            return smoothstep(0.0, width, interior);`}
          }

          vec3 applyAmitabhaLighting(vec3 baseColour) {
            if (uLegacyBlocks > 0.5) {
              vec3 imageCrop = texture2D(uPackingImage, vPackingImageUv).rgb;
              // Match the cloud's full-screen grade first. The body only
              // reveals a displaced piece of it; it must not turn into a
              // bright, independently coloured card.
              vec3 imageMask = mix(
                vec3(0.002, 0.006, 0.016),
                imageCrop * vec3(0.34, 0.54, 0.84),
                0.2
              );
              if (vPackingEmission.a > 0.001) {
                return mix(imageMask, vPackingEmission.rgb, 0.44)
                  * (0.86 + vPackingEmission.a * 0.42);
              }
              vec2 legacyUv = (vPackingPosition - uPackingWorldBounds.xy)
                / (uPackingWorldBounds.zw - uPackingWorldBounds.xy);
              vec3 legacyIrradiance = texture2D(
                uPackingIrradiance,
                clamp(legacyUv, vec2(0.001), vec2(0.999))
              ).rgb;
              return imageMask + legacyIrradiance * 0.14;
            }
            if (vPackingEmission.a > 0.001) {
              return vPackingEmission.rgb * (0.92 + vPackingEmission.a * 0.34);
            }
            vec2 fieldUv = (vPackingPosition - uPackingWorldBounds.xy)
              / (uPackingWorldBounds.zw - uPackingWorldBounds.xy);
            vec3 irradiance = texture2D(
              uPackingIrradiance,
              clamp(fieldUv, vec2(0.001), vec2(0.999))
            ).rgb;
            if (vPackingOpticalKind > 1.5) {
              float edge = packingOpticalEdge();
              float fresnel = pow(smoothstep(0.28, 1.0, edge), 2.2);
              float diagonal = pow(max(
                0.0,
                1.0 - abs(vPackingLocal.x * 0.9 + vPackingLocal.y * 0.5 - 0.08) * 7.0
              ), 3.0);
              vec3 glassBody = vec3(0.012, 0.13, 0.19)
                + irradiance * vec3(0.035, 0.13, 0.2);
              vec3 glassRim = vec3(0.62, 0.98, 1.0)
                + irradiance * vec3(0.08, 0.15, 0.2);
              return mix(glassBody, glassRim, fresnel * 0.92)
                + diagonal * vec3(0.18, 0.68, 0.9);
            }
            if (vPackingOpticalKind > 0.5) {
              float edge = packingOpticalEdge();
              float chromeWave = 0.5 + 0.5 * sin(
                vPackingLocal.x * 3.5 - vPackingLocal.y * 5.0 + 0.7
              );
              float chromeBand = smoothstep(0.18, 0.82, chromeWave);
              vec3 reflectedField = irradiance.bgr * vec3(0.38, 0.48, 0.65);
              vec3 chromeDark = vec3(0.025, 0.035, 0.065) + reflectedField * 0.35;
              vec3 chromeBright = vec3(0.72, 0.82, 0.96) + reflectedField * 0.42;
              return mix(chromeDark, chromeBright, chromeBand)
                + pow(edge, 5.0) * vec3(0.22, 0.3, 0.42);
            }
            return baseColour * (vec3(0.1) + irradiance * 1.08)
              + irradiance * 0.06;
          }`,
        )
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
          // The HRC plane already contains the source radiance needed for
          // transport. Letting that plane leak through the translucent source
          // mesh made a second, low-resolution copy of the emitter visible.
          // Emitters are therefore an opaque foreground silhouette; only the
          // outgoing field remains visible around their exact Box2D shape.
          if (vPackingEmission.a > 0.001) {
            diffuseColor.a = 1.0;
          } else if (vPackingOpticalKind > 1.5) {
            float glassFresnel = pow(
              smoothstep(0.28, 1.0, packingOpticalEdge()),
              2.2
            );
            diffuseColor.a *= mix(0.16, 0.86, glassFresnel);
          } else if (vPackingOpticalKind > 0.5) {
            diffuseColor.a *= 0.98;
          }
          diffuseColor.a *= packingShapeCoverage();`,
        )
        .replace(
          'vec3 outgoingLight = reflectedLight.indirectDiffuse;',
          `vec3 outgoingLight = reflectedLight.indirectDiffuse;
          outgoingLight = applyAmitabhaLighting(outgoingLight);`,
        );
    };
    material.customProgramCacheKey = () => morphPolygon
      ? 'piano-forward-caustics-polygons-v3-image-materials'
      : 'piano-forward-caustics-blocks-v3-image-materials';
  }

  private disposeOutgoing(): void {
    if (!this.outgoing) return;
    this.scene.remove(this.outgoing);
    this.outgoing.material.dispose();
    this.outgoing = null;
  }

  private spawnNoteParticle(note: DetectedNote): void {
    if (this.noteParticles.length >= MAX_NOTE_PARTICLES) this.noteParticles.shift();
    const angle = Math.random() * Math.PI * 2;
    const strength = Math.max(0, Math.min(1, note.strength));
    const pitch = Math.max(0, Math.min(1, (note.midi - 21) / (108 - 21)));
    const octave = Math.max(0, Math.min(1, (Math.floor(note.midi / 12) - 1) / 8));
    const speed = 0.22 + strength * 0.56;
    this.noteParticles.push({
      age: 0,
      note: { ...note, strength },
      x: -4.9 + pitch * 9.8 + (Math.random() - 0.5) * 0.18,
      y: -1.9 + octave * 3.8 + (Math.random() - 0.5) * 0.16,
      z: (Math.random() - 0.5) * 0.45,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed * 0.45 + 0.18,
      vz: (Math.random() - 0.5) * speed * 0.35,
    });
  }

  private updateNoteParticles(dt: number): void {
    let writeIndex = 0;
    for (const particle of this.noteParticles) {
      particle.age += dt;
      if (particle.age >= NOTE_PARTICLE_LIFETIME) continue;
      const drag = Math.exp(-1.15 * dt);
      particle.vx *= drag;
      particle.vy = particle.vy * drag + 0.035 * dt;
      particle.vz *= drag;
      particle.x += particle.vx * dt;
      particle.y += particle.vy * dt;
      particle.z += particle.vz * dt;
      const progress = particle.age / NOTE_PARTICLE_LIFETIME;
      const fade = Math.pow(1 - progress, 1.45);
      this.notePositions[writeIndex * 3] = particle.x;
      this.notePositions[writeIndex * 3 + 1] = particle.y;
      this.notePositions[writeIndex * 3 + 2] = particle.z;
      this.noteAlphas[writeIndex] = fade;
      this.noteSizes[writeIndex] = (15 + particle.note.strength * 26) * Math.pow(1 - progress, 0.72);
      this.noteParticles[writeIndex] = particle;
      writeIndex += 1;
    }
    this.noteParticles.length = writeIndex;
    this.notePositionAttribute.needsUpdate = true;
    this.noteAlphaAttribute.needsUpdate = true;
    this.noteSizeAttribute.needsUpdate = true;
    this.noteGeometry.setDrawRange(0, writeIndex);
    this.notePoints.visible = this.impulseMode === 1 && writeIndex > 0;
  }

  private spawnAccumulationParticle(note: DetectedNote): void {
    if (this.accumulationParticles.length >= MAX_ACCUMULATION_PARTICLES) this.accumulationParticles.shift();
    const index = this.accumulationParticles.length;
    const column = index % ACCUMULATION_COLUMNS;
    const row = Math.floor(index / ACCUMULATION_COLUMNS);
    const strength = Math.max(0, Math.min(1, note.strength));
    const targetX = -4.45 + (column + 0.5) * (8.9 / ACCUMULATION_COLUMNS) + (Math.random() - 0.5) * 0.14;
    const targetY = -2.55 + row * 0.27 + (Math.random() - 0.5) * 0.08;
    this.accumulationParticles.push({
      age: 0,
      note: { ...note, strength },
      x: targetX + (Math.random() - 0.5) * 0.42,
      y: -3.5,
      z: (Math.random() - 0.5) * 0.5,
      targetX,
      targetY,
      targetZ: (Math.random() - 0.5) * 0.22,
    });
  }

  private updateAccumulationParticles(dt: number): void {
    for (let index = 0; index < this.accumulationParticles.length; index += 1) {
      const particle = this.accumulationParticles[index];
      particle.age += dt;
      particle.x = damp(particle.x, particle.targetX, 4.8, dt);
      particle.y = damp(particle.y, particle.targetY, 3.1, dt);
      particle.z = damp(particle.z, particle.targetZ, 3.4, dt);
      this.accumulationPositions[index * 3] = particle.x;
      this.accumulationPositions[index * 3 + 1] = particle.y;
      this.accumulationPositions[index * 3 + 2] = particle.z;
      this.accumulationAlphas[index] = Math.min(0.92, particle.age * 2.6);
      this.accumulationSizes[index] = 9 + particle.note.strength * 12;
    }
    this.accumulationPositionAttribute.needsUpdate = true;
    this.accumulationAlphaAttribute.needsUpdate = true;
    this.accumulationSizeAttribute.needsUpdate = true;
    this.accumulationGeometry.setDrawRange(0, this.accumulationParticles.length);
    this.accumulationPoints.visible = this.impulseMode === 2 && this.accumulationParticles.length > 0;
  }

  private clearAccumulation(): void {
    this.accumulationParticles = [];
    this.accumulationGeometry.setDrawRange(0, 0);
    this.accumulationPoints.visible = false;
  }

  private spawnPackingBurst(note: DetectedNote): void {
    // A played note produces a small physical shower rather than a lone
    // object. Stronger notes create more bodies, so the audio remains the
    // source of density without overwhelming the Box2D/HRC body budget.
    const strength = Math.max(0, Math.min(1, note.strength));
    const requested = 2 + Math.floor(strength * 3);
    const count = Math.min(requested, MAX_PACKING_BLOCKS - this.packingBlocks.length);
    for (let index = 0; index < count; index += 1) this.spawnPackingBlock(note);
  }

  private spawnPackingBlock(note: DetectedNote): void {
    this.lastPackingMidi = note.midi;
    this.packingReceivedNoteSinceTurn = true;
    if (this.packingBlocks.length >= MAX_PACKING_BLOCKS) return;
    this.blockSequence += 1;
    const seed = note.midi * 17.17 + note.strength * 31.7 + this.blockSequence * 7.31;
    const pitch = Math.max(0, Math.min(1, (note.midi - 21) / 87));
    const strength = Math.max(0, Math.min(1, note.strength));
    const blockWidth = Math.max(0.3, Math.min(1.38, 1.25 - pitch * 0.8 + (pseudoRandom(seed) - 0.5) * 0.26));
    const blockHeight = Math.max(0.18, Math.min(0.92, 0.22 + pitch * 0.56 + (pseudoRandom(seed + 19.4) - 0.5) * 0.2));
    // Circles belong to the original diffuse HRC mode only. The optical
    // scenes keep their deliberate material rig unchanged.
    const isCircle = this.legacyBlocksActive && pseudoRandom(seed + 57.9) < 0.34;
    const circleDiameter = Math.max(0.28, Math.min(0.9, (blockWidth + blockHeight) * 0.56));
    const width = isCircle ? circleDiameter : blockWidth;
    const height = isCircle ? circleDiameter : blockHeight;
    const light = this.packingEmitter(seed, strength);
    const legacyEmitterCount = this.packingBlocks.reduce(
      (count, block) => count + (block.emissive ? 1 : 0),
      0,
    );
    const targetEmitterCount = this.legacyEmitterCount(this.packingBlocks.length + 1);
    // Keep a constellation of actual HRC sources alive. A loud note can add
    // another emitter on top of the density-derived baseline.
    const shouldEmit = this.legacyBlocksActive
      ? legacyEmitterCount < targetEmitterCount
        || (
          legacyEmitterCount < LEGACY_EMITTER_MAX
          && strength > 0.68
          && pseudoRandom(seed + 301.7) < 0.48
        )
      : light.emissive;
    const opticalMaterial = this.legacyBlocksActive
      ? 'diffuse'
      : this.selectForwardOpticalMaterial(light.emissive);
    const spawn = this.packingSpawn(seed, strength, height);
    const body = this.packingWorld.createDynamicBody({
      position: spawn.position,
      angle: (pseudoRandom(seed + 12.7) - 0.5) * 0.62,
      linearVelocity: spawn.velocity,
      angularVelocity: (pseudoRandom(seed + 91.6) - 0.5) * (3.4 + strength * 5.2),
      linearDamping: 0.05,
      angularDamping: 0.12,
      bullet: true,
    });
    const emitterPalette = LEGACY_EMITTER_COLOURS[Math.floor(pseudoRandom(seed + 228.4) * LEGACY_EMITTER_COLOURS.length)];
    const opaqueColour = LEGACY_OPAQUE_COLOURS[Math.floor(pseudoRandom(seed + 184.2) * LEGACY_OPAQUE_COLOURS.length)];
    const block: PackingBlock = {
      kind: isCircle ? 'circle' : 'block',
      note,
      body,
      fixture: null,
      physicsScale: 1,
      baseMass: 0,
      width,
      height,
      color: this.legacyBlocksActive
        ? (shouldEmit ? emitterPalette.body : opaqueColour)
        : opticalMaterialColour(opticalMaterial),
      sides: isCircle ? 32 : 4,
      morphScale: 1,
      morphAspect: 1,
      morphPhase: 0,
      morphSeed: pseudoRandom(seed + 118.2),
      imageAnchorX: spawn.position.x,
      imageAnchorY: spawn.position.y,
      emissive: shouldEmit,
      emissionRed: this.legacyBlocksActive && shouldEmit ? emitterPalette.emission[0] : light.red,
      emissionGreen: this.legacyBlocksActive && shouldEmit ? emitterPalette.emission[1] : light.green,
      emissionBlue: this.legacyBlocksActive && shouldEmit ? emitterPalette.emission[2] : light.blue,
      emissionStrength: shouldEmit
        ? this.legacyBlocksActive
          ? 0.65 + strength * 0.55
          : light.strength
        : 0,
      opticalMaterial,
      transportOrder: this.blockSequence,
    };
    block.fixture = body.createFixture(isCircle ? Circle(width / 2) : Box(width / 2, height / 2), {
      density: isCircle ? 0.86 : 1,
      friction: isCircle ? 0.44 : 0.56,
      restitution: isCircle ? 0.28 : 0.1,
    });
    block.baseMass = body.getMass();
    body.setUserData(block);
    this.packingBlocks.push(block);
  }

  private spawnPackingPolygon(note: DetectedNote): void {
    this.lastPackingMidi = note.midi;
    this.packingReceivedNoteSinceTurn = true;
    if (this.packingBlocks.length >= MAX_PACKING_BLOCKS) return;
    this.blockSequence += 1;
    const strength = Math.max(0, Math.min(1, note.strength));
    const density = this.packingDensityTarget;
    const turbulence = this.packingTurbulenceTarget;
    const seed = note.midi * 19.31 + strength * 37.1 + this.blockSequence * 8.47;
    const sides = polygonSidesForSound(note.midi, density);
    const radius = 0.24 + strength * 0.28 + density * 0.2 + pseudoRandom(seed + 8.1) * 0.1;
    const baseAspect = 0.72 + pseudoRandom(seed + 22.7) * 0.56;
    const width = radius * 2;
    const height = radius * 2 * baseAspect;
    const light = this.packingEmitter(seed, strength);
    const opticalMaterial = this.selectForwardOpticalMaterial(light.emissive);
    const spawn = this.packingSpawn(seed, strength, height);
    const body = this.packingWorld.createDynamicBody({
      position: spawn.position,
      angle: (pseudoRandom(seed + 12.7) - 0.5) * Math.PI,
      linearVelocity: spawn.velocity,
      angularVelocity: (pseudoRandom(seed + 91.6) - 0.5) * (3.8 + strength * 4.2 + turbulence * 4.5),
      linearDamping: 0.07,
      angularDamping: 0.15,
      bullet: true,
    });
    const vertices = Array.from({ length: sides }, (_, index) => {
      const angle = -Math.PI / 2 + index * Math.PI * 2 / sides;
      return Vec2(Math.cos(angle) * radius, Math.sin(angle) * radius * baseAspect);
    });
    const block: PackingBlock = {
      kind: 'polygon',
      note,
      body,
      fixture: null,
      physicsScale: 1,
      baseMass: 0,
      width,
      height,
      color: opticalMaterialColour(opticalMaterial),
      sides,
      morphScale: 1,
      morphAspect: 1,
      morphPhase: pseudoRandom(seed + 71.3) * Math.PI * 2,
      morphSeed: pseudoRandom(seed + 118.2),
      imageAnchorX: spawn.position.x,
      imageAnchorY: spawn.position.y,
      emissive: light.emissive,
      emissionRed: light.red,
      emissionGreen: light.green,
      emissionBlue: light.blue,
      emissionStrength: light.strength,
      opticalMaterial,
      transportOrder: this.blockSequence,
    };
    block.fixture = body.createFixture(Polygon(vertices), {
      density: 0.8 + strength * 0.8 + density * 0.65,
      friction: 0.42 + (1 - turbulence) * 0.28,
      restitution: 0.08 + turbulence * 0.2,
    });
    block.baseMass = body.getMass();
    body.setUserData(block);
    this.packingBlocks.push(block);
  }

  private seedDynamicOpticalScene(): void {
    // These are ordinary Box2D bodies, not a separate demo animation. They
    // begin in a legible emitter → optic arrangement, drift/collide slowly,
    // while note-triggered blocks retain the full free Box2D behaviour.
    this.packingWorld.setGravity(Vec2(0, -3.8));
    const seed: Array<{
      x: number; y: number; angle: number; vx: number; vy: number; spin: number;
      width: number; height: number; material: DynamicOpticalMaterial; color: number;
      strength?: number; gravityScale: number;
    }> = [
      { x: -3.9, y: 2.05, angle: 0.08, vx: 0.34, vy: -0.03, spin: 0.18, width: 0.55, height: 0.55, material: 'emitter', color: 0xffe8a3, strength: 4.1, gravityScale: 0 },
      { x: 3.55, y: 2.5, angle: -0.32, vx: -0.30, vy: -0.02, spin: -0.15, width: 0.48, height: 0.48, material: 'emitter', color: 0xa8dcff, strength: 3.5, gravityScale: 0 },
      { x: -1.92, y: 1.3, angle: 0.78, vx: 0.08, vy: 0.0, spin: 0.10, width: 0.24, height: 1.75, material: 'mirror', color: 0xd7e8ff, gravityScale: 0 },
      { x: 0.05, y: 1.42, angle: -0.32, vx: -0.08, vy: 0.0, spin: -0.08, width: 0.78, height: 1.28, material: 'glass', color: 0x35dcff, gravityScale: 0 },
      { x: 2.1, y: 0.54, angle: 1.06, vx: -0.06, vy: -0.04, spin: 0.08, width: 0.2, height: 1.52, material: 'mirror', color: 0xc5d6f1, gravityScale: 0 },
      { x: -2.85, y: -0.38, angle: -0.17, vx: 0.17, vy: 0.0, spin: -0.08, width: 1.04, height: 0.45, material: 'metal', color: 0xc77b32, gravityScale: 0 },
      { x: 1.18, y: -0.55, angle: 0.35, vx: -0.12, vy: 0.0, spin: 0.12, width: 0.82, height: 0.42, material: 'glass', color: 0x52cde6, gravityScale: 0 },
      { x: 3.45, y: -1.05, angle: -0.24, vx: -0.16, vy: 0.0, spin: -0.08, width: 0.7, height: 0.54, material: 'diffuse', color: 0x6f7888, gravityScale: 0 },
      { x: -0.35, y: -1.65, angle: 0.11, vx: 0.05, vy: 0.0, spin: 0.06, width: 1.05, height: 0.34, material: 'diffuse', color: 0x7d8795, gravityScale: 0 },
    ];
    seed.forEach((spec, index) => this.createDynamicOpticalBlock(spec, index));
    this.dynamicOpticalField.setBodies(this.buildDynamicOpticalBodies());
  }

  private createDynamicOpticalBlock(
    spec: {
      x: number; y: number; angle: number; vx: number; vy: number; spin: number;
      width: number; height: number; material: DynamicOpticalMaterial; color: number;
      strength?: number; gravityScale: number;
    },
    index: number,
  ): void {
    this.blockSequence += 1;
    const note: DetectedNote = {
      midi: 48 + index * 5,
      frequency: 440 * 2 ** ((48 + index * 5 - 69) / 12),
      strength: 0.78,
    };
    const body = this.packingWorld.createDynamicBody({
      position: Vec2(spec.x, spec.y),
      angle: spec.angle,
      linearVelocity: Vec2(spec.vx, spec.vy),
      angularVelocity: spec.spin,
      gravityScale: spec.gravityScale,
      linearDamping: 0.32,
      angularDamping: 0.38,
      bullet: true,
    });
    const colour = new THREE.Color(spec.color);
    const isEmitter = spec.material === 'emitter';
    const opticalMaterial: Exclude<ForwardOpticalMaterial, 'emitter'> = spec.material === 'glass'
      ? 'glass'
      : spec.material === 'mirror' || spec.material === 'metal'
        ? 'mirror'
        : 'diffuse';
    const block: PackingBlock = {
      kind: 'block',
      note,
      body,
      fixture: null,
      physicsScale: 1,
      baseMass: 0,
      width: spec.width,
      height: spec.height,
      color: spec.color,
      sides: 4,
      morphScale: 1,
      morphAspect: 1,
      morphPhase: 0,
      morphSeed: pseudoRandom(this.blockSequence * 7.17),
      imageAnchorX: spec.x,
      imageAnchorY: spec.y,
      emissive: isEmitter,
      emissionRed: isEmitter ? colour.r : 0,
      emissionGreen: isEmitter ? colour.g : 0,
      emissionBlue: isEmitter ? colour.b : 0,
      emissionStrength: isEmitter ? spec.strength ?? 3.2 : 0,
      opticalMaterial,
      dynamicMaterial: spec.material,
      dynamicPinned: true,
      transportOrder: this.blockSequence,
    };
    block.fixture = body.createFixture(Box(spec.width * 0.5, spec.height * 0.5), {
      density: isEmitter ? 0.72 : spec.material === 'glass' ? 0.9 : 1.1,
      friction: 0.54,
      restitution: 0.12,
    });
    block.baseMass = body.getMass();
    body.setUserData(block);
    this.packingBlocks.push(block);
  }

  private packingEmitter(seed: number, strength: number): {
    emissive: boolean;
    red: number;
    green: number;
    blue: number;
    strength: number;
  } {
    const emissive = this.blockSequence % 5 === 1 || pseudoRandom(seed + 203.7) < 0.12;
    if (!emissive) return { emissive: false, red: 0, green: 0, blue: 0, strength: 0 };
    const palette = pseudoRandom(seed + 241.9);
    if (palette < 0.34) {
      return { emissive: true, red: 1, green: 0.055, blue: 0.018, strength: 2.4 + strength * 1.8 };
    }
    if (palette < 0.68) {
      return { emissive: true, red: 0.035, green: 0.15, blue: 1, strength: 2.4 + strength * 1.8 };
    }
    return { emissive: true, red: 1, green: 0.72, blue: 0.34, strength: 2.2 + strength * 1.6 };
  }

  private selectForwardOpticalMaterial(
    emissive: boolean,
  ): Exclude<ForwardOpticalMaterial, 'emitter'> {
    const nonEmitterIndex = this.packingBlocks.reduce(
      (count, block) => count + (block.emissive ? 0 : 1),
      0,
    );
    return forwardOpticalMaterialForIndex(nonEmitterIndex, emissive);
  }

  private packingSpawn(seed: number, strength: number, height: number): { position: ReturnType<typeof Vec2>; velocity: ReturnType<typeof Vec2> } {
    if (this.packingGravityEnabled) {
      return {
        position: Vec2((pseudoRandom(seed + 43.8) - 0.5) * BLOCK_HALF_WIDTH * 1.85, BLOCK_TOP + height + 0.8),
        velocity: Vec2((pseudoRandom(seed + 63.2) - 0.5) * (1.8 + strength * 3.5), -0.15 - strength * 0.35),
      };
    }

    const edge = pseudoRandom(seed + 43.8);
    const along = pseudoRandom(seed + 51.6);
    const position = edge < 0.34
      ? Vec2(-5.25, -1.6 + along * 4.7)
      : edge < 0.68
        ? Vec2(5.25, -1.6 + along * 4.7)
        : Vec2(-4.25 + along * 8.5, 3.75);
    const targetX = (pseudoRandom(seed + 77.4) - 0.5) * 1.1;
    const targetY = (pseudoRandom(seed + 84.1) - 0.5) * 0.9;
    const deltaX = targetX - position.x;
    const deltaY = targetY - position.y;
    const distance = Math.max(0.001, Math.hypot(deltaX, deltaY));
    const speed = 2.6 + strength * 3.4 + this.packingTurbulenceTarget * 2.2;
    const sideways = (pseudoRandom(seed + 93.8) - 0.5) * (0.35 + this.packingTurbulenceTarget * 1.2);
    return {
      position,
      velocity: Vec2(deltaX / distance * speed - deltaY / distance * sideways, deltaY / distance * speed + deltaX / distance * sideways),
    };
  }

  private updatePackingBlocks(dt: number, elapsed: number): void {
    if (
      this.activeScene === 8
      || this.activeScene === 9
      || this.activeScene === 10
    ) return;
    const dynamicOptics = this.activeScene === 7;
    if (!dynamicOptics && this.impulseMode !== 3 && this.impulseMode !== 5) return;
    const frameDt = Math.min(dt, 0.1);
    this.polygonMorphTime.value = elapsed;
    this.packingDensity = damp(this.packingDensity, this.packingDensityTarget, 3.2, frameDt);
    this.packingTurbulence = damp(this.packingTurbulence, this.packingTurbulenceTarget, 2.8, frameDt);
    this.packingTension = damp(this.packingTension, this.packingTensionTarget, 3.6, frameDt);

    if (dynamicOptics || this.impulseMode !== 3) {
      this.packingCycleElapsed = 0;
    }

    if (!dynamicOptics && this.packingTurnActive) {
      this.packingTurnElapsed += frameDt;
      const progress = Math.min(1, this.packingTurnElapsed / PACKING_ROTATION_DURATION);
      const eased = progress * progress * (3 - 2 * progress);
      this.packingCameraRotation = this.packingTurnStartRotation + this.packingTurnAngle * eased;
      this.camera.rotation.z = this.packingCameraRotation;
      if (progress >= 1) this.commitPackingTurn();
    }

    if (!dynamicOptics) {
      this.updateLegacyEmitterScale();
      this.syncLegacyEmitterPhysics();
    }

    // A camera-only turn must never pause the physical scene. Keep the fixed
    // step simulation and the HRC field running on every render frame.
    this.physicsAccumulator += frameDt;
    const fixedStep = 1 / 120;
    let subSteps = 0;
    while (this.physicsAccumulator >= fixedStep && subSteps < 12) {
      this.packingWorld.step(fixedStep, 8, 3);
      this.physicsAccumulator -= fixedStep;
      subSteps += 1;
    }
    if (subSteps === 12) this.physicsAccumulator = 0;

    this.updatePackingFloor(frameDt);
    this.removeEscapedPackingBlocks();
    this.packingBlocks.forEach((block) => {
      if (block.kind === 'polygon') this.updatePackingMorph(block, frameDt);
    });
    if (dynamicOptics) {
      this.dynamicOpticalField.setBodies(this.buildDynamicOpticalBodies());
      return;
    }
    this.updateLegacyBlockMaterials(frameDt);
    this.updateAmitabhaField(elapsed);
    if (!this.legacyBlocksActive) this.forwardCaustics.update(frameDt, this.buildForwardOpticalBodies());
    let blockInstance = 0;
    let circleInstance = 0;
    const polygonCounts = [0, 0, 0, 0, 0, 0];
    for (let index = 0; index < this.packingBlocks.length; index += 1) {
      const block = this.packingBlocks[index];
      const position = block.body.getPosition();
      this.blockPosition.set(position.x, position.y, 0);
      this.blockQuaternion.setFromAxisAngle(this.blockRotationAxis, block.body.getAngle());
      const emitterScale = this.legacyBlocksActive && block.emissive
        ? this.legacyEmitterScale
        : 1;
      if (block.kind === 'block') {
        this.blockMatrix.compose(
          this.blockPosition,
          this.blockQuaternion,
          this.blockScale.set(block.width * emitterScale, block.height * emitterScale, 1),
        );
        this.blockMesh.setMatrixAt(blockInstance, this.blockMatrix);
        this.blockMesh.setColorAt(blockInstance, this.blockColor.setHex(block.color));
        this.blockEmissionData[blockInstance * 4] = block.emissionRed;
        this.blockEmissionData[blockInstance * 4 + 1] = block.emissionGreen;
        this.blockEmissionData[blockInstance * 4 + 2] = block.emissionBlue;
        this.blockEmissionData[blockInstance * 4 + 3] = block.emissionStrength;
        this.blockOpticalData[blockInstance] = opticalMaterialCode(block.opticalMaterial);
        this.blockImageAnchorData[blockInstance * 2] = block.imageAnchorX;
        this.blockImageAnchorData[blockInstance * 2 + 1] = block.imageAnchorY;
        blockInstance += 1;
      } else if (block.kind === 'circle') {
        this.blockMatrix.compose(
          this.blockPosition,
          this.blockQuaternion,
          this.blockScale.set(block.width * emitterScale, block.height * emitterScale, 1),
        );
        this.circleMesh.setMatrixAt(circleInstance, this.blockMatrix);
        this.circleMesh.setColorAt(circleInstance, this.blockColor.setHex(block.color));
        this.circleEmissionData[circleInstance * 4] = block.emissionRed;
        this.circleEmissionData[circleInstance * 4 + 1] = block.emissionGreen;
        this.circleEmissionData[circleInstance * 4 + 2] = block.emissionBlue;
        this.circleEmissionData[circleInstance * 4 + 3] = block.emissionStrength;
        this.circleOpticalData[circleInstance] = 0;
        this.circleImageAnchorData[circleInstance * 2] = block.imageAnchorX;
        this.circleImageAnchorData[circleInstance * 2 + 1] = block.imageAnchorY;
        circleInstance += 1;
      } else {
        const meshIndex = block.sides - 3;
        const instanceIndex = polygonCounts[meshIndex];
        const mesh = this.polygonMeshes[meshIndex];
        this.blockMatrix.compose(
          this.blockPosition,
          this.blockQuaternion,
          this.blockScale.set(block.width * 0.5 * block.morphScale, block.height * 0.5 * block.morphScale * block.morphAspect, 1),
        );
        mesh.setMatrixAt(instanceIndex, this.blockMatrix);
        mesh.setColorAt(instanceIndex, this.blockColor.setHex(block.color));
        this.polygonMorphSeeds[meshIndex][instanceIndex] = block.morphSeed;
        this.polygonMorphAmounts[meshIndex][instanceIndex] = 0.065
          + block.morphSeed * 0.045
          + regulatedPackingChaos(this.packingDensity, this.packingTurbulence, this.packingTension) * 0.26;
        this.polygonEmissionData[meshIndex][instanceIndex * 4] = block.emissionRed;
        this.polygonEmissionData[meshIndex][instanceIndex * 4 + 1] = block.emissionGreen;
        this.polygonEmissionData[meshIndex][instanceIndex * 4 + 2] = block.emissionBlue;
        this.polygonEmissionData[meshIndex][instanceIndex * 4 + 3] = block.emissionStrength;
        this.polygonOpticalData[meshIndex][instanceIndex] = opticalMaterialCode(block.opticalMaterial);
        this.polygonImageAnchorData[meshIndex][instanceIndex * 2] = block.imageAnchorX;
        this.polygonImageAnchorData[meshIndex][instanceIndex * 2 + 1] = block.imageAnchorY;
        polygonCounts[meshIndex] += 1;
      }
    }
    this.blockMesh.count = blockInstance;
    this.blockMesh.instanceMatrix.needsUpdate = true;
    if (this.blockMesh.instanceColor) this.blockMesh.instanceColor.needsUpdate = true;
    this.blockGeometry.getAttribute('aEmission').needsUpdate = true;
    this.blockGeometry.getAttribute('aOpticalKind').needsUpdate = true;
    this.blockGeometry.getAttribute('aPackingImageAnchor').needsUpdate = true;
    this.blockMesh.visible = blockInstance > 0;
    this.circleMesh.count = circleInstance;
    this.circleMesh.instanceMatrix.needsUpdate = true;
    if (this.circleMesh.instanceColor) this.circleMesh.instanceColor.needsUpdate = true;
    this.circleGeometry.getAttribute('aEmission').needsUpdate = true;
    this.circleGeometry.getAttribute('aOpticalKind').needsUpdate = true;
    this.circleGeometry.getAttribute('aPackingImageAnchor').needsUpdate = true;
    this.circleMesh.visible = circleInstance > 0;
    this.polygonMeshes.forEach((mesh, index) => {
      mesh.count = polygonCounts[index];
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      this.polygonGeometries[index].getAttribute('aMorphSeed').needsUpdate = true;
      this.polygonGeometries[index].getAttribute('aMorphAmount').needsUpdate = true;
      this.polygonGeometries[index].getAttribute('aEmission').needsUpdate = true;
      this.polygonGeometries[index].getAttribute('aOpticalKind').needsUpdate = true;
      this.polygonGeometries[index].getAttribute('aPackingImageAnchor').needsUpdate = true;
      mesh.visible = polygonCounts[index] > 0;
    });
  }

  private updatePackingMorph(block: PackingBlock, dt: number): void {
    const chaos = regulatedPackingChaos(this.packingDensity, this.packingTurbulence, this.packingTension);
    block.morphPhase += dt * (0.45 + this.packingTension * 1.25 + this.packingTurbulence * 2.4) * (0.82 + block.morphSeed * 0.42);
    const scaleWave = Math.sin(block.morphPhase + block.morphSeed * 5.7);
    const aspectWave = Math.sin(block.morphPhase * 0.73 + block.morphSeed * 11.3);
    const targetScale = 0.9 + this.packingDensity * 0.32 + scaleWave * (0.025 + chaos * 0.16);
    const targetAspect = 1 + aspectWave * (0.035 + chaos * 0.25);
    block.morphScale = damp(block.morphScale, targetScale, 2.2 + chaos * 2.7, dt);
    block.morphAspect = damp(block.morphAspect, targetAspect, 1.8 + chaos * 2.2, dt);

    const spinDirection = block.morphSeed >= 0.5 ? 1 : -1;
    const targetSpin = spinDirection * (0.35 + chaos * 5.8) * (0.65 + block.note.strength * 0.55);
    block.body.setAngularVelocity(damp(block.body.getAngularVelocity(), targetSpin, 0.16 + chaos * 0.55, dt));
  }

  private updateLegacyBlockMaterials(dt: number): void {
    if (!this.legacyBlocksActive) {
      this.legacyMaterialCycleElapsed = 0;
      return;
    }
    if (this.packingBlocks.length === 0) return;
    this.legacyMaterialCycleElapsed += dt;
    if (this.legacyMaterialCycleElapsed < LEGACY_MATERIAL_CYCLE_SECONDS) return;
    this.legacyMaterialCycleElapsed -= LEGACY_MATERIAL_CYCLE_SECONDS;
    this.legacyMaterialCycle += 1;

    const ordered = [...this.packingBlocks].sort((left, right) => left.transportOrder - right.transportOrder);
    const emitterCount = this.legacyEmitterCount(ordered.length);
    const selected = new Set(
      [...ordered]
        .sort((left, right) => (
          pseudoRandom(left.transportOrder * 5.3 + this.legacyMaterialCycle * 11.7)
          - pseudoRandom(right.transportOrder * 5.3 + this.legacyMaterialCycle * 11.7)
        ))
        .slice(0, emitterCount),
    );

    // Rotate a group of real emitters, not a single coloured body. The
    // hand-off changes the shadows and the cloud-mask illumination together.
    ordered.forEach((block) => {
      if (selected.has(block)) this.makeLegacyBlockEmitter(block);
      else this.makeLegacyBlockOpaque(block);
    });
  }

  private legacyEmitterCount(bodyCount: number): number {
    if (!this.legacyBlocksActive) return 0;
    return Math.min(
      LEGACY_EMITTER_MAX,
      Math.max(LEGACY_EMITTER_MIN, Math.ceil(bodyCount * 0.34)),
    );
  }

  private updateLegacyEmitterScale(): void {
    if (!this.legacyBlocksActive || !Number.isFinite(this.legacyEmitterScaleStartedAt)) return;
    const progress = Math.min(
      1,
      Math.max(
        0,
        (Date.now() / 1000 - this.legacyEmitterScaleStartedAt)
          / LEGACY_EMITTER_SCALE_DURATION,
      ),
    );
    const eased = progress * progress * (3 - 2 * progress);
    this.legacyEmitterScale = this.legacyEmitterScaleStart
      + (this.legacyEmitterScaleTarget - this.legacyEmitterScaleStart) * eased;
    if (progress >= 1) this.legacyEmitterScaleStartedAt = -Infinity;
  }

  private syncLegacyEmitterPhysics(): void {
    if (!this.legacyBlocksActive) return;
    for (const block of this.packingBlocks) {
      if (block.kind === 'polygon') continue;
      const targetScale = block.emissive ? this.legacyEmitterScale : 1;
      const scaleDelta = Math.abs(targetScale - block.physicsScale);
      const atEndpoint = Math.abs(targetScale - LEGACY_EMITTER_SCALE_MIN) < 0.0001
        || Math.abs(targetScale - LEGACY_EMITTER_SCALE_MAX) < 0.0001;
      if (
        block.fixture
        && scaleDelta < LEGACY_PHYSICS_SCALE_STEP
        && (!atEndpoint || scaleDelta < 0.0001)
      ) {
        continue;
      }

      if (block.fixture) block.body.destroyFixture(block.fixture);
      const shape = block.kind === 'circle'
        ? Circle(block.width * targetScale * 0.5)
        : Box(block.width * targetScale * 0.5, block.height * targetScale * 0.5);
      block.fixture = block.body.createFixture(shape, {
        density: block.kind === 'circle' ? 0.86 : 1,
        friction: block.kind === 'circle' ? 0.44 : 0.56,
        restitution: block.kind === 'circle' ? 0.28 : 0.1,
      });
      block.physicsScale = targetScale;
      block.body.setAwake(true);
    }
  }

  private makeLegacyBlockOpaque(block: PackingBlock): void {
    const index = Math.floor(pseudoRandom(block.transportOrder * 3.7 + this.legacyMaterialCycle * 9.1) * LEGACY_OPAQUE_COLOURS.length);
    block.emissive = false;
    block.emissionRed = 0;
    block.emissionGreen = 0;
    block.emissionBlue = 0;
    block.emissionStrength = 0;
    block.color = LEGACY_OPAQUE_COLOURS[index];
  }

  private makeLegacyBlockEmitter(block: PackingBlock): void {
    const index = Math.floor(pseudoRandom(block.transportOrder * 5.3 + this.legacyMaterialCycle * 11.7) * LEGACY_EMITTER_COLOURS.length);
    const palette = LEGACY_EMITTER_COLOURS[index];
    block.emissive = true;
    block.emissionRed = palette.emission[0];
    block.emissionGreen = palette.emission[1];
    block.emissionBlue = palette.emission[2];
    block.emissionStrength = 0.65 + block.note.strength * 0.55;
    block.color = palette.body;
  }

  private updateAmitabhaField(elapsed: number): void {
    // Glass is transported by the bounded forward pass. Leaving it out of the
    // diffuse HRC input lets the base field pass through it instead of casting
    // a second, opaque shadow behind an object that is visually transparent.
    const bodies: AmitabhaBody[] = this.packingBlocks
      .filter((block) => block.opticalMaterial !== 'glass')
      .map((block) => {
        const position = block.body.getPosition();
        this.blockColor.setHex(block.color);
        const pulse = block.emissive
          ? 0.94 + Math.sin(elapsed * (1.05 + block.morphSeed * 0.55) + block.morphPhase) * 0.06
          : 0;
        const morphWidth = block.kind === 'polygon'
          ? block.width * block.morphScale
          : block.width;
        const morphHeight = block.kind === 'polygon'
          ? block.height * block.morphScale * block.morphAspect
          : block.height;
        const emitterScale = this.legacyBlocksActive && block.emissive
          ? this.legacyEmitterScale
          : 1;
        return {
          x: position.x,
          y: position.y,
          halfWidth: morphWidth * emitterScale * 0.5,
          halfHeight: morphHeight * emitterScale * 0.5,
          angle: block.body.getAngle(),
          emission: [block.emissionRed, block.emissionGreen, block.emissionBlue] as const,
          emissionStrength: block.emissionStrength * pulse,
          albedo: block.emissive
            ? [0, 0, 0] as const
            : [
                this.blockColor.r * 0.72,
                this.blockColor.g * 0.72,
                this.blockColor.b * 0.72,
              ] as const,
          sides: block.kind === 'polygon' || block.kind === 'circle' ? block.sides : undefined,
          transportRole: 'body',
          transportOrder: block.transportOrder,
        };
      });
    bodies.push({
      x: 0,
      y: this.packingFloorY - 0.055,
      halfWidth: PACKING_FLOOR_HALF_WIDTH,
      halfHeight: 0.055,
      angle: 0,
      emission: [0, 0, 0],
      emissionStrength: 0,
      albedo: [0.58, 0.58, 0.62],
      transportRole: 'floor',
      transportOrder: -1,
    });
    this.amitabhaField.setBodies(bodies);
    this.amitabhaField.render();
    this.packingIrradiance.value = this.amitabhaField.texture;
  }

  private buildDynamicOpticalBodies(): DynamicOpticalBody[] {
    const blocks = this.packingBlocks.map((block): DynamicOpticalBody => {
      const position = block.body.getPosition();
      const material: DynamicOpticalMaterial = block.dynamicMaterial
        ?? (block.emissive
          ? 'emitter'
          : block.opticalMaterial === 'glass'
            ? 'glass'
            : block.opticalMaterial === 'mirror'
              ? (block.transportOrder % 5 === 0 ? 'metal' : 'mirror')
              : 'diffuse');
      return {
        x: position.x,
        y: position.y,
        width: block.width * (block.kind === 'polygon' ? block.morphScale : 1),
        height: block.height * (block.kind === 'polygon' ? block.morphScale * block.morphAspect : 1),
        angle: block.body.getAngle(),
        material,
        color: block.color,
        emissionStrength: block.emissionStrength,
        order: block.transportOrder,
        pinned: block.dynamicPinned,
      };
    });
    blocks.push({
      x: 0,
      y: this.packingFloorY - 0.08,
      width: PACKING_FLOOR_HALF_WIDTH * 2,
      height: 0.16,
      angle: 0,
      material: 'diffuse',
      color: 0x4e5562,
      emissionStrength: 0,
      order: -1,
      pinned: true,
    });
    return blocks;
  }

  private buildForwardOpticalBodies(): ForwardOpticalBody[] {
    const maximumBodies = 64;
    const selected = new Set<PackingBlock>();
    const add = (blocks: readonly PackingBlock[]): void => {
      for (const block of blocks) {
        if (selected.size >= maximumBodies) return;
        selected.add(block);
      }
    };
    add(
      this.packingBlocks
        .filter((block) => block.emissive)
        .sort((left, right) => right.emissionStrength - left.emissionStrength)
        .slice(0, 4),
    );
    add(
      this.packingBlocks
        .filter((block) => block.opticalMaterial !== 'diffuse')
        .sort((left, right) => right.transportOrder - left.transportOrder),
    );
    add(
      this.packingBlocks
        .filter((block) => !block.emissive && block.opticalMaterial === 'diffuse')
        .sort((left, right) => right.transportOrder - left.transportOrder),
    );

    const bodies = [...selected].map((block): ForwardOpticalBody => {
      const position = block.body.getPosition();
      const material: ForwardOpticalMaterial = block.emissive
        ? 'emitter'
        : block.opticalMaterial;
      return {
        id: block.transportOrder,
        order: block.transportOrder,
        center: { x: position.x, y: position.y },
        vertices: this.forwardOpticalVertices(block),
        material,
        emission: {
          r: block.emissionRed,
          g: block.emissionGreen,
          b: block.emissionBlue,
        },
        emissionStrength: block.emissionStrength,
        tint: material === 'glass'
          ? { r: 0.64, g: 0.9, b: 1 }
          : material === 'mirror'
            ? { r: 0.72, g: 0.84, b: 1 }
            : { r: 1, g: 1, b: 1 },
        reflectivity: material === 'mirror' ? 0.82 : 0,
        ior: material === 'glass' ? 1.43 : 1,
        absorption: material === 'glass' ? 0.62 : 0,
      };
    });

    bodies.push({
      id: -1,
      order: -1,
      center: { x: 0, y: this.packingFloorY - 0.055 },
      vertices: [
        { x: -PACKING_FLOOR_HALF_WIDTH, y: this.packingFloorY - 0.11 },
        { x: PACKING_FLOOR_HALF_WIDTH, y: this.packingFloorY - 0.11 },
        { x: PACKING_FLOOR_HALF_WIDTH, y: this.packingFloorY },
        { x: -PACKING_FLOOR_HALF_WIDTH, y: this.packingFloorY },
      ],
      material: 'diffuse',
      emission: { r: 0, g: 0, b: 0 },
      emissionStrength: 0,
      tint: { r: 1, g: 1, b: 1 },
      reflectivity: 0,
      ior: 1,
      absorption: 0,
    });
    return bodies;
  }

  private forwardOpticalVertices(block: PackingBlock): ForwardVec2[] {
    const position = block.body.getPosition();
    const angle = block.body.getAngle();
    const cosine = Math.cos(angle);
    const sine = Math.sin(angle);
    const halfWidth = block.width * 0.5
      * (block.kind === 'polygon' ? block.morphScale : 1);
    const halfHeight = block.height * 0.5
      * (block.kind === 'polygon' ? block.morphScale * block.morphAspect : 1);
    const localVertices: ForwardVec2[] = block.kind === 'block'
      ? [
          { x: -halfWidth, y: -halfHeight },
          { x: halfWidth, y: -halfHeight },
          { x: halfWidth, y: halfHeight },
          { x: -halfWidth, y: halfHeight },
        ]
      : Array.from({ length: block.sides }, (_, index) => {
          const vertexAngle = -Math.PI / 2 + index * Math.PI * 2 / block.sides;
          return {
            x: Math.cos(vertexAngle) * halfWidth,
            y: Math.sin(vertexAngle) * halfHeight,
          };
        });
    return localVertices.map((vertex) => ({
      x: position.x + vertex.x * cosine - vertex.y * sine,
      y: position.y + vertex.x * sine + vertex.y * cosine,
    }));
  }

  private updatePackingFloor(dt: number): void {
    if (!this.packingFloorWaveActive) {
      if (this.packingBlocks.length === 0) return;
      this.packingFloorWaitElapsed += dt;
      if (this.packingFloorWaitElapsed < this.packingFloorNextWave) return;
      this.packingFloorWaveActive = true;
      this.packingFloorWaveElapsed = 0;
    }

    this.packingFloorWaveElapsed += dt;
    const progress = Math.min(1, this.packingFloorWaveElapsed / PACKING_FLOOR_WAVE_DURATION);
    const envelope = Math.sin(Math.PI * progress);
    const displacement = Math.sin(Math.PI * 4 * progress) * envelope * PACKING_FLOOR_WAVE_AMPLITUDE;
    this.setPackingFloorY(BLOCK_BOTTOM + displacement);

    if (progress < 1) return;
    this.packingFloorWaveActive = false;
    this.packingFloorWaveElapsed = 0;
    this.packingFloorWaitElapsed = 0;
    this.packingFloorNextWave = 8 + pseudoRandom(this.blockSequence * 5.3 + this.packingCycleElapsed) * 6;
    this.setPackingFloorY(BLOCK_BOTTOM);
  }

  private setPackingFloorY(y: number): void {
    if (Math.abs(y - this.packingFloorY) < 0.0001) return;
    this.packingFloorY = y;
    this.packingFloor.setTransform(Vec2(0, y), 0);
    this.packingFloor.setAwake(true);
    this.blockFrame.position.y = y - BLOCK_BOTTOM;
  }

  private updateModeFiveCamera(dt: number): void {
    const frameDt = Math.min(dt, 0.1);
    if (this.impulseMode !== 5) {
      this.modeFiveCameraPhase = 'idle';
      this.modeFiveCameraElapsed = 0;
      this.modeFiveCameraTarget = null;
      this.modeFiveCameraX = damp(this.modeFiveCameraX, 0, 2.8, frameDt);
      this.modeFiveCameraY = damp(this.modeFiveCameraY, 0, 2.8, frameDt);
      this.modeFiveCameraAmount = damp(this.modeFiveCameraAmount, 0, 3.2, frameDt);
      this.camera.position.x = this.modeFiveCameraX;
      this.camera.position.y = this.modeFiveCameraY;
      return;
    }

    this.modeFiveCameraElapsed += frameDt;
    const polygons = this.packingBlocks.filter((block) => block.kind === 'polygon');
    if (this.modeFiveCameraPhase === 'idle') {
      this.modeFiveCameraX = damp(this.modeFiveCameraX, 0, 2.2, frameDt);
      this.modeFiveCameraY = damp(this.modeFiveCameraY, 0, 2.2, frameDt);
      this.modeFiveCameraAmount = damp(this.modeFiveCameraAmount, 0, 2.6, frameDt);
      if (polygons.length >= 3 && this.modeFiveCameraElapsed >= this.modeFiveCameraDelay) {
        const visiblePolygons = polygons.filter((block) => {
          const position = block.body.getPosition();
          return Math.abs(position.x) <= 5.2 && position.y >= -3.4 && position.y <= 4.2;
        });
        const candidates = visiblePolygons.length ? visiblePolygons : polygons;
        const selection = Math.floor(pseudoRandom(this.blockSequence * 7.3 + this.modeFiveCameraElapsed * 3.1) * candidates.length);
        this.modeFiveCameraTarget = candidates[Math.min(candidates.length - 1, selection)] ?? null;
        this.modeFiveCameraPhase = 'focus';
        this.modeFiveCameraElapsed = 0;
        const chaos = regulatedPackingChaos(this.packingDensity, this.packingTurbulence, this.packingTension);
        this.modeFiveCameraDuration = 2.6 - chaos * 0.75;
      }
    } else if (this.modeFiveCameraPhase === 'focus') {
      if (!this.modeFiveCameraTarget || !this.packingBlocks.includes(this.modeFiveCameraTarget)) {
        this.modeFiveCameraPhase = 'return';
        this.modeFiveCameraElapsed = 0;
        this.modeFiveCameraTarget = null;
      } else {
        const position = this.modeFiveCameraTarget.body.getPosition();
        const targetX = Math.max(-3.8, Math.min(3.8, position.x));
        const targetY = Math.max(-2.1, Math.min(2.4, position.y));
        this.modeFiveCameraX = damp(this.modeFiveCameraX, targetX, 1.75, frameDt);
        this.modeFiveCameraY = damp(this.modeFiveCameraY, targetY, 1.75, frameDt);
        this.modeFiveCameraAmount = damp(this.modeFiveCameraAmount, 1, 2.1, frameDt);
        if (this.modeFiveCameraElapsed >= this.modeFiveCameraDuration) {
          this.modeFiveCameraPhase = 'return';
          this.modeFiveCameraElapsed = 0;
          this.modeFiveCameraTarget = null;
        }
      }
    } else {
      this.modeFiveCameraX = damp(this.modeFiveCameraX, 0, 1.8, frameDt);
      this.modeFiveCameraY = damp(this.modeFiveCameraY, 0, 1.8, frameDt);
      this.modeFiveCameraAmount = damp(this.modeFiveCameraAmount, 0, 2, frameDt);
      if (
        this.modeFiveCameraElapsed >= 2.1
        || Math.abs(this.modeFiveCameraX) + Math.abs(this.modeFiveCameraY) < 0.05
      ) {
        this.modeFiveCameraPhase = 'idle';
        this.modeFiveCameraElapsed = 0;
        this.modeFiveCameraDelay = 4.2 + pseudoRandom(this.blockSequence * 5.9 + 17.1) * 3.2;
      }
    }

    this.camera.position.x = this.modeFiveCameraX;
    this.camera.position.y = this.modeFiveCameraY;
  }

  private clearPackingBlocks(): void {
    this.packingBlocks.forEach((block) => this.packingWorld.destroyBody(block.body));
    this.packingBlocks = [];
    this.blockSequence = 0;
    this.packingCycleElapsed = 0;
    this.packingTurnElapsed = 0;
    this.packingTurnActive = false;
    this.packingTurnAngle = 0;
    this.packingCameraRotation = 0;
    this.packingTurnStartRotation = 0;
    this.packingTurnDirection = 1;
    this.packingIdleDirection = 1;
    this.packingReceivedNoteSinceTurn = false;
    this.lastPackingMidi = 60;
    this.legacyMaterialCycleElapsed = 0;
    this.legacyMaterialCycle = 0;
    this.legacyEmitterScale = LEGACY_EMITTER_SCALE_MIN;
    this.legacyEmitterScaleStart = LEGACY_EMITTER_SCALE_MIN;
    this.legacyEmitterScaleTarget = LEGACY_EMITTER_SCALE_MIN;
    this.legacyEmitterScaleStartedAt = -Infinity;
    this.packingGravityEnabled = true;
    this.packingWorld.setGravity(Vec2(0, -14));
    this.blockFrameMaterial.opacity = 0.55;
    this.physicsAccumulator = 0;
    this.packingFloorWaveActive = false;
    this.packingFloorWaveElapsed = 0;
    this.packingFloorWaitElapsed = 0;
    this.packingFloorNextWave = 8.5;
    this.setPackingFloorY(BLOCK_BOTTOM);
    this.hrcSlowElapsed = 0;
    this.hrcStableElapsed = 0;
    this.hrcQuality = this.quality;
    this.causticsSlowElapsed = 0;
    this.causticsStableElapsed = 0;
    this.causticsQuality = this.quality === 'safe' ? 'safe' : 'high';
    this.forwardCaustics.reset();
    this.forwardCaustics.setQuality(this.causticsQuality);
    this.resetFrameTimingWindow();
    this.amitabhaField.reset();
    this.packingIrradiance.value = this.amitabhaField.texture;
    this.resetPackingCamera();
    this.modeFiveCameraPhase = 'idle';
    this.modeFiveCameraElapsed = 0;
    this.modeFiveCameraDelay = 4.2;
    this.modeFiveCameraDuration = 2.2;
    this.modeFiveCameraTarget = null;
    this.modeFiveCameraAmount = 0;
    this.blockMesh.count = 0;
    this.blockMesh.visible = false;
    this.circleMesh.count = 0;
    this.circleMesh.visible = false;
    this.polygonMeshes.forEach((mesh) => {
      mesh.count = 0;
      mesh.visible = false;
    });
    this.dynamicOpticalField.setBodies([]);
  }

  private updateVoronoi(dt: number, elapsed: number): void {
    this.voronoiField.update(dt);
    const cells = this.voronoiField.snapshot();
    for (let index = 0; index < MAX_VORONOI_CELLS; index += 1) {
      const cell = cells[index];
      this.voronoiSeeds[index].set(cell?.x ?? 0, cell?.y ?? 0);
    }
    this.voronoiMaterial.uniforms.uSeedCount.value = cells.length;
    this.voronoiMaterial.uniforms.uTime.value = elapsed;
    this.updateVoronoiChaser(cells, dt);
    const turbulence = this.current.turbulence ?? 0.1;
    const brightness = this.current.brightness ?? 0.35;
    this.voronoiMaterial.uniforms.uTextureMotion.value = 0.0045 + turbulence * 0.014;
    this.voronoiMaterial.uniforms.uForestExposure.value = 1.4 + brightness;
    const zoom = 1
      + Math.sin(elapsed * 0.42) * 0.034
      + Math.sin(elapsed * 0.17 + 0.8) * 0.017
      + Math.sin(elapsed * 0.071 + 2.2) * 0.009;
    this.voronoiFrameScale.copy(this.voronoiBaseFrameScale).multiplyScalar(zoom);
    this.voronoiFramePixels.copy(this.voronoiBaseFramePixels).multiplyScalar(zoom);
  }

  private applyVoronoiImpulse(note: DetectedNote): void {
    const result = this.voronoiField.applyImpulse(note);
    if (result === 'added') {
      this.voronoiChaseTrail.unshift(this.voronoiChaseIndex);
      this.voronoiChaseIndex = this.voronoiField.count - 1;
      this.voronoiChaseElapsed = 0;
      this.voronoiCellLight[this.voronoiChaseIndex] = Math.max(
        this.voronoiCellLight[this.voronoiChaseIndex],
        0.32,
      );
    } else if (result === 'removed') {
      this.voronoiChaseIndex = Math.min(this.voronoiChaseIndex, this.voronoiField.count - 1);
    }
  }

  private resetVoronoiChaser(): void {
    this.voronoiCellLight.fill(0);
    this.voronoiCellLightTargets.fill(0);
    this.voronoiChaseTrail.length = 0;
    this.voronoiChaseIndex = 0;
    this.voronoiChaseElapsed = 0;
    this.voronoiChaseSequence = 0;
    this.voronoiLastCellCount = this.voronoiField.count;
  }

  private updateVoronoiChaser(cells: VoronoiCellSnapshot[], dt: number): void {
    const count = cells.length;
    if (count === 0) {
      this.voronoiCellLight.fill(0);
      return;
    }
    if (this.voronoiLastCellCount !== count) {
      this.voronoiChaseIndex = Math.min(this.voronoiChaseIndex, count - 1);
      for (let index = this.voronoiChaseTrail.length - 1; index >= 0; index -= 1) {
        if (this.voronoiChaseTrail[index] >= count) this.voronoiChaseTrail.splice(index, 1);
      }
      this.voronoiLastCellCount = count;
    }

    const density = this.current.density ?? 0.2;
    const turbulence = this.current.turbulence ?? 0.1;
    const tension = this.current.tension ?? 0.1;
    const stepSeconds = Math.max(0.38, 1.15 - turbulence * 0.62 - tension * 0.18);
    this.voronoiChaseElapsed += dt;
    let transitions = 0;
    while (this.voronoiChaseElapsed >= stepSeconds && transitions < 3) {
      this.voronoiChaseElapsed -= stepSeconds;
      this.voronoiChaseTrail.unshift(this.voronoiChaseIndex);
      this.voronoiChaseIndex = this.pickVoronoiNeighbour(cells, this.voronoiChaseIndex);
      this.voronoiChaseSequence += 1;
      transitions += 1;
    }

    const trailLength = 2 + Math.round(density * 4);
    this.voronoiChaseTrail.splice(trailLength);
    this.voronoiCellLightTargets.fill(0);
    this.voronoiCellLightTargets[this.voronoiChaseIndex] = 1;
    this.voronoiChaseTrail.forEach((index, position) => {
      const trailLight = 0.62 * Math.pow(0.63, position);
      this.voronoiCellLightTargets[index] = Math.max(
        this.voronoiCellLightTargets[index],
        trailLight,
      );
    });

    const fadeSpeed = 1.0 + tension * 1.2;
    for (let index = 0; index < MAX_VORONOI_CELLS; index += 1) {
      const target = index < count ? this.voronoiCellLightTargets[index] : 0;
      const speed = target > this.voronoiCellLight[index] ? 7.4 : fadeSpeed;
      this.voronoiCellLight[index] = damp(this.voronoiCellLight[index], target, speed, dt);
    }
  }

  private pickVoronoiNeighbour(cells: VoronoiCellSnapshot[], fromIndex: number): number {
    if (cells.length <= 1) return 0;
    const origin = cells[Math.min(fromIndex, cells.length - 1)];
    const recent = new Set(this.voronoiChaseTrail.slice(0, 3));
    const candidates = cells
      .map((cell, index) => {
        const dx = (cell.x - origin.x) * 1.6;
        const dy = cell.y - origin.y;
        return { index, distance: dx * dx + dy * dy };
      })
      .filter((candidate) => candidate.index !== fromIndex)
      .sort((left, right) => left.distance - right.distance);
    const neighbourhoodSize = Math.min(candidates.length, Math.max(2, Math.ceil(cells.length * 0.18)));
    const neighbourhood = candidates.slice(0, neighbourhoodSize);
    const unvisited = neighbourhood.filter((candidate) => !recent.has(candidate.index));
    const pool = unvisited.length > 0 ? unvisited : neighbourhood;
    const random = pseudoRandom(this.voronoiChaseSequence * 7.17 + fromIndex * 3.91 + cells.length);
    return pool[Math.min(pool.length - 1, Math.floor(random * pool.length))].index;
  }

  togglePackingGravity(): boolean | undefined {
    if (!this.legacyBlocksActive && this.activeScene !== 7 && this.impulseMode !== 5) return undefined;
    this.packingGravityEnabled = !this.packingGravityEnabled;
    this.packingWorld.setGravity(Vec2(0, this.packingGravityEnabled ? -14 : 0));
    this.blockFrameMaterial.opacity = this.packingGravityEnabled ? 0.55 : 0.18;
    this.packingBlocks.forEach((block, index) => {
      block.body.setAwake(true);
      if (!this.packingGravityEnabled) this.launchPackingBodyTowardCenter(block, index);
    });
    return this.packingGravityEnabled;
  }

  rotatePackingScene(): boolean {
    if (!this.legacyBlocksActive || this.packingTurnActive) return false;
    this.beginPackingTurn();
    return true;
  }

  toggleLitBlockScale(): 1 | 3 | undefined {
    if (!this.legacyBlocksActive || !this.packingBlocks.some((block) => block.emissive)) return undefined;
    this.legacyEmitterScaleStart = this.legacyEmitterScale;
    this.legacyEmitterScaleTarget = this.legacyEmitterScaleTarget === LEGACY_EMITTER_SCALE_MAX
      ? LEGACY_EMITTER_SCALE_MIN
      : LEGACY_EMITTER_SCALE_MAX;
    this.legacyEmitterScaleStartedAt = Date.now() / 1000;
    return this.legacyEmitterScaleTarget;
  }

  private launchPackingBodyTowardCenter(block: PackingBlock, index: number): void {
    const position = block.body.getPosition();
    const velocity = block.body.getLinearVelocity();
    let deltaX = -position.x;
    let deltaY = -position.y;
    let distance = Math.hypot(deltaX, deltaY);
    if (distance < 0.2) {
      const angle = pseudoRandom(this.blockSequence * 3.7 + index * 9.1) * Math.PI * 2;
      deltaX = Math.cos(angle);
      deltaY = Math.sin(angle);
      distance = 1;
    }
    const speed = 1.15 + block.note.strength * 1.15 + this.packingTurbulenceTarget * 1.35;
    const tangent = (block.morphSeed - 0.5) * (0.45 + this.packingTurbulenceTarget * 1.1);
    block.body.setLinearVelocity(Vec2(
      velocity.x * 0.18 + deltaX / distance * speed - deltaY / distance * tangent,
      velocity.y * 0.18 + deltaY / distance * speed + deltaX / distance * tangent,
    ));
  }

  private beginPackingTurn(): void {
    this.packingTurnActive = true;
    this.packingTurnElapsed = 0;
    this.packingTurnDirection = this.packingReceivedNoteSinceTurn
      ? (this.lastPackingMidi >= 60 ? 1 : -1)
      : this.packingIdleDirection;
    this.packingIdleDirection *= -1;
    this.packingReceivedNoteSinceTurn = false;
    this.packingTurnAngle = this.packingTurnDirection * Math.PI / 2;
    this.packingTurnStartRotation = this.packingCameraRotation;
  }

  private commitPackingTurn(): void {
    this.packingCameraRotation = Math.atan2(
      Math.sin(this.packingTurnStartRotation + this.packingTurnAngle),
      Math.cos(this.packingTurnStartRotation + this.packingTurnAngle),
    );
    this.camera.rotation.z = this.packingCameraRotation;
    this.packingTurnActive = false;
    this.packingTurnElapsed = 0;
    this.packingTurnAngle = 0;
    this.packingTurnStartRotation = this.packingCameraRotation;
  }

  private resetPackingCamera(): void {
    this.packingTurnActive = false;
    this.packingTurnElapsed = 0;
    this.packingTurnAngle = 0;
    this.packingCameraRotation = 0;
    this.packingTurnStartRotation = 0;
    this.camera.rotation.z = 0;
  }

  private syncAmitabhaDisplayToCamera(): void {
    const roll = this.camera.rotation.z;
    this.packingImageRoll.value = roll;
    const centerX = (AMITABHA_WORLD_BOUNDS.x + AMITABHA_WORLD_BOUNDS.z) * 0.5;
    const centerY = (AMITABHA_WORLD_BOUNDS.y + AMITABHA_WORLD_BOUNDS.w) * 0.5;
    const cosine = Math.cos(roll);
    const sine = Math.sin(roll);
    this.amitabhaDisplay.rotation.z = roll;
    this.amitabhaDisplay.position.set(
      cosine * centerX - sine * centerY,
      sine * centerX + cosine * centerY,
      AMITABHA_DISPLAY_Z,
    );
    this.amitabhaField.setDisplayRoll(roll);
  }

  private onPackingContact(firstBody: PhysicsBody, secondBody: PhysicsBody): void {
    const first = this.asPackingBlock(firstBody.getUserData());
    const second = this.asPackingBlock(secondBody.getUserData());
    if (first && second) {
      const firstDirection = Math.abs(first.body.getAngularVelocity()) > 0.2
        ? first.body.getAngularVelocity()
        : first.note.midi - 60;
      const secondDirection = Math.abs(second.body.getAngularVelocity()) > 0.2
        ? second.body.getAngularVelocity()
        : second.note.midi - 60;
      first.color = firstDirection >= 0 ? 0xef3155 : 0x3979ef;
      second.color = secondDirection >= 0 ? 0xef3155 : 0x3979ef;
      if (first.emissive) first.emissionStrength = Math.max(first.emissionStrength, 3.4 + first.note.strength);
      if (second.emissive) second.emissionStrength = Math.max(second.emissionStrength, 3.4 + second.note.strength);
    }
  }

  private asPackingBlock(value: unknown): PackingBlock | null {
    const kind = typeof value === 'object' && value !== null && 'kind' in value
      ? (value as { kind?: unknown }).kind
      : null;
    return kind === 'block' || kind === 'circle' || kind === 'polygon'
      ? value as PackingBlock
      : null;
  }

  private removeEscapedPackingBlocks(): void {
    const survivors: PackingBlock[] = [];
    for (const block of this.packingBlocks) {
      const position = block.body.getPosition();
      if (position.y < -10 || Math.abs(position.x) > 14 || position.y > 12) this.packingWorld.destroyBody(block.body);
      else survivors.push(block);
    }
    this.packingBlocks = survivors;
  }

  private onEvent(event: GestureEvent): void {
    if (this.impulseMode === 4 && this.activeScene !== 8) return;
    if (event.type === 'estalla' || event.type === 'climax' || event.target === 'explosion' || event.target === 'finale') {
      const intensity = 'intensity' in event && typeof event.intensity === 'number' ? event.intensity : 1;
      this.flash = Math.max(this.flash, intensity);
      this.pulse = Math.max(this.pulse, 0.75);
      this.viscoelasticFluid.burst(intensity);
    }
    if (event.type === 'pulso') {
      this.pulse = Math.max(this.pulse, 0.7);
      this.viscoelasticFluid.burst(0.42);
    }
  }

  private onContextLost = (event: Event): void => {
    event.preventDefault();
    this.contextState = 'lost';
    this.contextLosses += 1;
  };

  private onContextRestored = (): void => {
    this.contextState = 'ready';
    this.restorePending = true;
  };

  private applyQuality(): void {
    // Honour HiDPI displays and supersample ordinary 1× projectors. Capping
    // DPR at 2 avoids runaway framebuffer cost on 3×/4× laptop panels.
    const displayPixelRatio = window.devicePixelRatio || 1;
    const pixelRatio = this.quality === 'safe'
      ? Math.min(1, displayPixelRatio)
      : Math.min(2, Math.max(1.5, displayPixelRatio));
    this.renderer.setPixelRatio(pixelRatio);
    this.viscoelasticFluid.setPixelRatio(pixelRatio);
  }

  private updateTransportQuality(dt: number): void {
    this.hrcP95SampleElapsed += dt;
    if (this.hrcP95SampleElapsed >= 0.25) {
      const sorted = [...this.frameTimes].sort((left, right) => left - right);
      this.hrcFrameTimeP95Ms =
        sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? 0;
      this.frameTimeAverageMs = this.frameTimes.length > 0
        ? this.frameTimes.reduce((sum, value) => sum + value, 0)
          / this.frameTimes.length
        : 0;
      this.hrcP95SampleElapsed = 0;
    }
    this.updateForwardCausticsQuality(dt);
    if (
      this.activeScene !== 9
      && this.activeScene !== 10
      && this.impulseMode !== 3
      && this.impulseMode !== 5
    ) return;
    if (document.visibilityState !== 'visible') {
      this.hrcSlowElapsed = 0;
      this.hrcStableElapsed = 0;
      this.resetFrameTimingWindow();
      return;
    }

    if (this.quality === 'safe') {
      if (this.hrcQuality !== 'safe') {
        this.hrcQuality = 'safe';
        this.amitabhaField.setQuality('safe');
      }
      return;
    }

    // Scene 9 uses a 1024² particle transport mask and an edge-aware display
    // resolve specifically to preserve small emitters and their shadow edges.
    // Letting a transient entrance/compile spike demote it defeats that detail
    // even after the renderer has returned to a stable frame rate.
    if (this.activeScene === 9) {
      if (this.hrcQuality !== 'high') {
        this.hrcQuality = 'high';
        this.amitabhaField.setQuality('high');
      }
      this.hrcSlowElapsed = 0;
      this.hrcStableElapsed = 0;
      return;
    }

    const p95 = this.hrcFrameTimeP95Ms;
    if (p95 > 20) {
      this.hrcSlowElapsed += dt;
      this.hrcStableElapsed = 0;
      if (this.hrcSlowElapsed >= 1.5 && this.hrcQuality !== 'safe') {
        this.hrcQuality = 'safe';
        this.amitabhaField.setQuality('safe');
      }
      return;
    }

    this.hrcSlowElapsed = 0;
    if (p95 > 0 && p95 < 15) {
      this.hrcStableElapsed += dt;
      if (this.hrcStableElapsed >= 5 && this.hrcQuality !== 'high') {
        this.hrcQuality = 'high';
        this.amitabhaField.setQuality('high');
      }
    } else {
      this.hrcStableElapsed = 0;
    }
  }

  private updateForwardCausticsQuality(dt: number): void {
    if (this.legacyBlocksActive) {
      this.causticsSlowElapsed = 0;
      this.causticsStableElapsed = 0;
      this.setForwardCausticsQuality('off');
      return;
    }
    if (
      this.activeScene === 8
      || this.activeScene === 9
      || this.activeScene === 10
    ) {
      this.setForwardCausticsQuality('off');
      return;
    }
    if (this.activeScene === 6 || this.activeScene === 7) {
      this.setForwardCausticsQuality('off');
      const p95 = this.hrcFrameTimeP95Ms;
      if (this.activeScene === 6) {
        if (this.quality === 'safe' || p95 > 18) {
          this.opticalLab.setQuality('safe');
        } else if (p95 > 0 && p95 < 13) {
          this.opticalLab.setQuality('high');
        }
      } else if (this.quality === 'safe' || p95 > 18) {
        this.dynamicOpticalField.setQuality('safe');
      } else if (p95 > 0 && p95 < 13) {
        this.dynamicOpticalField.setQuality('high');
      }
      return;
    }
    const packingActive = this.impulseMode === 3 || this.impulseMode === 5;
    if (!packingActive || document.visibilityState !== 'visible') {
      this.causticsSlowElapsed = 0;
      this.causticsStableElapsed = 0;
      this.setForwardCausticsQuality('off');
      return;
    }

    const requestedQuality: ForwardCausticsQuality =
      this.quality === 'safe' ? 'safe' : 'high';
    const p95 = this.hrcFrameTimeP95Ms;
    if (p95 <= 0) {
      this.setForwardCausticsQuality(requestedQuality);
      return;
    }

    if (p95 > 18) {
      this.causticsSlowElapsed += Math.min(dt, 0.1);
      this.causticsStableElapsed = 0;
      if (this.causticsSlowElapsed >= 1.2) {
        this.setForwardCausticsQuality('off');
      } else if (this.causticsSlowElapsed >= 0.6) {
        this.setForwardCausticsQuality('safe');
      }
      return;
    }

    if (p95 > 12) {
      this.causticsSlowElapsed += Math.min(dt, 0.1);
      this.causticsStableElapsed = 0;
      if (this.causticsSlowElapsed >= 1) {
        this.setForwardCausticsQuality('safe');
      }
      return;
    }

    this.causticsSlowElapsed = 0;
    if (p95 < 10) {
      this.causticsStableElapsed += Math.min(dt, 0.1);
      if (this.causticsStableElapsed >= 5) {
        this.setForwardCausticsQuality(requestedQuality);
      }
    } else {
      this.causticsStableElapsed = 0;
    }
  }

  private setForwardCausticsQuality(quality: ForwardCausticsQuality): void {
    if (this.causticsQuality === quality) return;
    this.causticsQuality = quality;
    this.forwardCaustics.setQuality(quality);
  }

  private resetFrameTimingWindow(): void {
    this.frameTimes.length = 0;
    this.hrcP95SampleElapsed = 0;
    this.hrcFrameTimeP95Ms = 0;
    this.frameTimeAverageMs = 0;
  }

  private resize = (): void => {
    const canvas = this.renderer.domElement;
    const width = canvas.clientWidth || window.innerWidth;
    const height = canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(width, height, false);
    // Optical Lab follows the real drawing buffer, including the active DPR,
    // instead of rendering to its previous fixed-size target.
    this.opticalLab.setSize(canvas.width, canvas.height);
    this.dynamicOpticalField.setSize(width, height);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    const margin = Math.max(24, Math.min(58, Math.min(width, height) * 0.065));
    const frameWidth = Math.max(180, Math.min(width - margin * 2, (height - margin * 2) * 1.6));
    const frameHeight = Math.max(120, frameWidth / 1.6);
    this.voronoiBaseFrameScale.set(frameWidth / width, frameHeight / height);
    this.voronoiFrameScale.copy(this.voronoiBaseFrameScale);
    this.voronoiMaterial.uniforms.uFrameOffset.value.set(0, 0);
    this.voronoiMaterial.uniforms.uFrameAspect.value = frameWidth / frameHeight;
    this.voronoiBaseFramePixels.set(frameWidth * this.renderer.getPixelRatio(), frameHeight * this.renderer.getPixelRatio());
    this.voronoiFramePixels.copy(this.voronoiBaseFramePixels);
  };
}

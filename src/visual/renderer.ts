import * as THREE from 'three';
import { Box, Edge, Polygon, Vec2, World } from 'planck-js';
import type { DetectedNote, GestureEvent, ImpulseMode, RendererStatus, VisualFrame } from '../types';
import forestAtlasUrl from '../assets/forest-satellite-atlas-8x8.jpg';
import { AMITABHA_WORLD_BOUNDS, AmitabhaRadianceField, type AmitabhaBody } from './amitabha-radiance-field';
import { polygonSidesForSound, regulatedPackingChaos } from './packing-dynamics';
import { visualProfileById } from './profiles';
import { MAX_VORONOI_CELLS, VoronoiField, type VoronoiCellSnapshot } from './voronoi-field';

// Deliberately small: this renderer is the MVP/concept visual, not the final
// particle piece. Keeping the point count and render resolution low leaves
// headroom for a 120 Hz screen, audio analysis and the control panel.
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
const PACKING_ROTATION_INTERVAL = 6;
const PACKING_ROTATION_DURATION = 0.82;
const PACKING_FLOOR_WAVE_DURATION = 5;
const PACKING_FLOOR_WAVE_AMPLITUDE = 0.34;
const MAX_FRAME_SAMPLES = 180;

const damp = (current: number, target: number, speed: number, dt: number): number => current + (target - current) * (1 - Math.exp(-speed * dt));
const pseudoRandom = (seed: number): number => {
  const value = Math.sin(seed * 12.9898) * 43758.5453;
  return value - Math.floor(value);
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
  kind: 'block' | 'polygon';
  note: DetectedNote;
  body: PhysicsBody;
  width: number;
  height: number;
  color: number;
  sides: number;
  morphScale: number;
  morphAspect: number;
  morphPhase: number;
  morphSeed: number;
  emissive: boolean;
  emissionRed: number;
  emissionGreen: number;
  emissionBlue: number;
  emissionStrength: number;
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
  private readonly blockGeometry = new THREE.PlaneGeometry(1, 1);
  private readonly blockMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.97, depthWrite: false });
  private readonly polygonMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.97, depthWrite: false });
  private readonly polygonMorphTime = { value: 0 };
  private readonly blockMesh = new THREE.InstancedMesh(this.blockGeometry, this.blockMaterial, MAX_PACKING_BLOCKS);
  private readonly polygonGeometries = Array.from({ length: 6 }, (_, index) => new THREE.CircleGeometry(1, index + 3));
  private readonly polygonMorphSeeds = Array.from({ length: 6 }, () => new Float32Array(MAX_PACKING_BLOCKS));
  private readonly polygonMorphAmounts = Array.from({ length: 6 }, () => new Float32Array(MAX_PACKING_BLOCKS));
  private readonly blockEmissionData = new Float32Array(MAX_PACKING_BLOCKS * 4);
  private readonly polygonEmissionData = Array.from({ length: 6 }, () => new Float32Array(MAX_PACKING_BLOCKS * 4));
  private readonly polygonMeshes = this.polygonGeometries.map((geometry) => new THREE.InstancedMesh(geometry, this.polygonMaterial, MAX_PACKING_BLOCKS));
  private readonly amitabhaField: AmitabhaRadianceField;
  private readonly amitabhaDisplay: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
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
  private hrcSlowElapsed = 0;
  private hrcStableElapsed = 0;
  private hrcQuality: RendererStatus['quality'] = 'high';
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
  private readonly voronoiMaterial: THREE.ShaderMaterial;
  private readonly voronoiMesh: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  private impulseMode: ImpulseMode = 1;
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
    this.applyQuality();
    this.renderer.setClearColor(0x030307, 1);
    this.amitabhaField = new AmitabhaRadianceField(this.renderer);
    this.amitabhaField.setQuality(this.quality);
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
    this.polygonGeometries.forEach((geometry, index) => {
      geometry.setAttribute('aMorphSeed', new THREE.InstancedBufferAttribute(this.polygonMorphSeeds[index], 1));
      geometry.setAttribute('aMorphAmount', new THREE.InstancedBufferAttribute(this.polygonMorphAmounts[index], 1));
      geometry.setAttribute('aEmission', new THREE.InstancedBufferAttribute(this.polygonEmissionData[index], 4));
    });
    this.packingGroup.add(this.amitabhaDisplay);
    this.blockMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.blockMesh.count = 0;
    this.blockMesh.visible = false;
    this.blockMesh.frustumCulled = false;
    this.blockMesh.renderOrder = 1;
    this.packingGroup.add(this.blockMesh);
    this.polygonMeshes.forEach((mesh) => {
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.count = 0;
      mesh.visible = false;
      mesh.frustumCulled = false;
      mesh.renderOrder = 1;
      this.packingGroup.add(mesh);
    });
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
    const modeChanged = this.impulseMode !== frame.impulseMode;
    this.impulseMode = frame.impulseMode;
    if (modeChanged && this.impulseMode === 2) this.clearAccumulation();
    if (modeChanged && (this.impulseMode === 3 || this.impulseMode === 5)) this.clearPackingBlocks();
    if (modeChanged && this.impulseMode !== 3 && this.impulseMode !== 5) this.resetPackingCamera();
    if (modeChanged && this.impulseMode === 4) {
      this.voronoiField.reset();
      this.resetVoronoiChaser();
      this.flash = 0;
      this.pulse = 0;
    }
    const baseFieldVisible = ![1, 2, 3, 4, 5].includes(this.impulseMode);
    this.points.visible = baseFieldVisible;
    if (this.outgoing) this.outgoing.visible = baseFieldVisible;
    this.packingDensityTarget = Math.max(0, Math.min(1, frame.params.density ?? 0.2));
    this.packingTurbulenceTarget = Math.max(0, Math.min(1, frame.params.turbulence ?? 0.1));
    this.packingTensionTarget = Math.max(0, Math.min(1, frame.params.tension ?? 0.1));
    if (this.impulseMode === 1) frame.noteAttacks.forEach((note) => this.spawnNoteParticle(note));
    if (this.impulseMode === 2) frame.noteAttacks.forEach((note) => this.spawnAccumulationParticle(note));
    if (this.impulseMode === 3) frame.noteAttacks.forEach((note) => this.spawnPackingBlock(note));
    if (this.impulseMode === 5) frame.noteAttacks.forEach((note) => this.spawnPackingPolygon(note));
    if ((this.impulseMode === 3 || this.impulseMode === 5) && frame.wideChord) this.togglePackingGravity();
    if (this.impulseMode === 4) frame.noteAttacks.forEach((note) => this.applyVoronoiImpulse(note));
    const packingVisible = this.impulseMode === 3 || this.impulseMode === 5;
    this.blockFrame.visible = packingVisible;
    this.packingGroup.visible = packingVisible;
    this.voronoiMesh.visible = this.impulseMode === 4;
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
      this.resetFrameTimingWindow();
      this.packingIrradiance.value = this.amitabhaField.texture;
      this.renderer.compile(this.scene, this.camera);
      this.resize();
      this.restorePending = false;
    }

    this.flash = Math.max(0, this.flash - dt * 3.4);
    this.pulse = Math.max(0, this.pulse - dt * 2.8);
    this.updateNoteParticles(dt);
    this.updateAccumulationParticles(dt);
    this.updatePackingBlocks(dt, elapsed);
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
    this.polygonGeometries.forEach((geometry) => geometry.dispose());
    this.blockMaterial.dispose();
    this.polygonMaterial.dispose();
    this.amitabhaDisplay.geometry.dispose();
    this.amitabhaField.dispose();
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
      hrcResolution: this.amitabhaField.stats.resolution,
      hrcUpdateHz: this.amitabhaField.stats.updateHz,
      hrcFrustumsPerFrame: this.amitabhaField.stats.frustumsPerFrame,
      hrcTargetMemoryBytes: this.amitabhaField.stats.targetMemoryBytes,
      hrcDrawCalls: this.amitabhaField.stats.drawCalls,
    };
  }

  setQuality(quality: RendererStatus['quality']): void {
    if (this.quality === quality) return;
    this.quality = quality;
    this.applyQuality();
    this.hrcQuality = quality;
    this.resetFrameTimingWindow();
    this.amitabhaField.setQuality(quality);
    this.resize();
  }

  resetPackingBlocks(): void {
    this.clearPackingBlocks();
  }

  private configurePackingMaterial(material: THREE.MeshBasicMaterial, morphPolygon: boolean): void {
    material.onBeforeCompile = (shader) => {
      shader.uniforms.uPackingIrradiance = this.packingIrradiance;
      shader.uniforms.uPackingWorldBounds = { value: AMITABHA_WORLD_BOUNDS.clone() };
      if (morphPolygon) shader.uniforms.uMorphTime = this.polygonMorphTime;

      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
          attribute vec4 aEmission;
          varying vec2 vPackingPosition;
          varying vec4 vPackingEmission;
          ${morphPolygon
            ? `attribute float aMorphSeed;
          attribute float aMorphAmount;
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
          #ifdef USE_INSTANCING
            vec4 packingPosition = instanceMatrix * vec4(transformed, 1.0);
          #else
            vec4 packingPosition = vec4(transformed, 1.0);
          #endif
          vPackingPosition = packingPosition.xy;
          #include <project_vertex>`,
        );

      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
          varying vec2 vPackingPosition;
          varying vec4 vPackingEmission;
          uniform sampler2D uPackingIrradiance;
          uniform vec4 uPackingWorldBounds;

          vec3 applyAmitabhaLighting(vec3 baseColour) {
            if (vPackingEmission.a > 0.001) {
              return vPackingEmission.rgb * (0.92 + vPackingEmission.a * 0.34);
            }
            vec2 fieldUv = (vPackingPosition - uPackingWorldBounds.xy)
              / (uPackingWorldBounds.zw - uPackingWorldBounds.xy);
            vec3 irradiance = texture2D(
              uPackingIrradiance,
              clamp(fieldUv, vec2(0.001), vec2(0.999))
            ).rgb;
            return baseColour * (vec3(0.1) + irradiance * 1.08)
              + irradiance * 0.06;
          }`,
        )
        .replace(
          'vec3 outgoingLight = reflectedLight.indirectDiffuse;',
          `vec3 outgoingLight = reflectedLight.indirectDiffuse;
          outgoingLight = applyAmitabhaLighting(outgoingLight);`,
        );
    };
    material.customProgramCacheKey = () => morphPolygon
      ? 'piano-amitabha-polygons-v5-diffuse'
      : 'piano-amitabha-blocks-v5-diffuse';
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

  private spawnPackingBlock(note: DetectedNote): void {
    this.lastPackingMidi = note.midi;
    this.packingReceivedNoteSinceTurn = true;
    if (this.packingBlocks.length >= MAX_PACKING_BLOCKS) return;
    this.blockSequence += 1;
    const seed = note.midi * 17.17 + note.strength * 31.7 + this.blockSequence * 7.31;
    const pitch = Math.max(0, Math.min(1, (note.midi - 21) / 87));
    const strength = Math.max(0, Math.min(1, note.strength));
    const width = Math.max(0.3, Math.min(1.38, 1.25 - pitch * 0.8 + (pseudoRandom(seed) - 0.5) * 0.26));
    const height = Math.max(0.18, Math.min(0.92, 0.22 + pitch * 0.56 + (pseudoRandom(seed + 19.4) - 0.5) * 0.2));
    const light = this.packingEmitter(seed, strength);
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
    const block: PackingBlock = {
      kind: 'block',
      note,
      body,
      width,
      height,
      color: 0x85858d,
      sides: 4,
      morphScale: 1,
      morphAspect: 1,
      morphPhase: 0,
      morphSeed: pseudoRandom(seed + 118.2),
      emissive: light.emissive,
      emissionRed: light.red,
      emissionGreen: light.green,
      emissionBlue: light.blue,
      emissionStrength: light.strength,
      transportOrder: this.blockSequence,
    };
    body.createFixture(Box(width / 2, height / 2), { density: 1, friction: 0.56, restitution: 0.1 });
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
      width,
      height,
      color: 0x85858d,
      sides,
      morphScale: 1,
      morphAspect: 1,
      morphPhase: pseudoRandom(seed + 71.3) * Math.PI * 2,
      morphSeed: pseudoRandom(seed + 118.2),
      emissive: light.emissive,
      emissionRed: light.red,
      emissionGreen: light.green,
      emissionBlue: light.blue,
      emissionStrength: light.strength,
      transportOrder: this.blockSequence,
    };
    body.createFixture(Polygon(vertices), {
      density: 0.8 + strength * 0.8 + density * 0.65,
      friction: 0.42 + (1 - turbulence) * 0.28,
      restitution: 0.08 + turbulence * 0.2,
    });
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
    if (this.impulseMode !== 3 && this.impulseMode !== 5) return;
    const frameDt = Math.min(dt, 0.1);
    this.polygonMorphTime.value = elapsed;
    this.packingDensity = damp(this.packingDensity, this.packingDensityTarget, 3.2, frameDt);
    this.packingTurbulence = damp(this.packingTurbulence, this.packingTurbulenceTarget, 2.8, frameDt);
    this.packingTension = damp(this.packingTension, this.packingTensionTarget, 3.6, frameDt);

    if (this.impulseMode === 3) {
      this.packingCycleElapsed += frameDt;
      if (!this.packingTurnActive && this.packingCycleElapsed >= PACKING_ROTATION_INTERVAL) {
        this.beginPackingTurn();
      }
    } else {
      this.packingCycleElapsed = 0;
    }

    if (this.packingTurnActive) {
      this.packingTurnElapsed += frameDt;
      const progress = Math.min(1, this.packingTurnElapsed / PACKING_ROTATION_DURATION);
      const eased = progress * progress * (3 - 2 * progress);
      this.packingCameraRotation = this.packingTurnStartRotation + this.packingTurnAngle * eased;
      this.camera.rotation.z = this.packingCameraRotation;
      if (progress >= 1) this.commitPackingTurn();
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
    this.updateAmitabhaField(elapsed);
    let blockInstance = 0;
    const polygonCounts = [0, 0, 0, 0, 0, 0];
    for (let index = 0; index < this.packingBlocks.length; index += 1) {
      const block = this.packingBlocks[index];
      const position = block.body.getPosition();
      this.blockPosition.set(position.x, position.y, 0);
      this.blockQuaternion.setFromAxisAngle(this.blockRotationAxis, block.body.getAngle());
      if (block.kind === 'block') {
        this.blockMatrix.compose(this.blockPosition, this.blockQuaternion, this.blockScale.set(block.width, block.height, 1));
        this.blockMesh.setMatrixAt(blockInstance, this.blockMatrix);
        this.blockMesh.setColorAt(blockInstance, this.blockColor.setHex(block.color));
        this.blockEmissionData[blockInstance * 4] = block.emissionRed;
        this.blockEmissionData[blockInstance * 4 + 1] = block.emissionGreen;
        this.blockEmissionData[blockInstance * 4 + 2] = block.emissionBlue;
        this.blockEmissionData[blockInstance * 4 + 3] = block.emissionStrength;
        blockInstance += 1;
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
        polygonCounts[meshIndex] += 1;
      }
    }
    this.blockMesh.count = blockInstance;
    this.blockMesh.instanceMatrix.needsUpdate = true;
    if (this.blockMesh.instanceColor) this.blockMesh.instanceColor.needsUpdate = true;
    this.blockGeometry.getAttribute('aEmission').needsUpdate = true;
    this.blockMesh.visible = blockInstance > 0;
    this.polygonMeshes.forEach((mesh, index) => {
      mesh.count = polygonCounts[index];
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      this.polygonGeometries[index].getAttribute('aMorphSeed').needsUpdate = true;
      this.polygonGeometries[index].getAttribute('aMorphAmount').needsUpdate = true;
      this.polygonGeometries[index].getAttribute('aEmission').needsUpdate = true;
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

  private updateAmitabhaField(elapsed: number): void {
    const bodies: AmitabhaBody[] = this.packingBlocks.map((block) => {
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
      return {
        x: position.x,
        y: position.y,
        halfWidth: morphWidth * 0.5,
        halfHeight: morphHeight * 0.5,
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
        sides: block.kind === 'polygon' ? block.sides : undefined,
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
    this.polygonMeshes.forEach((mesh) => {
      mesh.count = 0;
      mesh.visible = false;
    });
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

  private togglePackingGravity(): void {
    this.packingGravityEnabled = !this.packingGravityEnabled;
    this.packingWorld.setGravity(Vec2(0, this.packingGravityEnabled ? -14 : 0));
    this.blockFrameMaterial.opacity = this.packingGravityEnabled ? 0.55 : 0.18;
    this.packingBlocks.forEach((block, index) => {
      block.body.setAwake(true);
      if (!this.packingGravityEnabled) this.launchPackingBodyTowardCenter(block, index);
    });
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
    this.packingCycleElapsed -= PACKING_ROTATION_INTERVAL;
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
    const centerX = (AMITABHA_WORLD_BOUNDS.x + AMITABHA_WORLD_BOUNDS.z) * 0.5;
    const centerY = (AMITABHA_WORLD_BOUNDS.y + AMITABHA_WORLD_BOUNDS.w) * 0.5;
    const cosine = Math.cos(roll);
    const sine = Math.sin(roll);
    this.amitabhaDisplay.rotation.z = roll;
    this.amitabhaDisplay.position.set(
      cosine * centerX - sine * centerY,
      sine * centerX + cosine * centerY,
      -0.22,
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
    return kind === 'block' || kind === 'polygon'
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
    if (this.impulseMode === 4) return;
    if (event.type === 'estalla' || event.type === 'climax' || event.target === 'explosion' || event.target === 'finale') {
      const intensity = 'intensity' in event && typeof event.intensity === 'number' ? event.intensity : 1;
      this.flash = Math.max(this.flash, intensity);
      this.pulse = Math.max(this.pulse, 0.75);
    }
    if (event.type === 'pulso') this.pulse = Math.max(this.pulse, 0.7);
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
    this.renderer.setPixelRatio(this.quality === 'safe' ? 0.65 : 1);
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
    if (this.impulseMode !== 3 && this.impulseMode !== 5) return;
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

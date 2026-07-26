import './style.css';
import { LiveAudioAnalyzer } from './audio/analyzer';
import { PolyphonicNoteTranscriber } from './audio/polyphonic-transcriber';
import { WideChordSwitchDetector } from './audio/wide-chord-switch';
import { ControlBus, type ControlAction } from './control/bus';
import { DirectorPanel } from './control/panel';
import { SceneMachine } from './control/scene-machine';
import { loadShowConfig, parseShowConfig, saveShowConfig } from './control/show-config';
import { GestureEngine } from './gestures/engine';
import { createCatalog } from './gestures/catalog';
import type { AudioStatus, DetectedNote, ImpulseMode, RendererStatus, SystemStatus, TranscriberStatus } from './types';

type RendererInstance = import('./visual/renderer').ReactiveVisualRenderer;

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) throw new Error('No se encontró el punto de montaje de la aplicación.');

const panelOnly = new URLSearchParams(window.location.search).get('mode') === 'panel';
const bus = new ControlBus(panelOnly ? 'panel' : 'visual');

if (panelOnly) {
  app.innerHTML = '<aside id="director-panel"></aside>';
  const panel = new DirectorPanel(document.querySelector<HTMLElement>('#director-panel')!, bus, true);
  window.addEventListener('beforeunload', () => { panel.destroy(); bus.dispose(); });
} else {
  const { ReactiveVisualRenderer } = await import('./visual/renderer');
  const loadedConfig = loadShowConfig(localStorage);
  app.innerHTML = `
    <main class="stage"><canvas id="visual-canvas" aria-label="Visual reactivo del piano"></canvas><div class="stage-label">PIANO / UMBRAL</div></main>
    <aside id="director-panel"></aside>
  `;
  const canvas = document.querySelector<HTMLCanvasElement>('#visual-canvas')!;
  const stage = document.querySelector<HTMLElement>('.stage')!;
  const stageLabel = document.querySelector<HTMLElement>('.stage-label')!;
  let notice: string | null = loadedConfig.warning
    ?? (loadedConfig.migrated ? 'Se migró el preset local al formato actual.' : null)
    ?? (!window.isSecureContext ? 'El micrófono requiere localhost o HTTPS; este origen no es seguro.' : null);
  let connectionNotice: string | null = null;
  let renderer: RendererInstance | null = null;
  let transportSample: HTMLOutputElement | null = null;
  let rendererStatus: RendererStatus = {
    state: 'lost', quality: 'high', pixelRatio: 0, width: 0, height: 0,
    drawCalls: 0, geometries: 0, textures: 0, contextLosses: 0,
    fpsAverage: 0, frameTimeP95Ms: 0, tabVisible: document.visibilityState === 'visible',
    voronoiCells: 5, packingGravityEnabled: true, packingTransparentCount: 0,
    packingMirrorCount: 0, packingGlassCount: 0,
    hrcResolution: 512, hrcUpdateHz: 0, hrcFrustumsPerFrame: 2, hrcTargetMemoryBytes: 0, hrcDrawCalls: 0,
    opticalSupported: false, opticalAllocated: false, opticalActive: false,
    opticalTier: 5, opticalResolution: 0, opticalDirectionsPerPixel: 0,
    opticalMaxStepsPerSegment: 0, opticalUpdateEveryHrcCycles: 0,
    opticalMaterials: 'off', opticalUpdateHz: 0, opticalTargetMemoryBytes: 0,
    opticalTargetTextureCount: 0, opticalDrawCalls: 0, opticalFallbackRatio: 0,
  };
  try {
    const searchParams = new URLSearchParams(window.location.search);
    renderer = new ReactiveVisualRenderer(
      canvas,
      'high',
      searchParams.has('transportTelemetry'),
    );
    rendererStatus = renderer.getStatus();
    if (searchParams.has('opticalTest')) {
      (
        window as Window & {
          __PIANO_OPTICAL_TEST__?: {
            readEnergy: () => ReturnType<RendererInstance['readOpticalEnergyProbeForTest']>;
            readMetrics: () => ReturnType<RendererInstance['readTransportMetricsForTest']>;
            readStatus: () => ReturnType<RendererInstance['getStatus']>;
            readOpticalQuality: () => ReturnType<
              RendererInstance['readOpticalQualityForTest']
            >;
            readGpuTiming: () => ReturnType<RendererInstance['readGpuTimingForTest']>;
            resetGpuTiming: () => void;
            resetPerformanceSample: () => void;
            setFixture: (kind: 'mirror' | 'glass' | null) => void;
            setTransportFixture: (
              options: Parameters<RendererInstance['setTransportFixtureForTest']>[0],
            ) => void;
            setBounceGain: (gain: number) => void;
          };
        }
      ).__PIANO_OPTICAL_TEST__ = {
        readEnergy: () => renderer!.readOpticalEnergyProbeForTest(),
        readMetrics: () => renderer!.readTransportMetricsForTest(),
        readStatus: () => renderer!.getStatus(),
        readOpticalQuality: () => renderer!.readOpticalQualityForTest(),
        readGpuTiming: () => renderer!.readGpuTimingForTest(),
        resetGpuTiming: () => renderer!.resetGpuTimingForTest(),
        resetPerformanceSample: () =>
          renderer!.resetPerformanceSampleForTest(),
        setFixture: (kind) => renderer!.setOpticalFixtureForTest(kind),
        setTransportFixture: (options) =>
          renderer!.setTransportFixtureForTest(options),
        setBounceGain: (gain) => renderer!.setHrcBounceGainForTest(gain),
      };
      const diagnostics = document.createElement('div');
      diagnostics.dataset.transportDiagnostics = '';
      diagnostics.style.cssText = [
        'position:fixed',
        'left:12px',
        'top:12px',
        'z-index:1000',
        'display:flex',
        'gap:6px',
        'padding:6px',
        'background:#080811cc',
      ].join(';');
      diagnostics.innerHTML = `
        <button type="button" data-transport-fixture="control">DIAG DIFUSO</button>
        <button type="button" data-transport-fixture="mirror">DIAG ESPEJO</button>
        <button type="button" data-transport-fixture="glass">DIAG VIDRIO</button>
        <button type="button" data-transport-reset>MEDIR</button>
        <output data-transport-sample></output>
      `;
      diagnostics.querySelector('[data-transport-fixture="control"]')
        ?.addEventListener('click', () => renderer?.setTransportFixtureForTest({
          name: 'mirror-law',
          materialOverride: 'diffuse',
        }));
      diagnostics.querySelector('[data-transport-fixture="mirror"]')
        ?.addEventListener('click', () => renderer?.setTransportFixtureForTest({
          name: 'mirror-law',
        }));
      diagnostics.querySelector('[data-transport-fixture="glass"]')
        ?.addEventListener('click', () => renderer?.setTransportFixtureForTest({
          name: 'glass-prism',
        }));
      diagnostics.querySelector('[data-transport-reset]')
        ?.addEventListener('click', () =>
          renderer?.resetPerformanceSampleForTest());
      transportSample = diagnostics.querySelector<HTMLOutputElement>(
        '[data-transport-sample]',
      );
      stage.append(diagnostics);
    }
  } catch (error) {
    notice = error instanceof Error ? `No se pudo iniciar WebGL: ${error.message}` : 'No se pudo iniciar WebGL.';
  }
  const analyzer = new LiveAudioAnalyzer();
  const transcriber = new PolyphonicNoteTranscriber();
  const chordSwitch = new WideChordSwitchDetector();
  const engine = new GestureEngine(createCatalog());
  const sceneMachine = new SceneMachine(loadedConfig.config);
  let audioStatus: AudioStatus = { state: 'idle', running: false, sampleRate: 0, rawRms: 0, latencyMs: null, error: null, calibrated: false, calibrating: false };
  let revision = 0;
  let fps = 0;
  let lastOutputs: SystemStatus['outputs'] = {};
  let lastRender = performance.now();
  let lastFpsAt = lastRender;
  let renderedFrames = 0;
  let lastStatusAt = 0;
  let lowFpsSince: number | null = null;
  let tabWasHidden = false;
  let rendererResourceBaseline: { geometries: number; textures: number } | null = null;
  let impulseMode: ImpulseMode = 1;
  let detectedNoteCount = 0;
  let detectedNotes: string[] = [];
  let detectedNotesUntil = 0;
  let nativeNoteCount = 0;
  let modelNoteCount = 0;
  let audioChunkCount = 0;
  let pendingTestNotes: DetectedNote[] = [];
  let lastImpulseAt = -Infinity;
  let transcriberStatus: TranscriberStatus = 'loading';
  let transcriberError: string | null = null;
  const unsubscribeSamples = analyzer.subscribeSamples((samples, sampleRate) => {
    audioChunkCount += 1;
    transcriber.push(samples, sampleRate);
  });

  function activateScene(id: number): void {
    const changed = sceneMachine.scene.id !== id;
    const scene = sceneMachine.setScene(id);
    engine.setActive(scene.gestosActivos);
    if (changed) engine.clearFrozen();
    Object.entries(scene.presets).forEach(([gestureId, params]) => engine.setParams(gestureId, params));
    engine.reset(scene.gestosActivos);
    stageLabel.textContent = `PIANO / ${scene.nombre.toUpperCase()}`;
    revision += 1;
  }

  function status(): SystemStatus {
    return {
      audio: audioStatus,
      fps,
      activeScene: sceneMachine.scene.id,
      outputs: lastOutputs,
      gestureParams: engine.snapshotParams(),
      frozenGestures: engine.getFrozenIds(),
      impulseMode,
      detectedNoteCount,
      detectedNotes,
      nativeNoteCount,
      modelNoteCount,
      audioChunkCount,
      transcriberTelemetry: transcriber.getTelemetry(),
      transcriber: { state: transcriberStatus, error: transcriberError },
      blackout: sceneMachine.isBlackout(),
      overrides: sceneMachine.getOverrides(),
      config: sceneMachine.showConfig,
      revision: revision + sceneMachine.getRevision(),
      notice: connectionNotice ?? notice,
      renderer: rendererStatus,
    };
  }

  async function handleAction(action: ControlAction): Promise<void> {
    try {
      if (action.type === 'scene') activateScene(action.id);
      if (action.type === 'force-event') sceneMachine.forceEvent(action.event);
      if (action.type === 'freeze') { engine.setFrozen(action.gestureId, action.frozen); revision += 1; }
      if (action.type === 'gesture-param') {
        engine.setParams(action.gestureId, { [action.key]: action.value });
        sceneMachine.setGestureParams(action.gestureId, { [action.key]: action.value });
        revision += 1;
      }
      if (action.type === 'override') { sceneMachine.setOverride(action.target, action.value); revision += 1; }
      if (action.type === 'wire-target') { sceneMachine.setWire(action.index, { target: action.target }); revision += 1; }
      if (action.type === 'blackout') { sceneMachine.setBlackout(action.value); revision += 1; }
      if (action.type === 'impulse-mode') {
        impulseMode = action.mode;
        chordSwitch.reset();
        stage.classList.toggle('voronoi-active', action.mode === 4);
        stage.classList.toggle('hrc-active', action.mode === 3 || action.mode === 5);
        lastImpulseAt = -Infinity;
        detectedNoteCount = 0;
        detectedNotes = [];
        notice = action.mode === 1
          ? 'Impulso 01 activo: un ataque, una partícula blanca de 3 s.'
          : action.mode === 2
            ? 'Impulso 02 activo: las partículas nacen abajo y se acumulan hacia arriba.'
            : action.mode === 3
              ? 'Impulso 03 activo: HRC con transparencia y espejos direccionales de un rebote.'
              : action.mode === 4
                ? 'Impulso 04 activo: agudas suman celdas Voronoi; graves las restan.'
                : action.mode === 5
                  ? 'Impulso 05 activo: polígonos HRC con espejo, vidrio refractivo y caústicas 2D.'
                  : `Impulso ${String(action.mode).padStart(2, '0')} todavía no está implementado.`;
        revision += 1;
      }
      if (action.type === 'test-note') {
        pendingTestNotes = [action.midi ?? 60].map((midi) => ({
          midi,
          frequency: 440 * 2 ** ((midi - 69) / 12),
          strength: 0.85,
        }));
        // This action is consumed by the next animation frame. Publish its
        // pitch now as well, so a remote control panel never waits on shader
        // compilation before confirming the requested test note.
        detectedNotes = [noteName(pendingTestNotes[0])];
        detectedNotesUntil = performance.now() + 850;
        notice = `Prueba visual: un impulso ${noteName(pendingTestNotes[0])} emitido.`;
        revision += 1;
      }
      if (action.type === 'test-chord') {
        pendingTestNotes = [48, 55, 60, 64].map((midi) => ({
          midi,
          frequency: 440 * 2 ** ((midi - 69) / 12),
          strength: 0.85,
        }));
        notice = 'Prueba visual: acorde amplio emitido; alterna la gravedad de los modos 03 y 05.';
        revision += 1;
      }
      if (action.type === 'reset-packing') {
        pendingTestNotes = [];
        renderer?.resetPackingBlocks();
        detectedNoteCount = 0;
        detectedNotes = [];
        notice = 'Cajas reiniciadas.';
        revision += 1;
      }
      if (action.type === 'recalibrate') analyzer.recalibrate();
      if (action.type === 'start-audio') {
        try { await analyzer.start(); } catch { /* Error is exposed through the status panel. */ }
      }
      if (action.type === 'save-config') {
        saveShowConfig(localStorage, sceneMachine.showConfig);
        notice = 'Configuración guardada en este navegador.';
        revision += 1;
      }
      if (action.type === 'render-quality') {
        renderer?.setQuality(action.quality);
        rendererStatus = renderer?.getStatus() ?? { ...rendererStatus, quality: action.quality };
        notice = action.quality === 'safe'
          ? 'Modo seguro activo: menor resolución y menos partículas.'
          : 'Modo alto activo.';
        revision += 1;
      }
      if (action.type === 'replace-config') {
        const scene = sceneMachine.replaceConfig(parseShowConfig(action.config));
        engine.setActive(scene.gestosActivos);
        engine.clearFrozen();
        Object.entries(scene.presets).forEach(([gestureId, params]) => engine.setParams(gestureId, params));
        engine.reset(scene.gestosActivos);
        stageLabel.textContent = `PIANO / ${scene.nombre.toUpperCase()}`;
        saveShowConfig(localStorage, sceneMachine.showConfig);
        notice = 'Preset importado y guardado.';
        revision += 1;
      }
    } catch (error) {
      notice = error instanceof Error ? error.message : 'No se pudo aplicar el control solicitado.';
      revision += 1;
    }
    bus.publishSnapshot(status());
  }

  analyzer.subscribe((nextStatus) => {
    const stateChanged = audioStatus.state !== nextStatus.state
      || audioStatus.running !== nextStatus.running
      || audioStatus.calibrated !== nextStatus.calibrated
      || audioStatus.calibrating !== nextStatus.calibrating
      || audioStatus.error !== nextStatus.error;
    audioStatus = nextStatus;
    if (stateChanged) revision += 1;
  });
  transcriber.subscribeStatus((state, error) => {
    transcriberStatus = state;
    transcriberError = error;
    if (state === 'ready') notice = 'Detector polifónico listo: partículas por nota individual.';
    if (state === 'error') notice = `Detector polifónico no disponible: ${error ?? 'error desconocido.'}`;
    revision += 1;
  });
  bus.onAction((action) => { void handleAction(action); });
  bus.onStatusRequest(() => bus.publishSnapshot(status()));
  bus.onVisualConnection((connection) => {
    connectionNotice = connection.state === 'multiple'
      ? 'Hay dos vistas visuales abiertas. Solo una es autoritativa; cerrá la duplicada.'
      : null;
    revision += 1;
  });
  const onVisibilityChange = (): void => {
    if (document.visibilityState === 'hidden') {
      tabWasHidden = true;
      return;
    }
    if (tabWasHidden) {
      tabWasHidden = false;
      notice = 'La vista visual estuvo oculta; verificá FPS y WebGL antes de continuar.';
      revision += 1;
    }
  };
  document.addEventListener('visibilitychange', onVisibilityChange);
  const panel = new DirectorPanel(document.querySelector<HTMLElement>('#director-panel')!, bus, false);
  activateScene(1);

  const loop = (now: number): void => {
    const dt = Math.min(0.1, Math.max(0.001, (now - lastRender) / 1000));
    lastRender = now;
    const audioFrames = analyzer.takeFrames();
    const noteAttacks: DetectedNote[] = [];
    let wideChord = false;
    if (impulseMode === 1 || impulseMode === 2 || impulseMode === 3 || impulseMode === 4 || impulseMode === 5) {
      const testAttacks = pendingTestNotes;
      pendingTestNotes = [];
      const modelAttacks = transcriber.takeNotes();
      const nativeAttacks = audioFrames.flatMap((frame) => frame.noteAttacks);
      wideChord = (impulseMode === 3 || impulseMode === 5)
        && chordSwitch.push([...testAttacks, ...nativeAttacks, ...modelAttacks], now / 1000);
      modelNoteCount += modelAttacks.length;
      nativeNoteCount += nativeAttacks.length;
      // A piano tone has several harmonics. For impulse effects, those are one
      // musical attack, so only the strongest native candidate gets one mark.
      const attack = testAttacks[0] ?? strongestAttack(nativeAttacks);
      if (attack && (testAttacks.length > 0 || now - lastImpulseAt >= 90)) {
        lastImpulseAt = now;
        noteAttacks.push(attack);
      }
      if (noteAttacks.length) {
        detectedNoteCount += noteAttacks.length;
        detectedNotes = [...new Set(noteAttacks.map(noteName))].slice(0, 8);
        detectedNotesUntil = now + 850;
      } else if (now > detectedNotesUntil) detectedNotes = [];
    }
    lastOutputs = engine.update(audioFrames, dt);
    if (renderer) {
      const visualFrame = sceneMachine.compose(lastOutputs, now / 1000);
      visualFrame.impulseMode = impulseMode;
      visualFrame.noteAttacks = noteAttacks;
      visualFrame.wideChord = wideChord;
      renderer.apply(visualFrame);
      renderer.render(dt, now / 1000);
      const nextRendererStatus = renderer.getStatus();
      if (wideChord) {
        notice = nextRendererStatus.packingGravityEnabled
          ? 'Acorde amplio detectado: gravedad activada.'
          : 'Acorde amplio detectado: gravedad suspendida.';
        revision += 1;
      }
      if (rendererStatus.state !== nextRendererStatus.state) {
        notice = nextRendererStatus.state === 'lost'
          ? 'Se perdió WebGL. El panel sigue operativo; esperá la recuperación o recargá la vista visual.'
          : 'WebGL se recuperó y recompiló los recursos visuales.';
        revision += 1;
      }
      rendererStatus = nextRendererStatus;
      if (transportSample) {
        transportSample.textContent = JSON.stringify({
          fps: rendererStatus.fpsAverage,
          p95: rendererStatus.frameTimeP95Ms,
          quality: rendererStatus.quality,
          hrcResolution: rendererStatus.hrcResolution,
          hrcFrustums: rendererStatus.hrcFrustumsPerFrame,
          opticalActive: rendererStatus.opticalActive,
          opticalTier: rendererStatus.opticalTier,
          opticalDrawCalls: rendererStatus.opticalDrawCalls,
          opticalTextures: rendererStatus.opticalTargetTextureCount,
          opticalBytes: rendererStatus.opticalTargetMemoryBytes,
        });
      }
      if (rendererStatus.state === 'lost') {
        rendererResourceBaseline = null;
      } else if (!rendererResourceBaseline) {
        rendererResourceBaseline = { geometries: rendererStatus.geometries, textures: rendererStatus.textures };
      } else if (
        rendererStatus.geometries > rendererResourceBaseline.geometries + 1
        || rendererStatus.textures
          > rendererResourceBaseline.textures
            + 1
            + rendererStatus.opticalTargetTextureCount
      ) {
        if (notice === null) {
          notice = 'Los recursos WebGL crecieron tras cambios de escena; usá Modo seguro y recargá entre piezas.';
          revision += 1;
        }
      }
      if (!rendererStatus.tabVisible) {
        lowFpsSince = null;
      } else if (rendererStatus.fpsAverage > 0 && rendererStatus.fpsAverage < 110) {
        lowFpsSince ??= now;
        if (now - lowFpsSince >= 2000 && notice === null) {
          notice = 'Render por debajo de 110 FPS. Verificá que la visual esté visible y usá Modo seguro si hace falta.';
          revision += 1;
        }
      } else {
        lowFpsSince = null;
      }
    }
    renderedFrames += 1;
    if (now - lastFpsAt >= 500) {
      fps = renderedFrames * 1000 / (now - lastFpsAt);
      renderedFrames = 0;
      lastFpsAt = now;
    }
    if (now - lastStatusAt >= 125) {
      bus.publishTelemetry(status());
      lastStatusAt = now;
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  window.addEventListener('beforeunload', () => {
    document.removeEventListener('visibilitychange', onVisibilityChange);
    panel.destroy();
    unsubscribeSamples();
    transcriber.dispose();
    analyzer.stop();
    renderer?.dispose();
    bus.dispose();
  });
}

const pitchClassNames = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

function noteName(note: DetectedNote): string {
  return `${pitchClassNames[note.midi % 12]}${Math.floor(note.midi / 12) - 1}`;
}

function strongestAttack(notes: readonly DetectedNote[]): DetectedNote | null {
  return notes.reduce<DetectedNote | null>((strongest, note) => !strongest || note.strength > strongest.strength ? note : strongest, null);
}

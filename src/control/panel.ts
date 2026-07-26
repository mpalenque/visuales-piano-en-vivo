import type { GestureOutput, ImpulseMode, SystemStatus } from '../types';
import { createDefaultShowConfig, getGestureParamDefinition, parseShowConfig, type GestureId, type GestureParamKey, visualEventTargets, visualParameterTargets } from './show-config';
import type { ControlAction, ControlBus } from './bus';
import type { VisualConnection } from './protocol';

const number = (value: number, decimals = 2): string => Number.isFinite(value) ? value.toFixed(decimals) : '—';
const escapeHtml = (value: string): string => value.replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character] ?? character);
const impulseModes: readonly ImpulseMode[] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const pitchClassNames = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const noteLabel = (midi: number): string => `${pitchClassNames[midi % 12]}${Math.floor(midi / 12) - 1}`;

const initialStatus: SystemStatus = {
  audio: { state: 'idle', running: false, sampleRate: 0, rawRms: 0, latencyMs: null, error: null, calibrated: false, calibrating: false },
  fps: 0,
  activeScene: 1,
  outputs: {},
  gestureParams: {},
  frozenGestures: [],
  impulseMode: 1,
  detectedNoteCount: 0,
  detectedNotes: [],
  nativeNoteCount: 0,
  modelNoteCount: 0,
  audioChunkCount: 0,
  transcriberTelemetry: { inputChunks: 0, receivedSamples: 0, windows: 0, emittedNotes: 0, peakOnset: 0, peakFrame: 0 },
  transcriber: { state: 'loading', error: null },
  blackout: false,
  overrides: {},
  config: createDefaultShowConfig(),
  revision: 0,
  notice: null,
  renderer: {
    state: 'ready', quality: 'high', pixelRatio: 1, width: 0, height: 0,
    drawCalls: 0, geometries: 0, textures: 0, contextLosses: 0,
    fpsAverage: 0, frameTimeP95Ms: 0, tabVisible: true,
    voronoiCells: 5, packingGravityEnabled: true, packingTransparentCount: 0,
    packingMirrorCount: 0, packingGlassCount: 0,
    hrcResolution: 512, hrcUpdateHz: 0, hrcFrustumsPerFrame: 2, hrcTargetMemoryBytes: 0, hrcDrawCalls: 0,
    opticalSupported: false, opticalAllocated: false, opticalActive: false,
    opticalTier: 5, opticalResolution: 0, opticalDirectionsPerPixel: 0,
    opticalMaxStepsPerSegment: 0, opticalUpdateEveryHrcCycles: 0,
    opticalMaterials: 'off', opticalUpdateHz: 0, opticalTargetMemoryBytes: 0,
    opticalTargetTextureCount: 0, opticalDrawCalls: 0, opticalFallbackRatio: 0,
  },
};

export class DirectorPanel {
  private status: SystemStatus = initialStatus;
  private visible = true;
  private testNotePreview: string | null = null;
  private readonly unsubscribeStatus: () => void;
  private readonly unsubscribeConnection: () => void;
  private connection: VisualConnection;

  constructor(private readonly root: HTMLElement, private readonly bus: ControlBus, private readonly panelOnly: boolean) {
    this.unsubscribeStatus = this.bus.onStatus((status) => {
      const needsRender = status.revision !== this.status.revision || status.activeScene !== this.status.activeScene;
      this.status = status;
      if (status.detectedNotes.length > 0) this.testNotePreview = null;
      if (needsRender) this.render();
      else this.updateLiveStatus();
    });
    this.connection = { hostCount: panelOnly ? 0 : 1, authorityId: null, state: panelOnly ? 'disconnected' : 'connected' };
    this.unsubscribeConnection = this.bus.onVisualConnection((connection) => {
      this.connection = connection;
      this.render();
    });
    this.bus.requestStatus();
    this.render();
    window.addEventListener('keydown', this.onKeydown);
  }

  destroy(): void {
    this.unsubscribeStatus();
    this.unsubscribeConnection();
    window.removeEventListener('keydown', this.onKeydown);
  }

  private get scene() {
    return this.status.config.scenes.find((scene) => scene.id === this.status.activeScene) ?? this.status.config.scenes[0];
  }

  private render(): void {
    const scene = this.scene;
    const audio = this.status.audio;
    const audioControl = this.panelOnly
      ? '<button class="primary" data-action="audio" disabled title="El permiso del micrófono debe iniciarse en la vista visual.">Micrófono en vista visual</button>'
      : `<button class="primary" data-action="audio" ${audio.running || audio.state === 'requesting-permission' || audio.state === 'starting' ? 'disabled' : ''}>${audio.running ? 'Micrófono activo' : audio.state === 'requesting-permission' || audio.state === 'starting' ? 'Abriendo micrófono…' : 'Iniciar micrófono'}</button>`;
    this.root.className = `${this.panelOnly ? 'panel-only' : 'director-panel'} ${this.visible ? '' : 'is-hidden'}`;
    this.root.innerHTML = `
      <header class="panel-header">
        <div><p class="eyebrow">PIANO / VISUAL ENGINE</p><h1>Dirección en vivo</h1></div>
        <div class="header-actions">
          ${this.panelOnly ? '' : '<button class="icon-button" data-action="hide" title="Ocultar panel (P)">⌘</button>'}
          <button class="panic ${this.status.blackout ? 'active' : ''}" data-action="blackout">${this.status.blackout ? 'RESTAURAR' : 'BLACKOUT'}</button>
        </div>
      </header>
      <section class="system-status">
        <div class="status-card ${audio.running ? 'ok' : ''}" data-status-card="mic"><span>MIC</span><strong data-status="mic">${audio.running ? 'ACTIVO' : audio.state === 'requesting-permission' || audio.state === 'starting' ? 'ABRIENDO' : 'EN ESPERA'}</strong><small data-status="mic-detail">${audio.sampleRate ? `${audio.sampleRate} Hz` : 'Autoriza para iniciar'}</small></div>
        <div class="status-card"><span>LATENCIA</span><strong data-status="latency">${audio.latencyMs === null ? '—' : `${number(audio.latencyMs, 0)} ms`}</strong><small>worklet → panel</small></div>
        <div class="status-card ${this.status.fps >= 110 ? 'ok' : ''}" data-status-card="fps"><span>RENDER</span><strong data-status="fps">${number(this.status.fps, 0)} FPS</strong><small data-status="fps-detail">p95 ${number(this.status.renderer.frameTimeP95Ms, 1)} ms · objetivo 120</small></div>
        <div class="status-card ${audio.calibrated ? 'ok' : ''}" data-status-card="input"><span>ENTRADA</span><strong data-status="input">${number(audio.rawRms, 3)}</strong><small data-status="input-detail">${audio.calibrated ? 'calibrada' : audio.calibrating ? 'calibrando…' : 'requiere calibración'}</small></div>
        <div class="status-card ${this.status.renderer.state === 'ready' ? 'ok' : ''}" data-status-card="webgl"><span>WEBGL</span><strong data-status="webgl">${this.status.renderer.state === 'ready' ? 'OK' : 'PERDIDO'}</strong><small data-status="webgl-detail">${this.rendererDetail()}</small></div>
        <div class="status-card ${this.status.transcriber.state === 'ready' ? 'ok' : ''}" data-status-card="transcriber"><span>NOTAS IA</span><strong data-status="transcriber">${this.transcriberLabel()}</strong><small data-status="transcriber-detail">${this.transcriberDetail()}</small></div>
        <div class="status-card ${this.connection.state === 'connected' ? 'ok' : this.panelOnly ? '' : 'ok'}" data-status-card="visual"><span>VISUAL</span><strong data-status="visual">${this.visualConnectionLabel()}</strong><small data-status="visual-detail">${this.visualConnectionDetail()}</small></div>
      </section>
      ${audio.error ? `<p class="error">${escapeHtml(audio.error)}</p>` : ''}
      ${this.status.notice ? `<p class="notice">${escapeHtml(this.status.notice)}</p>` : ''}
      <section>
        <div class="section-title"><h2>Escenas</h2><span>Teclas 1–6</span></div>
        <div class="scene-grid">${this.status.config.scenes.map((item) => `<button class="scene-button ${item.id === scene.id ? 'active' : ''}" data-scene="${item.id}"><b>${item.id}</b><span>${escapeHtml(item.nombre)}</span></button>`).join('')}</div>
        <p class="scene-notes">${escapeHtml(scene.notes)}</p>
      </section>
      <section class="quick-actions">
        ${audioControl}
        <button data-action="recalibrate" ${audio.running ? '' : 'disabled'}>Recalibrar · 10 s</button>
        <button data-action="quality">${this.status.renderer.quality === 'safe' ? 'Usar modo alto' : 'Modo seguro'}</button>
        <button data-event="estalla">Forzar estallido</button>
        <button data-event="climax">Forzar clímax</button>
        <button data-event="pulso">Forzar pulso</button>
      </section>
      ${this.panelOnly ? '<p class="notice mic-remote-hint" data-mic-remote-hint>Por seguridad del navegador, activá el micrófono en la vista visual (la pestaña sin <code>?mode=panel</code>).</p>' : ''}
      <section>
        <div class="section-title"><h2>Impulsos</h2><span><button class="impulse-test" data-action="test-note">Probar</button>${this.status.impulseMode === 3 || this.status.impulseMode === 5 ? ' <button class="impulse-test" data-action="test-chord">Acorde ↕ gravedad</button>' : ''} <b data-note-impulse-count>${this.status.detectedNoteCount}</b> notas</span></div>
        <div class="impulse-grid">${impulseModes.map((mode) => `<button class="impulse-button ${this.status.impulseMode === mode ? 'active' : ''} ${mode <= 5 ? '' : 'reserved'}" data-impulse="${mode}" ${mode <= 5 ? '' : 'disabled'}><b>${String(mode).padStart(2, '0')}</b><span>${mode === 1 ? 'NOTA' : mode === 2 ? 'ACUMULA' : mode === 3 ? 'BLOQUES' : mode === 4 ? 'VORONOI' : mode === 5 ? 'POLÍGONOS' : 'PRÓX.'}</span></button>`).join('')}</div>
        <p class="impulse-hint" data-impulse-hint><span data-impulse-hint-text>${this.impulseHint()}</span><br><b data-note-pitches>${this.notePitches()}</b> · <small data-note-debug>entrada 0 · rápido 0 · IA 0</small></p>
        ${this.status.impulseMode === 4 ? `<div class="voronoi-controls">
          <button data-test-midi="84">Aguda +</button>
          <button data-test-midi="48">Grave −</button>
          <span><b data-voronoi-cells>${this.status.renderer.voronoiCells}</b> celdas · órbita satelital</span>
        </div>` : ''}
        ${this.status.impulseMode === 5 ? `<div class="voronoi-controls">
          <button data-test-midi="21">Grave · 3 lados</button>
          <button data-test-midi="64">Media · 5 lados</button>
          <button data-test-midi="108">Aguda · 8 lados</button>
          <span>altura → lados · fuerza → tamaño · densidad/turbulencia → morph</span>
        </div>` : ''}
      </section>
      <section>
        <div class="section-title"><h2>Gestos activos</h2><span>Estado en tiempo real</span></div>
        <div class="gesture-stack">${scene.gestosActivos.map((id) => this.gestureCard(id, this.status.outputs[id], this.status.gestureParams[id] ?? scene.presets[id] ?? {})).join('')}</div>
      </section>
      <section>
        <div class="section-title"><h2>Mapeo de la escena</h2><span>Gesto → parámetro</span></div>
        <div class="wire-list">${scene.wires.map((wire, index) => this.wireControl(index, wire.gestureId, wire.output, wire.target, wire.min, wire.max)).join('')}</div>
      </section>
      <section>
        <div class="section-title"><h2>Override manual</h2><span>La red de seguridad</span></div>
        <div class="override-grid">${visualParameterTargets.filter((target) => target !== 'grain' && target !== 'saturation').map((target) => this.overrideControl(target, scene.baseParams[target] ?? 0)).join('')}</div>
      </section>
      <section class="persistence">
        <button data-action="save">Guardar local</button>
        <button data-action="export">Exportar JSON</button>
        <button data-action="import">Importar JSON</button>
        <input id="import-file" type="file" accept="application/json" hidden />
        ${this.panelOnly ? '<small>Panel remoto sincronizado por BroadcastChannel.</small>' : '<small>Abrí <code>?mode=panel</code> en otra ventana para operar separado.</small>'}
      </section>
    `;
    this.bind();
  }

  private gestureCard(id: string, output: GestureOutput | undefined, params: Record<string, number>): string {
    const value = output?.value ?? 0;
    const recent = output?.events.map((event) => event.type).join(' · ') ?? '';
    const frozen = this.status.frozenGestures.includes(id);
    return `<article class="gesture-card">
      <div class="gesture-heading"><strong>${escapeHtml(id.replaceAll('-', ' '))}</strong><span data-gesture-value="${escapeHtml(id)}">${number(value)}</span><button class="freeze ${frozen ? 'active' : ''}" data-freeze="${escapeHtml(id)}">${frozen ? 'Descongelar' : 'Congelar'}</button></div>
      <div class="meter"><i data-gesture-meter="${escapeHtml(id)}" style="transform:scaleX(${value})"></i></div>
      <div class="event-chip ${recent ? '' : 'empty'}" data-gesture-events="${escapeHtml(id)}">${escapeHtml(recent)}</div>
      <div class="param-grid">${Object.entries(params).map(([key, paramValue]) => this.paramControl(id as GestureId, key as GestureParamKey, paramValue)).join('')}</div>
    </article>`;
  }

  private paramControl(id: GestureId, key: GestureParamKey, value: number): string {
    const metadata = getGestureParamDefinition(id, key);
    return `<label><span>${escapeHtml(key)}</span><input type="range" min="${metadata.min}" max="${metadata.max}" step="${metadata.step}" value="${value}" data-param-gesture="${escapeHtml(id)}" data-param-key="${escapeHtml(key)}" /><output>${number(value, metadata.step < 0.01 ? 3 : 2)}</output></label>`;
  }

  private wireControl(index: number, gestureId: string, output: string, target: string, min?: number, max?: number): string {
    const targets = output === 'value' ? visualParameterTargets : visualEventTargets;
    const options = targets.map((candidate) => `<option value="${candidate}" ${candidate === target ? 'selected' : ''}>${candidate}</option>`).join('');
    return `<label class="wire"><code>${escapeHtml(gestureId)}.${escapeHtml(output)}</code><span>→</span><select data-wire="${index}" aria-label="Destino visual">${options}</select><em>${min ?? '—'}–${max ?? 'evento'}</em></label>`;
  }

  private overrideControl(target: string, fallback: number): string {
    const max = target === 'hue' ? 360 : target === 'zoom' ? 2.5 : 1;
    const value = this.status.overrides[target] ?? fallback;
    const enabled = target in this.status.overrides;
    return `<label class="override"><span>${target}</span><input type="checkbox" data-override-enabled="${target}" ${enabled ? 'checked' : ''} /><input type="range" min="0" max="${max}" step="0.01" value="${value}" data-override-value="${target}" ${enabled ? '' : 'disabled'} /></label>`;
  }

  private bind(): void {
    this.root.querySelectorAll<HTMLButtonElement>('[data-scene]').forEach((button) => button.addEventListener('click', () => this.dispatch({ type: 'scene', id: Number(button.dataset.scene) })));
    this.root.querySelectorAll<HTMLButtonElement>('[data-event]').forEach((button) => button.addEventListener('click', () => this.dispatch({ type: 'force-event', event: button.dataset.event as 'estalla' | 'climax' | 'pulso' })));
    this.root.querySelector<HTMLButtonElement>('[data-action="audio"]')?.addEventListener('click', () => this.dispatch({ type: 'start-audio' }));
    this.root.querySelector<HTMLButtonElement>('[data-action="test-note"]')?.addEventListener('click', () => this.dispatch({ type: 'test-note' }));
    this.root.querySelector<HTMLButtonElement>('[data-action="test-chord"]')?.addEventListener('click', () => this.dispatch({ type: 'test-chord' }));
    this.root.querySelectorAll<HTMLButtonElement>('[data-test-midi]').forEach((button) => button.addEventListener('click', () => {
      this.dispatch({ type: 'test-note', midi: Number(button.dataset.testMidi) });
    }));
    this.root.querySelectorAll<HTMLButtonElement>('[data-impulse]').forEach((button) => button.addEventListener('click', () => {
      this.dispatch({ type: 'impulse-mode', mode: Number(button.dataset.impulse) as ImpulseMode });
    }));
    this.root.querySelector<HTMLButtonElement>('[data-action="recalibrate"]')?.addEventListener('click', () => this.dispatch({ type: 'recalibrate' }));
    this.root.querySelector<HTMLButtonElement>('[data-action="quality"]')?.addEventListener('click', () => this.dispatch({ type: 'render-quality', quality: this.status.renderer.quality === 'safe' ? 'high' : 'safe' }));
    this.root.querySelector<HTMLButtonElement>('[data-action="blackout"]')?.addEventListener('click', () => this.dispatch({ type: 'blackout', value: !this.status.blackout }));
    this.root.querySelector<HTMLButtonElement>('[data-action="hide"]')?.addEventListener('click', () => { this.visible = false; this.render(); });
    this.root.querySelectorAll<HTMLButtonElement>('[data-freeze]').forEach((button) => button.addEventListener('click', () => {
      const id = button.dataset.freeze!;
      this.dispatch({ type: 'freeze', gestureId: id, frozen: !this.status.frozenGestures.includes(id) });
    }));
    this.root.querySelectorAll<HTMLInputElement>('[data-param-gesture]').forEach((input) => input.addEventListener('input', () => {
      this.dispatch({ type: 'gesture-param', gestureId: input.dataset.paramGesture!, key: input.dataset.paramKey!, value: Number(input.value) });
    }));
    this.root.querySelectorAll<HTMLSelectElement>('[data-wire]').forEach((input) => input.addEventListener('change', () => this.dispatch({ type: 'wire-target', index: Number(input.dataset.wire), target: input.value }))); 
    this.root.querySelectorAll<HTMLInputElement>('[data-override-enabled]').forEach((checkbox) => checkbox.addEventListener('change', () => {
      const target = checkbox.dataset.overrideEnabled!;
      const slider = this.root.querySelector<HTMLInputElement>(`[data-override-value="${target}"]`)!;
      this.dispatch({ type: 'override', target, value: checkbox.checked ? Number(slider.value) : null });
    }));
    this.root.querySelectorAll<HTMLInputElement>('[data-override-value]').forEach((slider) => slider.addEventListener('input', () => {
      const target = slider.dataset.overrideValue!;
      if (target in this.status.overrides) this.dispatch({ type: 'override', target, value: Number(slider.value) });
    }));
    this.root.querySelector<HTMLButtonElement>('[data-action="save"]')?.addEventListener('click', () => this.dispatch({ type: 'save-config' }));
    this.root.querySelector<HTMLButtonElement>('[data-action="export"]')?.addEventListener('click', () => this.exportJson());
    this.root.querySelector<HTMLButtonElement>('[data-action="import"]')?.addEventListener('click', () => this.root.querySelector<HTMLInputElement>('#import-file')?.click());
    this.root.querySelector<HTMLInputElement>('#import-file')?.addEventListener('change', (event) => { void this.importJson(event); });
  }

  private updateLiveStatus(): void {
    const audio = this.status.audio;
    this.setText('[data-status="mic"]', audio.running ? 'ACTIVO' : audio.state === 'requesting-permission' || audio.state === 'starting' ? 'ABRIENDO' : 'EN ESPERA');
    this.setText('[data-status="mic-detail"]', audio.sampleRate ? `${audio.sampleRate} Hz` : 'Autoriza para iniciar');
    this.setText('[data-status="latency"]', audio.latencyMs === null ? '—' : `${number(audio.latencyMs, 0)} ms`);
    this.setText('[data-status="fps"]', `${number(this.status.fps, 0)} FPS`);
    this.setText('[data-status="fps-detail"]', `p95 ${number(this.status.renderer.frameTimeP95Ms, 1)} ms · objetivo 120`);
    this.setText('[data-status="input"]', number(audio.rawRms, 3));
    this.setText('[data-status="input-detail"]', audio.calibrated ? 'calibrada' : audio.calibrating ? 'calibrando…' : 'requiere calibración');
    this.setText('[data-status="webgl"]', this.status.renderer.state === 'ready' ? 'OK' : 'PERDIDO');
    this.setText('[data-status="webgl-detail"]', this.rendererDetail());
    this.setText('[data-status="transcriber"]', this.transcriberLabel());
    this.setText('[data-status="transcriber-detail"]', this.transcriberDetail());
    this.setText('[data-transcriber-inline]', this.transcriberLabel());
    this.setText('[data-status="visual"]', this.visualConnectionLabel());
    this.setText('[data-status="visual-detail"]', this.visualConnectionDetail());
    this.setText('[data-note-impulse-count]', String(this.status.detectedNoteCount));
    this.setText('[data-note-pitches]', this.notePitches());
    this.setText('[data-impulse-hint-text]', this.impulseHint());
    this.setText('[data-voronoi-cells]', String(this.status.renderer.voronoiCells));
    this.setText('[data-note-debug]', `entrada ${this.status.audioChunkCount} · Worker ${this.status.transcriberTelemetry.inputChunks} · rápido ${this.status.nativeNoteCount} · IA ${this.status.modelNoteCount} · ventanas ${this.status.transcriberTelemetry.windows} · pico ${number(this.status.transcriberTelemetry.peakOnset, 2)}`);
    this.root.querySelector('[data-status-card="mic"]')?.classList.toggle('ok', audio.running);
    this.root.querySelector('[data-status-card="fps"]')?.classList.toggle('ok', this.status.fps >= 110);
    this.root.querySelector('[data-status-card="input"]')?.classList.toggle('ok', audio.calibrated);
    this.root.querySelector('[data-status-card="webgl"]')?.classList.toggle('ok', this.status.renderer.state === 'ready');
    this.root.querySelector('[data-status-card="transcriber"]')?.classList.toggle('ok', this.status.transcriber.state === 'ready');
    this.root.querySelector('[data-status-card="visual"]')?.classList.toggle('ok', !this.panelOnly || this.connection.state === 'connected');
    const blackout = this.root.querySelector<HTMLButtonElement>('[data-action="blackout"]');
    if (blackout) {
      blackout.textContent = this.status.blackout ? 'RESTAURAR' : 'BLACKOUT';
      blackout.classList.toggle('active', this.status.blackout);
    }
    Object.entries(this.status.outputs).forEach(([id, output]) => {
      this.setText(`[data-gesture-value="${id}"]`, number(output.value));
      const meter = this.root.querySelector<HTMLElement>(`[data-gesture-meter="${id}"]`);
      if (meter) meter.style.transform = `scaleX(${output.value})`;
      const events = this.root.querySelector<HTMLElement>(`[data-gesture-events="${id}"]`);
      if (events) {
        const text = output.events.map((event) => event.type).join(' · ');
        events.textContent = text;
        events.classList.toggle('empty', !text);
      }
    });
  }

  private setText(selector: string, value: string): void {
    const element = this.root.querySelector<HTMLElement>(selector);
    if (element) element.textContent = value;
  }

  private visualConnectionLabel(): string {
    if (!this.panelOnly) return this.connection.state === 'multiple' ? 'DUPLICADO' : 'LOCAL';
    if (this.connection.state === 'connected') return 'CONECTADO';
    if (this.connection.state === 'multiple') return 'DUPLICADO';
    return 'DESCONECTADO';
  }

  private rendererDetail(): string {
    const renderer = this.status.renderer;
    const resolution = renderer.width && renderer.height ? `${renderer.width}×${renderer.height}` : 'sin canvas';
    const hrcMemory = renderer.hrcTargetMemoryBytes / (1024 * 1024);
    const opticalMemory = renderer.opticalTargetMemoryBytes / (1024 * 1024);
    const optical = !renderer.opticalSupported
      ? 'óptica no disponible'
      : renderer.opticalActive
        ? `óptica T${renderer.opticalTier} ${renderer.opticalResolution}²/${renderer.opticalDirectionsPerPixel}D/${renderer.opticalMaxStepsPerSegment}S/${number(renderer.opticalUpdateHz, 0)} Hz/${renderer.opticalDrawCalls} calls`
        : renderer.opticalAllocated
          ? `óptica T${renderer.opticalTier} en espera`
          : 'óptica lazy';
    return `${renderer.quality} · DPR ${number(renderer.pixelRatio, 1)} · ${resolution} · HRC ${renderer.hrcResolution}²/${number(renderer.hrcUpdateHz, 0)} Hz/${renderer.hrcFrustumsPerFrame}F/${renderer.hrcDrawCalls} calls · ${number(hrcMemory, 0)} MB · ${optical}/${number(opticalMemory, 1)} MB · transparentes ${renderer.packingTransparentCount} · espejos ${renderer.packingMirrorCount} · vidrios ${renderer.packingGlassCount} · escena ${renderer.drawCalls} calls · ${renderer.geometries}G/${renderer.textures}T`;
  }

  private transcriberLabel(): string {
    if (this.status.transcriber.state === 'ready') return 'LISTA';
    if (this.status.transcriber.state === 'error') return 'ERROR';
    return 'CARGANDO';
  }

  private transcriberDetail(): string {
    if (this.status.transcriber.state === 'ready') return 'modelo polifónico · 88 teclas';
    if (this.status.transcriber.state === 'error') return this.status.transcriber.error ?? 'no disponible';
    return 'cargando modelo local…';
  }

  private impulseHint(): string {
    if (this.status.impulseMode === 2) return '02 · Cada toque nace abajo y queda acumulado, llenando hacia arriba.';
    if (this.status.impulseMode === 3) return `03 · Amitabha HRC: emisores, transparencia y hasta dos espejos direccionales. Tablero cada 6 s. Gravedad ${this.status.renderer.packingGravityEnabled ? 'ON' : 'OFF'}.`;
    if (this.status.impulseMode === 4) return '04 · Agudas suman y graves restan. Chaser espacial: cada celda revela una vista satelital distinta.';
    if (this.status.impulseMode === 5) return `05 · Morph + HRC: rebote difuso, espejo y un vidrio refractivo con caústicas 2D. Cámara focal dinámica. Gravedad ${this.status.renderer.packingGravityEnabled ? 'ON' : 'OFF'}.`;
    return '01 · Un ataque, una partícula blanca de 3 s. Se desplaza, achica y desvanece.';
  }

  private visualConnectionDetail(): string {
    if (!this.panelOnly) return this.connection.state === 'multiple' ? `${this.connection.hostCount} hosts visual` : 'host autoritativo';
    if (this.connection.state === 'connected') return 'snapshot en vivo';
    if (this.connection.state === 'multiple') return `${this.connection.hostCount} hosts; cerrá duplicados`;
    return 'esperando host visual';
  }

  private dispatch(action: ControlAction): void {
    if (action.type === 'test-note') {
      this.testNotePreview = noteLabel(action.midi ?? 60);
      this.status = {
        ...this.status,
        detectedNotes: [this.testNotePreview],
      };
      this.updateLiveStatus();
    }
    this.bus.dispatch(action);
  }

  private notePitches(): string {
    return this.status.detectedNotes.join(' · ') || this.testNotePreview || '—';
  }

  private onKeydown = (event: KeyboardEvent): void => {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement || event.target instanceof HTMLTextAreaElement) return;
    const scene = Number(event.key);
    if (scene >= 1 && scene <= 6) this.dispatch({ type: 'scene', id: scene });
    if (event.key.toLowerCase() === 'b') this.dispatch({ type: 'blackout', value: !this.status.blackout });
    if (event.key.toLowerCase() === 'r') { event.preventDefault(); this.dispatch({ type: 'reset-packing' }); }
    if (event.key === ' ') { event.preventDefault(); this.dispatch({ type: 'force-event', event: 'estalla' }); }
    if (!this.panelOnly && event.key.toLowerCase() === 'p') { this.visible = !this.visible; this.render(); }
  };

  private exportJson(): void {
    const blob = new Blob([JSON.stringify(this.status.config, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'piano-visuales-show-config-v2.json';
    link.click();
    URL.revokeObjectURL(url);
  }

  private async importJson(event: Event): Promise<void> {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file) return;
    try {
      const config = parseShowConfig(JSON.parse(await file.text()));
      this.dispatch({ type: 'replace-config', config });
    } catch (error) {
      window.alert(error instanceof Error ? error.message : 'No se pudo importar el preset.');
    }
  }

}

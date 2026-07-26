# 09 — Stack, riesgos y decisiones abiertas

## Stack propuesto

| Capa | Herramienta | Por qué | Estado |
|---|---|---|---|
| Build | **Vite** + TypeScript | Sirve worklets y WASM sin fricción; HMR rápido | Recomendado |
| Análisis | **Essentia.js** (WASM, en AudioWorklet) | Onset, chroma/HPCP, key, RMS en tiempo real | Base |
| Análisis (complemento) | **Meyda** y/o `AnalyserNode` nativo | RMS, bandas, centroid, flux livianos | Opción/plan B |
| Motor de gestos | **Reducers puros** (micro-motor propio) | Predecible en vivo, cero GC sorpresa | Recomendado (vs RxJS) |
| Render | **Three.js** sobre **WebGL** | Predecible para vivo; sobra para shaders/partículas | Base |
| Panel de control | **Vanilla + Tweakpane** | Liviano, hecho para params en tiempo real | Recomendado v1 |
| Comunicación panel↔visual | **BroadcastChannel** (2 pestañas) | Cero servidor, cero red | Recomendado para show |
| Transcripción (offline) | **basic-pitch-ts** | Solo estudio/ensayo, NO en vivo | Opcional, fuera del camino crítico |

Navegador objetivo: **Chrome** (fijar uno solo y testear solo ese).

## Decisiones implementadas (v1 actual)

| Decisión | Estado real |
|---|---|
| D1 — gestos | Micro-motor propio con estado y tests; no RxJS. |
| D2 — análisis | DSP nativo en `AudioWorklet`; Essentia queda como gate si la prueba musical falla. |
| D3 — entrada | Solo micrófono; MIDI fuera de alcance de esta v1. |
| D4 — panel | `BroadcastChannel` versionado, una autoridad visual y detección de desconexión/duplicado. |
| D5 — visuales | Un renderer Three.js, seis perfiles distinguibles y transiciones reales. |
| D6 — UI | HTML/TypeScript propio; no Tweakpane, React ni Svelte. |

---

## Registro de riesgos

| # | Riesgo | Impacto | Prob. | Mitigación | Dónde |
|---|---|---|---|---|---|
| R1 | Essentia-en-worklet más difícil de lo previsto | Alto | Media | Sub-tarea dedicada en Fase 1A + plan B por feature | `03`,`08` |
| R2 | Latencia mic→dato demasiado alta | Alto | Baja-Media | Medir primero (1B); ajustar hop; plan B nativo | `03`,`08` |
| R3 | Los gestos no "se sienten" musicales | Alto | Media | Fase 2 con la pianista antes de gráficos; tuneo en vivo | `04`,`08` |
| R4 | GC/jank de RxJS tira frames en vivo | Medio | Media (si se usa RxJS) | Usar reducers puros; o RxJS con disciplina | `01`,`04` |
| R5 | Realimentación mic/parlantes en sala | Medio | Media | Gate + calibración + posición de mic; ensayo en sala | `03`,`08` |
| R6 | Caída de framerate en escena pesada | Medio | Media | 60fps por escena; simplificar la culpable; precarga | `05`,`08` |
| R7 | Falla en vivo (mic/navegador/red) | Alto | Baja | Overrides manuales + blackout + plan de contingencia | `06`,`08` |
| R8 | Rubato rompe cualquier beat-tracking | Medio | Alta | Pulso = onset crudo, nunca beat musical | `01`,`04` |
| R9 | Basic Pitch tentando entrar al vivo | Bajo | Media | Decisión documentada: solo offline | `01`,`03` |

---

## Decisiones abiertas (esto lo elegís vos)

Marcá tu preferencia y lo bajamos al resto del plan. Mi recomendación está marcada, pero son tuyas.

**D1 — Motor de gestos: ¿reducers puros o RxJS?**
- [ ] Reducers puros (micro-motor propio) — *recomendado: más predecible en vivo, cero deps*
- [ ] RxJS — si ya lo dominás y querés su expresividad (con disciplina de GC)
- [ ] Que Claude arme un spike chico de las dos y comparás

**D2 — Análisis: ¿Essentia para todo, o híbrido?**
- [ ] Essentia para todo (onset, chroma, rms, bandas, centroid, flux)
- [ ] Híbrido: Essentia (onset + chroma) + nativo/Meyda (rms + bandas + centroid) — *recomendado si Essentia-en-worklet se complica*
- [ ] Decidir después de la Fase 1A según cómo venga el andamiaje

**D3 — MIDI: ¿100% descartado?**
- [ ] Sí, solo mic (piano acústico confirmado) — *asunción actual del plan*
- [ ] Dejar la puerta abierta: si aparece un piano/teclado con salida MIDI, sumarlo (mucho más robusto y sin latencia)
- [ ] Quiero que el plan contemple MIDI como entrada alternativa desde el diseño

**D4 — Comunicación panel↔visual**
- [ ] Empezar embebido (Opción 1) → migrar a BroadcastChannel (Opción 2) para el show — *recomendado*
- [ ] Directo a tablet vía WebSocket (Opción 3) — si querés control remoto caminando
- [ ] Solo embebido, no me importa separar panel y visual

**D5 — Las 6 escenas**
- [ ] Un motor visual, 6 variaciones por params — *más rápido y estable*
- [ ] 6 mundos visuales independientes — más rico, más trabajo
- [ ] Mezcla: algunas comparten motor, otras no

**D6 — Panel de control: stack**
- [ ] Vanilla + Tweakpane — *recomendado v1*
- [ ] HTML/Web Components custom (más control del look)
- [ ] React/Svelte (solo si el panel crece mucho)

**D7 — ¿Qué construimos primero cuando aprobés el plan?**
- [ ] Esqueleto Fase 1 (HTML + AudioWorklet + Essentia sacando features, logueando latencia)
- [ ] Diseño en código de la interfaz común de gestos (Fase 2) para ver la "biblioteca" antes del análisis
- [ ] Otra cosa (decime)

---

## Notas finales

- Este plan está escrito para que las decisiones D1–D6 se puedan cambiar **sin reescribir las otras capas**, porque los contratos de `02` desacoplan todo. Podés arrancar y cambiar de opinión.
- Todo lo que digo acá es criterio de ingeniería, no dogma. Si algo no te cierra, tachalo y lo rearmamos.

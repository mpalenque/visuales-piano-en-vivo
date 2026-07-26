# 08 — Roadmap: fases, tareas y criterios de aceptación

Ordenado **por riesgo**, no por capas. Primero se valida lo que puede hundir el proyecto (latencia, andamiaje Essentia), después se construye hacia arriba. Cada fase tiene un criterio de aceptación medible: si no se cumple, no se avanza.

Las estimaciones son órdenes de magnitud (sesiones de trabajo), no compromisos. Ajustá a tu ritmo.

> Estado de implementación (actualizado): la base automatizable está realizada:
> Vite/TypeScript, seis escenas y perfiles, AudioWorklet nativo, motor propio de
> gestos, presets v2 validados, panel autoritativo por BroadcastChannel,
> transiciones, recuperación visible de audio/WebGL, modo seguro, CI, 29
> unitarias y 3 E2E Chrome. Siguen pendientes exclusivamente los gates con
> pianista, micrófono/interfaz, proyector y sala real de la Fase 4 /
> `docs/show-validation.md`. Las referencias históricas a Essentia son una
> alternativa condicionada a esa validación, no una dependencia instalada.

---

## Fase 0 — Setup del proyecto (0.5–1 sesión)

- [ ] Repo/carpeta con la estructura de módulos de `02` (`audio/ gestures/ visual/ control/`).
- [ ] Toolchain: bundler (Vite recomendado — sirve worklets y WASM sin dolor), TypeScript, servidor local con HTTPS (el mic requiere contexto seguro).
- [ ] Página en blanco que pide permiso de micrófono y muestra "mic OK".
- [ ] Fijar navegador objetivo (Chrome) y anotar specs de la máquina del show.

**Aceptación:** abre en el navegador, pide mic, loguea el sample rate real.

---

## Fase 1 — Validar LATENCIA y andamiaje de análisis (2–4 sesiones) 🔴 riesgo alto

El objetivo NO es tener todas las features. Es responder: **¿cuántos ms hay de mic→dato, y Essentia entra en el worklet?**

**1A — Andamiaje Essentia-en-AudioWorklet (lo más delicado, ver `03`)**
- [ ] Cargar `essentia-wasm.umd.js` en el worklet con el patrón `URLFromFiles()`.
- [ ] Ring buffer main↔worklet (patrón `ringbuf.js`).
- [ ] Sacar **un solo número** (RMS) del worklet al main thread, estable, sin glitches.
- [ ] Loguear en pantalla el RMS en vivo.

**Aceptación 1A:** RMS estable en pantalla reaccionando al mic, sin cortes, corriendo en el hilo de audio.

**1B — Medir latencia mic→dato**
- [ ] Test de palmada: medir ms entre el sonido y el cambio del número.
- [ ] Probar distintos hop sizes (512 / 1024) y anotar el trade-off latencia/CPU.

**Aceptación 1B:** número de latencia real anotado. Objetivo < ~30 ms. Si es mucho peor, decidir plan B (`03`) antes de seguir.

**1C — Agregar el resto de features**
- [ ] Onset + onsetStrength, bandas (low/mid/high), chroma, centroid, flux.
- [ ] Emitir el `FeatureFrame` completo (contrato de `02`).
- [ ] Calibración de sala (piso de ruido + pico) + gate.

**Aceptación 1C:** `FeatureFrame` completo saliendo estable; cada feature reacciona como se espera (tocar grave sube `bands.low`, un agudo sube `centroid`, etc.).

**1D — (opcional, en paralelo) Basic Pitch offline**
- [ ] Spike: correr basic-pitch-ts sobre una grabación de ensayo (archivo, no stream).
- [ ] Confirmar que es útil solo offline y sacarlo del camino en vivo.

**Aceptación 1D:** decisión documentada de que Basic Pitch queda como herramienta de estudio.

---

## Fase 2 — Biblioteca de gestos + validación con la pianista (3–5 sesiones) 🟡 riesgo medio (es donde se define si "se siente")

- [ ] Interfaz común `Gesture` + el runner por frame (`04`). (Decidir antes: reducers puros vs RxJS — ver `09`.)
- [ ] Implementar 3–4 gestos: **fader-carga**, densidad, contador-pulsos, color-armonico.
- [ ] Visualización cruda en el DOM: una barra/número por gesto + flash en eventos.
- [ ] Exponer todos los params a sliders en vivo (mini-panel, embrión de `06`).
- [ ] **Sesión con la pianista:** que toque un swarm, ver el fader llenarse y estallar, tunear velLlenado/fuga/umbral hasta que caiga donde la música pide.
- [ ] Guardar presets de params ("pólvora", "marea"…).

**Aceptación:** con la pianista tocando, al menos el fader-carga "se siente" musical (el estallido llega cuando tiene que llegar) y quedó al menos 1 preset guardado. **Validar musicalidad antes de meter gráficos.**

---

## Fase 3 — Integración visual + escenas + panel (4–7 sesiones) 🟢 riesgo bajo (trabajo, no incertidumbre)

**3A — Motor visual base**
- [ ] Three.js/WebGL montado, recibiendo `VisualFrame` (params + eventos).
- [ ] Interpolación de params (lerp) + consumo de eventos (flash en `estalla`).
- [ ] Una escena visual real conectada al fader-carga.

**Aceptación 3A:** la pianista toca → carga visual → estalla en pantalla con un golpe contundente. Latencia mic→pixel medida (< ~80–100 ms percibidos).

**3B — Las 6 escenas + máquina de estados**
- [ ] Definir las 6 escenas (llenar plantilla de `07`).
- [ ] `SceneMapping` por escena (matriz de cableado).
- [ ] Cambio de escena (corte/crossfade), precarga para evitar hitching.

**Aceptación 3B:** se recorren las 6 escenas en vivo sin caídas de framerate ni glitches al cambiar.

**3C — Panel del director (web, `06`)**
- [ ] Selector de escena + monitor de gestos + sliders de params.
- [ ] Overrides: forzar evento, congelar gesto, override de parámetro, blackout, recalibrar.
- [ ] Comunicación panel↔visual (arrancar Opción 1, migrar a Opción 2 BroadcastChannel).
- [ ] Persistencia de presets/mapeos en JSON del proyecto.

**Aceptación 3C:** podés operar un show completo desde el panel, incluido rescatar el sistema a mano.

---

## Fase 4 — Endurecer para vivo (2–3 sesiones)

- [ ] Ensayo general en la **sala y máquina reales** (no la de desarrollo).
- [ ] Recalibración de audio en la sala; probar realimentación mic/parlantes.
- [ ] Estrés de 30 min continuos: vigilar memoria GPU, framerate, fugas.
- [ ] Checklist de arranque en pantalla (mic/latencia/escena).
- [ ] Plan de contingencia: qué hacer si se cae el mic / el framerate / el navegador.

**Aceptación:** un pase completo de 30 min sin intervención de emergencia, y un plan escrito para cuando algo falle en vivo.

---

## Hitos (para medir avance de un vistazo)

| Hito | Qué demuestra | Fase |
|---|---|---|
| **H1 — "Late"** | Latencia mic→dato medida y aceptable | Fin de 1B |
| **H2 — "Escucha"** | `FeatureFrame` completo y confiable | Fin de 1C |
| **H3 — "Se siente"** | El fader estalla musical con la pianista | Fin de Fase 2 |
| **H4 — "Se ve"** | Estallido visual contundente, latencia mic→pixel OK | Fin de 3A |
| **H5 — "Show"** | 6 escenas + panel operables en vivo | Fin de 3C |
| **H6 — "Listo"** | 30 min en sala real sin rescate | Fin de Fase 4 |

**Regla de oro del roadmap:** no pasar de fase sin cumplir su criterio de aceptación. H1 y H3 son los dos puntos donde el proyecto se puede caer; si pasan, el resto es trabajo.

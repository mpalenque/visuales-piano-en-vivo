# 01 — Evaluación crítica del enfoque

**Pregunta que respondo acá:** ¿está bien encarado el proyecto? Respuesta corta: **sí, la dirección es correcta.** Lo que sigue separa lo que ya está bien de lo que corregiría, con alternativas y un veredicto por cada decisión.

Metodología: validé los supuestos técnicos clave contra documentación oficial y estado del arte (Essentia.js, Basic Pitch, Meyda, RxJS). Las fuentes están al final.

---

## Veredicto general

**GO, con 3 correcciones antes de escribir código.** La tesis central —*features baratas → gestos con estado → visual que solo lee gestos*— es la forma correcta de no terminar en vúmetro, tanto en el análisis como en el render. Los cambios que propongo son de implementación y de reencuadre de riesgo, no de rumbo.

Las 3 correcciones (desarrolladas abajo):
1. Presupuestar el setup real de **Essentia-en-AudioWorklet** (no es plug-and-play).
2. Bajar **Basic Pitch** a herramienta **offline**, sacarlo del camino crítico en vivo.
3. Reconsiderar **RxJS** vs. un micro-motor de **reducers puros** para el motor de gestos.

---

## Lo que está BIEN encarado (validado)

Estos puntos los mantendría tal cual. No son obvios; están bien pensados.

**1. Separar medición / procesamiento-con-estado / render.** ✅
Es exactamente la arquitectura que evita el vúmetro. El error clásico (RMS → parámetro visual directo) es lo que estás evitando conscientemente. Mantener.

**2. AudioWorklet para el análisis.** ✅
Correcto. Es el mecanismo no-deprecado para audio de baja latencia en el browser, corriendo en su propio hilo para no comerse el framerate. La alternativa vieja (ScriptProcessorNode) está deprecada y trabaría el render. Bien elegido.

**3. Base en onset + energía por bandas + chroma, NO en transcripción polifónica.** ✅✅
Esta es la mejor decisión del plan. Essentia.js soporta onset, chroma/HPCP, RMS y key/chords en tiempo real dentro del worklet (documentado oficialmente). Son features baratas, de baja latencia y suficientes para gestos ricos. La transcripción nota-por-nota es cara, latente y frágil; sacarla de la base es correcto.

**4. Depriorizar Basic Pitch.** ✅ (y hay que ir más lejos — ver correcciones)
La intuición es correcta. Solo que la razón real es más fuerte de lo que decía el plan.

**5. Gestos con estado: histéresis + memoria + fuga + umbrales + easing.** ✅✅
Este es el corazón del diseño y está bien pensado. Los cuatro mecanismos son justamente los que convierten un valor instantáneo en "una pequeña máquina con vida propia". El "fader de carga" (integra energía, estalla, descarga, se rellena) es un buen ejemplo de gesto con fase y memoria, no un medidor. Mantener y expandir.

**6. Interfaz común para todos los gestos + biblioteca intercambiable.** ✅
Que todos los gestos tengan la misma firma (entran features, sale 0–1 o evento) para poder enchufar cualquiera a cualquier parámetro visual es lo que te va a dejar probar rápido con la pianista. Es una decisión de diseño de software madura. Mantener; la formalizo en `02` y `04`.

**7. Regla de oro: el visual solo lee la salida de la capa 2.** ✅
Correcta y hay que defenderla con disciplina. Es lo que permite reusar un mismo gesto en escenas distintas. Mantener.

**8. Fasear por riesgo (latencia primero, features después).** ✅
Buena ingeniería. Validar la tubería mic→dato antes de invertir en features y visual evita construir sobre una base latente. Mantener.

**9. Panel de director con overrides manuales.** ✅
Innegociable para un show real y está bien que lo tengas desde el diseño. En vivo, el análisis se va a portar raro en algún momento; poder forzar un estallido, congelar un gesto o mover un parámetro a mano es lo que salva la función. Mantener y reforzar (`06`).

**10. La observación sobre rubato / beat-tracking.** ✅✅
Muy buena. Atajaste un pozo clásico: el beat-tracking automático se rompe con tempo libre de piano clásico. La decisión de que "pulso = onset crudo" y no "beat musical" es correcta. Mantener.

---

## Lo RIESGOSO / lo que corregiría

### Corrección 1 — Essentia en AudioWorklet NO es plug-and-play

**El problema.** El plan trata "AudioWorklet + Essentia" como un paso simple de Fase 1. No lo es. Para correr Essentia.js dentro de un worklet necesitás:
- El build correcto del WASM (`essentia-wasm.umd.js`) — **no** el `.web.js` ni el `.es.js` en el hilo de audio.
- Un **ring buffer** entre el main thread y el worklet (el patrón `ringbuf.js` de la propia doc de Essentia).
- La función `URLFromFiles()` para concatenar tu código de procesamiento con la librería antes de crear el `AudioWorkletNode`.
- Manejo de diferencias entre navegadores (Firefox/Edge tienen sus vueltas).

Esto son varias sesiones de setup y debugging, no una tarde. Es el punto más subestimado del plan.

**La corrección.** En el roadmap (`08`), la Fase 1 tiene una sub-tarea dedicada y time-boxed **solo** al andamiaje Essentia-en-worklet (ring buffer + carga del WASM + un primer feature saliendo), **antes** de sumar features. Criterio de aceptación: un solo número (RMS) saliendo del worklet al main thread de forma estable. Recién ahí se agregan onset/chroma/bandas.

**Alternativa de mitigación.** Si Essentia-en-worklet se vuelve un pantano, hay un plan B por feature: RMS y energía por bandas se pueden sacar con la FFT nativa (`AnalyserNode`) o con **Meyda** para spectral centroid/flux/rolloff, dejando Essentia solo para lo que de verdad lo necesita (chroma/HPCP, key, onset robusto). Ver Corrección 4.

---

### Corrección 2 — Basic Pitch no es para vivo. Bajarlo a herramienta offline

**El problema.** El plan lo deja como "capa secundaria opcional en vivo" y propone "medir su latencia en Fase 1". Pero Basic Pitch está diseñado para **archivos completos → MIDI**, no para streaming. Internamente ve frames de ~20 ms, pero el pipeline asume que tiene el audio entero (hace pasadas y post-procesado sobre la señal completa). Correrlo sobre buffers rodantes en tiempo real no está soportado y arrastra latencia grande e inestable. La versión browser (`basic-pitch-ts`) procesa un archivo que soltás, no un stream de micrófono.

**La corrección.** Reencuadrarlo: **no** es una capa opcional en vivo, es una **herramienta de estudio/offline**. Usos válidos: analizar grabaciones de ensayo para diseñar escenas, o generar una "partitura aproximada" de referencia para programar cambios. Sacarlo por completo del camino crítico del show. Esto simplifica la Fase 1: ya no hay que "medir su latencia", hay que aceptar que no entra en vivo.

**Si igual querés altura de nota en vivo:** Essentia tiene extractores de pitch monofónico/melodía predominante de baja latencia. Para piano (polifónico) eso da solo la voz dominante, pero puede alcanzar para gestos de "registro" (¿está tocando agudo o grave?). Es una opción mucho más realista que Basic Pitch para tiempo real.

---

### Corrección 3 — RxJS para el motor de gestos: dudoso para un show en vivo

**El problema.** RxJS es elegante para modelar streams, pero para un render en vivo de 30 min tiene dos costos concretos: (a) presión de **garbage collection** por las asignaciones de cada operador y las suscripciones, y (b) historial de **regresiones de performance** en `animationFrameScheduler` con muchos timers concurrentes. Una pausa de GC en vivo = un frame dropeado = el estallido que llega tarde justo cuando importa. Además suma una dependencia grande y una curva de aprendizaje para algo que corre a frame-rate, no a sample-rate.

**Matiz importante:** el motor de gestos corre a **frame-rate / por evento** (no procesa audio muestra por muestra — eso queda en el worklet), así que RxJS *funciona* técnicamente. El problema no es corrección, es **predecibilidad en vivo**.

**La corrección (recomendada).** Un **micro-motor propio de reducers puros**: cada gesto es una función `(estado, features, dt) → nuevoEstado` más un selector `estado → salida`. Se llaman todos una vez por frame dentro de un único `requestAnimationFrame`. Ventajas: cero dependencias, cero GC sorpresa (podés preasignar), trivial de testear (son funciones puras), y trivial de razonar bajo presión. Es literalmente el patrón que ya describís ("un `scan` que mantiene `{nivel, fase}`") pero sin el runtime de RxJS encima.

**Si querés RxJS igual:** es defendible con disciplina — un solo `animationFrames()` como reloj maestro, `scan` para el estado, nada de operadores pesados anidados (`mergeMap`/`switchMap`), y desuscripción estricta. Lo dejo como decisión abierta en `09`; el plan está escrito para que cualquiera de las dos opciones encaje sin reescribir las otras capas (porque la interfaz de gesto es la misma).

---

### Otros ajustes (menores, pero anótalos)

**A. Energía por bandas: definí FFT vs. filtros, y en qué hilo.** La FFT del `AnalyserNode` es fácil pero vive en el main thread y da frames grandes (más latencia). Para bandas de baja latencia conviene FFT o banco de filtros **dentro del worklet**. Lo dejo especificado en `03`.

**B. Presupuesto de latencia total mic→pixel, no solo mic→dato.** Aun con análisis a 20 ms, el render a 60 fps + el easing de los gestos agregan su propia latencia. La métrica de aceptación del show debería ser la latencia percibida **mic→pixel**, medida con un test de palmada/flash. Lo agrego como criterio en `08`.

**C. Meyda como complemento liviano.** Para spectral centroid/flux/RMS/bandas, Meyda es real-time y más liviano que Essentia. Contra: históricamente usa `ScriptProcessorNode` (deprecado); hay que verificar su soporte actual de AudioWorklet antes de adoptarlo. Queda como opción, no como base. Ver `09`.

**D. ¿MIDI está 100% descartado?** Confirmaste piano acústico → micrófono. Perfecto, el plan asume mic. Pero vale una pregunta de una línea: si existiera *cualquier* chance de una fuente MIDI (un Disklavier, un híbrido, o hasta un teclado de respaldo para algún pasaje), MIDI vuelve el sistema **infinitamente más robusto y sin latencia** (sabés la nota exacta, la velocidad y el timing sin analizar nada). No es para cambiar el rumbo; es para no cerrar la puerta si aparece la opción. Decisión abierta en `09`.

---

## Tabla resumen de veredictos

| Decisión del plan | Veredicto | Acción |
|---|---|---|
| Separar análisis / gestos / render | ✅ Correcto | Mantener |
| AudioWorklet para análisis | ✅ Correcto | Mantener |
| Base onset + bandas + chroma (no transcripción) | ✅✅ Muy correcto | Mantener |
| Gestos con estado (histéresis/fuga/umbral/easing) | ✅✅ Muy correcto | Mantener y expandir |
| Interfaz común de gesto + biblioteca | ✅ Correcto | Formalizar (`02`,`04`) |
| Visual solo lee gestos | ✅ Correcto | Mantener con disciplina |
| Fasear por riesgo | ✅ Correcto | Mantener |
| Overrides del director | ✅ Correcto | Reforzar (`06`) |
| Pulso = onset crudo, no beat | ✅✅ Muy correcto | Mantener |
| Essentia en AudioWorklet como paso simple | ⚠️ Subestimado | **Corrección 1**: sub-tarea dedicada + plan B |
| Basic Pitch como capa opcional en vivo | ❌ Mal encuadrado | **Corrección 2**: bajar a offline |
| RxJS para el motor de gestos | ⚠️ Riesgoso en vivo | **Corrección 3**: preferir reducers puros |
| Bandas por FFT del AnalyserNode | ⚠️ A definir | Especificar hilo/método (`03`) |
| Three.js/WebGL sobre WebGPU | ✅ Correcto para vivo | Mantener (`05`) |

---

## Fuentes

- [Essentia.js — Real-time analysis (tutorial oficial)](https://mtg.github.io/essentia.js/docs/api/tutorial-2.%20Real-time%20analysis.html)
- [Essentia.js — Getting started / builds WASM](https://mtg.github.io/essentia.js/docs/api/tutorial-1.%20Getting%20started.html)
- [Audio and Music Analysis on the Web using Essentia.js (TISMIR)](https://transactions.ismir.net/articles/10.5334/tismir.111)
- [Spotify Basic Pitch (repo)](https://github.com/spotify/basic-pitch) · [basic-pitch-ts (browser/TS)](https://github.com/spotify/basic-pitch-ts) · [Meet Basic Pitch (Spotify Engineering)](https://engineering.atspotify.com/2022/6/meet-basic-pitch)
- [Meyda — audio features](https://meyda.js.org/audio-features.html) · [Meyda (repo)](https://github.com/meyda/meyda)
- [RxJS animationFrameScheduler — performance issue #7017](https://github.com/reactivex/rxjs/issues/7017) · [RxJS animationFrames()](https://rxjs.dev/api/index/function/animationFrames)

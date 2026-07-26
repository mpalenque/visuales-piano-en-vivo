# 03 — Capa 1: Análisis de audio (AudioWorklet)

**Objetivo:** convertir el micrófono en un stream de `FeatureFrame` (ver `02`) de baja latencia, corriendo todo el DSP en el hilo de audio para no tocar el framerate del render.

**Salida:** un `FeatureFrame` cada bloque de análisis (~10–25 ms según hop size).

---

## Features a extraer (y para qué sirve cada una)

| Feature | Qué es | Para qué gesto sirve | Fuente |
|---|---|---|---|
| **RMS / energía** | Volumen real percibido | Fader de carga, acumulador de clímax | nativo o Essentia |
| **Energía por bandas** (grave/medio/agudo) | Distribución de energía en el espectro | Distinguir acorde grave denso de trino agudo; color/textura | FFT en worklet o Essentia |
| **Onset** | El momento del ataque | Contador de pulsos, densidad/swarm, fader | Essentia (`OnsetDetection`) |
| **Onset strength** | Qué tan fuerte fue el ataque | Densidad ponderada, intensidad del estallido | Essentia |
| **Chroma / HPCP** | Energía en las 12 alturas | Color armónico (mayor/menor, centro tonal) | Essentia (`HPCP`) |
| **Spectral centroid** | "Brillo" del sonido | Textura/brillo → shaders | Essentia o Meyda |
| **Spectral flux** | Cuánto cambia el espectro | Textura (denso/sucio vs limpio) | Essentia o Meyda |

> **Fuera de la base:** transcripción polifónica / Basic Pitch. No entra al camino crítico en vivo (ver `01`, Corrección 2). Si se usa, es offline sobre grabaciones de ensayo.

---

## El andamiaje Essentia-en-AudioWorklet (el punto delicado)

⚠️ Esto es lo más subestimado del proyecto. **Reservá tiempo dedicado solo a esto** antes de sumar features. Ver `08`, Fase 1.

Requisitos concretos (de la doc oficial de Essentia.js):
- Usar el build **`essentia-wasm.umd.js`** (soporta import síncrono + AudioWorklet). **No** usar `.web.js` ni `.es.js` en el hilo de audio.
- Un **ring buffer** compartido entre main thread y worklet (patrón `ringbuf.js` de la doc). El worklet recibe bloques de 128 muestras del `AudioWorkletProcessor`; vos acumulás en el ring buffer hasta tener el tamaño de ventana de análisis (p.ej. 1024/2048).
- Cargar la librería con `URLFromFiles()` para concatenar tu `worklet-processor.js` con el WASM antes de crear el `AudioWorkletNode` (necesario para que ande en Firefox/Edge).
- Pasar los `FeatureFrame` del worklet al main thread por `port.postMessage` (o por otro ring buffer de salida si el `postMessage` mete jitter).

**Criterio de aceptación del andamiaje:** un solo número (RMS) llegando del worklet al main thread de forma estable, sin glitches, con la latencia medida. Recién ahí se agregan las demás features.

---

## Parámetros de DSP (a tunear)

| Parámetro | Valor inicial sugerido | Efecto |
|---|---|---|
| Sample rate | 44100 o 48000 Hz | Fijado por el hardware; leer el real |
| Frame size (ventana FFT) | 2048 | Más grande = mejor resolución en graves, peor latencia |
| Hop size (salto entre análisis) | 512 (~11 ms @ 44.1k) | Más chico = más frames/seg, más CPU |
| Ventana | Hann | Estándar para análisis espectral |
| Bandas | low 20–250 / mid 250–2000 / high 2000–8000 Hz | Ajustar al registro del piano y la sala |
| Onset method | HFC o complex (Essentia) | Probar cuál dispara mejor con el piano |
| Compresión de RMS | `sqrt` o log suave | Que la dinámica no sea todo-o-nada |

---

## Normalización (clave para que los gestos sean portables)

Todas las features salen en 0–1 en la medida de lo posible. Como el nivel del mic depende de la sala, la ganancia y el micrófono:
- Calibración de arranque: 3–5 s de "silencio de sala" para fijar el piso de ruido (noise floor) y un pico de referencia con un acorde fuerte.
- Guardar esos valores como `min`/`max` de normalización, editables desde el panel (una sala distinta = recalibrar en 10 s).
- Aplicar un **gate** de ruido: por debajo del piso, `rms = 0` (evita que el sistema "respire" con el aire acondicionado).

---

## Plan B por feature (si Essentia-en-worklet se complica)

No es todo-o-nada. Se puede degradar por partes:

- **RMS + bandas** → FFT nativa (`AnalyserNode.getFloatFrequencyData`) o Meyda. Fácil, aunque el `AnalyserNode` vive en main thread (más latencia).
- **Centroid + flux** → Meyda (real-time, liviano). Verificar su soporte actual de AudioWorklet antes de adoptar; históricamente usaba el deprecado `ScriptProcessorNode`.
- **Onset + chroma/HPCP** → acá Essentia es difícil de reemplazar con calidad. Si Essentia no entra, el onset se puede aproximar con detección de picos sobre el flux espectral (peor, pero sirve para arrancar).

**Decisión abierta:** ¿Essentia para todo, o híbrido Essentia (onset/chroma) + nativo/Meyda (rms/bandas/centroid)? Ver `09`.

---

## Riesgos de esta capa

- **Latencia real desconocida hasta medirla.** Objetivo: mic→dato < ~30 ms. Es lo primero que valida la Fase 1.
- **Ruido de sala y realimentación** (el mic cerca de los parlantes del show). Gate + calibración + posicionamiento de mic.
- **CPU del worklet** con muchas features a hop chico. Medir; subir hop size si hace falta.
- **Diferencias entre navegadores.** Fijar UN navegador para el show (Chrome recomendado) y testear solo ese.

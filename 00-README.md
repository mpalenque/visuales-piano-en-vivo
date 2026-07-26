# Visuales reactivas a piano en vivo — Plan de proyecto

Sistema web que escucha un piano acústico por micrófono, lo convierte en **gestos musicales con estado** y dispara **visuales generativas** en tiempo real, con un **panel de control web** para el director durante un show de ~30 min y 6 escenas.

> Este plan está partido en archivos chicos a propósito, para que puedas editar, tachar o reescribir cada pieza sin tocar el resto. Empezá por `01` (la evaluación) y `08` (el roadmap). El resto son las especificaciones que vas a ir modificando.

---

## Cómo usar este plan

1. Leé **`01-evaluacion-critica.md`** primero. Ahí está el veredicto de si el proyecto está bien encarado, qué cambiaría, y las 3 correcciones antes de escribir una línea de código.
2. Mirá **`09-stack-riesgos-y-decisiones.md`**, sección *Decisiones abiertas*. Hay 4–5 elecciones que dependen de vos (RxJS sí/no, MIDI sí/no, etc.). Marcá las que quieras y las bajamos al resto del plan.
3. El resto de los archivos son las specs por capa. Editá lo que no te cierre. Cada archivo es independiente.
4. Cuando estés conforme, arrancamos por la **Fase 0/1** del `08-roadmap`.

---

## Índice de archivos

| # | Archivo | Qué contiene |
|---|---------|--------------|
| 00 | `00-README.md` | Este índice + resumen + glosario rápido |
| 01 | `01-evaluacion-critica.md` | **¿Está bien encarado?** Veredicto por decisión, alternativas, 3 correcciones |
| 02 | `02-arquitectura-y-contratos.md` | Las 3 capas, el flujo de datos, y los "contratos" (interfaces) entre capas |
| 03 | `03-capa1-analisis-audio.md` | AudioWorklet + Essentia: qué features, cómo, y los riesgos de setup |
| 04 | `04-capa2-motor-de-gestos.md` | El corazón: interfaz común de gesto + catálogo (fader de carga, etc.) |
| 05 | `05-capa3-render-visual.md` | Three.js/WebGL: cómo el visual lee gestos y nunca audio crudo |
| 06 | `06-interfaz-control-web.md` | Panel del director, **todo web**: escenas, overrides, arquitectura de comunicación |
| 07 | `07-escenas-y-mapeos.md` | Máquina de estados de 6 escenas + matriz de cableado gesto→parámetro |
| 08 | `08-roadmap-fases-y-tareas.md` | Fases ordenadas por riesgo, tareas granulares, criterios de aceptación, hitos |
| 09 | `09-stack-riesgos-y-decisiones.md` | Dependencias/versiones, registro de riesgos, y **decisiones abiertas para vos** |

---

## Resumen en una página

**La tesis central es correcta y es lo que separa esto de un vúmetro:** medir features baratas y de baja latencia (onset + energía por bandas + chroma), acumularlas en **gestos con estado y memoria** (histéresis, fuga, umbrales, easing), y que el visual **solo lea la salida de los gestos**, nunca el audio crudo.

**Las 3 capas:**

1. **Análisis** (AudioWorklet + Essentia.js): mic → features numéricas cada ~10–25 ms.
2. **Motor de gestos** (frame-rate): features → valores 0–1 y eventos de alto nivel ("estalla", "clímax", "densidad=0.7").
3. **Render** (Three.js/WebGL): gestos → pixeles. No sabe nada de audio.

Más una **capa de control web** (panel del director) que gobierna qué gesto controla qué parámetro visual en cada una de las 6 escenas, con overrides manuales.

**Las 3 correcciones que propongo antes de codear** (detalle en `01`):
1. Presupuestar en serio el setup de **Essentia dentro del AudioWorklet** — no es plug-and-play (WASM + ring buffer).
2. Bajar **Basic Pitch** de "capa opcional en vivo" a "herramienta offline de estudio" — no está hecho para streaming.
3. Reconsiderar **RxJS** para el motor de gestos vs. un micro-motor de reducers puros (más predecible para vivo, cero GC sorpresa).

**Veredicto: GO**, con esas 3 correcciones. La dirección es sólida; los cambios son de implementación y de reencuadre de riesgo, no de rumbo.

---

## Glosario rápido

- **Onset**: el momento del ataque de una nota (no la nota en sí). Barato y confiable.
- **Chroma / HPCP**: energía repartida en las 12 clases de altura (do, do#, re…). Sirve para color tonal sin transcribir.
- **Gesto**: un procesador con estado que toma features y emite un valor 0–1 o un evento. Es la unidad de diseño del sistema.
- **Histéresis**: usar umbrales distintos para subir y para bajar, así nada titila.
- **Fuga (leak)**: que el estado se vacíe solo de a poco cuando deja de haber actividad.
- **AudioWorklet**: hilo dedicado de audio en el browser, para procesar sin trabar el render.
- **Rubato**: tempo libre, expresivo, típico del piano clásico. Rompe el beat-tracking automático.

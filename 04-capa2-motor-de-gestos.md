# 04 — Capa 2: Motor de gestos (el corazón)

Acá el sistema deja de ser un vúmetro. Cada "herramienta de control" es un **procesador con estado** que toma `FeatureFrame` y emite un `value` continuo (0–1) y/o `events` discretos. Todos comparten la misma interfaz (ver `02`, Contrato 2), así se arma una **biblioteca** y se enchufa cualquier gesto a cualquier parámetro visual.

---

## Los 4 mecanismos que evitan el vúmetro

Cada gesto usa uno o más de estos. Son la diferencia entre "reflejar el instante" y "tener vida propia":

1. **Histéresis** — umbral de subida ≠ umbral de bajada. Nada titila en el borde.
2. **Memoria / fuga (leak)** — el estado persiste y decae solo; no refleja el instante.
3. **Umbral de disparo** — genera eventos discretos, no solo valores continuos.
4. **Curvas no lineales (easing)** — el movimiento se siente orgánico, no mecánico.

---

## El motor (runner)

Un único loop por frame (recomendado sobre RxJS — ver `01`, Corrección 3):

```
cada frame (requestAnimationFrame):
  dt = tiempo desde el frame anterior
  frame = último(s) FeatureFrame del worklet
  para cada gesto activo en la escena:
     estado[g] = g.update(estado[g], frame, dt)
     salida[g] = g.read(estado[g])
  aplicar mapeos escena → construir VisualFrame
  entregar VisualFrame al renderer
```

Todos los gestos son **funciones puras** sobre su estado → testeables, predecibles, sin GC sorpresa. Preasignar estados en `init()`.

---

## Catálogo de gestos

Cada uno tiene: qué hace, sus parámetros tuneables (lo que ajustás en vivo con la pianista), y la lógica.

### Gesto A — "Fader de carga" (integrador con descarga)

Tu ejemplo del swarm. Acumula energía frame a frame, sube mientras hay actividad, al superar un umbral **estalla**, entra en descarga (decay), y al tocar el piso vuelve a estar listo.

**Estado:** `{ nivel: 0–1, fase: 'cargando' | 'descargando' }`

**Parámetros (los que le dan personalidad):**
| Parámetro | Efecto | Rango inicial |
|---|---|---|
| `velLlenado` | cuánto sube el nivel por onset/RMS | 0.05–0.5 |
| `fuga` | cuánto se vacía solo por segundo si no tocás | 0.1–1.0 /s |
| `umbralEstallido` | nivel al que dispara `estalla` | 0.8–1.0 |
| `velDescarga` | qué tan rápido cae tras estallar | rápido |
| `curvaDescarga` | forma del decay (exp/lineal) | exponencial |

**Lógica:**
```
update:
  if fase == 'cargando':
     nivel += velLlenado * (onsetStrength o rms) * dt_norm
     nivel -= fuga * dt            // la fuga es lo que evita que quede "pegado"
     if nivel >= umbralEstallido:  fase='descargando'; emitir {estalla, intensity:nivel}
  if fase == 'descargando':
     nivel -= velDescarga * curva(nivel) * dt
     if nivel <= 0:  nivel=0; fase='cargando'
read: value = nivel  (para animar la carga); el estallido va como evento
```

**Personalidades a probar** (mismo gesto, distintos params): "pólvora" (llenado rápido, umbral bajo, descarga violenta), "marea" (llenado lento, fuga alta, umbral alto), "nervioso" (fuga muy alta → necesita actividad constante para cargar).

---

### Gesto B — "Contador de N pulsos"

Escucha onsets, cuenta hasta N, emite `{pulso, count:N}` y resetea. Para cambios rítmicos por frase.

**Estado:** `{ cuenta: number }`
**Params:** `N` (default 4), `ventanaMax` (si pasan X segundos sin completar, resetea).
**Lógica:** `if onset: cuenta++; if cuenta>=N: emitir {pulso}; cuenta=0`.
Ojo: **pulso = onset crudo, no beat musical** (ver `01`, punto rubato).

---

### Gesto C — "Acumulador climático"

Suma RMS sostenido; al llegar al techo emite `climax` y vacía. Distinto del fader: no tiene descarga suave, es un build largo (minutos) hacia un punto de quiebre.

**Estado:** `{ acumulado: number }`
**Params:** `techo` (ej. equivalente a "200"), `decayLento` (fuga muy baja, para que un silencio corto no lo tire), `resetTrasClimax`.
**Lógica:** `acumulado += rms * dt; acumulado -= decayLento*dt; if acumulado>=techo: emitir {climax}; acumulado=0`.
**Uso:** builds largos dentro de un momento musical. `value` = `acumulado/techo` (la tensión creciente).

---

### Gesto D — "Detector de densidad / swarm"

Mide onsets por ventana de tiempo. Pocos = calma; muchos en poco tiempo = swarm. Emite un `value` continuo de densidad.

**Estado:** `{ ventana: timestamps[], densidad: 0–1 }`
**Params:** `ventanaSeg` (ej. 1.5 s), `maxOnsets` (cuántos onsets = densidad 1.0), `suavizado` (easing del value).
**Lógica:** contar onsets en la ventana deslizante → normalizar por `maxOnsets` → suavizar. Captura **cómo** toca, no solo qué. Mapea bien a turbulencia, cantidad de partículas.

---

### Gesto E — "Color armónico"

Del chroma, detecta centro tonal y carácter (mayor / menor / disonante). Con **histéresis** para que no titile entre acordes de paso.

**Estado:** `{ centroActual: 0–11, caracter: 'mayor'|'menor'|'disonante', confianza: 0–1 }`
**Params:** `histeresis` (cuánta evidencia nueva hace falta para cambiar de centro), `ventanaPromedio` (promediar chroma en el tiempo).
**Lógica:** promediar chroma → estimar tónica y modo → solo cambiar de estado si la nueva estimación supera al actual por más de `histeresis`. Mapea a **paleta**.

---

### Gesto F — "Textura / brillo"

Del spectral centroid + flux. Distingue pasajes densos/oscuros de agudos brillantes/limpios.

**Estado:** `{ brillo: 0–1, agitacion: 0–1 }` (ambos suavizados)
**Params:** `suavizadoBrillo`, `suavizadoAgitacion`, curvas.
**Lógica:** `brillo = ease(centroid)`, `agitacion = ease(flux)`. Mapea a parámetros de shader (roughness, distorsión, grano).

---

## Cómo se prueba con la pianista (Fase 2)

El motor debe exponer **todos los params en vivo** al panel (`06`). El flujo de ensayo:
1. La pianista toca un swarm.
2. Vos ves el fader llenarse y estallar en pantalla (barras/números crudos, sin gráficos todavía).
3. Ajustás `velLlenado` / `fuga` / `umbral` en vivo hasta que el estallido caiga **donde la música lo pide**.
4. Guardás ese preset de params con un nombre ("pólvora", "marea"…).

Validar la **musicalidad** de los gestos antes de meter Three.js. Es la fase donde se define si el sistema "se siente".

---

## Notas de implementación

- **Preasignar** todo en `init()`; nada de crear objetos en `update()` (GC = frames perdidos).
- `dt` real entre frames (no asumir 16.6 ms) para que la fuga/decay sean estables si baja el framerate.
- Un gesto puede leer **varios** `FeatureFrame` acumulados si el worklet corre más rápido que el render (buffer chico de frames).
- Presets de params en JSON, versionados con el proyecto. Cada escena arranca con un preset.

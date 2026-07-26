# 02 — Arquitectura y contratos entre capas

## Principio rector

Separar tres cosas que la gente mezcla (y por eso terminan en vúmetro):

1. **Qué mido** — features de audio crudas, baja latencia. (Capa 1)
2. **Cómo lo acumulo/transformo en el tiempo** — gestos con estado. Acá vive la complejidad y el diseño. (Capa 2)
3. **Cómo lo dibujo** — el visual reacciona a gestos procesados, nunca al audio crudo. (Capa 3)

Más una capa transversal de **control** (el panel del director) que decide, por escena, qué gesto gobierna qué parámetro visual.

---

## Flujo de datos (mic → pixel)

```
┌─────────────┐   features    ┌──────────────┐   gestos      ┌──────────────┐
│  CAPA 1     │  (números,    │  CAPA 2      │  (0–1 +       │  CAPA 3      │
│  Análisis   │──20 ms aprox──▶│  Motor de    │──por frame───▶│  Render      │
│ AudioWorklet│   por bloque  │  gestos      │   (60 fps)    │  Three.js    │
└─────────────┘               └──────────────┘               └──────────────┘
      ▲                              ▲                               ▲
      │ mic                          │ config: qué gesto →           │ overrides
      │                              │ qué parámetro (por escena)    │ visuales
   🎹 piano                     ┌──────────────────────────────────────────┐
                                │  CAPA DE CONTROL (panel web del director)  │
                                │  escena activa · mapeos · overrides        │
                                └──────────────────────────────────────────┘
```

**Regla de oro (no negociable):** la Capa 3 solo lee la salida de la Capa 2. Nunca toca `features` crudas. Esto permite reusar un mismo gesto en escenas distintas y cambiar el "cableado" sin tocar shaders.

**Dónde vive cada cosa (hilos):**
- Capa 1 → hilo de audio (AudioWorklet). Trabajo pesado de DSP acá.
- Capa 2 → main thread, una vez por frame (`requestAnimationFrame`). Barato.
- Capa 3 → main thread + GPU (WebGL).
- Control → misma pestaña (panel embebido) o segunda pestaña/dispositivo (ver `06`).

---

## Contrato 1 — `FeatureFrame` (Capa 1 → Capa 2)

Lo que el worklet emite en cada bloque de análisis. Números crudos, sin interpretación. Objeto plano, serializable, preasignado (para no generar basura de GC).

```ts
interface FeatureFrame {
  t: number;            // timestamp de audio (segundos, alta precisión)
  rms: number;          // energía total, 0–1 (ya normalizada/comprimida)
  bands: {              // energía por banda, cada una 0–1
    low: number;        //   ~20–250 Hz
    mid: number;        //   ~250–2000 Hz
    high: number;       //   ~2000–8000 Hz
  };
  onset: boolean;       // true si hubo ataque en este bloque
  onsetStrength: number;// fuerza del onset, 0–1 (para densidad)
  chroma: Float32Array; // 12 valores (do..si), suma normalizada
  centroid: number;     // spectral centroid normalizado 0–1 ("brillo")
  flux: number;         // spectral flux 0–1 ("cuánto cambia el espectro")
}
```

> Este contrato es el que congela la interfaz entre DSP y gestos. Si mañana cambia el motor de análisis (Essentia ↔ Meyda ↔ nativo), mientras siga emitiendo un `FeatureFrame`, la Capa 2 no se entera. Es el punto de desacople más importante del sistema.

---

## Contrato 2 — `Gesture` (la interfaz común de la Capa 2)

Todos los gestos tienen la misma firma. Esto es lo que te deja armar una biblioteca y enchufar cualquier gesto a cualquier parámetro. Detalle y catálogo en `04`.

```ts
interface Gesture<Params = any, State = any> {
  id: string;
  params: Params;                    // se tunean en vivo desde el panel
  init(params: Params): State;
  // se llama una vez por frame con el/los últimos FeatureFrame y el dt
  update(state: State, frame: FeatureFrame, dt: number): State;
  // deriva la salida a partir del estado
  read(state: State): GestureOutput;
}

interface GestureOutput {
  value: number;        // 0–1 continuo (para animar)
  events: GestureEvent[];// eventos discretos disparados este frame
}

type GestureEvent =
  | { type: 'estalla'; intensity: number }
  | { type: 'climax' }
  | { type: 'pulso'; count: number }
  | { type: string; [k: string]: any }; // extensible
```

**Por qué importa la separación `value` / `events`:** el `value` continuo maneja tensiones y rampas (la carga del fader); los `events` disparan cosas contundentes y puntuales (el flash del estallido). El visual usa los dos de forma distinta.

---

## Contrato 3 — `SceneMapping` (Control → cómo se cablea cada escena)

Una escena define qué gestos están activos y a qué parámetro visual va la salida de cada uno.

```ts
interface SceneMapping {
  scene: number;              // 1–6
  wires: Wire[];
}

interface Wire {
  gestureId: string;          // qué gesto
  output: 'value' | GestureEventType; // qué parte de su salida
  target: string;             // qué parámetro visual (ej. 'turbulence', 'cameraZoom')
  curve?: 'linear' | 'exp' | 'log' | 'sCurve'; // easing dato→parámetro
  min?: number; max?: number; // rango del parámetro visual
}
```

Ver `07` para la matriz concreta de las 6 escenas.

---

## Contrato 4 — `VisualParams` (Capa 2/Control → Capa 3)

Lo que el render recibe cada frame. Un diccionario plano de parámetros ya interpolados y en rango, más una cola de eventos a consumir.

```ts
interface VisualFrame {
  params: Record<string, number>;   // ej. { turbulence: 0.7, hue: 210, zoom: 1.2 }
  events: GestureEvent[];           // ej. [{type:'estalla', intensity:0.9}]
  scene: number;                    // escena activa
}
```

El render **no** sabe de dónde salió `turbulence: 0.7`. Podría venir del fader de carga en la escena 2 y del detector de densidad en la escena 5. Le da igual.

---

## Diagrama de módulos (repos/carpetas)

```
src/
  audio/            → Capa 1: worklet, carga de Essentia, extracción de features
    worklet-processor.js
    features.js
    ringbuffer.js
  gestures/         → Capa 2: interfaz + catálogo de gestos + el "runner" por frame
    gesture.ts      (interfaz común)
    engine.ts       (loop por frame que corre todos los gestos activos)
    catalog/
      fader-carga.ts
      contador-pulsos.ts
      acumulador-climax.ts
      densidad.ts
      color-armonico.ts
      textura-brillo.ts
  visual/           → Capa 3: escenas Three.js, shaders, post-procesado
    renderer.ts
    scenes/ (una por escena)
    shaders/
  control/          → Capa de control: panel web, estado de escena, mapeos, overrides
    panel.ts        (UI del director)
    scene-machine.ts(máquina de estados de 6 escenas)
    mappings.ts     (SceneMapping de cada escena)
    bus.ts          (comunicación panel ↔ motor: BroadcastChannel / WS)
  main.ts           → arma el grafo: audio → engine → renderer, y conecta control
```

Los contratos de arriba son las **fronteras**. Mientras cada módulo respete su contrato, se puede reescribir por dentro sin romper el resto — que es lo que necesitás para experimentar con la pianista sin miedo.

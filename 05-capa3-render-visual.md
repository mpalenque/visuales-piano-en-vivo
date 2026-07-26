# 05 — Capa 3: Render visual (Three.js / WebGL)

**Objetivo:** dibujar. Recibe un `VisualFrame` por frame (params ya interpolados + cola de eventos) y no sabe nada de audio.

**Tecnología:** Three.js sobre **WebGL**, no WebGPU todavía. Para un show en vivo querés la máquina más predecible y con más kilómetros; WebGL sobra para shaders custom, partículas y post-procesado. WebGPU queda como upgrade futuro, no para la función.

---

## La regla de oro (repetida porque es la que se rompe primero)

El render **solo** lee la salida de la Capa 2. Recibe `{ turbulence: 0.7, hue: 210, zoom: 1.2 }` y una lista de eventos. Su único trabajo es **interpolar parámetros visualmente**. Nunca lee `rms`, `chroma` ni nada crudo.

Beneficio: el mismo gesto puede manejar la turbulencia de un shader en la escena 2 y el movimiento de cámara en la escena 5, sin que el visual sepa de dónde viene el número.

---

## Cómo consume el render

**Parámetros continuos (`value`):** se aplican con interpolación suave hacia el valor objetivo (lerp/damp por frame), no de golpe. Esto agrega un colchón de suavidad además del easing del gesto.

**Eventos discretos (`estalla`, `climax`, `pulso`):** disparan cosas contundentes y puntuales. Se consumen de la cola una vez y se descartan.

Ejemplo del contraste carga-lenta / descarga-explosiva del fader:
- Mientras `nivelFader` sube (0→1), la tensión visual crece: partículas que se juntan, un shader que se comprime, color que se satura.
- Cuando llega el evento `{estalla, intensity:0.9}`, se dispara el golpe: flash, expansión de partículas, un shader que revienta.
- Ese contraste es lo que hace que el público sienta que **la música dispara la imagen**, no que la imagen acompaña.

---

## Presupuesto de latencia (mic → pixel)

No alcanza con "mic→dato < 30 ms". El render + el easing agregan latencia propia. Métrica de aceptación del show:
- Test de palmada/flash: una palmada fuerte debe producir el evento visual en **< ~80–100 ms** percibidos.
- Balancear: más easing = más suave pero más latente. Cada escena puede tener su propio balance.

---

## Estructura de una escena visual

```ts
interface VisualScene {
  id: number;
  paramSchema: string[];        // qué params espera (ej. ['turbulence','hue','zoom'])
  init(renderer): void;         // crear mallas, materiales, shaders, post-fx
  applyParams(params): void;    // mapear params → uniforms/propiedades (con lerp)
  onEvent(event): void;         // reacción a estalla/climax/pulso
  render(dt): void;             // draw call
  dispose(): void;              // liberar GPU al cambiar de escena
}
```

Cada una de las 6 escenas es una `VisualScene`. El cambio de escena hace `dispose()` de la vieja e `init()` de la nueva (o precarga, ver abajo).

---

## Técnicas visuales disponibles (paleta de recursos)

- **Sistemas de partículas** (GPU) para swarms, expansiones, densidad.
- **Shaders de fragmento custom** (GLSL) para texturas generativas, distorsión, "reventones".
- **Post-procesado** (`EffectComposer`): bloom para los estallidos, RGB shift, film grain, feedback.
- **Movimiento de cámara** como parámetro (zoom, shake en el clímax).
- **Feedback buffers** (render-to-texture) para estelas y acumulación visual.

> Vos ya venís del mundo visual (Premiere, mucho material gráfico). Esta capa es donde tu ojo manda; el plan solo garantiza que reciba señales limpias y bien diseñadas para trabajar.

---

## Rendimiento y estabilidad (show de 30 min)

- **60 fps fijos** como objetivo; si una escena no llega, simplificar esa escena, no bajar todo.
- **Precargar** shaders/texturas de las 6 escenas al inicio (evitar hitching al cambiar de escena en vivo).
- Vigilar **memoria GPU**: `dispose()` de lo que no se usa, o mantener las 6 residentes si entran.
- **Un solo navegador** fijado (Chrome). Testear en la máquina real del show, no en la de desarrollo.
- Modo **"blackout"** instantáneo (negro total) como red de seguridad, disparable desde el panel.

---

## Decisión abierta

¿Las 6 escenas son 6 mundos visuales distintos, o variaciones de un mismo motor visual con params muy distintos? Lo primero es más rico pero más trabajo; lo segundo es más rápido de construir y más estable. Se define al diseñar las escenas (`07`). Anotado en `09`.

# 06 — Interfaz de control del director (100% web)

**Todo el sistema es web**, incluido el panel de control. Nada de apps nativas ni hardware especial. Corre en el navegador, en la misma máquina del show o en un segundo dispositivo.

**Para quién:** el director (vos, o quien opere en vivo). Tiene que poder gobernar el show sin tocar código y **rescatarlo a mano** si el análisis se porta raro.

---

## Qué controla el panel

**1. Selector de escena (1–6)**
- Botón grande por escena, con estado visible de cuál está activa.
- Transición configurable (corte seco / crossfade de X segundos).
- Atajos de teclado (1–6) para cambiar sin mouse.

**2. Monitor de gestos en vivo**
- Una barra/medidor por gesto activo, mostrando su `value` en tiempo real.
- Flash cuando un gesto dispara un evento (`estalla`, `climax`, `pulso`).
- Es tu ventana a "qué está entendiendo el sistema" — clave en ensayo y en vivo.

**3. Tuneo de parámetros por gesto**
- Sliders para cada param del gesto (velLlenado, fuga, umbral… ver `04`).
- Cambios **en vivo**, sin recargar. Esto es lo que usás con la pianista.
- Guardar/cargar **presets** de params por gesto ("pólvora", "marea"…).

**4. Matriz de cableado (gesto → parámetro visual) por escena**
- Ver y editar qué gesto controla qué parámetro en la escena activa (el `SceneMapping` de `07`).
- Cambiar un cable en vivo ("que ahora el fader controle el zoom en vez del contador").

**5. Overrides manuales (la red de seguridad — innegociable)**
- **Forzar evento:** botón que dispara `estalla` / `climax` a mano.
- **Congelar gesto:** freezea el `value` de un gesto (si el análisis enloquece).
- **Override de parámetro:** tomar un parámetro visual y manejarlo a mano con un slider, ignorando el gesto.
- **Blackout / panic:** negro total instantáneo.
- **Recalibrar audio:** relanzar la calibración de sala (piso de ruido / pico) en 10 s.

**6. Estado del sistema**
- Latencia mic→dato actual, framerate, nivel de entrada del mic, escena activa.
- Aviso visible si el mic se cae o el framerate baja.

---

## Arquitectura de comunicación (web)

El panel y el motor visual son dos "vistas" que tienen que hablar. Tres opciones, de menos a más infra:

### Opción 1 — Misma pestaña, panel embebido (más simple)
Panel y visual en la misma página; el panel es un overlay que se muestra/oculta con una tecla. Cero comunicación entre procesos.
- ✅ Nada que sincronizar. Ideal para empezar.
- ❌ Panel y visual comparten pantalla; no podés tener el visual limpio en el proyector y el panel en tu laptop.

### Opción 2 — Dos pestañas/ventanas, `BroadcastChannel` (recomendada para el show)
Visual en pantalla completa en el proyector; panel en otra ventana (segundo monitor). Se comunican por `BroadcastChannel` (mismo navegador, misma máquina).
- ✅ Visual limpio en el proyector, controles en tu monitor. Cero red, cero servidor.
- ✅ Es lo que ya venías pensando. Buen default.
- ❌ Tienen que ser la misma máquina y el mismo navegador.

### Opción 3 — Segundo dispositivo (tablet/celular), servidor local + WebSocket
El panel corre en una tablet; la máquina del visual levanta un servidor local mínimo (Node) y se comunican por WebSocket en la red local.
- ✅ Controlás desde una tablet en la mano, caminando. Ergonomía de show real.
- ❌ Suma un componente servidor y depende de red local estable (riesgo en vivo).

**Recomendación:** arrancar con Opción 1 (desarrollo), pasar a Opción 2 para el show. Opción 3 solo si querés control remoto desde tablet y podés garantizar la red. El código se estructura detrás de un `bus` (ver `02`, `control/bus.ts`) para poder cambiar de opción sin tocar el resto.

---

## Stack del panel (a decidir — ver `09`)

- **Vanilla JS + [Tweakpane](https://tweakpane.github.io/docs/)**: liviano, hecho para paneles de parámetros en tiempo real, se ve bien, cero framework. **Recomendado** para v1.
- **HTML custom + Web Components**: más control sobre el look, más trabajo.
- **React/Svelte**: solo si el panel crece mucho; para vivo, cuanto menos runtime, mejor.

---

## Requisitos no funcionales (porque es en vivo)

- **A prueba de pánico:** todo override accesible en ≤ 1 clic o 1 tecla. Nada enterrado en menús.
- **Legible en oscuridad:** alto contraste, texto grande, para leer de reojo en un teatro oscuro.
- **Sin estados sorpresa:** lo que ves en el panel = lo que hace el sistema, siempre.
- **Persistencia de sesión:** que un reload accidental no borre tus presets/mapeos (guardar en archivo/JSON del proyecto, no solo en memoria).
- **Arranque rápido:** de abrir el navegador a "listo para tocar" en < 1 min, con checklist en pantalla (mic OK, latencia OK, escena 1 cargada).

# 10 — Plan integral de ejecución para Terra

## Mandato

Convertir el prototipo actual en una versión confiable para ensayo y, después de
las validaciones manuales, para función en vivo.

Terra debe ejecutar este documento en orden, sin saltar criterios de aceptación.
Cada fase debe terminar con código, pruebas, documentación actualizada y un
resumen de:

1. archivos modificados;
2. decisiones tomadas;
3. comandos ejecutados y resultado;
4. riesgos o validaciones que sigan pendientes.

> **Estado de ejecución automática (2026-07-25):** Fases 0–7 implementadas y
> verificadas con `npm run check`, cobertura de módulos puros (94% statements,
> 83% branches) y E2E Chrome. La Fase 8 continúa deliberadamente pendiente:
> requiere evidencia con piano, micrófono/interfaz, proyector y sala reales en
> `docs/show-validation.md`; no se sustituye con simulación.

No declarar el sistema “listo para show” hasta completar la Fase 8 con el piano,
micrófono, sala y máquina reales.

---

## Decisiones fijadas para esta v1

Estas decisiones eliminan ambigüedades de los documentos anteriores:

- **Motor de gestos:** reducers/máquinas de estado propias, sin RxJS.
- **Entrada principal:** micrófono. MIDI queda fuera de esta ejecución.
- **Análisis:** conservar inicialmente el DSP nativo del `AudioWorklet`.
  Essentia solo entra si el gate de calidad de la Fase 4 demuestra que onset o
  chroma no son suficientemente confiables.
- **Visuales:** un solo motor Three.js con seis perfiles visuales claramente
  diferenciados. `visualScene` debe seleccionar un perfil real; no puede quedar
  como configuración muerta.
- **Panel:** HTML/TypeScript actual, sin migrar a React/Svelte.
- **Comunicación:** una vista visual autoritativa y uno o más paneles mediante
  `BroadcastChannel`, siempre en el mismo navegador/origen.
- **Inicio seguro:** la aplicación arranca siempre en escena 1, sin blackout ni
  overrides persistidos. Se persisten configuraciones y presets, no estados de
  emergencia.
- **Cambio de escena:** reiniciar el estado dinámico de los gestos que entran en
  la nueva escena. Así se evita que una carga o un clímax viejo dispare algo al
  regresar a una escena.

---

## Definición global de terminado

El trabajo de código está terminado cuando:

- `npm run check` ejecuta lint, pruebas unitarias y build sin errores.
- `npm run test:e2e` pasa en Chrome.
- Las seis escenas cambian por botón, teclado y panel separado.
- `corte` y `crossfade` se comportan según la configuración.
- Todos los ajustes de cada escena sobreviven a recarga, exportación e
  importación.
- El panel embebido y el separado siempre muestran el mismo estado.
- Un preset inválido no rompe el arranque ni modifica parcialmente el estado.
- Una caída del micrófono, suspensión de audio o pérdida de WebGL produce un
  aviso visible y una vía de recuperación.
- No quedan errores ni warnings inesperados en consola.
- La documentación describe lo que realmente hace el código.

La versión queda habilitada para función solo después de los gates manuales de
latencia, musicalidad y estrés de la Fase 8.

---

# Fase 0 — Baseline, control de versiones y herramientas

## 0.1 Preservar y registrar el baseline

- Ejecutar antes de modificar:

  ```bash
  npm ci
  npm test
  npm run build
  npm audit
  ```

- Registrar versiones de Node, npm, Chrome y sistema operativo en
  `docs/environment.md`.
- Confirmar que no existe un repositorio Git superior antes de inicializar uno.
- No borrar `package-lock.json`.

## 0.2 Inicializar higiene del proyecto

- Si sigue sin existir repositorio, ejecutar `git init`.
- Crear `.gitignore` para:
  - `node_modules/`
  - `dist/`
  - `coverage/`
  - `playwright-report/`
  - `test-results/`
  - `*.log`
  - `.DS_Store`
  - certificados o claves locales
- Agregar `engines.node` a `package.json` según una versión soportada por la
  versión instalada de Vite.
- Agregar ESLint para TypeScript y los scripts:

  ```json
  {
    "lint": "eslint .",
    "test:unit": "vitest run",
    "test:e2e": "playwright test",
    "check": "npm run lint && npm run test:unit && npm run build"
  }
  ```

- Agregar CI en `.github/workflows/ci.yml` con `npm ci`, `npm run check` y,
  cuando la Fase 6 esté lista, `npm run test:e2e`.

## Aceptación de Fase 0

- El baseline continúa pasando.
- Git no incluye dependencias, builds ni resultados de pruebas.
- `npm run check` existe y pasa.
- El entorno reproducible queda documentado.

---

# Fase 1 — Modelo canónico, presets y persistencia segura

Esta fase corrige la pérdida de parámetros por escena, la restauración parcial y
los presets que pueden romper el arranque.

## 1.1 Crear una configuración versionada

Crear un módulo puro, por ejemplo `src/control/show-config.ts`, con:

```ts
interface ShowConfigV2 {
  version: 2;
  scenes: Scene[];
}
```

Reglas:

- Deben existir exactamente seis escenas con ids únicos 1–6.
- Cada escena conserva:
  - nombre y notas;
  - `visualScene`;
  - gestos activos;
  - parámetros completos de esos gestos;
  - wires;
  - transición;
  - parámetros visuales base.
- Los parámetros editados desde el panel se escriben inmediatamente en el
  preset de la escena activa además de aplicarse al motor.
- Volver a una escena restaura sus últimos parámetros guardados.
- Los estados dinámicos (`nivel`, contador, acumulador) se reinician al entrar.
- Blackout, overrides, eventos forzados y freeze no se persisten.
- La escena activa tampoco se persiste: el arranque seguro siempre usa escena 1.

## 1.2 Centralizar metadatos de parámetros

Eliminar la inferencia de rangos basada en nombres de `panel.ts`.

Crear descriptores compartidos por gesto:

```ts
interface GestureParamDescriptor {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
  defaultValue: number;
}
```

El motor, la validación de presets y los sliders deben leer la misma fuente.
Incluir pasos suficientemente finos para valores como `decayLento: 0.008`.

Crear también un registro de targets visuales permitidos. Los wires importados
solo pueden apuntar a targets conocidos.

## 1.3 Validar y migrar importaciones

Crear un parser que:

- acepte `version: 2`;
- migre el JSON v1 actual a v2;
- rechace versiones futuras desconocidas;
- valide todos los objetos, arrays, ids, strings, números finitos, rangos,
  curvas, eventos, targets y referencias a gestos;
- valide todo antes de cambiar el estado;
- aplique la importación de forma transaccional: éxito completo o ningún cambio;
- ignore de forma segura un valor corrupto de `localStorage` y arranque con
  defaults;
- permita restablecer defaults desde una acción explícita del usuario.

No usar un simple cast TypeScript como validación de runtime.

## 1.4 Eliminar inyección mediante HTML

- No interpolar nombres, notas, ids, keys ni targets importados directamente en
  `innerHTML`.
- Preferencia: construir nodos y asignar contenido con `textContent`.
- Si se conserva el template, escapar texto y atributos con funciones probadas,
  además de la validación estricta.
- Agregar casos con `<img onerror=...>`, comillas, HTML y números no finitos.

## 1.5 Persistencia

- Tener una sola clave versionada, por ejemplo
  `piano-visuales-show-config-v2`.
- Conservar temporalmente lectura/migración de las claves v1.
- Exportar exactamente el mismo objeto validado que se persiste.
- Importar y guardar desde el estado autoritativo, no desde una copia local de
  la UI.
- Mostrar confirmación visible de guardado/importación y el timestamp.

## Pruebas de Fase 1

Agregar pruebas para:

- defaults válidos;
- migración v1 → v2;
- rechazo de 0, 5, 7 o escenas duplicadas;
- gesto, wire, target, curva o transición desconocidos;
- `NaN`, `Infinity`, strings donde van números y valores fuera de rango;
- payloads HTML;
- importación atómica;
- fallback ante `localStorage` corrupto;
- parámetros distintos del mismo gesto en dos escenas;
- recarga y regreso a una escena sin perder sus ajustes;
- reset de estado dinámico al cambiar de escena.

## Aceptación de Fase 1

- Ajustar escena 1, ajustar escena 2, guardar, recargar y volver a ambas conserva
  sus valores correctos.
- Exportar → restablecer → importar reproduce la configuración completa.
- Ningún JSON inválido rompe el arranque ni altera el estado anterior.

---

# Fase 2 — Estado autoritativo y sincronización entre paneles

La vista visual debe ser la única autoridad durante la ejecución. El panel
embebido y `?mode=panel` son clientes del mismo estado.

## 2.1 Definir protocolo

Crear `src/control/protocol.ts` con mensajes versionados:

- `hello`
- `action`
- `request-snapshot`
- `snapshot`
- `telemetry`
- `heartbeat`
- `error`

Cada mensaje debe incluir:

- versión de protocolo;
- `sourceId`;
- rol (`visual` o `panel`);
- número de revisión o secuencia cuando corresponda.

Ignorar mensajes inválidos, de versión incompatible o snapshots más viejos.

## 2.2 Separar configuración, estado y telemetría

El snapshot autoritativo debe incluir:

- escena activa;
- configuración completa o su revisión;
- parámetros efectivos de gestos;
- gestos congelados;
- overrides activos;
- blackout;
- wires efectivos;
- transición actual;
- estado de audio y renderer.

La telemetría frecuente incluye:

- outputs de gestos;
- eventos recientes;
- FPS;
- nivel de entrada;
- latencias disponibles;
- estado de calibración.

No es necesario retransmitir toda la configuración ocho veces por segundo:
enviar snapshot completo al conectar y cuando cambia su revisión; telemetría por
separado.

## 2.3 Convertir el panel en proyección del snapshot

- Los sliders, freeze, overrides, wires y escena activa siempre se actualizan
  desde el estado confirmado.
- Puede existir feedback optimista, pero debe reconciliarse con la revisión
  recibida.
- Una edición hecha en un panel debe aparecer en el otro.
- El panel separado no debe leer ni guardar una copia divergente de `scenes`.
- `requestStatus()` debe funcionar también dentro de la misma pestaña.
- Detectar falta de heartbeat y mostrar “VISUAL DESCONECTADO”.
- Detectar dos vistas visuales autoritativas y mostrar un warning; nunca mezclar
  silenciosamente dos fuentes de estado.

## 2.4 Corregir lifecycle y controles

- Guardar las funciones de unsubscribe retornadas por el bus.
- Llamarlas en `destroy()`.
- Cerrar el bus tanto en vista visual como en panel-only.
- Corregir “Ocultar panel”:
  - en panel embebido, botón y `P` ocultan/restauran;
  - en panel-only, retirar el botón o implementar un modo compacto que sí tenga
    sentido;
  - nunca dejar una vista panel-only imposible de recuperar.
- Deshabilitar “Iniciar micrófono” mientras la apertura está en progreso.

## Pruebas de Fase 2

Con Playwright, abrir una vista visual y dos paneles:

- cambiar las seis escenas desde cada superficie;
- modificar un slider y comprobar ambos paneles;
- congelar/descongelar;
- activar/desactivar override y moverlo;
- editar un wire;
- blackout y restaurar;
- guardar, recargar las tres vistas y verificar estado;
- cerrar la vista visual y verificar aviso de desconexión;
- abrir una segunda vista visual y verificar warning.

## Aceptación de Fase 2

- Las tres vistas muestran siempre los mismos valores efectivos.
- Un panel nuevo recibe un snapshot completo inmediatamente.
- Al perder la vista visual, ningún panel continúa diciendo que está conectado.

---

# Fase 3 — Seis perfiles visuales y transiciones reales

## 3.1 Usar `visualScene`

Crear un registro, por ejemplo `src/visual/profiles.ts`, con seis perfiles:

1. **Umbral:** campo escaso, tenue y de movimiento contenido.
2. **Pólvora:** compresión visible y expansión/flash contundente.
3. **Constelación:** estructura o red legible con pulsos.
4. **Abismo:** profundidad, vórtice/zoom y grano creciente.
5. **Marea armónica:** movimiento fluido y color dominante, sin ataques bruscos.
6. **Coda luminosa:** campo cálido, denso y expansivo.

Los perfiles pueden compartir geometría y shaders, pero deben producir
diferencias visibles y usar realmente `visualScene`.

No duplicar lógica de audio ni gestos dentro del renderer.

## 3.2 Implementar transiciones

- `corte` debe cambiar en el mismo frame y no heredar un damp largo del perfil
  anterior.
- `crossfade` debe respetar `seg`.
- Para un crossfade verdadero, mantener simultáneamente salida e ingreso durante
  la transición, mediante dos capas/materiales o render targets.
- Los eventos nuevos afectan la escena entrante.
- Blackout sigue siendo inmediato, incluso durante un crossfade.
- Al terminar, liberar recursos temporales.
- Precargar/compilar los seis perfiles al inicio para evitar hitching.

Extender `VisualFrame` con la información explícita que necesite el renderer; no
inferir transiciones a partir de cambios accidentales de parámetros.

## 3.3 Ciclo de vida de gestos al cambiar

- Reiniciar los gestos activados para la nueva escena.
- Limpiar eventos pendientes y outputs de gestos inactivos.
- Aplicar los parámetros guardados de la nueva escena antes de procesar el
  siguiente frame.
- Limpiar overrides al cambiar, como comportamiento seguro.
- Documentar que freeze también se limpia al cambiar de escena, salvo que una
  prueba de uso real justifique lo contrario.

## Pruebas de Fase 3

- Tests unitarios de corte, progreso y fin de crossfade.
- Test con reloj falso para duraciones 0, 1, 1.5, 2 y 3 segundos.
- Test de blackout durante transición.
- Test de eventos dirigidos únicamente a la escena entrante.
- Test de liberación de recursos temporales.
- E2E recorriendo 1→6 y saltos 6→2→5, por botón y teclado.
- Verificar que cada id selecciona el perfil esperado.

## Aceptación de Fase 3

- Las seis escenas son visualmente distinguibles.
- Los cortes son instantáneos.
- Los crossfades terminan en el tiempo configurado con tolerancia de un frame.
- Cien cambios de escena no generan errores, crecimiento continuo de recursos ni
  caídas visibles de FPS.

---

# Fase 4 — Audio, gestos y mediciones confiables

## 4.1 Estado de audio explícito

Reemplazar el booleano `running` como única señal por estados:

- `idle`
- `requesting-permission`
- `starting`
- `running`
- `suspended`
- `ended`
- `error`

Conservar un campo derivado `running` si simplifica compatibilidad.

Agregar:

- guard contra doble `start()`;
- una sola promesa de inicio compartida;
- escucha de `MediaStreamTrack.ended`;
- escucha de `AudioContext.statechange`;
- acción visible de reintento/reanudar que se ejecuta desde un gesto del usuario;
- limpieza completa de listeners, nodos, tracks y contexto;
- nombre del dispositivo después del permiso, sin persistir identificadores
  sensibles;
- error con código y mensaje entendible.

## 4.2 Calibración

- Iniciar una calibración guiada después de abrir audio, o exigirla mediante un
  checklist claro.
- Mostrar estados `idle`, `running`, progreso, `complete` y `failed`.
- Explicar en UI qué hacer durante los 10 segundos: registrar ambiente silencioso
  y un rango fuerte del piano.
- No marcar “calibración auto” si el sistema nunca terminó una calibración.
- Evitar que “Recalibrar” parezca funcionar cuando el audio no está activo.
- Validar que piso y pico resultantes sean finitos, ordenados y con headroom.

## 4.3 Nombrar correctamente la latencia

La cifra actual no es micrófono→pixel. Separar:

- edad o tránsito worklet→main;
- costo estimado de ventana/hop del análisis;
- tiempo de último frame→render;
- medición manual micrófono→pixel.

El panel nunca debe etiquetar una estimación parcial como latencia total.

Usar timestamp de centro o final de ventana de forma documentada y coherente.

## 4.4 Hacer el DSP comprobable

- Extraer la lógica DSP pura del entorno global del worklet cuando sea viable.
- Mantener el worklet como adaptador de entrada/salida.
- Probar con señales sintéticas:
  - silencio;
  - impulso;
  - seno grave, medio y agudo;
  - acordes sintéticos;
  - ruido;
  - secuencia con onsets conocidos.
- Verificar normalización 0–1 y ausencia de `NaN`/`Infinity`.
- Verificar que el queue permanezca acotado.

## 4.5 Corregir reloj y cobertura de gestos

En `GestureEngine`, el tiempo sintético usado cuando no llegan frames debe
avanzar acumulativamente. No reutilizar siempre `lastFrame.t + renderDt`.

Agregar pruebas de:

- decaimiento durante pausas de audio;
- expiración de densidad y contador;
- freeze sin eventos residuales;
- cambio de activos;
- reset de estado;
- múltiples frames de audio en un frame visual;
- límite de `dt`;
- todos los gestos y sus eventos.

## 4.6 Gate Essentia

No integrar Essentia por inercia.

Medir el baseline nativo con piano real:

- al menos 20 ataques suaves/fuertes y acordes;
- falsos positivos durante silencio/ruido de sala;
- comportamiento del chroma en notas y acordes representativos;
- CPU, latencia y estabilidad.

Si onset o chroma no alcanzan la aceptación musical:

- integrar Essentia solo para onset y/o HPCP;
- conservar exactamente el contrato `FeatureFrame`;
- mantener RMS, bandas, centroid y flux nativos si funcionan;
- repetir todas las mediciones antes de aceptar el cambio.

## Aceptación automática de Fase 4

- Tests DSP y gestos pasan.
- La aplicación detecta mic terminado y contexto suspendido.
- Doble clic no abre dos streams/contextos.
- Los nombres de latencia son técnicamente correctos.

La calidad musical queda pendiente hasta la Fase 8.

---

# Fase 5 — Robustez del renderer y rendimiento

## 5.1 WebGL

- Capturar fallo al crear `WebGLRenderer` y mostrar fallback operable.
- Escuchar `webglcontextlost` y `webglcontextrestored`.
- Al perder contexto:
  - prevenir el comportamiento por defecto cuando corresponda;
  - actualizar estado visible;
  - mantener blackout disponible en UI;
  - ofrecer recuperación o recarga controlada.
- Reconstruir recursos tras restore y verificar que no se dupliquen listeners.

## 5.2 Telemetría

Agregar al estado del renderer:

- estado WebGL;
- FPS promedio y p95 por ventana;
- draw calls;
- geometrías y texturas reportadas por `renderer.info`;
- pixel ratio y resolución real;
- contador de context loss.

Mostrar warning si:

- FPS permanece por debajo de 55 durante más de 2 segundos;
- el tab está oculto;
- la resolución/pixel ratio excede el perfil ensayado;
- los recursos crecen después de cambios de escena repetidos.

## 5.3 Calidad adaptativa controlada

- Mantener `devicePixelRatio` máximo configurable.
- Definir perfiles `high` y `safe`, no una degradación impredecible.
- El operador debe poder cambiar a `safe`.
- El perfil `safe` reduce resolución/partículas, no altera el significado de los
  gestos.

## 5.4 Bundle y carga

- Cargar Three.js/renderer dinámicamente solo en la vista visual.
- `?mode=panel` no debe descargar ni inicializar Three.js.
- Separar el chunk del renderer para caching.
- No perseguir un número arbitrario de KB si aumenta riesgo; documentar el
  warning restante y medir tiempo real de arranque.

## Pruebas de Fase 5

- Ciclo repetido de `init()`/`dispose()`.
- Simulación de context loss con `WEBGL_lose_context` en entorno de prueba.
- Cambio a perfil seguro.
- Blackout en estado normal, transición y error.
- E2E sin errores de consola.

## Aceptación de Fase 5

- La pérdida de WebGL no produce una pantalla congelada silenciosa.
- Los recursos vuelven al baseline después de transiciones.
- Panel-only queda separado del bundle pesado.

---

# Fase 6 — Suite de pruebas y CI

## 6.1 Matriz mínima

### Unitarias

- curvas y clamps;
- seis gestos;
- engine;
- máquina de escenas;
- transiciones;
- configuración/migración/validación;
- reducer/store autoritativo;
- protocolo del bus;
- DSP puro.

### Integración

- acción → store → engine/scene machine → snapshot;
- importación → validación → aplicación → persistencia;
- status de audio y renderer;
- panel renderizado desde snapshots.

### E2E Chrome

- boot visual;
- boot panel-only;
- sincronización de dos paneles;
- seis escenas y teclado;
- freeze, overrides, wires y eventos;
- blackout;
- guardado, reload, export/import usando fixture válida;
- fixture inválida;
- desconexión;
- sin errores de consola.

El permiso de micrófono real no se falsifica como validación final. Para E2E puede
usarse una fuente sintética o un adaptador de prueba explícito, aislado de
producción.

## 6.2 Cobertura

- Activar reporte de cobertura.
- Objetivo inicial para módulos puros de control/gestos/configuración: 80% de
  statements y 70% de branches.
- No subir cobertura con asserts vacíos o snapshots gigantes.
- Documentar exclusiones justificadas de APIs de navegador/WebGL.

## 6.3 CI

- Node y npm fijados.
- `npm ci`.
- `npm run check`.
- `npm run test:e2e` en Chrome headless.
- Guardar reportes solo cuando falla.
- Fallar ante errores TypeScript, lint, tests o build.

## Aceptación de Fase 6

- CI verde desde un checkout limpio.
- Todos los defectos encontrados en la revisión tienen una prueba de regresión
  cuando son automatizables.

---

# Fase 7 — Operación, despliegue y contingencia

## 7.1 Origen seguro

- Documentar que `localhost` es válido para micrófono en la máquina del show.
- No prometer micrófono en URLs LAN servidas por HTTP.
- Si se despliega fuera de localhost, usar HTTPS real.
- Agregar una comprobación de `window.isSecureContext` y un error accionable.
- Documentar el comando exacto usado en función.

## 7.2 Modo función

Agregar una pantalla/checklist de arranque:

- origen seguro;
- Chrome soportado;
- WebGL activo;
- micrófono activo;
- sample rate;
- calibración completa;
- latencia/edad de datos;
- FPS estable;
- panel conectado;
- escena 1;
- blackout probado.

Opcional pero recomendado:

- botón de fullscreen;
- Wake Lock con estado visible y reacquisición tras volver al tab;
- aviso si la página pierde visibilidad;
- ocultar cursor/overlay en modo función.

## 7.3 Documentos operativos

Crear:

- `docs/show-checklist.md`
- `docs/contingency.md`
- `docs/show-validation.md`

`contingency.md` debe decir exactamente qué hacer si:

- el micrófono no abre;
- el micrófono se desconecta;
- la calibración falla;
- los gestos se vuelven erráticos;
- baja el framerate;
- se pierde WebGL;
- el panel se desconecta;
- el navegador se cierra;
- es necesario continuar solo con overrides/blackout.

## 7.4 Actualizar documentación

- Actualizar `README.md` con instalación, desarrollo, test, build, modo panel,
  modo función y troubleshooting.
- Marcar el progreso real en `08-roadmap-fases-y-tareas.md`.
- Actualizar decisiones D1–D6 en `09-stack-riesgos-y-decisiones.md`.
- Aclarar si Essentia fue necesario o no.
- Eliminar afirmaciones que no estén respaldadas por pruebas.

## Aceptación de Fase 7

- Una persona que no escribió el código puede arrancar, comprobar y recuperar el
  sistema usando solo la documentación.

---

# Fase 8 — Gates manuales con hardware real

Estas tareas no pueden ser sustituidas por tests automatizados ni declaradas
completas por Terra sin evidencia.

Registrar fecha, máquina, Chrome, interfaz/micrófono, sala, sample rate,
resolución y resultados en `docs/show-validation.md`.

## 8.1 Audio y features

- Probar silencio, ruido ambiente, notas graves, medias, agudas, acordes, pedal,
  pasajes suaves y fuertes.
- Confirmar:
  - grave aumenta `bands.low`;
  - agudo aumenta centroid;
  - ataques generan onset sin dobles disparos excesivos;
  - chroma/color no salta erráticamente;
  - calibración deja headroom.
- Repetir con parlantes del show para detectar realimentación.

## 8.2 Musicalidad

Con la pianista:

- tunear cada gesto en cada escena;
- guardar esos presets;
- comprobar fader, densidad, pulso, color y clímax;
- confirmar que eventos llegan musicalmente, no solo técnicamente;
- recorrer el show completo y anotar rescates manuales necesarios.

## 8.3 Latencia micrófono→pixel

- Grabar audio y pantalla con cámara de alta velocidad o método equivalente.
- Medir al menos 10 ataques.
- Registrar mediana, p95 y peor caso.
- Objetivo: p95 menor a 100 ms para eventos contundentes.
- No usar la cifra worklet→main como sustituto.

## 8.4 Estrés

Ejecutar al menos 45 minutos:

- audio y visual activos;
- secuencia realista de las seis escenas;
- al menos 100 cambios de escena;
- panel separado conectado;
- overrides, freeze, recalibración y blackout probados.

Registrar:

- FPS promedio/p95/mínimo;
- errores de consola;
- uso de recursos disponible;
- context loss;
- crecimiento de geometrías/texturas;
- desconexiones o pérdida de mensajes.

Aceptación: sin degradación progresiva, sin intervención de emergencia no
planificada y FPS sostenido adecuado a la pantalla ensayada.

## 8.5 Inyección de fallos

Ensayar deliberadamente:

- desconectar/reconectar micrófono;
- suspender/reanudar audio;
- cerrar/reabrir panel;
- recargar panel;
- perder conexión del bus;
- context loss WebGL de prueba;
- bajar a perfil visual seguro;
- recuperar desde blackout.

## Aceptación final

Solo marcar “listo para función” cuando:

- audio/features aprobados en sala;
- musicalidad aprobada con la pianista;
- p95 micrófono→pixel cumple el objetivo;
- prueba de 45 minutos aprobada;
- contingencias ensayadas;
- configuración final exportada y respaldada.

---

# Orden de ejecución resumido

- [x] Fase 0 — baseline, Git, lint y CI base
- [x] Fase 1 — configuración v2, validación y persistencia
- [x] Fase 2 — store autoritativo y sincronización de paneles
- [x] Fase 3 — perfiles y transiciones
- [x] Fase 4 — audio, DSP y reloj de gestos automatizables (gate Essentia: sala real)
- [x] Fase 5 — WebGL, telemetría y rendimiento
- [x] Fase 6 — cobertura, integración, E2E y CI
- [x] Fase 7 — modo función y documentación operativa
- [ ] Fase 8 — validación manual con hardware real

---

## Prompt breve para iniciar a Terra

> Ejecutá `10-plan-ejecucion-terra.md` en orden. Empezá por la Fase 0 y continuá
> mientras los criterios automáticos pasen. No cambies las decisiones fijadas sin
> documentar el motivo. No declares completadas tareas que requieran micrófono,
> pianista, sala o máquina real: prepará el soporte y dejalas como gates manuales.
> Después de cada fase ejecutá sus pruebas, actualizá los checkboxes y entregá un
> resumen de cambios, comandos, resultados y pendientes.

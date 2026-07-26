# Visuales reactivas a piano en vivo

Primera versión operable del sistema descrito en los planes del proyecto: micrófono → `FeatureFrame` → gestos con estado → visual WebGL, con panel de dirección, seis escenas y controles de emergencia.

## Arranque

```bash
npm install
npm run dev
```

Antes de entregar cambios, ejecutá:

```bash
npm run check
npm run test:coverage
npm run test:e2e
```

`check` valida TypeScript, lint, unitarias y build. La cobertura exige al menos
80% de statements y 70% de branches en los módulos puros de control y gestos;
las APIs de navegador, audio y WebGL se cubren con E2E en Chrome.

Abrí la dirección que muestra Vite en **Chrome** y, en la **vista visual** (la URL sin `?mode=panel`), elegí **Iniciar micrófono**. En producción serví el sitio por HTTPS: los navegadores solo autorizan el micrófono en un origen seguro (en `localhost` también funciona).

Para separar visual y controles en dos ventanas de la misma máquina/navegador:

1. Abrí la app normal a pantalla completa en el proyector.
2. Abrí la misma dirección con `?mode=panel` en el monitor de control.
3. Las dos vistas se comunican con `BroadcastChannel`, sin red ni servidor. La
   vista visual es la fuente autoritativa: escenas, sliders, mapeos, freezes y
   overrides se reflejan en ambos paneles. El panel muestra `CONECTADO`,
   `DESCONECTADO` o `DUPLICADO`; si hay dos visuales, solo uno es autoridad y
   hay que cerrar el duplicado antes de operar el show. Por el permiso del
   navegador, el micrófono se inicia en el panel embebido de la vista visual,
   no desde el panel remoto.

## Controles de show

- `1`–`6`: cambiar escena.
- `Espacio`: forzar estallido.
- `B`: blackout / restaurar.
- `P`: mostrar u ocultar el panel embebido.

El panel permite recalibrar 10 segundos, congelar gestos, forzar eventos,
reasignar targets, hacer overrides por parámetro y exportar/importar presets
JSON versión 2. La configuración se valida antes de aplicarse y cada escena
conserva sus propios parámetros. **Modo seguro** reduce el pixel ratio y el
número de partículas sin alterar el significado de los gestos; es operativo y
no se guarda dentro del preset.

Los impulsos `01`–`04` son operativos. El `04 · VORONOI` subdivide un campo
por ataques del analizador FFT: las 44 teclas graves (`MIDI 21–64`) quitan una
celda y las 44 agudas (`MIDI 65–108`) agregan una. Cada cambio se mueve y
amortigua durante 2 segundos antes de quedar fijo. Se presenta dentro de un
rectángulo completo, con fondo negro puro y líneas blancas finas, aislado de
los flashes y pulsos de los otros modos. Una cámara respirada acerca y aleja el
campo suavemente; un chaser ilumina los segmentos por turnos y revela una
vista satelital distinta en cada uno. El chaser salta entre vecinos espaciales,
deja una cola luminosa y desplaza lentamente cada imagen dentro de su celda.
El atlas de 4096×4096 reúne 64 recortes de fuentes NASA/USGS y se filtra con
mipmaps y anisotropía para conservar detalle durante la respiración de cámara.
Las fuentes y el generador reproducible están en
[`docs/satellite-atlas-sources.md`](docs/satellite-atlas-sources.md).

## Arquitectura y decisión de análisis

El `AudioWorklet` nativo actual genera RMS, bandas, onset, chroma aproximado, centroid y flux en el contrato especificado. El cálculo vive en `src/audio/dsp.ts`, probado con señales sintéticas, y el worklet es solo su adaptador de entrada/salida. Esto permite validar latencia y musicalidad sin poner Essentia/WASM en el camino crítico de esta primera ejecución. La frontera `FeatureFrame` está aislada en `src/audio`, de modo que se puede integrar Essentia para onset/HPCP sin tocar gestos, escenas ni renderer.

Antes de un show, seguí [el checklist](docs/show-checklist.md), ensayá en la
sala real, medí palmada→pixel y verificá al menos 45 minutos continuos. La cifra
del panel mide tránsito worklet→panel; la validación final debe ser
micrófono→pixel percibido. Consultá también el [plan de contingencia](docs/contingency.md).

La suite E2E no solicita ni simula una aprobación final del micrófono: comprueba
la operación visual y el protocolo entre ventanas. La prueba musical y de
latencia con el equipo real sigue siendo un gate manual documentado en
[show-validation.md](docs/show-validation.md).

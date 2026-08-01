# Visuales reactivas a piano en vivo

Versión operable del sistema descrito en los planes del proyecto: micrófono → `FeatureFrame` → gestos con estado → visual WebGL, con panel de dirección, diez escenas y controles de emergencia.

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

- `1`–`9`: cambiar a las escenas 1–9; `0`: cambiar a la escena 10.
- `Espacio`: forzar estallido.
- `B`: blackout / restaurar.
- `Q`: activar o suspender la gravedad en `03 · BLOQUES`.
- `W`: girar manualmente 90° la escena de bloques; ya no gira sola.
- `E`: llevar el objeto iluminado —render, luz, colisión y masa Box2D— de 1× a 3×, o de vuelta a 1×, en 10 segundos.
- `R`: reiniciar los cuerpos Box2D.
- En `10 · Órbita de Penumbra`, `A/S/D/F/G` cambian respectivamente la
  apariencia, escala, posición, foco luminoso y gama de color.
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

La escena `08 · Materia viscoelástica` integra como módulo nativo la simulación
MIT de
[`kotsoft/particle_based_viscoelastic_fluid`](https://github.com/kotsoft/particle_based_viscoelastic_fluid).
Conserva hashing espacial, relajación de doble densidad, viscosidad y resortes
plásticos, pero se renderiza con `THREE.Points` dentro del canvas del show. Se
mueve de forma autónoma sin micrófono; las notas y eventos musicales aplican
impulsos. La procedencia, revisión fijada y correspondencia de archivos están
documentadas en [`docs/viscoelastic-fluid.md`](docs/viscoelastic-fluid.md).

La escena `09 · Materia radiante` conserva esa misma simulación, pero rasteriza
los blobs en cada frame como emisividad y absorción para usarlos como entrada
del transporte Holographic Radiance Cascades. La escena `08` permanece sin HRC
para poder comparar ambas versiones desde botones separados.

La escena `10 · Órbita de Penumbra` es un instrumento visual manual, sin física
ni gestos automáticos. Un disco, un anillo elíptico hueco y cuerpos orbitales
proyectan eclipses dentro de Radiance Cascades. Cada pulsación de `A/S/D/F/G`
elige un nuevo estado objetivo y la transición se interpola suavemente; `F`
mantiene uno o dos elementos emisivos para conservar sombras legibles.

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

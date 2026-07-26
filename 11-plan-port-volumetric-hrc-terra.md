# Plan de ejecución para Terra: port fiel de Volumetric-HRC

## Configuración recomendada

- Modelo: **GPT Terra**
- Reasoning effort: **ultra**
- Si la interfaz ofrece prioridad de ejecución: **priority**
- No usar `low`, `medium` o `high` para la primera etapa del port.
- Después de que compile y exista una referencia visual correcta, `high` alcanza para ajustes de color, exposición y rendimiento.

`ultra` es necesario aquí porque los errores de coordenadas, rotación de frustums,
alineación par/impar y muestreo de texturas pueden producir una imagen plausible
pero matemáticamente incorrecta.

## Objetivo

Reemplazar completamente la aproximación actual de iluminación por un port WebGL2
del pipeline de ray extensions de:

- https://github.com/Yaazarai/Volumetric-HRC
- Carpeta de referencia: `HolographicRadianceCascades`
- Paper: https://arxiv.org/abs/2505.02041
- Licencia de la implementación: Unlicense

El port debe iluminar los bloques de los modos 3 y 5 sin convertir el efecto en
bloom, glow o blur. Algunas figuras emiten luz; las demás absorben, bloquean,
reciben y reflejan parcialmente esa iluminación.

## Decisión de arquitectura

No reparar ni seguir extendiendo el algoritmo de radiance cascades aproximado que
había antes.

Se conserva:

- análisis de audio;
- detección de notas y acordes;
- modos visuales;
- física Planck/Box2D;
- cajas y polígonos;
- cámaras;
- API pública de `AmitabhaRadianceField`;
- integración de `packingIrradiance` con los materiales.

Se reemplaza:

- generación del campo de radiancia;
- cascadas anteriores;
- reconstrucción gaussiana;
- acumulación temporal usada para esconder artefactos.

## Estado actual que Terra va a encontrar

El archivo `src/visual/amitabha-radiance-field.ts` ya fue sustituido por un
primer port no verificado de HRC.

Ese archivo ya contiene:

- render target MRT de emissivity y absorption;
- seed de cascada cero;
- shader de ray extensions;
- shader de merge de conos;
- cuatro frustums;
- suma final de fluencia;
- representación analítica de cajas y polígonos;
- feedback difuso moderado;
- ejecución incremental de dos frustums por frame.

**Este port parcial todavía no fue compilado ni validado visualmente.** Terra debe
tratarlo como una implementación en progreso, no como código terminado.

## Fase 0 — Baseline y protección del trabajo

1. Leer completamente:
   - `src/visual/amitabha-radiance-field.ts`
   - integración relevante en `src/visual/renderer.ts`
   - `package.json`
   - tests de renderer y E2E.
2. Ejecutar `git status --short`.
3. No borrar ni sobrescribir cambios ajenos: casi todo el workspace puede aparecer
   como untracked.
4. Ejecutar:
   - `npm run build`
   - `npm run test:unit`
5. Registrar errores de TypeScript y compilación GLSL por separado.

Resultado esperado: conocer el baseline real antes de modificar shaders.

## Fase 1 — Hacer compilar el port WebGL2

1. Confirmar que Three.js r181 usa WebGL2 y render targets con `count: 2`.
2. Validar el tipo TypeScript de:
   - `WebGLRenderTarget<Texture[]>`;
   - `target.textures[0]`;
   - `target.textures[1]`.
3. Compilar primero únicamente los materiales GLSL3:
   - scene;
   - frustum seed;
   - extension;
   - merge;
   - copy;
   - fluence;
   - display.
4. Abrir la aplicación y revisar consola WebGL.
5. No continuar si aparece cualquier error o warning de shader.

Criterio de salida:

- `npm run build` pasa;
- no existen errores de link/compile GLSL;
- los dos attachments MRT reciben contenido diferente.

## Fase 2 — Validar las entradas físicas de la escena

Construir dos texturas cuadradas de 512×512:

### Emissivity

- negro donde no hay objeto;
- color lineal multiplicado por intensidad en figuras emisivas;
- rebote difuso moderado en figuras no emisivas;
- limitar radiancia para evitar inestabilidad.

### Absorption

- cero en el vacío;
- absorción alta en cajas y polígonos;
- emisores también deben absorber;
- el piso debe bloquear luz.

Validaciones visuales temporales:

1. Mostrar emissivity directamente en pantalla.
2. Mostrar absorption directamente.
3. Probar una única caja blanca emisiva.
4. Probar una caja opaca delante.
5. Verificar que los polígonos usan 3–8 lados y no sólo su bounding box.

No avanzar mientras estas texturas tengan coordenadas invertidas o formas
deformadas incorrectamente.

## Fase 3 — Port fiel de ray extensions

Usar como fuente de verdad:

- `Shd_FrustumSeed.fsh`
- `Shd_Extensions.fsh`
- `Shd_MergingCones.fsh`
- `Shd_FluenceSum.fsh`
- eventos Create y Draw del objeto HRC del repositorio original.

Para una resolución `N`:

1. `cascadeCount = ceil(log2(N))`.
2. Cascada cero:
   - intervalo 1;
   - 2 ray endpoints por plano;
   - tomar emissivity y absorption en la rotación del frustum.
3. Cascadas superiores:
   - la cantidad de planos se divide por dos;
   - los rays por probe se duplican;
   - construir cada ray extendiendo y combinando rays de `cN-1`;
   - radiance: `near + far * nearTransmit`;
   - transmit: `nearTransmit * farTransmit`.
4. Usar nearest sampling durante extensión y merge.
5. Mantener radiance y transmit separados.

Pruebas aisladas:

- fuente puntual sin obstáculo: campo radial continuo;
- fuente + pared: sombra estable;
- mover pared: no debe aparecer ruido temporal;
- fuente de 1 px: no debe romperse en bloques grandes.

## Fase 4 — Merge correcto de conos

Implementar exactamente las dos reglas:

### Planos impares

- endpoint del ray coincide con el plano de la cascada superior;
- merge directo con el cono lejano.

### Planos pares

- extender a doble distancia;
- calcular merge cercano;
- calcular merge lejano;
- interpolar **la fluencia ya mergeada**, no posiciones ni rays sin mergear.

Peso angular:

```text
0.5 × (atan(right.y / right.x) - atan(left.y / left.x))
```

Errores que Terra debe buscar:

- usar interpolación lineal antes del merge;
- confundir cantidad de rays con cantidad de conos;
- bleeding entre celdas del atlas;
- samplear con filtro lineal;
- bordes fuera de textura tratados como radiancia negra pero transmitancia negra;
- reutilizar como input el mismo render target que se está escribiendo.

Criterio de salida: no deben existir bandas direccionales o cuadrados visibles al
mover una luz lentamente.

## Fase 5 — Cuatro frustums

Calcular cuatro frustums de 90 grados:

1. derecha;
2. abajo;
3. izquierda;
4. arriba.

Cada frustum debe usar la misma textura de escena capturada al inicio del ciclo.

Al recombinarlos:

- rotar las coordenadas de cada textura a screen space;
- desplazar un píxel hacia adentro en cada dirección;
- sumar contribuciones;
- dividir por cuatro;
- mantener el resultado en espacio lineal.

Aplicar gamma/tone mapping una sola vez en display, nunca dentro de cada cascada.

## Fase 6 — Integración incremental para rendimiento

No ejecutar necesariamente los cuatro frustums como un único pico de 70–80 draw
calls.

Estrategia inicial:

- capturar emissivity/absorption;
- procesar 2 frustums por frame;
- completar campo cada 2 frames;
- a 120 FPS: iluminación nueva a 60 Hz;
- a 60 FPS: iluminación nueva a 30 Hz;
- la física y dibujo de objetos siguen actualizándose cada frame.

Fallback:

- si el p95 supera 20 ms durante una ventana sostenida, bajar a 1 frustum/frame;
- si aun así no sostiene 50 FPS, reconstruir targets a 256×256;
- volver a 512 sólo después de varios segundos estables;
- evitar cambios de resolución repetidos.

No bajar la física de 120 Hz.

## Fase 7 — Rebote difuso controlado

HRC entrega transferencia de radiancia single-frame. Para el aspecto de radiosity
de cajas coloreadas:

1. Muestrear el campo anterior sólo al generar emissivity de superficies.
2. Multiplicar por albedo lineal.
3. Usar gain inicial entre 0.15 y 0.25.
4. Clamp de radiancia.
5. Evitar que el fondo realimente luz.
6. Resetear history al cambiar de modo, contexto o resolución.

Pruebas:

- emisor rojo junto a caja blanca: rebote rojo leve;
- emisor azul: respuesta azul;
- quitar emisor: la energía debe desaparecer rápidamente;
- mover cajas: no debe quedar una silueta fantasma larga.

## Fase 8 — Composición estética

Fondo:

- gris oscuro neutro, no negro total.

Emisores:

- rojo, azul y ámbar;
- pocos emisores;
- núcleo visible pero sin halo de bloom.

Receptores:

- conservar color del bloque;
- iluminación multiplicativa más una contribución difusa pequeña;
- no convertir todas las figuras en blanco.

Display:

- ACES o tone mapping similar;
- exposición única;
- conversión lineal → sRGB al final;
- no Gaussian blur;
- no bloom;
- no glow dibujado manualmente.

## Fase 9 — Calidad adaptativa e instrumentación

Agregar métricas separadas para:

- FPS general;
- p95 del frame;
- frecuencia efectiva de actualización HRC;
- resolución HRC;
- frustums procesados por frame;
- memoria aproximada de targets;
- draw calls.

Si está disponible, usar `EXT_disjoint_timer_query_webgl2` para medir GPU sin
bloquear. No usar `readPixels` por frame.

Presets:

- `high`: 512², 2 frustums/frame;
- `safe`: 256², 1–2 frustums/frame;
- objetivo obligatorio: al menos 50 FPS;
- objetivo ideal: 120 FPS de escena y 60 Hz de iluminación.

## Fase 10 — Validación visual en navegador

Usar el navegador real, no sólo tests.

Escenario mínimo:

1. Abrir modo 3.
2. Crear una sola caja emisiva.
3. Crear receptor blanco.
4. Crear obstáculo.
5. Confirmar sombra.
6. Mover/rotar objetos.
7. Llenar la escena.
8. Rotar tablero.
9. Desactivar gravedad.
10. Probar modo 5 con polígonos.

Tomar capturas de:

- emissivity;
- absorption;
- frustum individual;
- resultado combinado;
- composición final.

Comparar contra el video y screenshots del repositorio fuente.

## Fase 11 — Tests y cierre

Ejecutar:

```bash
npm run lint
npm run test:unit
npm run build
npm run test:e2e
```

Además:

- consola sin errores WebGL;
- contexto WebGL se recupera;
- cambio repetido entre modos 3 y 5 no filtra texturas;
- `dispose()` libera todos los render targets y materiales;
- el micrófono y análisis de audio continúan funcionando;
- no cambiar comportamiento de detección de notas o acordes.

## Criterios de aceptación obligatorios

El trabajo no está terminado hasta cumplir todo:

- no se ve pixelado a distancia normal;
- no hay cuadrados de probes claramente visibles;
- no existe blur usado para esconder artefactos;
- las cajas emisivas iluminan el fondo y otras cajas;
- las cajas opacas bloquean luz;
- colores rojo y azul son claramente distinguibles;
- los polígonos proyectan una silueta correspondiente a sus lados;
- movimiento y rotación no producen ruido o parpadeo fuerte;
- sostiene 50 FPS como mínimo en el equipo de prueba;
- build, unit, lint y E2E pasan;
- se probó visualmente en navegador;
- no se modificó el pipeline de audio.

## Prompt listo para pegarle a Terra

```text
Ejecutá completamente el archivo 11-plan-port-volumetric-hrc-terra.md.

Usá como fuente de verdad Yaazarai/Volumetric-HRC, carpeta
HolographicRadianceCascades. No continúes el antiguo algoritmo aproximado y no
uses blur, bloom o glow para esconder errores. Conservá la física, audio, modos y
API pública existentes.

El archivo src/visual/amitabha-radiance-field.ts contiene un port parcial no
verificado. Primero compilalo y auditá cada shader contra la fuente original.
Después validá emissivity/absorption, ray extensions, merge par/impar, cuatro
frustums y suma de fluencia. Probalo visualmente en navegador y medí rendimiento.

El objetivo obligatorio es una imagen estable, limpia y reactiva con mínimo 50
FPS. No declares terminado el trabajo sólo porque compile: deben pasar lint,
unit, build, E2E y la inspección visual.
```

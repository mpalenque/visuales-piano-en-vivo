# Plan de ejecución: reflexión, refracción y caústicas sobre el HRC

## Estado de ejecución — primera versión completa

Completado el 25 de julio de 2026:

- contrato `diffuse | transparent | mirror | glass`;
- transparencia simple por instancia y absorción parcial HRC, sin targets nuevos;
- SDF exacta de caja y estimador conservador de polígonos regulares;
- MRT óptico RGBA16F lazy con distancia, ID de cuerpo, material, roughness, IOR,
  tint y reflectividad/transmisión;
- escape analítico del cuerpo receptor;
- espejo con un cambio direccional real;
- vidrio con entrada, salida, Snell, Fresnel, Beer–Lambert y una reflexión
  interna total como máximo;
- caústicas 2D producidas por el camino refractado sólo sobre receptores
  difusos reales: el aire/fondo no se trata como medio participante;
- reconstrucción angular de cinco taps a `128²/64²` para resolver las cuatro
  fases de rayos sin grilla; no hay bloom, history, denoise temporal ni
  postproceso a resolución de pantalla;
- apariencia visible separada del transporte: espejo cromado procedural y
  vidrio translúcido con muestreo refractado barato dentro del material;
- asignación estable de hasta dos espejos y un vidrio;
- reserva de cuerpos direccionales, emisores fuertes y obstáculos difusos dentro
  del presupuesto de 48;
- controlador adaptativo independiente que degrada óptica antes que HRC;
- fallback por capabilities/framebuffer y lifecycle de reset/context restore;
- telemetría visible de materiales, tier, resolución, direcciones, pasos, Hz,
  draw calls y memoria;
- fixtures deterministas y readback explícito sólo para tests;
- 62 tests unitarios y 7 E2E pasando.

Validación real en Chrome, modos 3 y 5:

- `120 FPS`;
- p95 entre `8.5` y `9.3 ms` con espejo o vidrio activo;
- HRC `512²`, `60 Hz`, 2 frustums/frame y `68 MB`;
- óptica `128²`, 4 direcciones, 28 pasos, `60 Hz`, 3 draw calls;
- targets ópticos `0.63 MB`;
- modo seguro: `120 FPS`, p95 `8.9 ms`, HRC `256²/31 Hz` y óptica
  `64²/2 direcciones/31 Hz`;
- transparencia sola conserva `óptica lazy/0 MB`;
- ningún error GLSL/WebGL.

No hace falta otro cambio de modelo para cerrar esta primera versión.

## Conclusión técnica

Es viable, pero no conviene portar `VL.Radiosity` literalmente.

La arquitectura recomendada es:

- conservar el HRC actual para luz directa, sombras y rebote difuso;
- generar una representación de escena compartida con distancia, normal implícita
  y parámetros ópticos;
- agregar un campo direccional de baja resolución que trace un único material
  óptico por camino;
- resolver sus cuatro fases angulares en una única pasada low-res;
- sumar el resultado al HRC sólo donde existe una superficie difusa receptora.

Esto no es un filtro dibujado encima. La contribución nueva sólo existe cuando un
rayo encuentra un espejo o un vidrio, cambia de dirección y llega realmente a un
emisor.

El primer objetivo debe ser **espejo que redirige luz**. El vidrio y las caústicas
entran después de que ese camino sea correcto y medible.

Antes del espejo se puede entregar un material **transparente simple** de costo
muy bajo:

- alpha visual por instancia;
- absorción parcial en el HRC;
- la luz atraviesa el cuerpo sin cambiar de dirección;
- sin ray marching, SDF, target adicional ni pasada de postproceso.

Este material no refracta el fondo ni produce caústicas. El material `glass` es la
versión óptica posterior: cambia la dirección según IOR y por eso sí consume GPU.

## Qué se toma de `VL.Radiosity`

Fuente:

- https://github.com/michael-burk/VL.Radiosity
- https://github.com/michael-burk/VL.Radiosity/blob/main/shaders/Radiosity_TextureFX.sdsl

Ideas que sí se deben portar:

- escena representada por distancia firmada;
- normal disponible en el punto de choque;
- identificador o parámetros de material;
- `reflect(direction, normal)` para espejo;
- `refract(direction, normal, eta)` para vidrio;
- tinte acumulado a lo largo del camino;
- pequeño desplazamiento después de cada choque para no pegarle dos veces a la
  misma superficie.

Partes que no se deben copiar:

- 64 direcciones por píxel;
- hasta 48 pasos de marcha para cada dirección;
- cantidad abierta de rebotes;
- `SmartDenoise` como forma de esconder ruido;
- índice de refracción dramático fijo de `3.0`;
- comparación exacta de floats para decidir materiales.

`VL.Radiosity` es también un transporte 2D. En este proyecto, “espejo” significa
que una figura redirige rayos de luz dentro del plano visual. No significa una
reflexión 3D tipo cubemap donde se ve una copia fotográfica completa de la escena.

Si en una implementación futura se trasladan fragmentos literales del repositorio,
se debe conservar su aviso de licencia MIT. La implementación recomendada puede
recrear la técnica en GLSL3 sin copiar el shader línea por línea.

## Baseline e implementación comprobados el 25 de julio de 2026

El proyecto actual:

- usa Three.js `0.181.x`, TypeScript y WebGL2;
- compila con `npm run build`;
- pasa lint;
- pasa 62 tests unitarios;
- pasa 7 tests E2E;
- tiene HRC a `512²` en calidad alta y `256²` en calidad segura;
- procesa cuatro frustums, de a dos por frame en alta y de a uno en segura;
- reconstruye una textura final de irradiancia sin dirección;
- usa MRT RGBA16F separado para emissivity y absorption;
- mantiene feedback difuso con albedo y gain `0.24`;
- mide resolución, Hz de actualización, memoria y draw calls de ambos campos;
- conserva el HRC mientras todavía quede un tier óptico por degradar.

La memoria aproximada de los render targets HRC es:

- alta: `67.98 MB`;
- segura: `15.99 MB`.

Limitaciones que permanecen deliberadamente:

1. El transporte es 2D y admite un único cuerpo óptico por camino.
2. El HRC considera un máximo de 48 cuerpos, mientras la escena visual admite
   hasta 220; la selección reserva piso, ópticos, hasta 20 emisores fuertes y
   completa con obstáculos/receptores recientes.
3. El polígono anisotrópico usa un estimador de distancia conservador para
   mantener el costo apto para vivo.
4. No hay reflexión fotográfica 3D, dispersión RGB ni cadenas de materiales.
5. El tiempo GPU específico queda como telemetría opcional futura; el gate actual
   usa FPS/p95 de frame, Hz, draw calls, memoria y pruebas A/B en el equipo real.

## Alcance de la primera versión

Incluido:

- material difuso existente;
- material transparente simple, sin refracción;
- espejo neutro;
- espejo teñido o metal coloreado;
- vidrio transparente con IOR configurable;
- un objeto óptico por camino;
- entrada y salida del mismo objeto de vidrio;
- caústicas 2D producidas por refracción real;
- integración en modos 3 y 5;
- calidad adaptativa y desactivación segura;
  - fixture/readback de diagnóstico fuera del loop vivo;
  - instrumentación de frame, Hz, draw calls y memoria.

Fuera de alcance:

- path tracing general;
- más de un espejo o vidrio encadenado;
- reflexión 3D de la imagen completa;
- dispersión RGB en la primera versión;
- profundidad 3D o thickness volumétrico;
- blur, bloom, glow o denoise espacial;
- modificar análisis de audio, física o detección de notas;
- aumentar de entrada los 48 cuerpos del transporte.

## Arquitectura elegida

```text
PackingBlock[]
      |
      v
selección estable de cuerpos importantes
      |
      v
snapshot de cuerpos compartido
      |
      +--> MRT HRC 512²/256² ---------------------> diffuseField
      |
      +--> MRT óptico lazy 128²/64²
             |
             +--> SDF + materiales --> 1 óptico --> campo raw
                                                   |
                                      resolve angular 5 taps
                                                   |
                                            directionalField
                                                   |
diffuseField + directionalField -------------------+
      |
      +--> fondo HRC (direccional cero en aire)
      +--> receptores y materiales de cajas/polígonos
      |
      v
tone mapping único
```

No se crea un render target full-screen de composición. La única textura extra
resuelve a `128²/64²` las cuatro fases angulares del tracer antes de que el fondo
y los materiales sampleen el campo. Es una reconstrucción del estimador y no un
filtro cosmético sobre la imagen final.

### Texturas de escena

La implementación final preserva sin cambios de costo el MRT HRC de dos
attachments (`emissivity` y `absorption`). Sólo cuando existe un espejo o vidrio
crea un segundo MRT óptico, a `128²` en alta y `64²` en segura:

1. `geometryMaterial`
   - R: distancia firmada en unidades de mundo;
   - G: ID de cuerpo y tipo de material empaquetados;
   - B: roughness;
   - A: IOR.
2. `opticalProperties`
   - RGB: tinte o color directo del emisor;
   - A: reflectividad, transmisión o fuerza emisiva según el tipo.

Mantener nearest sampling en estas texturas. La distancia firmada debe calcularse
en el mismo shader analítico que ya recorre cuerpos, usando:

- SDF exacta de caja orientada;
- SDF de polígono regular de 3 a 8 lados;
- unión por distancia mínima;
- material del cuerpo que produjo la superficie más cercana.

La normal se obtiene sólo cuando hay un choque y se reevalúa analíticamente para
el ID exacto del cuerpo golpeado. Así una unión o un cuerpo vecino no contamina
la reflexión/refracción. No hace falta guardar una normal adicional por píxel.

Costo medido de los targets ópticos preasignados `128² + 64²`:

- dos attachments de escena, campo raw y campo resuelto: `0.63 MB`;
- cantidad de texturas: 8;
- transparencia sola: 0 targets ópticos.

Antes de habilitarlos se debe comprobar en runtime:

- WebGL2;
- al menos dos draw buffers;
- `EXT_color_buffer_float`;
- framebuffer completo con dos attachments half-float.

Si esa comprobación falla, el HRC difuso debe seguir funcionando y el transporte
óptico debe quedar deshabilitado.

### Contrato de materiales

Agregar un contrato explícito y sin rangos mágicos de floats:

```ts
type OpticalMaterialKind = 'diffuse' | 'transparent' | 'mirror' | 'glass';

interface OpticalMaterial {
  kind: OpticalMaterialKind;
  tint: readonly [number, number, number];
  roughness: number;      // 0..1
  reflectivity: number;   // 0..1
  transmission: number;   // 0..1
  opacity: number;        // 0..1, apariencia visible
  absorption: number;     // >= 0, transporte HRC
  ior: number;            // 1.0..1.8 en esta versión
}
```

En GPU el tipo puede codificarse como entero `0`, `1`, `2`, pero la API de CPU no
debe depender de umbrales como `< 0.3`.

`PackingBlock` y `AmitabhaBody` deben recibir el mismo material. El material debe
ser estable durante toda la vida del cuerpo para evitar parpadeos.

### Selección de los 48 cuerpos

Reemplazar `bodies.slice(-MAX_BODIES)` por una selección estable y testeable:

1. incluir siempre el piso;
2. incluir todos los emisores visibles;
3. incluir todos los espejos y vidrios;
4. completar con obstáculos/receptores recientes;
5. mantener orden estable entre frames;
6. limitar la cantidad de objetos ópticos por preset.

La transparencia simple no cuenta contra el cupo óptico direccional: no cambia la
dirección de los rayos. Valores iniciales para `mirror + glass`:

- alta: hasta 6 cuerpos ópticos;
- segura: hasta 3;
- nunca convertir un emisor en vidrio o espejo en la primera versión.

Si emisores + ópticos superan el límite total, priorizar por visibilidad y energía,
no sólo por antigüedad.

## Trazabilidad del plan original

Las fases siguientes conservan el diseño previo a la implementación. Cuando un
valor difiere, prevalecen el estado y la arquitectura final documentados arriba.
La diferencia principal es deliberada: se reemplazó el MRT de cuatro attachments
a resolución HRC por un MRT óptico lazy de dos attachments a `128²/64²`, porque
esa variante cumplió mejor el invariante de performance.

## Fase 0 — Congelar el baseline

1. Ejecutar:

   ```bash
   npm run lint
   npm run test:unit
   npm run build
   npm run test:e2e
   ```

2. Abrir modos 3 y 5 en navegador real.
3. Registrar en alta y segura:
   - FPS promedio;
   - p95;
   - HRC update Hz;
   - draw calls HRC;
   - memoria de targets;
   - cantidad de cuerpos enviados al transporte.
4. Tomar capturas de una escena fija con:
   - emisor;
   - receptor;
   - obstáculo;
   - piso.
5. Crear un flag de desarrollo `opticalTransportEnabled`, inicialmente `false`.

Criterio de salida:

- baseline reproducible;
- ningún error o warning GLSL;
- capturas y números guardados;
- con el flag apagado la imagen no cambia.

## Fase 1 — Contratos y transparencia de bajo costo

1. Crear `src/visual/optical-materials.ts`.
2. Agregar tipos, validación y defaults.
3. Agregar material a `PackingBlock` y `AmitabhaBody`.
4. Crear una asignación determinista basada en seed.
5. Implementar primero `transparent` sin campo direccional:
   - atributo instanciado de opacity;
   - alpha en el material visible;
   - absorption HRC menor que la de un cuerpo opaco;
   - transmission configurable;
   - sin refracción.
6. Empezar después con un único espejo y ningún vidrio en la escena de prueba.
7. Añadir un atributo instanciado para que la superficie óptica tenga una señal
   visual sobria y reconocible.
8. No alterar todavía la dirección de los rayos ni crear targets nuevos.

Tests:

- valores fuera de rango se limitan o rechazan;
- un mismo seed conserva material;
- un emisor nunca recibe material óptico;
- los caps de alta y segura se respetan;
- la selección de 48 cuerpos no pierde piso, emisores ni ópticos.
- un transparente reduce absorption sin volverla negativa;
- con sólo materiales `diffuse/transparent` no se crea el campo direccional;
- transparencia no agrega draw calls ni render targets.

Criterio de salida:

- contratos listos;
- transparencia visible y luz transmitida sin refracción;
- escena difusa idéntica con transporte óptico apagado;
- FPS, p95 y update Hz HRC dentro del margen del baseline;
- sin cambios en física, audio o spawns.

## Fase 2 — SDF y G-buffer óptico

1. Extender `sceneFragmentShader` para calcular distancia firmada.
2. Implementar caja orientada.
3. Implementar polígono regular de 3 a 8 lados.
4. Escribir los cuatro attachments MRT.
5. Añadir debug views temporales:
   - emissivity;
   - absorption;
   - SDF en falso color;
   - normal derivada;
   - material ID;
   - IOR;
   - tint.
6. Usar la misma captura de cuerpos para HRC y para el campo direccional.
7. Verificar el piso y las figuras rotadas.

Pruebas visuales:

- caja a 0°, 45° y 90°;
- triángulo, pentágono y octógono;
- dos cuerpos superpuestos;
- cuerpo tocando el límite del campo;
- morph de modo 5 comparado con su aproximación óptica.

Criterio de salida:

- SDF continua fuera de los objetos;
- signo correcto dentro/fuera;
- normal hacia afuera;
- ningún bleeding de material entre cuerpos;
- MRT completo en alta y segura;
- HRC difuso sigue siendo visualmente equivalente.

No avanzar al espejo mientras la SDF tenga errores. Un ray marcher sobre una SDF
incorrecta puede producir una imagen atractiva pero físicamente falsa.

## Fase 3 — Spike de espejo con un rebote

Crear `src/visual/directional-material-field.ts`.

Por cada píxel del campo direccional:

1. convertir UV a posición de mundo;
2. lanzar un conjunto pequeño y determinista de direcciones;
3. marchar por la SDF hasta el primer choque;
4. si el primer choque es difuso u opaco, terminar ese camino;
5. si es espejo:
   - obtener la normal analítica del ID de cuerpo golpeado;
   - ejecutar `reflect`;
   - proyectar el hit a la superficie y usar un bias acotado por el espesor;
   - continuar la marcha;
6. acumular energía sólo si después del espejo se llega a un emisor;
7. aplicar reflectividad, tinte y atenuación por distancia;
8. limitar energía antes de escribir RGBA16F.

No acumular caminos directos emisor→píxel: ya pertenecen al HRC. El nuevo target
debe contener únicamente energía que pasó por al menos un material óptico.

Valores iniciales para el spike:

- resolución `128²`;
- 1 espejo;
- 4 direcciones por píxel;
- máximo 28 pasos por tramo;
- máximo 1 cambio de dirección;
- direcciones fijas, sin jitter temporal;
- sin history ni denoise; resolve angular low-res de cinco taps.

Escena de validación:

- emisor blanco pequeño;
- espejo largo a 45°;
- pared receptora;
- obstáculo opcional.

Criterios de salida:

- el lóbulo cambia al rotar el espejo;
- a 45° se desvía en la dirección geométricamente esperada;
- un obstáculo entre espejo y emisor corta la contribución;
- al volver el espejo a difuso desaparece completamente;
- no aparece luz especular sin emisor;
- la energía no crece frame a frame;
- el resultado es estable con cámara y física quietas.

Éste es el go/no-go principal. Si el spike no es legible a `128²/4` y no entra en
presupuesto a `256²/8`, no se empieza vidrio.

## Fase 4 — Integración con HRC y renderer

1. Subir el campo óptico a la resolución del preset correspondiente.
2. Ejecutarlo al completar un ciclo HRC, usando el mismo snapshot de escena.
3. Exponer `directionalTexture` y sus stats.
4. En `displayFragmentShader`:
   - samplear HRC difuso;
   - samplear campo direccional;
   - sumar en espacio lineal;
   - aplicar exposición, ACES y gamma una sola vez.
5. En `configurePackingMaterial`:
   - samplear ambas texturas;
   - aplicar contribución óptica a receptores;
   - evitar doble iluminación en emisores.
6. No crear una pasada extra de composición.
7. Resetear el campo óptico al:
   - cambiar modo;
   - cambiar calidad;
   - restaurar contexto;
   - cambiar resolución;
   - resetear bloques.
8. Liberar sus targets en `dispose()`.

Criterios de salida:

- flag apagado reproduce baseline;
- flag encendido agrega sólo el camino reflectado;
- fondo y objetos reciben la misma estructura de luz;
- no hay una textura vieja después de reset o context restore;
- cambiar repetidamente entre modos 3 y 5 no aumenta texturas ni memoria.

## Fase 5 — Presupuesto y calidad adaptativa

### Invariante de performance

La prioridad es conservar la performance actual, no conservar a cualquier costo la
calidad del efecto nuevo.

Medir un `baselineP95` y `baselineFps` durante al menos 5 segundos con la misma
escena y el transporte direccional apagado. Con óptica activa:

- FPS promedio no debe caer más de 2%;
- p95 no debe aumentar más de `min(1 ms, baselineP95 × 5%)`;
- frecuencia HRC no debe bajar por culpa del campo óptico;
- física debe conservar 120 Hz;
- no debe aparecer un hitch al crear el primer espejo o vidrio.

El controlador adaptativo del campo óptico debe ser independiente del controlador
HRC. Si falta presupuesto, se degrada o apaga **primero el campo óptico**. No se
debe bajar la resolución HRC para financiar espejo, vidrio o caústicas.

La transparencia simple no activa este controlador porque reutiliza el shader
visible y la absorption que el HRC ya procesa.

Presets iniciales, sujetos a perfil real:

| Parámetro | Alta | Segura |
|---|---:|---:|
| HRC | `512²` | `256²` |
| Campo direccional | `256²` | `128²` |
| Direcciones por píxel | 8 | 4 |
| Pasos máximos por tramo | 40 | 28 |
| Objetos ópticos | 6 | 3 |
| Rebotes ópticos | 1 | 1 |
| Denoise | no | no |

El campo de `256²` RGBA16F necesita aproximadamente `0.5 MB`. Con los dos
attachments nuevos, el aumento objetivo total en alta debe quedar por debajo de
`8 MB`, manteniendo el conjunto de targets por debajo de unos `76 MB`.

Instrumentación nueva:

- tiempo GPU del HRC;
- tiempo GPU del campo direccional;
- frecuencia de actualización del campo direccional;
- resolución;
- direcciones y pasos activos;
- cuerpos ópticos;
- memoria de targets ópticos;
- razón de fallback.

Usar `EXT_disjoint_timer_query_webgl2` cuando esté disponible. No usar
`readPixels` durante el show.

Orden de degradación si el p95 supera 20 ms durante 1.5 s:

1. bajar direcciones `8 → 4`;
2. bajar campo `256² → 128²`;
3. actualizar el campo óptico cada dos ciclos HRC;
4. deshabilitar vidrio y conservar espejo;
5. deshabilitar campo óptico y conservar HRC difuso.

Si cualquiera de los límites relativos al baseline se incumple antes de llegar a
20 ms, aplicar el mismo orden de degradación sin esperar. El umbral de 20 ms es un
límite absoluto, no permiso para consumir todo el margen disponible.

Recuperación:

- esperar al menos 5 s con p95 menor a 15 ms;
- subir un único escalón por vez;
- no reconstruir targets repetidamente.

Objetivos:

- obligatorio: al menos 50 FPS en el equipo de show;
- deseable: 60 FPS visuales o más;
- física: conservar 120 Hz;
- ningún hitch visible al cambiar material o calidad.

## Fase 6 — Vidrio y refracción

Sólo empezar después de cerrar espejo.

Para vidrio, un camino puede atravesar dos superficies del mismo objeto:

1. detectar entrada desde aire;
2. usar `eta = 1 / ior`;
3. marchar dentro usando el valor absoluto de la SDF;
4. detectar la superficie de salida;
5. invertir la normal;
6. usar `eta = ior`;
7. continuar hacia el emisor;
8. si `refract` devuelve vector nulo, usar reflexión interna total;
9. aplicar Beer-Lambert simple según distancia interna y tint;
10. limitar el camino a un único cuerpo de vidrio.

Rango inicial:

- IOR: `1.1` a `1.7`;
- default: `1.5`;
- transmission: `0.75` a `0.95`;
- roughness: `0`;
- sin aberración cromática.

Fresnel:

- usar Schlick;
- en alta, repartir muestras de forma determinista entre reflexión y refracción;
- en segura, elegir la rama de mayor peso;
- no trazar ambas ramas por cada muestra hasta medir el costo.

Pruebas:

- placa paralela: desplaza el camino sin enfocarlo fuertemente;
- triángulo: desvía la luz;
- polígono convexo: concentra una zona más brillante;
- IOR `1.0`: equivale casi a no tener vidrio;
- aumentar IOR aumenta el desvío;
- cuerpo teñido absorbe sus canales complementarios;
- reflexión interna total no produce NaN ni píxeles negros inestables.

Criterio de salida:

- la caústica cambia coherentemente con forma, rotación e IOR;
- no existe contribución si no hay emisor;
- no se atraviesan obstáculos opacos;
- no hay energía infinita en bordes;
- no hay flicker fuerte con objetos quietos.

## Fase 7 — Apariencia y mapeo musical

Después de validar física y rendimiento:

1. definir una regla musical estable para crear pocos materiales ópticos;
2. mantener mayoría difusa;
3. usar espejo en eventos o notas que deban producir cortes direccionales;
4. reservar vidrio para momentos de tensión o brillo;
5. mapear un gesto a `reflectivity` o `ior` sólo dentro de rangos seguros;
6. amortiguar todo parámetro continuo;
7. no cambiar `kind` de material varias veces por segundo.

Propuesta inicial:

- modo 3: hasta 2 espejos, sin vidrio por defecto;
- modo 5: hasta 2 espejos y 1 vidrio;
- eventos fuertes pueden promover el próximo cuerpo no emisivo a óptico;
- pitch o brillo pueden elegir tinte, no número de rebotes;
- densidad no debe aumentar automáticamente el costo del tracer.

La superficie debe comunicar su material sin glow:

- espejo: base oscura, borde o banda direccional sobria;
- metal teñido: reflexión multiplicada por tint;
- vidrio: transmisión alta y contorno fino;
- emisor: mantiene su núcleo actual.

## Fase 8 — Tests y validación final

### Tests unitarios

- defaults y validación de materiales;
- selección estable de cuerpos;
- reserva de piso, ópticos, emisores fuertes y obstáculos difusos;
- presets y fallback;
- cálculo de memoria;
- resets y disposal;
- transición de calidad sin oscilación.

### Tests WebGL E2E

Crear una escena óptica determinista accesible sólo en desarrollo/test:

- un emisor;
- un espejo a 45°;
- un receptor;
- un obstáculo;
- un vidrio convexo.

Validar:

- compilación y link de todos los shaders;
- cuatro attachments distintos;
- framebuffer completo;
- pixel probes sólo durante el test;
- espejo on/off cambia la región esperada;
- obstáculo reduce esa contribución;
- IOR `1.0` y `1.5` producen resultados diferentes;
- no existen NaN/Inf;
- pérdida y restauración de contexto;
- cambio de calidad;
- repetición de modos 3/5;
- conteo de texturas vuelve al baseline después de dispose.

No usar screenshots como única aserción automática porque distintos drivers pueden
variar levemente. Combinar probes tolerantes con revisión visual.

### Validación visual manual

Capturar:

1. SDF;
2. material ID;
3. normal;
4. HRC difuso solo;
5. campo direccional solo;
6. resultado combinado;
7. espejo a 0°, 45° y 90°;
8. vidrio con tres IOR;
9. alta y segura;
10. escena llena en modos 3 y 5.

Hacer además una prueba sostenida de show con:

- entrada de audio;
- gravedad on/off;
- giros de tablero;
- cámara del modo 5;
- cambio de calidad;
- cambio repetido de escenas;
- pestaña oculta/visible;
- recuperación de contexto.

## Criterios de aceptación obligatorios

El trabajo no está terminado hasta que:

- HRC difuso conserva su comportamiento con el feature apagado;
- un material transparente deja pasar luz con menor absorption sin refractarla;
- transparencia simple no agrega targets ni draw calls;
- un espejo redirige luz según forma y rotación;
- un obstáculo bloquea el camino reflectado;
- vidrio refracta con entrada y salida correctas;
- una forma convexa puede concentrar una caústica legible;
- toda contribución óptica puede rastrearse hasta un emisor real;
- no se usa bloom, glow, blur o denoise espacial;
- no hay NaN, Inf, manchas persistentes ni energía creciente;
- alta y segura funcionan;
- sostiene al menos 50 FPS en el equipo de show;
- FPS promedio cae como máximo 2% respecto del baseline equivalente;
- p95 aumenta como máximo 1 ms o 5%, el límite que sea menor;
- el controlador óptico nunca degrada el HRC para financiar el efecto;
- p95 y tiempo GPU óptico están visibles;
- el fallback nunca rompe el HRC base;
- context restore recupera ambos campos;
- no hay fuga de render targets;
- lint, unit, build y E2E pasan;
- audio, física y control remoto no cambian;
- existe validación visual en navegador real.

## Riesgos y decisiones

### La salida HRC perdió dirección

No intentar obtener un espejo nítido sólo desde `fieldTargets`. Esa textura ya es
la suma angular. El campo direccional debe vivir antes o al costado de esa suma.

### Costo del ray marching

No copiar `64 × 48` de vvvv. Empezar en `4 × 28`, medir y subir. Un único rebote
óptico es una restricción de producto, no sólo una optimización accidental.

### SDF incorrecta

La mayor fuente de errores será geometría, signo, normal y epsilon. Por eso SDF
tiene una fase y debug views propios.

### Objetos no incluidos entre los 48

La selección debe ser estable y priorizada. Aumentar el límite sin medir multiplica
el costo del shader de escena.

### Ruido y bandas

Primera respuesta: más direcciones dentro del presupuesto y muestreo determinista.
La implementación usa sólo un resolve angular de cinco taps a `128²/64²`; no
agregar otro blur ni un filtro full-screen. Si más adelante se estudia history
temporal, debe estar detrás de un flag, conservar bordes y no ser requisito para
que la física óptica se lea.

### Caústicas “de cine”

La meta es una caústica 2D clara y musical dentro del lenguaje de esta obra. Photon
mapping 3D, múltiples rebotes y dispersión espectral quedan fuera de este port.

## Orden recomendado y dificultad

1. Contratos + selección estable: media.
2. Transparencia simple: baja.
3. SDF/G-buffer: media-alta.
4. Espejo de un rebote: media-alta.
5. Integración y calidad adaptativa: media.
6. Vidrio con entrada/salida: alta.
7. Caústica estable y afinación estética: alta.

El espejo es el punto de entrega intermedio obligatorio. Permite obtener un efecto
escénico útil aunque vidrio no llegue a cumplir el presupuesto.

## Prompt de ejecución

```text
Ejecutá completamente
12-plan-materiales-direccionales-reflexion-refraccion-causticas.md.

Conservá el HRC para transporte difuso y agregá un campo direccional separado de
un solo rebote óptico. Usá VL.Radiosity sólo como referencia para SDF, normales,
reflect, refract y tint; no copies sus 64 rayos por píxel, sus 48 pasos ni su
SmartDenoise.

Primero congelá el baseline. Después implementá contratos de material, selección
estable de los 48 cuerpos y transparencia simple mediante alpha y absorption HRC,
sin target nuevo. Después hacé el debug del SDF/MRT. No empieces vidrio hasta que
un espejo a 45 grados redirija luz de forma correcta, bloqueable por obstáculos y
dentro del presupuesto.

No uses bloom, glow, blur ni denoise espacial. La luz nueva debe existir únicamente
si el camino trazado toca un material óptico y llega a un emisor. El feature debe
tener fallback limpio al HRC difuso, liberar todos sus targets y sostener al menos
50 FPS en el equipo de show.

La performance actual es una restricción dura: compará siempre contra la misma
escena con óptica apagada. No permitas más de 2% de caída de FPS ni más de 1 ms o
5% de aumento de p95, el límite que sea menor. Si no entra, degradá o apagá el
campo óptico antes de tocar resolución, frecuencia o calidad del HRC.

No declares terminado sólo porque compile: deben pasar lint, unit, build, E2E,
pruebas WebGL de los attachments, context restore, perfil GPU y validación visual
en navegador real.
```

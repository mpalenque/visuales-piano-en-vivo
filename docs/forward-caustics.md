# Óptica forward acotada

Los impulsos 03 y 05 conservan Amitabha HRC como transporte difuso principal y
agregan una capa óptica direccional pequeña para espejo, vidrio y caústicas.
No hay un pase fullscreen, acumulación temporal ni render targets adicionales.

## Transporte

- Los cuerpos no emisivos alternan vidrio, espejo y difuso para que los
  materiales sean identificables. El vidrio tiene interior transparente y
  borde Fresnel cian; el espejo usa bandas de cromo plateado.
- El transporte sigue limitado a los dos materiales ópticos con mejor prioridad,
  aunque haya más materiales visibles.
- Para cada material se elige el emisor con mejor visibilidad angular y se
  muestrea su silueta.
- El espejo aplica una reflexión especular.
- El vidrio calcula entrada y salida con Snell, Fresnel-Schlick, absorción
  Beer-Lambert y un único rebote interno por reflexión total.
- La energía sólo se deposita al encontrar una superficie real. Los depósitos
  son puntos gaussianos aditivos en coordenadas de mundo, no texturas cuadradas.
- El vidrio no entra como oclusor opaco del HRC: el campo difuso base lo
  atraviesa y la capa forward agrega la concentración refractada.

## Presupuesto de vivo

| Calidad | Rayos por par | Pares máximos | Rayos máximos | Frecuencia |
| --- | ---: | ---: | ---: | ---: |
| high | 192 | 2 | 384 | 30 Hz |
| safe | 96 | 2 | 192 | 20 Hz |
| off | 0 | 0 | 0 | 0 Hz |

La capa usa como máximo un draw call, 1.024 depósitos y 64 cuerpos de colisión.
Su memoria de render targets es siempre 0 bytes.

El control adaptativo observa el p95 del frame:

- sobre 12 ms baja a `safe`;
- sobre 18 ms baja primero a `safe` y luego a `off`;
- tras cinco segundos por debajo de 10 ms recupera la calidad solicitada.

Esto degrada la óptica antes que el HRC. La telemetría del panel muestra calidad,
rayos, impactos y tiempo de CPU.

## Alcance

Es una solución híbrida 2D para vivo, no photon mapping ni path tracing. Produce
reflexión/refracción de un rebote y concentraciones tipo caústica legibles, pero
no refleja la imagen completa de la escena dentro del material. Esa limitación
mantiene intactos el costo y la estabilidad del HRC existente.

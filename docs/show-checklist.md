# Checklist de función

## Antes de abrir al público

- [ ] Chrome y sistema actualizados según el entorno ensayado.
- [ ] Equipo conectado a corriente; suspensión automática desactivada.
- [ ] Visual abierto en `localhost` o HTTPS; no usar una IP LAN por HTTP para el micrófono.
- [ ] Vista visual en proyector y `?mode=panel` en el monitor de control.
- [ ] Estado `VISUAL` del panel en `CONECTADO` (nunca `DUPLICADO` ni `DESCONECTADO`).
- [ ] Estado WEBGL en `OK`, Modo alto o seguro elegido explícitamente y FPS estable por encima de 110 en una pantalla de 120 Hz.
- [ ] Micrófono activo, sample rate confirmado y entrada calibrada.
- [ ] Escena 1 visible, blackout probado y restaurado.
- [ ] Preset v2 final exportado y respaldado fuera del navegador.
- [ ] Plan de contingencia leído por quien opere el panel.

## Durante el show

- Usar `1`–`6` para escenas, espacio para estallido, `B` para blackout y `P`
  para el panel embebido.
- Si la respuesta musical es inestable, congelar el gesto afectado y usar
  overrides antes de recalibrar.
- Si WEBGL o el micrófono indican error, aplicar el procedimiento de
  `contingency.md`.
- Si el FPS cae durante más de dos segundos, usar **Modo seguro** antes de
  cerrar la aplicación o cambiar presets.

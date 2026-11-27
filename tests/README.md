# Pruebas

No hay dependencias ni navegador: cada script lee el código real del repo,
extrae el bloque que quiere probar y lo ejecuta en un `vm` de Node con mocks
mínimos de Chrome y del DOM. Por eso los tests se rompen si el código fuente
cambia de forma incompatible, que es justamente lo que queremos detectar.

## Ejecutar

```bash
npm test          # 10 scripts con asserts
npm run check     # node --check en los 5 JS de la extensión
npm run test:kick:dom   # diagnóstico adicional de Kick (solo imprime)
```

En Windows también podés correr `node tests\test-security.js` directamente.
Las rutas se calculan con `__dirname`, así que funciona desde cualquier
directorio.

## Qué cubre cada archivo

| Script | Qué valida |
| --- | --- |
| `check-ids.js` | Todo `getElementById` del popup existe en `popup.html`. |
| `check-popup.js` | IDs usados en JS y declarados en HTML (informativo). |
| `test-security.js` | Emisores, `requestId`, `tabId`, `streamId`, validación de tipos y agrupación de recargas. |
| `test-still-watching.js` | Cartel "¿Sigues viendo?" de YouTube/YTM y que no reanude video ajeno. |
| `test-ramp.js` | Rampa 1,06× solo en Shaka/DGO, limpieza al cambiar de fuente y opt-out. |
| `test-perf-lite.js` | Timer de lock, frame sin video, slider agrupado y FIFO de `usedStreamIds`. |
| `test-kick-cog.js` | Elección del botón de ajustes frente a subtítulos/audio. |
| `test-kick-wrong-menu.js` | Cerrar un menú equivocado y probar el siguiente candidato. |
| `test-i18n.js` | Textos, marcadores y claves de `es`/`en` en popup, background y page-hook. |
| `test-regressions.js` | Carrera de navegación con volumen, locks de dash, timeout de HLS, tecla Space y preferencias de Disney por título. |
| `test-kick-dom2.js` | Diagnóstico de lectura del menú de Kick (no tiene asserts). |

Estado al publicar `1.5.8`: los 10 scripts con asserts terminan con `PASS` /
`TODO OK` y salida `0`.

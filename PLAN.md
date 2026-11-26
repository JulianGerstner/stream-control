# Plan: carga, máxima calidad y adapters de plataforma

Estado: **v1.4.8 implementada en código, pendiente de prueba en vivo en Edge.**
Este documento describe qué se hizo, por qué, y qué falta para llevarlo a
otras plataformas.

> **Nota 1.4.8**: se agregó el adapter experimental de **HBO/Max** (motor
> Gluon). El player no está en `window`: se llega por fibers de React. La
> calidad se controla con `setBitrateOverride` + `selectVariant(period)`, pero
> el build actual tiene `_closestItem` roto, así que el adapter lo repara. La
> aplicación la hace el buffer y tarda ~30 s; se aplica una sola vez. Ver 6.2.

> **Nota 1.4.7**: el selector de Disney+ ahora lista **todas las variantes
> reales del master** (altura + bitrate + codec de video), como Netflix, en vez
> de colapsarlas por altura. Se conservan los topes por altura `(ABR)`, Auto y
> el sondeo 1080p. Además, las calidades se muestran en un **desplegable**
> (`<select>`) en todas las plataformas. Ver sección 6.1.

> **Nota 1.5.7**: rebranding visible a **Stream Control**, alineado con el
> nombre del repo. Cambian `manifest.json` (`name` / `default_title`), los
> títulos de `popup.html` y `offscreen.html`, el `<h1>` del popup, el aviso de
> captura ajena en `background.js` y las referencias del `README.md`. Los
> prefijos internos `nds-` y la carpeta física `noDelayStream` quedan intactos.
> En el mismo commit final se agregó el material de publicación: iconos, tests
> en el repo, README en inglés, licencia y Release con ZIP. Ver secciones 20 y 21.

> **Nota 1.5.6**: reducción de CPU/RAM sin cambiar el comportamiento. El timer
> de reafirmación de calidad se crea solo cuando hay un lock; `qs-get-speed-info`
> responde sin escanear en frames sin `<video>` ni shadow roots; el popup consulta
> solo el frame con reproductor (con fallback) y agrupa los `input` de los
> sliders; el cartel "¿Sigues viendo?" baja a 10 s y no escanea si el video está
> sonando; `usedStreamIds` queda acotado a 64 y se remueven listeners al soltar.
> Ver sección 19.

> **Nota 1.5.5**: se agregó el cierre automático del cartel "¿Sigues viendo?"
> de **YouTube / YouTube Music**: se confirma apenas aparece y se reanuda el
> video si quedó pausado. Solo en esos hosts, con opt-out
> `localStorage.setItem("qs-still-watching","off")`. Ver sección 18.

> **Nota 1.5.4**: corrección de los 6 hallazgos de seguridad priorizados. La
> captura de audio se detiene al navegar (aunque no cambie el `tabId`), el popup
> usa la pestaña activa real, los mensajes llevan `requestId` y los comandos van
> solo al frame con reproductor, se validan `sender` / `tabId` / `streamId`, y
> los datos de las páginas se comprueban por tipo antes de mostrarse. Agregado:
> las recargas de Disney+ se agrupan (1 cada 10 s) y `IVSPlayer` solo se parchea
> en Twitch. Ver sección 17.

> **Nota 1.5.3**: la rampa de arranque de **1,06×** quedó acotada a
> **Shaka/DGO**. En YouTube, Twitch, Kick, hls.js y dash.js ya no toca la
> velocidad nunca. Además, `skip`/`abort` ahora **sueltan el pin** (antes podían
> dejar el video clavado en 1,06×), un cambio de fuente cancela la rampa en
> curso y la vuelve a medir desde cero, y la detección de vivo de YouTube ya no
> usa `isLiveContent` solo (vale también para repeticiones de directos). Se
> agregó el opt-out `localStorage.setItem("qs-ramp", "off")` y los campos
> `rampPhase`/`rampReason`/`rampBurst`/`rampWrites`/`live` en
> `__qsSpeedDebug()`. Ver sección 16.

> **Nota 1.5.2**: se corrigió el bug de Kick que abría el menú de
> **subtítulos** en vez del de calidades. El engranaje se elige por nombre/ícono
> de ajustes y, si no hay, por cercanía a la esquina inferior derecha,
> descartando subtítulos/CC/audio/idioma. Si el botón elegido abre un menú
> equivocado, el adapter lo detecta, lo cierra y prueba el siguiente candidato
> (hasta 3). El aviso ahora incluye el motivo (`menu-equivocado`,
> `menu-no-abrio`, etc.). Ver sección 6.3.

> **Nota 1.5.1**: se agregó el **selector de calidad de Kick**. No hay API
> interna: se lee el menú ARIA del player (`[role="menuitemradio"]` +
> `aria-checked`) y se aplica simulando la secuencia de puntero. La lectura abre
> y cierra el menú, se cachea 3 min y, si algo falla, el selector cae a **Auto**.
> El tope se muestra como `Máx. del stream: 1080p60`. Ver sección 6.1.

> **Nota 1.5.0**: se quitó el botón **1080p (probar)** y la escalera típica de
> Disney+: el selector solo muestra variantes reales del master y, si no se
> interceptó, queda **Auto**. Debajo del selector se agregó el **tope real de la
> sesión** (`Cuenta: hasta Xp` / `Tope: Xp`), calculado sobre la lista visible.
> Netflix dejó de mostrar variantes que su filtro bloquea. Ver sección 6.1.

> **Nota 1.4.6**: se agregó el botón **1080p (probar)** al selector de Disney+.
> No fija un tope: activa el destope y vuelve a Auto con el piso de 720p, para
> pedir el master sin `datasaver` y dejar que el ABR use 1080 si el back-end lo
> entrega. Si el master tuviera 1080 real, el botón pasa a ser un tope exacto.
> Cualquier otra elección apaga el destope. Ver sección 6.1.

> **Nota 1.4.5**: se cerró la investigación de Disney+. Con el destope activo el
> back-end **sigue firmando `r=720`** y el master crudo solo trae 720/480/360:
> el techo es del servidor, no del adapter. Se documentó ese resultado y se
> agregó un **piso de 720p en Auto** (`qs-disney-floor=0` lo apaga) para que no
> arranque en 480p. Ver sección 6.1.

> **Nota 1.4.4**: se agregó un **destope opt-in** de Disney+ (apagado por
> defecto, `sessionStorage["qs-disney-uncap"] = "1"`). Parchea el
> `brandedPlaybackAdapter` antes de crear la sesión para que el player pida el
> master sin `resolutionConstraint: "datasaver"` / 720. Sirve para comprobar si
> hay 1080p en Chrome y si Auto deja de arrancar en 480p. Ver sección 6.1.

> **Nota 1.4.3**: se agregó el adapter experimental de Disney+. El player no
> expone ABR ni permite recrear la sesión en caliente, así que la calidad se
> controla **filtrando el master playlist** (fetch/XHR) y recargando la pestaña.
> Ver sección 6.1.

> **Nota 1.4.2**: el adapter de Netflix se reescribió para el player nuevo
> (2026). La ruta `playerState.streamingSession.setBitrateFilters()` ya no
> existe; ahora se usa `playback.playbackStreamManager` (el Stream Manager
> nativo) con `restartStreaming()`. El resto de la sección 5 quedó actualizado.

> **Nota 1.4.1**: se quitó "Arranque rápido" (no aportaba lo suficiente), se
> agregó detección de vivo por API del player (YouTube/Shaka/hls.js/dash.js) y
> el adaptador de velocidad de Twitch se generalizó a Kick. Las secciones de
> este documento sobre "arranque rápido" quedan como historial.

---

## 1. Objetivos

1. **Carga**: reducir el tiempo hasta el primer frame sin romper la
   estabilidad de la reproducción.
2. **DGO**: poder fijar la máxima calidad real, no solo un techo con margen.
3. **Otras plataformas**: un selector de calidad que no dependa de un único
   reproductor. Netflix usa un adapter **experimental** sobre objetos internos
   del player, porque no tiene API pública de bitrate.

Restricción de diseño: todo lo que se agregue debe ser **opt-in**, degradar
silenciosamente si la plataforma cambió y no tocar DRM ni contenido.

---

## 2. Arquitectura de adapters

La extensión ya detecta el reproductor por *duck typing* y normaliza la lista
de calidades. La evolución natural es separar eso en adapters con la misma
interfaz:

```js
PlayerAdapter {
  detect()                    // ¿hay un player de este tipo en la página?
  getQualities()              // [{ id, label, active }]
  setQuality(id)              // id = -1 vuelve a Auto
  getVideoElement()           // <video> real, o null
  onSeek(cb)                  // para reafirmar el lock
}
```

Implementaciones:

| Adapter | Detección | Estado |
|---|---|---|
| `shaka` | `getVariantTracks` + `selectVariantTrack` | Completo |
| `hlsjs` | `levels` + `currentLevel` + `on` | Completo |
| `dashjs` | `getBitrateInfoListFor` + `setQualityFor` | Completo |
| `youtube` | `#movie_player.getAvailableQualityLevels` | Completo |

Hoy los cuatro viven en `page-hook.js`. No se refactorizó a clases para no
mover 2.300 líneas de código probado a mano; la separación es lógica, por
funciones y por `type`. Si se suman más plataformas, conviene extraer cada
adapter a su propio archivo y cargarlo solo en su host.

### Por qué no un adapter universal

No existe una API web estándar para “elegir calidad”. MSE expone buffers, no
una escalera de renditions; EME expone claves, no bitrates. Cada player
(Shaka, hls.js, dash.js, Cadmium, el de Prime/Disney) inventa su propia capa.
El DRM tampoco es el bloqueo: el bloqueo es que el player es cerrado.

---

## 3. Fase 1 — DGO / Shaka (implementado)

### 3.1 El problema

DGO usa Shaka y expone `window.player` en `buildPlayer()`. Su configuración de
producción incluye:

- `abr.enabled: true`
- `abr.switchInterval: 8`
- `abr.bandwidthUpgradeTarget: 0.9`, `bandwidthDowngradeTarget: 0.8`
- `restrictions.minHeight: 360`
- `streaming.bufferingGoal: 15`, `rebufferingGoal: 15`, `bufferBehind: 15`
- `liveSync.targetLatency: 10`, `lowLatencyMode: false`
- Al hacer seek: `player.configure("abr.enabled", true)`

Dos consecuencias:

1. El código anterior solo aplicaba `restrictions` a nivel player. Shaka tiene
   **dos** niveles: `restrictions` (qué pistas existen) y `abr.restrictions`
   (qué pistas puede elegir el ABR). Si el segundo no se toca, el ABR puede
   bajar igual.
2. DGO reactiva el ABR en cada seek. Un lock que no se reafirma ahí se pierde.

### 3.2 Qué se implementó

- `reassertShakaLock()` ahora reaplica **ambos** niveles de restricciones y,
  en modo duro, **apaga el ABR** (`abr.enabled: false`) si DGO lo volvió a
  encender.
- `attachShakaGuards()` escucha `trackschanged`, `manifestupdated`,
  `adaptation` y el `seeked` del `<video>` real (con reintentos a +300 ms y
  +1500 ms, porque DGO reconfigura en su propio handler).
- Se agregó la opción **“Máxima fija”** (`id = -2`) para Shaka: apaga el ABR,
  selecciona la variante más alta con `selectVariantTrack(track, true)` y deja
  `minHeight = maxHeight` en los dos niveles como segunda barrera.
- El propio Shaka advierte que `selectVariantTrack()` se pisa si el ABR sigue
  encendido; por eso apagarlo es parte del lock, no un detalle.
- La reselección se limita a una cada 15 s para no entrar en un bucle de
  rebuffer si la red no aguanta el máximo.
- La selección normal de una calidad sigue usando un escalón de margen hacia
  abajo, con el ABR encendido. “Máxima fija” es la única que no deja margen.

### 3.3 Límites que no se pueden romper

- **Escalera del manifest**: si DGO no publica 4K para ese contenido, no hay
  pista que elegir.
- **Widevine en escritorio**: Chrome usa L3; muchos servicios limitan a 1080p.
- **Plan y dispositivo**: DGO tiene topes por suscripción y por tipo de
  contenido (el vivo suele estar más comprimido).
- **`window.player` no es contrato público**: una actualización de DGO puede
  renombrarlo. El detector por duck typing y el fallback silencioso ya cubren
  ese caso.

### 3.4 Riesgo de “Máxima fija”

Con `minHeight = maxHeight`, si la red no sostiene ese bitrate el player
**bufferea en vez de bajar**. Es una decisión explícita del usuario; por eso
no es el comportamiento por defecto.

---

## 4. Fase 2 — Carga (implementado)

### 4.1 Diagnóstico

El tiempo hasta el primer frame se reparte entre auth/token, manifest,
licencia DRM, primer segmento y buffering inicial. La extensión solo puede
tocar lo último.

DGO espera ~15 s de buffer (`bufferingGoal: 15`) antes de arrancar. Ese es el
principal costo evitable del lado cliente.

### 4.2 Qué se implementó: “Arranque rápido”

- Checkbox en el popup, persistido en `chrome.storage.local`
  (`nds-fast-start`), apagado por defecto.
- `bridge.js` le pasa la preferencia a `page-hook.js` al cargar la página
  (el page-hook corre en MAIN world y no ve `chrome.*`).
- Con Shaka, al detectar el player:
  - guarda `streaming.bufferingGoal` / `rebufferingGoal` originales;
  - aplica `bufferingGoal: 4`, `rebufferingGoal: 2`;
  - al primer `playing` (o a los 30 s de red de seguridad) restaura los
    originales;
  - se rearma en `emptied`, para la siguiente fuente.
- Se dispara desde `play()`, desde el polling del popup y al abrir el popup.

### 4.3 Otras palancas evaluadas

| Palanca | Efecto | Decisión |
|---|---|---|
| `preconnect` / `dns-prefetch` | 100–500 ms, y llega tarde desde un content script | Ya existía; se mantiene |
| `abr.defaultBandwidthEstimate` bajo | primer segmento más chico, arranque más rápido | No se tocó: el efecto es chico y el riesgo de arrancar en 240p es alto |
| `restrictToElementSize` / `restrictToScreenSize` | permite calidades altas en ventanas chicas | No se tocó: afecta calidad, no carga |
| Cachear el bundle del player | choca con CSP/DRM | Descartado |
| Prefetch del manifest | tokens efímeros por sesión | Descartado |

### 4.4 Qué no se puede mejorar

DNS, ruteo, CDN, auth y licencia están del lado del servicio. Si DGO tarda en
responder, ninguna extensión lo arregla.

---

## 5. Fase 3 — Netflix (adapter experimental)

### 5.1 Lo nativo primero

Netflix ya trae herramientas ocultas:

- `Ctrl + Alt + Shift + S` → Stream Manager (bitrate/resolución por sesión).
- `Ctrl + Alt + Shift + D` → A/V Stats (en algunos builds).
- `Ctrl + Alt + Shift + L` → logs.
- Builds modificados de Cadmium rehabilitan el menú de bitrate con
  `Ctrl + Alt + Shift + B`.

Para uso personal, esto es más estable que cualquier extensión.

### 5.2 Por qué el prototipo viejo no funcionaba

La API pública de Cadmium (`VideoPlayerApi`) solo expone
play/pause/seek/volumen/pistas de audio. **No tiene** `setVideoBitrate`,
`setMaxBitrate` ni `setBitrate`: el prototipo anterior llamaba a métodos que no
existen y por eso el selector “no hacía nada”.

El player nuevo (2026) tampoco tiene `playerState` ni `streamingSession`: esos
objetos desaparecieron del build. La calidad se controla desde el playback
interno y su Stream Manager:

```js
pb.playbackStreamManager._overrideBitrateFilter = { [bitrate]: 1 }
pb.playbackStreamManager.createFilteredVideoStreamListOverride =
  pb.playbackStreamManager._createFilteredVideoStreamListOverride.bind(psm)
pb.playbackStreamManager.updateASE()
pb.restartStreaming()
```

### 5.3 Cómo funciona el adapter actual

1. `getNetflixSession()` obtiene la sesión pública desde
   `window.netflix.appContext.state.playerApp.getAPI().videoPlayer`.
2. `findNetflixPlayback()` resuelve la ruta conocida
   `apiPlayer.playgraphManager.playbackStrategy.segmentManager.currSession.player.playback`
   y valida por forma: `getVideoStreamList()` + `createVideoBitrateRanges()` +
   `ase.setVideoBitrateRanges()`. Si el build renombra la ruta, hace un BFS
   acotado (profundidad 6, 600 nodos).
3. `getNetflixVideoStreams()` lee
   `pb.getVideoStreamList({ viewableId: movieId })`;
   `getNetflixSelectableStreams()` descarta lo que el player marque con
   `currentSegment.mediaStreamFilter.shouldDisallowStream()` (DRM/plan/
   dispositivo).
4. `getNetflixCurrentStream()` lee `currentSegment.videoStream._value` para
   mostrar la resolución actual en el botón Auto.
5. `applyNetflixBitrate()` replica el botón Apply del Stream Manager:
   `_overrideBitrateFilter = { [bitrate]: 1 }`,
   `createFilteredVideoStreamListOverride`, `updateASE()` y
   `restartStreaming()`. Elegir un bitrate deja una sola variante disponible,
   así que equivale a “fija”.
6. **Auto** hace `createFilteredVideoStreamListOverride = undefined`,
   `setVideoBitrateRangesForViewable(movieId)` y `restartStreaming()` para
   devolver los rangos originales del player.
7. `ensureNetflixGuards()` reaplica la selección en `seeked` y `playing`
   (con debounce de 600 ms), pero **no** reinicia el streaming si el override
   sigue puesto. Si cambia la sesión (nuevo título/episodio), la selección
   vuelve a Auto.

Todo está envuelto en `try/catch`: si una función o propiedad no existe, el
adapter devuelve “no encontrado” y el popup muestra el aviso, sin romper la
página.

### 5.4 Advertencias

- La API interna es **no documentada y ofuscada**; cambia entre builds
  (`playbackStreamManager`, `_overrideBitrateFilter`,
  `createFilteredVideoStreamListOverride`, `updateASE`, `restartStreaming` son
  nombres actuales, no contrato).
- Manipularla va **contra los Términos de Servicio** de Netflix (reverse
  engineering / circumvention). Riesgo de marca de cuenta.
- **No publicar** un adapter así en Chrome Web Store: una extensión que
  manipula el player de un servicio de terceros puede ser removida.
- Si falla, el fallback es el menú nativo `Ctrl+Alt+Shift+S` /
  `Ctrl+Alt+Shift+D`.

### 5.5 4K en Chrome

- Chrome 117+ en **Windows 11**, Netflix Premium, HDCP 2.2, display 4K y HEVC
  por hardware.
- **macOS con Chrome sigue limitado a 1080p**; Safari sí hace 4K en Apple
  Silicon.
- Edge usa PlayReady y también llega a 4K en Windows.
- “Spoofear” capacidad (resolución/HDCP/UA) solo sirve si el hardware puede;
  si no, negro o error.

---

## 6. Fase 4 — Otras plataformas

| Plataforma | Motor | Dificultad | Nota |
|---|---|---|---|
| Disney+ | Player propio + DRM | Alta | **Implementado (experimental)**: filtro del master + recarga, lista completa de variantes (1.4.7), piso de 720p en Auto, sondeo 1080p. Techo real 720p (back-end). Ver 6.1 |
| Prime Video | Player propio | Alta | Widevine/PlayReady |
| Max / HBO | Player propio (Gluon) | Alta | **Implementado (experimental, 1.4.8)**: fibers de React, override de bitrate + `selectVariant`, `_closestItem` reparado. Techo real 512p (DRM). Ver 6.2 |
| Crunchyroll / Pluto / sitios chicos | hls.js / dash.js / Shaka | **Baja** | Ya cubierto por los adapters actuales |
| YouTube / Twitch | Player propio | Muy alta | Ya tienen selector nativo |
| Kick | Player propio (menú ARIA) | Media | **Implementado (experimental, 1.5.2)**: sin API de calidad; se lee y se aplica por el menú ⚙️ (`[role="menuitemradio"]` + `aria-checked`) con secuencia de puntero. Ver 6.3 |

### 6.1 Disney+ (implementado en 1.4.3, destope en 1.4.4, piso en 1.4.5, sondeo 1080p en 1.4.6, variantes en 1.4.7)

Lo que se aprendió del player:

- `<disney-web-player>` cuelga `mediaPlayer` (facade) y `mediaElement`.
- La sesión interna (`PlaybackSession`, en `window["playback-session"]`) tiene
  `brandedPlaybackAdapter` y `__private_0__mediaEngine`. El motor **no** expone
  `setQuality`, `getVideoTracks` ni control de ABR; la estrategia que recibe
  `constraints` vive en una WeakMap privada.
- `mediaPlayer.restart()` **no resuelve nunca**: el Player IO Loop ignora ese
  input y la promesa queda colgada.
- La calidad se decide **al crear la sesión**, cuando se pide el master. Con
  las constraints por defecto (`getConstraintData()` →
  `resolutionConstraint: "datasaver"` / `720`) el master de Chrome viene con
  `r=720` y 14 variantes, máximo 1280x720.
- **Resultado del destope (1.4.4)**: aun con el adapter parcheado
  (`uncapped: true`, `uncappedSessions: 2`) el master crudo sigue trayendo
  `720 / 480 / 360` y la URL sigue con `r=720`; el `<video>` arranca en
  `854x480` y una medición de Auto de 90 s nunca llegó a 1080p. El `r` se
  resuelve antes de la sesión, del lado del back-end. **No hay 1080p para esta
  sesión/dispositivo en Chrome.**
- Con tope 720 medido 60 s: `1280x720` estable, sin caídas a 480.

Mecanismo del adapter:

1. En `document_start` (solo en `disneyplus.com`) se envuelven `fetch` y
   `XMLHttpRequest` para ver los `.m3u8`.
2. Al detectar un master (`#EXT-X-STREAM-INF`), se parsean las variantes
   completas (altura, ancho, `BANDWIDTH`, `AVERAGE-BANDWIDTH`, codecs, frame
   rate, URI) y se guardan en `disneyLadder`; también las alturas únicas.
3. Se reescribe el master dejando **solo** las variantes que correspondan: con
   una variante elegida, exactamente esa (en todos los grupos de audio); con un
   tope, esa altura; en **Auto**, las de 720p o más (piso). Las URIs relativas
   se pasan a absolutas porque al reemplazar la `Response` se pierde la URL
   base.
4. `setQuality()` guarda la variante (`qs-disney-variant`) o la altura
   (`qs-disney-cap`) en `sessionStorage` y hace `location.reload()`: el player
   vuelve a pedir el master y ya lo recibe filtrado. **Auto** borra ambas
   claves, apaga el destope y recarga.
5. Si el filtro no encuentra variantes (ni la altura pedida, ni ninguna en el
   piso), devuelve el master original: nunca deja al player sin opciones.

Piso de Auto (1.4.5):

1. Sin tope elegido, `getDisneyFloor()` devuelve 720 (o 0 si
   `sessionStorage["qs-disney-floor"] === "0"`).
2. El filtro conserva `h >= floor`; si no descarta nada, devuelve el texto
   original sin reescribirlo.
3. Un tope explícito (480p/360p) tiene prioridad sobre el piso: es la salida
   para redes lentas.
4. `__qsDisneyDebug()` expone `floor`.

Variantes (1.4.7):

1. `parseDisneyVariants()` recorre el master y devuelve una entrada por
   `#EXT-X-STREAM-INF` con su URI (la primera línea no comentada después).
2. `disneyVariantKey()` arma `altura|bitrate|codec de video`. El bitrate sale
   del nominal en la URI (`composite_2400k...`) o, si no está, de
   `AVERAGE-BANDWIDTH`. Así las copias `aac`/`ec-3` del mismo video se
   colapsan en una sola entrada.
3. `rememberDisneyLadder()` fusiona las variantes entre masters de la misma
   URL y resetea la escalera cuando cambia `location.href`.
4. `filterDisneyMaster(text, height, baseUrl, variantKey)` prioriza la variante
   exacta; si no hay, la altura; si no, el piso. Si no matchea nada, devuelve
   el master original.
5. `getQualities()` lista `v:<clave>` con etiqueta `720p · 2,4 Mbps`, agrega
   `720p (ABR)` solo si hay más de una variante en esa altura, y limpia
   selecciones viejas que ya no existen en el master actual.
6. `setDisneyQuality()` acepta `v:<clave>`: guarda la variante, borra tope y
   destope, y recarga solo si hubo un cambio real.

Sondeo de 1080p (1.4.6):

1. El botón **1080p (probar)** aparece siempre que el master no traiga 1080
   real.
2. Al elegirlo se activa `qs-disney-uncap=1`, se borra el tope y se recarga:
   queda **Auto con piso** y el adapter pide el master sin `datasaver`.
3. No fuerza 1080: si el back-end no lo entrega, el ABR se queda en 720p (nunca
   en 480p). Si el master trae 1080, el mismo id pasa a ser un tope exacto.
4. Cualquier otra elección (Auto o una altura) apaga el destope y recarga solo
   si hubo un cambio real.
5. **Conclusión**: desde el cliente no se puede forzar una calidad mayor a la
   del default. El `r` va firmado en el `hash` (403 al editarlo) y se resuelve
   al crear la sesión del lado del servidor; forzar más implicaría saltear DRM
   o plan.

Destope opt-in (1.4.4):

1. Solo si `sessionStorage["qs-disney-uncap"] === "1"`, al cargar la página se
   hace polling de `window["playback-session"]` (100 ms, hasta 60 s).
2. Al encontrar el constructor, se envuelven `initialize` y `prepare` de
   `PlaybackSession.prototype` para parchear `this.brandedPlaybackAdapter`
   **antes** de que el PBO cree la sesión. Si el adapter todavía no existe, se
   intercepta la asignación de la propiedad.
3. El parche reemplaza en el prototipo del adapter:
   `getConstraintData()` → todo `"none"` / `"0"`; `preferredResolutionMax` →
   `["res1920x1080","res1280x720","res854x480"]`; `isResolutionCappedByDRM()`
   → `false`.
4. Es reversible: se borra la clave y se recarga. `__qsDisneyDebug()` expone
   `uncap`, `uncapped` y `uncappedSessions`.
5. Sirve para dos preguntas: ¿el master destopado trae 1080p? y ¿el ABR deja
   de arrancar en 480p? **Respuesta medida**: no trae 1080p (sigue `r=720`) y
   Auto arranca en 480p. El techo lo pone el back-end; para el segundo síntoma
   está el piso de Auto de 1.4.5.

Limitaciones:

- Depende de que el master se pida por `fetch`/XHR desde el hilo principal. Si
  Disney lo moviera a un Worker, el interceptor no lo ve.
- El techo de 720p lo pone el backend, no la extensión.
- Elegir una altura fija puede buffear si la red no sostiene el pico. El piso
  de Auto tiene el mismo riesgo, pero acotado a 720p.

Estrategia recomendada: **no** perseguir a las grandes. El valor marginal está
en sitios con `hls.js`/`dash.js`/Shaka, que ya funcionan. Cada plataforma
grande es un adapter nuevo + mantenimiento permanente.

### 6.2 HBO/Max (implementado en 1.4.8)

Max usa el motor **Gluon** (`GLUON_BROWSER 11.1.0`) y no expone el player en
`window`. El camino que funcionó:

1. Desde el `<video>` se sube por el árbol de **fibers de React** hasta una
   clase de sesión (`tz`) que tiene `_playbackEngineAdapter`; de ahí se llega a
   `engine._player.getSession()`.
2. La sesión expone `_loadedData.buffer._variantSelector` y `_period`. La
   escalera sale de `selector._forecaster._manifest.periods[0].video` y, más
   filtrada, de `buffer._selectedVariants.get(period)`.
3. La palanca oficial es `selector.setBitrateOverride(bps)` y luego
   `buffer.selectVariant(period)` (recibe el **período**, no una variante;
   re-ejecuta filtros + selección y devuelve Promise).
4. El build actual tiene `_closestItem` roto: `_closestItemIndex` usa
   `list.find({bandwidth})` y siempre devuelve `-1`, así que el override nunca
   enganchaba. El adapter lo reemplaza una vez por sesión por un "bitrate más
   cercano" real. Es idempotente y guarda el original.
5. La selección cambia al instante en `_selectedVariantMap`, pero el video
   decodifica la nueva variante recién cuando el buffer se renueva. Medido en
   vivo: **~30 s** en ambos sentidos, con buffer estable de ~10 s. Por eso se
   aplica **una sola vez** y la opción elegida queda marcada como activa
   (optimista) mientras el buffer aplica.
6. **Auto** = quitar `_abrOverride` y `_options.maxBandwidth`, y re-seleccionar.
   El tope `(ABR)` usa `_options.maxBandwidth` (el `forecast` filtra por
   `bandwidth <= maxBandwidth`).

Medido en vivo en este equipo:

- Escalera real (6): `0-v5` 1024×512 4.438.416; `0-v0` 768×384 552.458;
  `0-v4` 768×384 964.244; `0-v1` 768×384 1.610.436; `0-v3` 768×384 2.658.116;
  `0-v2` 1280×640 7.021.297.
- La lista que recibe el selector tiene **5**: el "Digital Rights Variant
  Filter" rechaza la 640p en este equipo. **Techo real: 512p.**
- `setBitrateOverride(552458)` + `selectVariant(period)` → `buffer` a `0-v0` en
  t=1 y `decoded` a `768x384` en t=31. Auto → `0-v5` en t=1 y `1024x512` en
  t=30.

Limitaciones:

- Depende de la forma interna de Gluon y de los fibers de React. Si Max cambia
  el player, el adapter deja de encontrar la sesión (el popup avisa).
- La latencia de ~30 s es del buffer, no del adapter: no se puede acelerar sin
  pelear con el ABR.
- La preferencia vive en memoria: al recrear la sesión (otro título) vuelve a
  Auto.
- El tope `(ABR)` está implementado y cubierto por simulación, pero **falta
  validarlo en vivo**.

### 6.3 Kick (implementado en 1.5.1, corregido en 1.5.2)

Lo que se aprendió del player:

- Kick **no** expone `hls.js`, `dash.js`, `Shaka` ni una instancia con
  `getQualities`/`setQuality`. El recorrido de fibers y los expandos del DOM no
  encontraron nada parecido (el adaptador de velocidad ya lo había comprobado).
- La única fuente real de calidad es el **menú ⚙️**, construido con primitivas
  ARIA: el botón es `button[aria-haspopup="menu"]` y las opciones son
  `[role="menuitemradio"]` con `aria-checked="true"` en la elegida. Algunos
  layouts muestran primero un `[role="menuitem"]` con el texto “Quality”.
- El menú **ignora `.click()`**: hay que despachar la secuencia completa
  `pointerover → pointerenter → pointerdown → mousedown → pointerup → mouseup →
  click`. Es la misma técnica del userscript *Kick Stream Tweaks*.
- Los controles se ocultan por inactividad, así que antes de buscar el engranaje
  hay que simular `pointermove` sobre el video.
- Etiquetas típicas: `1080p60`, `720p60`, `480p`, `360p`, `160p`, `Auto`. La
  altura nominal se puede parsear del prefijo (`1080p60` → 1080), así que el
  tope y el orden usan los helpers comunes.

Decisiones del adapter:

- Kick tiene **varios** botones con `aria-haspopup="menu"` (subtítulos, audio,
  ajustes). Se elige por nombre/ícono de ajustes; si no hay, por cercanía a la
  esquina inferior derecha. Subtítulos/CC/audio/idioma y los controles conocidos
  (play, volumen, pantalla completa, etc.) se descartan explícitamente. No hay
  fallback a “cualquier botón”.
- Si el botón elegido abre un menú que no tiene opciones con forma de calidad
  (subtítulos, audio…), se detecta a los ~0,7 s, se cierra y se prueba el
  siguiente candidato, hasta 3. Un menú de nivel superior con una entrada
  “Calidad”/“Quality” no cuenta como equivocado: se entra en esa opción.
- Leer la lista **abre el menú** un instante; se cachea 3 min por URL para no
  parpadear en cada refresco del popup. Los fracasos no se cachean: si el
  player todavía está cargando, el popup reintenta una vez a los 1,5 s.
- Aplicar una calidad abre el menú, hace click en la opción y verifica
  `aria-checked`.
  Mientras se aplica, el refresco del popup usa el cache optimista en vez de
  abrir el menú otra vez.
- Si el menú no aparece o cambió, el selector queda en **Auto** (no se inventan
  escalones) y el resto de la extensión sigue igual.
- No se re-aplica sola al recargar: hacerlo implicaría abrir el menú sin acción
  del usuario.
- Tope: `Máx. del stream: 1080p60`. Kick no tiene planes, así que no se habla de
  límite de cuenta.

### Advertencia sobre extensiones QVI

Evitar las extensiones marcadas **QVI (Quality Viewership Initiative)**: hay
denuncias de recolección de datos de visualización de ~1.1 millones de
usuarios de streaming. Varias aparecen en la Web Store con “[QVI]” en el
nombre.

---

## 7. Checklist de pruebas

### DGO / Shaka

1. Abrir un vivo, esperar detección.
2. Elegir un 720p: el ABR puede quedar en 720p o un escalón abajo, nunca
   arriba.
3. Elegir **“Máxima fija”**: `getVariantTracks()` debe mostrar la altura
   máxima como activa.
4. Hacer seek ±30 s: la calidad debe seguir en el máximo (no debe caer).
5. Esperar 1–2 min: no debe bajar sola.
6. Volver a **Auto**: debe poder subir/bajar libremente.

### Arranque rápido

1. Activar el checkbox y recargar la pestaña del video.
2. Medir `performance.now()` hasta `playing` con y sin el toggle.
3. Confirmar que a los pocos segundos de reproducir el `bufferingGoal` volvió
   al valor original (consola: `window.player.getConfiguration().streaming`).
4. Probar con red limitada (DevTools → throttling): no debería cortarse más
   que antes.

### Netflix

1. Abrir un título en `netflix.com` y dar play.
2. Abrir el popup: debe mostrar las calidades y **Auto**.
3. Elegir un bitrate intermedio y confirmar en el menú nativo
   (`Ctrl+Alt+Shift+S`) que el player queda en ese valor.
4. Hacer seek y esperar 1–2 min: la selección debe reaplicarse.
5. Probar **Auto** y confirmar que el player vuelve a adaptarse.
6. Si el popup dice “no encontrado”, correr el diagnóstico del README y
   comparar los nombres internos.

### Disney+

1. Abrir un episodio en `disneyplus.com` y dar play.
2. Popup: `Disney+ (experimental)` + **desplegable de calidad** con
   **1080p (probar)**, **Auto**, una entrada por variante
   (`720p · 2,4 Mbps`, ...) y topes `(ABR)` por altura.
3. Consola: `__qsDisneyDebug()` → `intercepted: true`, `ladder.heights` y
   `ladder.variants`.
4. Elegir una **variante** (recarga), dar play y confirmar
   `__qsDisneyDebug().variant === "720|2400k|avc1.64001f"`; el audio debe
   seguir funcionando (el master conserva aac y ec-3).
5. Elegir un **tope** `720p (ABR)` (recarga): `cap: 720`, `variant: null`, y el
   ABR elige el bitrate dentro de 720p.
6. Elegir **480p** (recarga), dar play y confirmar `cap: 480` y que el video
   quede en 480p.
7. Volver a **Auto** (recarga): el master ya no trae 480/360 y
   `__qsDisneyDebug().floor === 720`; el video no debería quedar en 480p.
8. Piso off: `sessionStorage.setItem("qs-disney-floor","0")` + recarga →
   `floor: 0` y el master vuelve intacto. Reponer borrando la clave.
9. **1080p (probar)**: recarga; `uncap: true`, `cap: null`, `floor: 720`. Si el
   back-end entrega 1080, `ladder.heights` lo incluye; si no, el video queda en
   720p. Volver a Auto apaga el destope.
10. Si `intercepted` es `false`, el master se pide por un camino no interceptado
    (Worker): el filtro no aplica.
11. Destope manual (equivalente al botón):
    `sessionStorage.setItem("qs-disney-uncap","1")` + recarga. Dar play y
    comprobar `__qsDisneyDebug().uncapped === true`; mirar si `ladder.heights`
    incluye `1080` (medido: no, sigue en `r=720`). Para Auto, esperar 60 s sin
    tocar y comparar `dp.mediaElement.videoHeight`. Apagar borrando la clave y
    recargando.

### HBO/Max

1. Abrir un episodio en `hbomax.com` (o `max.com`) y dar play unos segundos.
2. Popup: `HBO/Max (experimental)` + **desplegable** con las variantes reales
   (`512p · 4,44 Mbps`, `384p · 1,61 Mbps`, ...), `384p (ABR)` y `Auto (512p)`.
3. Consola: `__qsHboDebug()` → `found: true`, `closestFixed: true`,
   `variants` con 5 entradas (la 640p no está: DRM la rechaza).
4. Elegir `384p · 552 kbps`: el desplegable la marca al instante;
   `override: 552458`, `selected: 384`. El video baja a `768x384` cuando el
   buffer se renueva (**~30 s**), sin tocar nada más.
5. Elegir `384p (ABR)`: `maxBandwidth: 2658116`, `override: null`.
6. Volver a **Auto**: `override` y `maxBandwidth` en `null`; el video regresa a
   `1024x512` en ~30 s.
7. Si `selected` cambia pero `decoded` no después de 60 s, el buffer no se
   renovó: probar un seek corto o esperar otro ciclo.

### Kick

1. Abrir un canal en `kick.com` y dar play.
2. Popup: `Kick (experimental)` + desplegable con las opciones reales
   (`1080p60`, `720p60`, …, `Auto`) y `Máx. del stream: 1080p60`.
3. Al abrirlo, el menú ⚙️ se abre y se cierra solo una vez (es la lectura). Si
   volvés a abrir el popup dentro de 3 min, no debe volver a parpadear.
4. Elegir `720p60`: el menú se abre, queda marcada esa opción y el video cambia
   de resolución en el siguiente segmento.
5. Elegir **Auto**: vuelve a la opción Auto del menú.
6. Consola: `__qsKickDebug()` → `cached` con las etiquetas y `video` con
   `width/height` reales. `__qsKickScan()` fuerza una lectura nueva.
7. Si el menú cambió de selectores: `cached` queda vacío, el selector muestra
   solo **Auto** y el aviso dice en qué paso falló (`sin-engranaje`,
   `menu-no-abrio`, `menu-vacio`). `__qsKickProbe()` lista videos, botones,
   menús y opciones; `__qsKickProbe(true)` intenta abrir el menú y reporta el
   motivo. Velocidad y volumen siguen funcionando.

### Regresión

1. Twitch: “Ponerse al día” y velocidad siguen funcionando.
2. YouTube: el selector sigue listando calidades.
3. Volumen: captura, badge y “Dejar de capturar” siguen funcionando.
4. Páginas sin player: el popup dice “no se detectó” y no cuelga.

---

## 8. Roadmap sugerido

1. **Probar en Chrome real** lo implementado y ajustar umbrales.
2. Medir el arranque con `PerformanceObserver` / `performance.now()` antes de
   dejar el toggle como recomendado.
3. Extraer adapters a archivos separados si se suman plataformas.
4. Evaluar un `defaultBandwidthEstimate` configurable (no automático).
5. Netflix: mantener el adapter como **experimental y opt-in**. Si Netflix
   cambia los nombres internos, actualizar `findNetflixPlayback` o dejar
   solo el menú nativo. Nunca publicarlo como función estable en la tienda.

---

## 9. Archivos tocados en v1.4.0

- `page-hook.js` — lock Shaka de dos niveles con ABR apagado en “Máxima
  fija”, arranque rápido, adapter experimental de Netflix y aviso/fallback.
- `bridge.js` — puente de `nds-fast-start` y preferencia al cargar.
- `popup.html` / `popup.css` / `popup.js` — checkbox de arranque rápido,
  etiquetas de tipo de player, selector de Netflix experimental y aviso.
- `manifest.json` — versión `1.4.0`.
- `README.md` — documentación de los cambios.
- `PLAN.md` — este documento.

---

## 10. Archivos tocados en v1.4.3

- `page-hook.js` — adapter de Disney+: detección de `<disney-web-player>`,
  interceptores de `fetch`/XHR para el master playlist, filtro por altura,
  `sessionStorage` para la preferencia y recarga para aplicar. También se
  agregó Disney+ a la detección de vivo y a `getMediaElementForPlayer`.
- `popup.js` — etiqueta `Disney+ (experimental)` y mensaje de "no detectado"
  actualizado.
- `manifest.json` — versión `1.4.3`.
- `README.md` / `PLAN.md` — sección de Disney+, advertencias y checklist.

---

## 11. Archivos tocados en v1.4.4

- `page-hook.js` — destope opt-in de Disney+: polling de
  `window["playback-session"]`, wrap de `PlaybackSession.prototype.initialize`
  y `prepare`, parche del `brandedPlaybackAdapter` (`getConstraintData`,
  `preferredResolutionMax`, `isResolutionCappedByDRM`). Diagnóstico ampliado
  en `__qsDisneyDebug()` (`uncap`, `uncapped`, `uncappedSessions`) y flag
  `intercepted` corregido para el camino XHR.
- `manifest.json` — versión `1.4.4`.
- `README.md` / `PLAN.md` — sección de destope y checklist.

---

## 12. Archivos tocados en v1.4.5

- `page-hook.js` — piso de Auto en Disney+: `DISNEY_FLOOR_KEY`
  (`qs-disney-floor`) y `DISNEY_AUTO_FLOOR = 720`; `filterDisneyMaster()` ahora
  acepta altura `null` y conserva las variantes `>= floor`; los interceptores
  de fetch/XHR ya no cortan en Auto; el selector muestra
  `Auto (mín. 720p)`; `__qsDisneyDebug()` expone `floor`. Aviso del popup y
  comentarios actualizados con el resultado medido (techo 720 del back-end).
- `manifest.json` — versión `1.4.5`.
- `README.md` / `PLAN.md` — resultado del destope, sección de piso de Auto y
  checklist actualizado.

---

## 13. Archivos tocados en v1.4.6

- `page-hook.js` — botón **1080p (probar)** en Disney+:
  `DISNEY_PROBE_ID = 1080`; si el master no trae 1080, elegirlo activa
  `qs-disney-uncap` y deja Auto con piso (no fuerza un tope); si el master sí
  trae 1080, el mismo id funciona como tope exacto. Cualquier otra elección
  apaga el destope y solo recarga si hubo un cambio real. Aviso del popup
  actualizado.
- `manifest.json` — versión `1.4.6`.
- `README.md` / `PLAN.md` — botón de sondeo, respuesta sobre forzar la calidad
  desde el cliente y nota de instalación en Edge.

## 14. Archivos tocados en v1.4.7

- `page-hook.js` — lista completa de variantes de Disney+:
  `DISNEY_VARIANT_KEY` (`qs-disney-variant`), `getDisneyVariantKey()` /
  `storeDisneyVariantKey()`; `parseDisneyStreamInf()`, `parseDisneyVariants()`,
  `disneyVideoCodec()`, `disneyVariantKey()`, `disneyVariantBitrate()` y
  `disneyVariantLabel()`; `rememberDisneyLadder()` guarda
  `{ url, heights, variants, at, href }`, fusiona variantes de la misma URL y
  resetea al cambiar `location.href`; `filterDisneyMaster()` acepta
  `variantKey` y conserva todos los grupos de audio de la variante elegida;
  los interceptores fetch/XHR pasan la variante; `setDisneyQuality()` soporta
  ids `v:<clave>`; `getQualities()` lista variantes, topes `(ABR)` por altura,
  sondeo 1080p y Auto, y limpia selecciones viejas; `__qsDisneyDebug()` expone
  `variant`; aviso del popup actualizado y aviso si `intercepted` es `false`.
- `manifest.json` — versión `1.4.7`.
- `popup.html` / `popup.css` / `popup.js` — la lista de calidades pasó de una
  grilla de botones a un **desplegable** (`<select id="quality-select">`). Se
  arma una opción por calidad con su id real (número, `-1` o `v:<clave>`) y al
  cambiar se envía `set-quality`, se deshabilita el control mientras aplica y
  se recarga la lista.
- `README.md` / `PLAN.md` — sección de variantes, etiquetas, claves de
  `sessionStorage`, desplegable y checklist de prueba.

## 15. Archivos tocados en v1.4.8

- `page-hook.js` — adapter de HBO/Max: `isHboHost()`, `hboPartsFromSession()`,
  `hboFindSession()` / `hboScanFiber()` (fibers de React), `hboCachedList()`,
  `hboVariants()`, `hboVariantLabel()`, `hboEnsureClosestFix()` (repara
  `_closestItem`), `applyHboQuality()` (exacta / tope `(ABR)` / Auto con
  `setBitrateOverride` + `selectVariant`), `getHboQualities()` y
  `__qsHboDebug()`; detección tipo `hbo` en `scanForPlayer` /
  `isPlayerStillAlive`; ramas en `getQualities` / `setQuality`; aviso del
  popup.
- `popup.js` — `hbo: "HBO/Max (experimental)"` en `typeLabels`; mensajes de
  "no detectado" y de error generalizados para los selectores experimentales.
- `manifest.json` — versión `1.4.8`.
- `README.md` / `PLAN.md` — changelog, sección HBO/Max, limitaciones y
  checklist de prueba.

## 16. Archivos tocados en v1.5.3

- `page-hook.js` — rampa de arranque acotada a **Shaka/DGO**:
  - `rampSample()` descarta cualquier otro motor (`motor-no-shaka`) y solo
    arranca con Shaka confirmado.
  - `isAdapterPage()` (Twitch/Kick) corta la rampa sin esperar el timeout.
  - `releaseRampRate()` suelta el pin de 1,06×; `abortStartupRamp()` y
    `skipStartupRamp()` lo llaman. `resetStartupRamp()` también libera si
    estaba `ramping`.
  - `startRampTimer()` centraliza el intervalo; `resetStartupRamp()` lo
    rearranca y `finish`/`skip`/`abort` lo detienen.
  - `restart` en `emptied`/`loadstart` ya no ignora `measuring`/`ramping`:
    finaliza la rampa, vuelve a 1× y mide de nuevo.
  - `ensureRampWatch()` respeta el opt-out `qs-ramp=0|off|false`.
  - `playerLiveHint()` de YouTube ya no trata `isLiveContent` como vivo: exige
    `duration === Infinity`; con duración finita devuelve `vod`.
  - `__qsSpeedDebug()` expone `live`, `rampPhase`, `rampReason`, `rampBurst`,
    `rampWrites` y `rampDisabled`.
- `manifest.json` — versión `1.5.3`.
- `README.md` — condiciones de la rampa, opt-out y diagnóstico.
- `PLAN.md` — esta sección.

### Prueba de la rampa (1.5.3)

1. YouTube: abrir un directo, dejarlo unos segundos y pasar a una canción sin
   recargar. La velocidad debe quedar en 1×; `__qsSpeedDebug()` debe mostrar
   `rampPhase: "skipped"` y `rampReason: "motor-no-shaka"`.
2. Repetición de un directo (`isLiveContent: true` con duración finita): no
   debe considerarse vivo.
3. DGO/Shaka: la rampa sigue funcionando (`rampPhase: "ramping"`, popup con
   “Ajuste 1,06×”) y vuelve a 1× sola.
4. Opt-out: `localStorage.setItem("qs-ramp","off")` y recargar. La rampa no
   corre (`rampDisabled: true`).

---

## 17. Archivos tocados en v1.5.4

Auditoría de seguridad: no hay severidad alta (sin `eval`, XSS, `postMessage`,
red saliente ni credenciales). Se corrigieron los 6 puntos priorizados:

1. **Captura al navegar** (`background.js`): `capturedTabs` guarda la URL al
   activar la captura. `chrome.tabs.onUpdated` la detiene cuando `changeInfo.url`
   cambia y exige una nueva acción del usuario. `onRemoved` limpia el estado.
2. **Pestaña activa real** (`popup.js`): se eliminó `volumeTab`. Slider, presets,
   teclas, restaurar por dominio, consulta de estado y **Detener** usan
   `getActiveTab()` en el momento del comando.
3. **`requestId` anti-spoofing** (`popup.js`, `bridge.js`, `page-hook.js`): cada
   pedido lleva un id único; el puente solo acepta la respuesta con ese id y
   `page-hook.js` lo hace eco en las 4 respuestas. Los comandos se envían al
   `frameId` que reportó `found` (`speedFrameId`, `qualityFrameId`), con fallback
   al broadcast. Así un iframe hostil no puede inducir un cambio en el frame
   principal.
4. **Validación de emisor y significado** (`background.js`, `offscreen.js`):
   `isFromPopup()` exige `sender.id` propio, sin `sender.tab` y la URL del popup.
   `operableTabUrl()` exige un entero no negativo y un tab http(s) existente. El
   offscreen exige mensajes del background, `tabId` entero, `streamId` no vacío
   y no reutilizado (`usedStreamIds`), con tope de 32 estados de audio.
5. **Tipos en el popup** (`popup.js`): `finiteNumber()` y `safeText()` antes de
   `.toFixed()` y de escribir textos/etiquetas; la lista de calidades se filtra
   a ids primitivos y se limita a 100 entradas.
6. **Comandos de la página** (`page-hook.js`): `qs-set-speed` exige `rate`
   numérico finito; las recargas de Disney+ pasan por `scheduleDisneyReload()`
   (una cada 10 s, agrupando cambios seguidos) y `IVSPlayer` solo se parchea en
   Twitch.

- `manifest.json` — versión `1.5.4`.
- `README.md` — sección "Seguridad y mensajería" y aviso de captura al navegar.
- `PLAN.md` — esta sección.

### Prueba de seguridad (1.5.4)

1. Activar volumen en un video y navegar esa pestaña a otra URL: el badge se
   limpia y el popup dice "Sin captura". El audio de la nueva página no se
   captura.
2. Abrir el popup, cambiar de pestaña y mover el slider: el cambio aplica a la
   pestaña activa nueva, no a la que estaba al abrir.
3. Volver a la pestaña original: la captura no se reactiva sola ("Detener"
   sigue sin efecto hasta volver a activarla).
4. En una página con iframe de terceros, el popup debe mostrar las calidades del
   frame con reproductor; un evento `CustomEvent` falso con otro `requestId` no
   debe cambiar la UI ni la calidad.
5. Ejecutar `test-security.js` (VM con mocks): 19 comprobaciones de `requestId`,
   `sender`, `tabId`, `streamId`, navegación y tipos.
6. Regresión: `test-ramp.js` (10 PASS), `test-kick-cog.js`,
   `test-kick-wrong-menu.js`, `test-kick-dom2.js` y `check-ids.js`.

---

## 18. Cartel "¿Sigues viendo?" en YouTube / YouTube Music

Pedido del usuario: que no aparezca el cartel que pausa el video después de un
rato sin interacción. Se eligió **auto-cerrar y reanudar**, sin interruptor en el
popup.

Implementación en `page-hook.js` (bloque autónomo, solo `youtube.com` incluido
`music.youtube.com`, solo frame principal):

1. `qsStillDeepQuery()` busca los diálogos (`ytmusic-you-there-renderer`,
   `yt-confirm-dialog-renderer`, `ytd-confirm-dialog-renderer`,
   `tp-yt-paper-dialog`, `paper-dialog`, `[role="dialog"]`) recorriendo también
   Shadow DOM abiertos y los cerrados registrados por el hook de `attachShadow`.
2. `QS_STILL_PROMPT_RE` filtra por texto del cartel (inglés y español, "watching"
   y "listening"). Otros diálogos se ignoran.
3. `qsStillConfirmButton()` elige el botón: primero `#confirm-button` / `#button`
   (los IDs que usan YouTube y YTM), después texto afirmativo
   (`Sí`, `Sí, seguir viendo`, `Yes`, `Continue`, ...) y por último el último
   botón visible que no diga `No`/`Cancelar`.
4. Después del click, `qsStillResume()` llama a `video.play()` y, si sigue
   pausado 700 ms después, toca el botón de play del reproductor. Nunca toca un
   video que ya esté sonando.
5. Un mismo diálogo se marca por 10 s para evitar confirmarlo dos veces.
   `MutationObserver` con debounce de 120 ms + escaneo de seguridad cada 2,5 s.
6. Opt-out: `localStorage["qs-still-watching"] = 0|off|false`, igual que la
   rampa. Diagnóstico: `__qsStillWatchingDebug()`.

Degrada silenciosamente: si el sitio cambia los selectores, no hace nada.

Prueba: `test-still-watching.js` extrae el bloque real y lo corre con un DOM
mock (11 PASS): YouTube, YouTube Music, español, botón "No", otro host, opt-out,
otro diálogo y video ya en reproducción. Regresión: `test-ramp.js`,
`test-security.js` y `check-ids.js` siguen pasando.

Archivos tocados en v1.5.5:

- `page-hook.js` — bloque del confirmador del cartel (detección con Shadow DOM,
  elección del botón, reanudación, opt-out y `__qsStillWatchingDebug()`).
- `manifest.json` — versión `1.5.5`.
- `README.md` — sección "Cartel ¿Sigues viendo?" y fila de diagnóstico.
- `PLAN.md` — esta sección.

---

## 19. v1.5.6 — Livianidad (CPU/RAM)

Sin cambios de comportamiento declarados; solo se evita trabajo innecesario.

1. `page-hook.js`: `ensureLockCheckTimer()` / `releaseLockCheckTimer()` crean y
   apagan el intervalo de 4 s solo mientras haya `lockedInstances`.
2. `page-hook.js`: contador de `attachShadow` para responder `found: false` en
   `qs-get-speed-info` cuando el frame no tiene `<video>` ni shadow roots.
3. `page-hook.js`: el safety-net del cartel pasa de 2500 ms a 10000 ms y
   `qsStillVideoPlaying()` evita escanear mientras el video reproduce. El
   `MutationObserver` sigue cubriendo la aparición normal del diálogo.
4. `popup.js`: `speedPollLoop()` usa `sendToFrame()` cuando `speedFrameId` es
   conocido y cae al broadcast si la respuesta no es `found: true`.
5. `popup.js`: `flushSpeedSlider()` / `flushVolumeSlider()` agrupan los eventos
   `input` (100/120 ms) y envían el valor final en `change`; los timers se limpian
   en `unload`.
6. `offscreen.js`: FIFO de 64 en `usedStreamIds` y `state.cleanups` para remover
   `statechange` / `ended` en `stopTab()`.

No se tocó `manifest.json` más allá del bump de versión: sigue `all_frames: true`.

Prueba: `test-perf-lite.js` (20 PASS) cubre los seis puntos con código real
extraído de los archivos. Regresión: `test-security.js` (19),
`test-still-watching.js` (11), `test-ramp.js` (10) y `check-ids.js` siguen pasando.

Archivos tocados en v1.5.6:

- `page-hook.js`, `popup.js`, `offscreen.js` — optimizaciones.
- `manifest.json` — versión `1.5.6`.
- `README.md` — versión actual.
- `PLAN.md` — esta sección.

---

## 20. v1.5.7 — Rebranding a Stream Control

Solo cambios visibles; ningún mensaje, target ni clave de almacenamiento cambia.

1. `manifest.json`: `name` y `action.default_title` pasan a `Stream Control`.
2. `popup.html`: `<title>` y `<h1>` pasan a `Stream Control`.
3. `offscreen.html`: `<title>Stream Control · audio</title>`.
4. `background.js`: el aviso cuando otra extensión ya captura el audio dice
   `Stream Control` en vez de `noDelayStream`.
5. `README.md`: título y referencias al nombre de la extensión. Se conserva
   `noDelayStream` en el paso de instalación porque es la carpeta física.

Se dejan sin tocar a propósito: los prefijos `nds-` (targets, mensajes,
`requestId`, storage keys) y la ruta de carga `noDelayStream`. Por eso no hay
cambios de comportamiento ni de compatibilidad con configuraciones previas.

Prueba: `check-ids.js` sin IDs faltantes, `node --check background.js`,
`test-security.js` 19 PASS. El manifest local reporta
`Stream Control | Stream Control | 1.5.7`.

Archivos tocados en v1.5.7:

- `manifest.json` — nombre visible y versión `1.5.7`.
- `popup.html`, `offscreen.html`, `background.js` — textos visibles.
- `README.md` — nombre y versión actual.
- `PLAN.md` — esta sección.

---

## 21. v1.5.7 — Material de publicación

Sin cambios de comportamiento; la versión funcional sigue siendo `1.5.7` y el
tag `v1.5.7` apunta al commit final que incluye esta sección.

1. `icons/icon16.png`, `icon48.png`, `icon128.png`: diseño original (play +
   barra de velocidad), generado sin dependencias y referenciado desde
   `manifest.json` (`icons`). Con esto se puede encarar la lista de la Web Store.
2. `tests/`: los 9 scripts que antes vivían fuera del repo ahora calculan la
   raíz con `__dirname`. `npm test` corre los 8 con asserts; `npm run check`
   hace `node --check` en los 5 JS; `test-kick-dom2.js` queda como diagnóstico.
3. `README.en.md`: resumen en inglés, diagrama Mermaid de la arquitectura
   (MAIN world vs. isolated world) y tabla de motores. `README.md` enlaza a él,
   agrega el mismo diagrama y aclara la instalación desde Release.
4. `docs/streamcontrolui.png`: captura real del popup aportada por el autor
   (275×476). Reemplaza la ilustración usada mientras no había Chrome visual.
5. `LICENSE`: MIT.

Publicación: tag `v1.5.7` + Release con ZIP `stream-control-1.5.7.zip`, y
descripción/topics del repo configurados por la API de GitHub. El ZIP se
genera con `Compress-Archive` y no se commitea (`.gitignore` ya excluye
`*.zip`).

Archivos tocados en esta sección:

- `manifest.json` — clave `icons`.
- `README.md`, `README.en.md`, `PLAN.md` — documentación.
- `package.json`, `tests/*`, `LICENSE`, `icons/*`, `docs/*` — nuevos.

---

## 22. v1.5.8 — Idioma de la interfaz según el navegador

Sin selector manual: `chrome.i18n` elige entre `_locales/es` y `_locales/en`
según el idioma de la UI de Chrome/Edge. Si el navegador está en otro idioma,
Chrome usa el `default_locale` (`es`). No cambia ningún comportamiento: solo
textos visibles.

1. `manifest.json`: `default_locale: "es"`, descripción localizable con
   `__MSG_extDescription__` y versión `1.5.8`.
2. `popup.html`: atributos `data-i18n`, `data-i18n-title` y `data-i18n-aria`
   para los textos y accesorios estáticos.
3. `popup.js`: helper `t()` con fallback en español, `applyStaticI18n()` para
   marcar `<html lang>`, textos dinámicos traducidos y `UI_STRINGS` con los
   avisos que necesita el reproductor.
4. `page-hook.js` corre en el MAIN world y no ve `chrome.i18n`: el popup manda
   los textos ya traducidos en `{ type: "get-qualities", strings }`.
   `bridge.js` filtra el paquete (hasta 60 claves, valores de hasta 300
   caracteres) y `page-hook.js` los aplica con `tr()` / `trf()` en avisos,
   topes, etiquetas y diagnósticos. Si no llegan, sigue en español.
5. `background.js`: mismo helper `t()` con fallback para los errores de
   captura, de modo que los mocks de tests sigan funcionando sin `chrome.i18n`.

Se dejan intactos los prefijos `nds-`, la carpeta `noDelayStream`, los mensajes
internos y las claves de storage.

Validación: `node --check` en los 5 JS, parseo JSON de `manifest.json` y de
ambos `messages.json`, y `npm test` (8 scripts con asserts) sin fallos.

Archivos tocados en v1.5.8:

- `_locales/es/messages.json`, `_locales/en/messages.json` — nuevos.
- `manifest.json`, `package.json` — default locale, descripción y versión.
- `popup.html`, `popup.js`, `bridge.js`, `page-hook.js`, `background.js` —
  textos y puente de strings.
- `README.md`, `README.en.md`, `PLAN.md` — documentación.

Corrección sobre la marcha: `chrome.i18n` puede devolver `$1` sin sustituir
cuando el mensaje no declara `placeholders`. `popup.js` ahora tiene
`fillI18n()` y `t()` rellena los marcadores tanto sobre el valor localizado
como sobre el fallback, así que `3.2 s buffer` no se muestra como
`$1 s buffer`. Se agregó `tests/test-i18n.js` a `npm test` para simular ese
caso. La versión sigue siendo `1.5.8` porque todavía no hay Release/ZIP.

Publicación: versión y commit/push autorizados. Release y ZIP de `1.5.8` no se
generan en esta sección.

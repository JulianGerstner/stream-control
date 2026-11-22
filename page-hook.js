// Este script corre en el "MAIN world", es decir, en el mismo contexto de JS
// que el sitio web. Por eso puede ver variables globales como window.Hls,
// window.dashjs, etc. Nunca corre en el contexto aislado de la extensión.

(function () {
  if (window.__qsHooked) return;
  window.__qsHooked = true;

  // Muchos reproductores modernos (incluido Shaka en varios sitios) meten el
  // <video> dentro de un Shadow DOM para encapsular sus estilos. Si ese
  // shadow root se crea en modo "closed", ni siquiera nuestro propio script
  // puede verlo con querySelector normal. Por eso interceptamos
  // attachShadow ANTES de que la página cree el suyo (este script corre en
  // document_start, así que llegamos primero) y nos guardamos una
  // referencia igual, sin importar el modo que hayan pedido.
  const __qsShadowRegistry = new WeakMap();
  try {
    const originalAttachShadow = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function (init) {
      const root = originalAttachShadow.call(this, init);
      __qsShadowRegistry.set(this, root);
      return root;
    };
  } catch (e) {}

  let currentPlayer = null; // { type: 'hls' | 'dash' | 'shaka' | 'youtube' | 'netflix' | 'disney' | 'hbo' | 'twitch' | 'kick', instance }

  // Instancias con una calidad "bloqueada" manualmente. Cuando el ABR del
  // reproductor intenta bajar la calidad (por un rebuffer, un error, etc.),
  // usamos esto para volver a forzarla. key = instancia del player.
  const lockedInstances = new Map();

  // --- Shaka ---------------------------------------------------------------
  //
  // Shaka tiene DOS juegos de restricciones:
  //   - player.configure({ restrictions })           -> qué pistas existen
  //   - player.configure({ abr: { restrictions } }) -> qué pistas puede elegir el ABR
  //
  // Y además el propio Shaka advierte: "Changing tracks while abr manager is
  // enabled will likely result in the selected track being overridden". O
  // sea que selectVariantTrack por sí solo NO alcanza si el ABR sigue
  // encendido. Por eso hay dos modos:
  //
  //   - Calidad normal: ABR encendido, rango con un escalón de margen.
  //   - "Máxima fija": ABR APAGADO + selectVariantTrack + restrictions
  //     min = max como segunda barrera. Es la única forma de que no baje.
  //
  // DGO vuelve a poner abr.enabled = true en cada seek
  // (onSeekedOrTimeShifted), así que el lock se reafirma en "seeked", en los
  // eventos de Shaka y en el chequeo periódico.

  function sameRestrictions(a, b) {
    if (!a || !b) return false;
    const keys = [
      "minHeight",
      "maxHeight",
      "minWidth",
      "maxWidth",
      "minBandwidth",
      "maxBandwidth",
    ];
    return keys.every((k) => {
      // Solo comparamos lo que el lock fija. Shaka completa el resto con sus
      // defaults (maxWidth: Infinity, etc.); si los comparáramos, el lock
      // nunca se vería "aplicado" y reconfiguraríamos en cada evento.
      if (b[k] == null) return true;
      const av = a[k] == null ? 0 : a[k];
      return av === b[k];
    });
  }

  // configure() de Shaka es estricto: una clave desconocida tira una
  // excepción y NO aplica el resto del objeto. Por eso cada parche va en su
  // propia llamada: si `abr.restrictions` no existiera en un build viejo,
  // las restrictions del player y la selección igual se aplican.
  function configureShakaSafe(instance, patch) {
    try {
      instance.configure(patch);
      return true;
    } catch (e) {
      return false;
    }
  }

  function getShakaVariants(instance) {
    try {
      return (instance.getVariantTracks() || []).filter(
        (t) => t.type === "variant" || !t.type
      );
    } catch (e) {
      return [];
    }
  }

  function getShakaActive(instance) {
    try {
      return (instance.getVariantTracks() || []).find((t) => t.active) || null;
    } catch (e) {
      return null;
    }
  }

  // Busca la pista objetivo por id y, si el manifest cambió, por altura.
  function findShakaTarget(instance, lock) {
    const tracks = getShakaVariants(instance);
    if (!tracks.length) return null;

    if (lock.id != null) {
      const byId = tracks.find((t) => t.id === lock.id);
      if (byId) return byId;
    }
    if (lock.height) {
      const sameHeight = tracks
        .filter((t) => t.height === lock.height)
        .sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0));
      if (sameHeight.length) return sameHeight[0];
    }
    return tracks
      .slice()
      .sort(
        (a, b) =>
          (b.height || 0) - (a.height || 0) ||
          (b.bandwidth || 0) - (a.bandwidth || 0)
      )[0];
  }

  function isShakaBelowTarget(active, lock) {
    if (!active) return true;
    if (lock.height && active.height) return active.height < lock.height;
    if (lock.bandwidth && active.bandwidth) {
      return active.bandwidth < lock.bandwidth;
    }
    return false;
  }

  // El <video> puede no existir todavía cuando se aplica el lock (Shaka tarda
  // en adjuntarlo), así que además de intentarlo en attachShakaGuards lo
  // reintentamos en cada reafirmación.
  function ensureShakaSeekGuard(instance) {
    try {
      const video = getMediaElementForPlayer({ type: "shaka", instance });
      if (video && !video.__qsShakaSeekGuard) {
        video.__qsShakaSeekGuard = true;
        video.addEventListener("seeked", () => {
          reassertShakaLock(instance);
          // DGO reconfigura en su propio handler de seek y no sabemos en qué
          // orden corre el nuestro: reintentamos un par de veces.
          setTimeout(() => reassertShakaLock(instance), 300);
          setTimeout(() => reassertShakaLock(instance), 1500);
        });
      }
    } catch (e) {}
  }

  function reassertShakaLock(instance) {
    const lock = lockedInstances.get(instance);
    if (!lock) return;
    ensureShakaSeekGuard(instance);

    let cfg = {};
    try {
      cfg = instance.getConfiguration() || {};
    } catch (e) {}
    const abrCfg = cfg.abr || {};

    if (lock.hard) {
      // 1) Rango de una sola altura, en los dos niveles.
      if (!sameRestrictions(cfg.restrictions, lock.restrictions)) {
        configureShakaSafe(instance, { restrictions: lock.restrictions });
      }
      if (
        lock.abrRestrictions &&
        !sameRestrictions(abrCfg.restrictions, lock.abrRestrictions)
      ) {
        configureShakaSafe(instance, {
          abr: { restrictions: lock.abrRestrictions },
        });
      }

      // 2) ABR apagado. Si DGO lo volvió a encender (seek, cambio de
      // configuración), lo apagamos otra vez.
      if (abrCfg.enabled !== false) {
        configureShakaSafe(instance, { abr: { enabled: false } });
      }

      // 3) Si la pista activa quedó por debajo del objetivo, reseleccionar.
      // clearBuffer corta el buffer de menor calidad para que el cambio se
      // vea al instante; lo limitamos para no entrar en un bucle de rebuffer
      // si la red no aguanta el máximo.
      if (isShakaBelowTarget(getShakaActive(instance), lock)) {
        const now = Date.now();
        if (!lock.lastReselect || now - lock.lastReselect > 15000) {
          lock.lastReselect = now;
          const target = findShakaTarget(instance, lock);
          if (target) {
            try {
              instance.selectVariantTrack(target, true);
            } catch (e) {}
          }
        }
      }
      return;
    }

    // Modo normal (calidad elegida con margen): solo reaplicamos el rango y
    // nos aseguramos de que el ABR siga encendido.
    if (!sameRestrictions(cfg.restrictions, lock.restrictions)) {
      configureShakaSafe(instance, { restrictions: lock.restrictions });
    }
    if (
      lock.abrRestrictions &&
      !sameRestrictions(abrCfg.restrictions, lock.abrRestrictions)
    ) {
      configureShakaSafe(instance, {
        abr: { restrictions: lock.abrRestrictions },
      });
    }
    if (abrCfg.enabled === false) {
      configureShakaSafe(instance, { abr: { enabled: true } });
    }
  }

  function attachShakaGuards(instance) {
    if (instance.__qsGuarded) return;
    instance.__qsGuarded = true;
    try {
      // En modo normal solo reaplican el rango; en "máxima fija" además
      // apagan el ABR y, si hace falta, reseleccionan la pista (ver
      // reassertShakaLock).
      instance.addEventListener("trackschanged", () =>
        reassertShakaLock(instance)
      );
      instance.addEventListener("manifestupdated", () =>
        reassertShakaLock(instance)
      );
      instance.addEventListener("adaptation", () =>
        reassertShakaLock(instance)
      );

      // El seek es el punto donde DGO reconfigura el ABR. Escuchamos el
      // <video> real, no el player, porque Shaka no emite un evento propio
      // de "seek terminado".
      ensureShakaSeekGuard(instance);
    } catch (e) {}
  }

  // --- hls.js: si el ABR interno cambia el nivel, lo volvemos a forzar ---

  function attachHlsGuards(instance) {
    if (instance.__qsGuarded) return;
    instance.__qsGuarded = true;
    try {
      instance.on("hlsLevelSwitched", () => {
        const lock = lockedInstances.get(instance);
        if (lock && instance.currentLevel !== lock.id) {
          instance.currentLevel = lock.id;
        }
      });
      instance.on("hlsError", () => {
        const lock = lockedInstances.get(instance);
        if (lock) {
          setTimeout(() => {
            if (instance.currentLevel !== lock.id) {
              instance.currentLevel = lock.id;
            }
          }, 300);
        }
      });
    } catch (e) {}
  }

  // Chequeo periódico "por las dudas": algunos reproductores reinician su
  // configuración al refrescar el manifest (streams en vivo) sin disparar
  // ningún evento que podamos escuchar.
  setInterval(() => {
    lockedInstances.forEach((lock, instance) => {
      if (lock.type === "shaka") reassertShakaLock(instance);
      if (lock.type === "hls" && instance.currentLevel !== lock.id) {
        try {
          instance.currentLevel = lock.id;
        } catch (e) {}
      }
    });
  }, 4000);

  // --- Detección por "duck typing" (miramos qué métodos tiene el objeto) ---

  function looksLikeHls(obj) {
    return (
      obj &&
      typeof obj === "object" &&
      Array.isArray(obj.levels) &&
      "currentLevel" in obj &&
      typeof obj.on === "function"
    );
  }

  function looksLikeDash(obj) {
    return (
      obj &&
      typeof obj === "object" &&
      typeof obj.getBitrateInfoListFor === "function" &&
      typeof obj.setQualityFor === "function"
    );
  }

  function looksLikeShaka(obj) {
    return (
      obj &&
      typeof obj === "object" &&
      typeof obj.getVariantTracks === "function" &&
      typeof obj.selectVariantTrack === "function"
    );
  }

  function classify(obj) {
    // Blindaje importante: en apps con Redux/Immer (Disney+, HBO Max, etc.)
    // es común encontrarse objetos Proxy "revocados" en el árbol de estado.
    // Tocar cualquier propiedad de esos objetos tira una excepción. Si eso
    // pasa acá sin atajarlo, corta todo el escaneo a la mitad y la
    // respuesta nunca se llega a mandar (el popup se queda cargando para
    // siempre). Por eso todo el chequeo va adentro de un try/catch.
    try {
      if (looksLikeHls(obj)) return { type: "hls", instance: obj };
      if (looksLikeDash(obj)) return { type: "dash", instance: obj };
      if (looksLikeShaka(obj)) return { type: "shaka", instance: obj };
    } catch (e) {}
    return null;
  }

  // Object.keys() solo ve propiedades propias ENUMERABLES y nunca las que
  // usan un Symbol como clave. Varias librerías esconden ahí su estado
  // interno a propósito. Esto ve todo lo que JS permite ver desde afuera
  // (lo único realmente invisible son los campos privados de clase #foo,
  // que ni siquiera la reflexión de JS puede leer).
  function getAllOwnKeys(obj) {
    let keys = [];
    try {
      keys = keys.concat(Object.getOwnPropertyNames(obj));
    } catch (e) {}
    try {
      keys = keys.concat(Object.getOwnPropertySymbols(obj));
    } catch (e) {}
    return keys;
  }

  // --- Adaptador de Netflix (experimental) ----------------------------------
  //
  // Netflix no expone una API pública de bitrate. El player nuevo (2026) ya no
  // tiene playerState ni streamingSession: la ruta real es
  //   apiPlayer.playgraphManager.playbackStrategy.segmentManager
  //     .currSession.player.playback
  // y el control de calidad vive en playback.playbackStreamManager, el mismo
  // Stream Manager que abre Ctrl+Alt+Shift+S.
  //
  // Esto es experimental y va contra los Términos de Servicio de Netflix. No
  // toca DRM ni contenido: solo limita qué variantes puede elegir el player.

  function isNetflixHost() {
    try {
      return /(^|\.)netflix\.com$/i.test(location.hostname);
    } catch (e) {
      return false;
    }
  }

  // Selección actual: null = Auto, { mode: "bitrate", bitrate }.
  let netflixSelection = null;
  let netflixInternalCache = null;

  function getNetflixPlayerApi() {
    try {
      const nf = window.netflix;
      const app = nf && nf.appContext;
      const state = app && app.state;
      const playerApp = state && state.playerApp;
      const api = playerApp && playerApp.getAPI && playerApp.getAPI();
      const vp = api && api.videoPlayer;
      return vp || null;
    } catch (e) {
      return null;
    }
  }

  // Netflix puede tener varias sesiones (el título que estás viendo, previews,
  // anuncios). Antes agarrábamos la última y, si esa no tenía el playback
  // listo, todo el adapter fallaba. Ahora probamos todas, de la más nueva a la
  // más vieja, y nos quedamos con la primera que tenga un player real.
  function collectNetflixSessions() {
    const vp = getNetflixPlayerApi();
    if (!vp) return [];

    let ids = [];
    try {
      if (typeof vp.getAllPlayerSessionIds === "function") {
        ids = vp.getAllPlayerSessionIds() || [];
      }
    } catch (e) {}

    const out = [];
    for (let i = ids.length - 1; i >= 0; i--) {
      const sessionId = ids[i];
      let player = null;
      try {
        if (typeof vp.getVideoPlayerBySessionId === "function") {
          player = vp.getVideoPlayerBySessionId(sessionId);
        }
      } catch (e) {}
      if (player && typeof player === "object") {
        out.push({ vp, sessionId, player });
      }
    }

    // Fallback por si cambió el nombre de los métodos del manager: buscamos
    // valores que se comporten como un VideoPlayerApi dentro del manager.
    if (!out.length) {
      try {
        for (const k of Object.keys(vp)) {
          const v = vp[k];
          if (
            v &&
            typeof v === "object" &&
            (typeof v.getMovieId === "function" ||
              typeof v.getPlayerSubsystem === "function")
          ) {
            out.push({ vp, sessionId: k, player: v });
          }
        }
      } catch (e) {}
    }
    return out;
  }

  function getNetflixSession() {
    if (!isNetflixHost()) return null;
    return collectNetflixSessions()[0] || null;
  }

  // Diagnóstico liviano para el popup y para la consola. No cambia nada del
  // player: solo reporta hasta dónde llegó la detección.
  function getNetflixDebugInfo() {
    const info = {
      host: false,
      netflix: false,
      appContext: false,
      playerApp: false,
      api: false,
      videoPlayer: false,
      sessions: 0,
      player: false,
      playback: false,
      streams: 0,
      selectable: 0,
      video: false,
      error: null,
    };
    try {
      info.host = isNetflixHost();
      if (!info.host) return info;
      const nf = window.netflix;
      info.netflix = !!nf;
      const app = nf && nf.appContext;
      info.appContext = !!app;
      const state = app && app.state;
      const playerApp = state && state.playerApp;
      info.playerApp = !!playerApp;
      let api = null;
      try {
        api = playerApp && playerApp.getAPI && playerApp.getAPI();
      } catch (e) {}
      info.api = !!api;
      info.videoPlayer = !!(api && api.videoPlayer);
      const sessions = collectNetflixSessions();
      info.sessions = sessions.length;
      info.player = sessions.length > 0;
      const internal = getNetflixInternal();
      if (internal && internal.pb) {
        info.playback = true;
        info.streams = getNetflixVideoStreams(internal.pb).length;
        info.selectable = getNetflixSelectableStreams(internal.pb).length;
      }
      info.video = !!getNetflixVideoElement();
    } catch (e) {
      info.error = String((e && e.message) || e);
    }
    return info;
  }

  function netflixDiagnosticText() {
    const d = getNetflixDebugInfo();
    const missing = [];
    if (!d.netflix) missing.push("window.netflix");
    else if (!d.appContext) missing.push("appContext");
    else if (!d.playerApp) missing.push("playerApp");
    else if (!d.api) missing.push("getAPI()");
    else if (!d.videoPlayer) missing.push("videoPlayer");
    else if (!d.sessions) missing.push("sesiones");
    else if (!d.playback) missing.push("playback");
    else if (!d.streams) missing.push("streams de video");
    else if (!d.selectable) missing.push("lista de calidades");
    if (!missing.length) {
      return `Diagnóstico: no se pudo usar el selector (playback ${
        d.playback ? "OK" : "no"
      }, streams ${d.streams}, video ${d.video ? "OK" : "no"}).`;
    }
    return `Diagnóstico: faltó ${missing.join(", ")}.`;
  }

  try {
    window.__qsNetflixDebug = () => getNetflixDebugInfo();
  } catch (e) {}

  function safeGet(obj, key) {
    try {
      return obj && obj[key];
    } catch (e) {
      return null;
    }
  }

  // El player nuevo de Netflix (2026) no expone playerState. Se detecta por
  // forma: el objeto playback tiene la lista de streams, los rangos y el ASE.
  function isNetflixPlayback(v) {
    try {
      if (!v || typeof v !== "object") return false;
      if (typeof v.getVideoStreamList !== "function") return false;
      if (typeof v.createVideoBitrateRanges !== "function") return false;
      const ase = v.ase;
      if (!ase || typeof ase.setVideoBitrateRanges !== "function") return false;
      return !!v.currentSegment;
    } catch (e) {
      return false;
    }
  }

  // Primero las rutas conocidas; si el build las renombra, búsqueda acotada
  // por forma. No se navega todo el árbol: solo propiedades con nombres
  // relacionados al playback.
  function findNetflixPlayback(apiPlayer) {
    if (!apiPlayer) return null;

    const known = [
      () =>
        apiPlayer.playgraphManager.playbackStrategy.segmentManager.currSession
          .player.playback,
      () => apiPlayer.playback,
      () => apiPlayer.player && apiPlayer.player.playback,
    ];
    for (const get of known) {
      let v = null;
      try {
        v = get();
      } catch (e) {}
      if (isNetflixPlayback(v)) return v;
    }

    const seen = new Set();
    const queue = [{ v: apiPlayer, d: 0 }];
    const RELEVANT = /playback|playgraph|segment|session|player/i;
    let visited = 0;
    while (queue.length && visited < 600) {
      const item = queue.shift();
      const v = item.v;
      if (!v || typeof v !== "object" || seen.has(v)) continue;
      seen.add(v);
      visited++;
      if (isNetflixPlayback(v)) return v;
      if (item.d >= 6) continue;
      let keys = [];
      try {
        keys = Object.keys(v);
      } catch (e) {
        continue;
      }
      for (const k of keys) {
        if (!RELEVANT.test(k)) continue;
        const child = safeGet(v, k);
        if (child && typeof child === "object") {
          queue.push({ v: child, d: item.d + 1 });
        }
      }
    }
    return null;
  }

  function getNetflixVideoElement() {
    try {
      const videos = Array.from(document.querySelectorAll("video")).filter(
        (v) => isRealMediaElement(v)
      );
      const found =
        videos.find((v) => !v.paused && v.currentSrc) ||
        videos.find((v) => v.currentSrc) ||
        videos.find((v) => !v.paused) ||
        videos[0] ||
        null;
      return found || getFallbackVideoElement();
    } catch (e) {
      return null;
    }
  }

  function getNetflixInternal() {
    const sessions = collectNetflixSessions();
    if (!sessions.length) {
      netflixInternalCache = null;
      return null;
    }

    // Cache hit si la sesión que teníamos sigue existiendo y su playback sigue
    // siendo válido.
    if (netflixInternalCache) {
      const cachedId = netflixInternalCache.session.sessionId;
      const current = sessions.find((s) => s.sessionId === cachedId);
      if (current && isNetflixPlayback(netflixInternalCache.pb)) {
        netflixInternalCache.session = current;
        ensureNetflixGuards(getNetflixVideoElement());
        return netflixInternalCache;
      }
    }

    // Solo se descarta la selección cuando cambia la sesión principal. Si es
    // la misma y el playback todavía no está listo, se conserva para
    // reintentar.
    const primary = sessions[0];
    const prevId = netflixInternalCache && netflixInternalCache.session.sessionId;
    if (!prevId || prevId !== primary.sessionId) netflixSelection = null;

    // Probamos todas las sesiones: la más nueva puede ser un anuncio o un
    // preview sin playback, mientras la del título sí lo tiene.
    for (const session of sessions) {
      const pb = findNetflixPlayback(session.player);
      if (pb) {
        netflixInternalCache = { session, pb };
        ensureNetflixGuards(getNetflixVideoElement());
        return netflixInternalCache;
      }
    }
    netflixInternalCache = null;
    return null;
  }

  function netflixMovieId(pb) {
    try {
      const seg = pb && pb.currentSegment;
      if (seg && seg.movieId != null) return seg.movieId;
    } catch (e) {}
    return null;
  }

  function getNetflixPlaybackData(pb) {
    const movieId = netflixMovieId(pb);
    if (movieId == null) return null;
    try {
      return pb.getPlaybackViewablesData(movieId) || null;
    } catch (e) {
      return null;
    }
  }

  function getNetflixVideoStreams(pb) {
    if (!pb) return [];
    try {
      const movieId = netflixMovieId(pb);
      const list =
        movieId == null
          ? pb.getVideoStreamList()
          : pb.getVideoStreamList({ viewableId: movieId });
      if (!Array.isArray(list)) return [];
      return list.filter(
        (s) => s && typeof s.bitrate === "number" && s.bitrate > 0
      );
    } catch (e) {
      return [];
    }
  }

  // El propio player decide qué variantes están permitidas (DRM, plan,
  // dispositivo). Usamos su filtro para no ofrecer calidades que van a fallar.
  function netflixDisallowedReasons(pb, stream) {
    try {
      const data = getNetflixPlaybackData(pb);
      const mf = data && data.mediaStreamFilter;
      if (!mf || typeof mf.shouldDisallowStream !== "function") return null;
      const reasons = mf.shouldDisallowStream(stream);
      if (!reasons) return [];
      return Array.isArray(reasons) ? reasons : [reasons];
    } catch (e) {
      return null;
    }
  }

  function getNetflixSelectableStreams(pb) {
    const streams = getNetflixVideoStreams(pb);
    if (!streams.length) return [];
    const allowed = streams.filter((s) => {
      const reasons = netflixDisallowedReasons(pb, s);
      return reasons == null || !reasons.length;
    });
    // Solo mostramos lo que el filtro del player permite. Si el filtro bloquea
    // todo, la lista queda vacía a propósito: preferimos Auto antes que ofrecer
    // una variante que la cuenta o el equipo no pueden reproducir.
    return allowed;
  }

  function getNetflixCurrentStream(pb) {
    const data = getNetflixPlaybackData(pb);
    try {
      const vs = data && data.videoStream && data.videoStream._value;
      if (vs && typeof vs.bitrate === "number") return vs;
    } catch (e) {}
    return null;
  }

  function getNetflixStreamManager(pb) {
    try {
      const psm = pb && pb.playbackStreamManager;
      if (!psm || typeof psm.updateASE !== "function") return null;
      return psm;
    } catch (e) {
      return null;
    }
  }

  function netflixRestart(pb) {
    try {
      if (pb && typeof pb.restartStreaming === "function") {
        pb.restartStreaming();
        return true;
      }
    } catch (e) {}
    return false;
  }

  // Mismo camino que el botón Apply del Stream Manager nativo: deja una sola
  // variante en la lista filtrada y reinicia el streaming para que se aplique.
  function applyNetflixBitrate(pb, bitrate) {
    try {
      const psm = getNetflixStreamManager(pb);
      if (!psm || typeof bitrate !== "number" || !isFinite(bitrate)) return false;
      psm._overrideBitrateFilter = {};
      psm._overrideBitrateFilter[bitrate] = 1;
      if (typeof psm._createFilteredVideoStreamListOverride === "function") {
        psm.createFilteredVideoStreamListOverride =
          psm._createFilteredVideoStreamListOverride.bind(psm);
      } else {
        psm.createFilteredVideoStreamListOverride = () =>
          pb
            .getVideoStreamList()
            .filter((s) => psm._overrideBitrateFilter[s.bitrate]);
      }
      psm.updateASE();
      netflixRestart(pb);
      return true;
    } catch (e) {
      return false;
    }
  }

  // Auto: saca el override y devuelve los rangos naturales del player.
  function resetNetflixBitrate(pb) {
    try {
      const psm = getNetflixStreamManager(pb);
      if (psm) psm.createFilteredVideoStreamListOverride = undefined;
      const movieId = netflixMovieId(pb);
      if (
        movieId != null &&
        typeof pb.setVideoBitrateRangesForViewable === "function"
      ) {
        pb.setVideoBitrateRangesForViewable(movieId);
      } else if (
        movieId != null &&
        typeof pb.createVideoBitrateRanges === "function"
      ) {
        pb.ase.setVideoBitrateRanges(
          pb.createVideoBitrateRanges(movieId),
          movieId
        );
      }
      netflixRestart(pb);
      return true;
    } catch (e) {
      return false;
    }
  }

  function netflixMbps(bitrate) {
    if (typeof bitrate !== "number" || !isFinite(bitrate)) return null;
    // Netflix suele exponer el bitrate en kbps; algunos builds usan bps.
    // El umbral separa ambos casos sin ambigüedad práctica.
    const bps = bitrate > 100000 ? bitrate : bitrate * 1000;
    return bps / 1000000;
  }

  function netflixLabel(stream) {
    const mbps = netflixMbps(stream.bitrate);
    const bitrateTxt =
      mbps == null ? String(stream.bitrate) : `${mbps.toFixed(1).replace(".", ",")} Mbps`;
    const height =
      stream.height ||
      stream.videoHeight ||
      (stream.videoTrack && stream.videoTrack.height) ||
      0;
    const vmaf = stream.vmaf ? ` · VMAF ${stream.vmaf}` : "";
    return height ? `${height}p · ${bitrateTxt}${vmaf}` : `${bitrateTxt}${vmaf}`;
  }

  function ensureNetflixGuards(video) {
    if (!video || video.__qsNetflixGuard) return;
    video.__qsNetflixGuard = true;

    let timer = null;
    const reapply = () => {
      if (!netflixSelection) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        const internal = getNetflixInternal();
        // getNetflixInternal() puede invalidar la selección si cambió la
        // sesión (nuevo título/episodio). En ese caso no hay nada que
        // reaplicar.
        const selection = netflixSelection;
        if (!internal || !selection || selection.mode !== "bitrate") return;
        const pb = internal.pb;
        const psm = getNetflixStreamManager(pb);
        if (!psm) return;
        // Si el override sigue puesto, no se toca nada: reiniciar el
        // streaming en cada seek/playing solo genera cortes.
        const active =
          typeof psm.createFilteredVideoStreamListOverride === "function" &&
          psm._overrideBitrateFilter &&
          psm._overrideBitrateFilter[selection.bitrate];
        if (active) return;
        applyNetflixBitrate(pb, selection.bitrate);
      }, 600);
    };

    try {
      video.addEventListener("seeked", reapply);
      video.addEventListener("playing", reapply);
    } catch (e) {}
  }

  // --- Adaptador de Disney+ (experimental) ---------------------------------
  //
  // Disney+ no usa hls.js/dash.js/Shaka: el player es propio (BAMTech/Hive/DMP)
  // y la calidad se decide al CREAR la sesión, cuando se pide el master
  // playlist. No hay API de ABR accesible y restart() deja la promesa colgada,
  // así que la única palanca confiable es filtrar el master: si dejamos solo
  // las variantes de una altura, el ABR no tiene de dónde elegir.
  //
  // El master se pide una sola vez por sesión, por eso cambiar de calidad
  // recarga la pestaña (Disney+ reanuda por bookmark).
  //
  // Medido en vivo (1.4.4): aun destapando el adapter (qs-disney-uncap), el
  // back-end sigue firmando r=720 y el master crudo solo trae 720/480/360.
  // O sea que para esta sesión/dispositivo no hay 1080p: el techo es del
  // back-end, no del adapter ni del filtro. El destope queda como diagnóstico.
  //
  // Por eso el selector ofrece topes hasta 720p y Auto aplica un piso de 720
  // (qs-disney-floor=0 lo desactiva) para que no arranque en 480.

  function isDisneyHost() {
    try {
      return /(^|\.)disneyplus\.com$/i.test(location.hostname);
    } catch (e) {
      return false;
    }
  }

  const DISNEY_CAP_KEY = "qs-disney-cap";
  // Variante exacta elegida en el selector: altura + bitrate + codec de video.
  // Si está seteada, el filtro deja solo esa variante (en todos los grupos de
  // audio) y no un tope por altura.
  const DISNEY_VARIANT_KEY = "qs-disney-variant";
  // Piso de Auto: sin tope elegido, el master se filtra para que no queden
  // variantes por debajo de esta altura. Se apaga con qs-disney-floor=0
  // (requiere recargar, porque el master se pide una sola vez por sesión).
  const DISNEY_FLOOR_KEY = "qs-disney-floor";
  const DISNEY_AUTO_FLOOR = 720;

  function getDisneyCap() {
    try {
      const n = parseInt(sessionStorage.getItem(DISNEY_CAP_KEY) || "", 10);
      return Number.isFinite(n) && n > 0 ? n : null;
    } catch (e) {
      return null;
    }
  }

  function getDisneyFloor() {
    try {
      if (sessionStorage.getItem(DISNEY_FLOOR_KEY) === "0") return 0;
    } catch (e) {}
    return DISNEY_AUTO_FLOOR;
  }

  function storeDisneyCap(height) {
    try {
      if (height) sessionStorage.setItem(DISNEY_CAP_KEY, String(height));
      else sessionStorage.removeItem(DISNEY_CAP_KEY);
    } catch (e) {}
  }

  function getDisneyVariantKey() {
    try {
      const v = sessionStorage.getItem(DISNEY_VARIANT_KEY);
      return v || null;
    } catch (e) {
      return null;
    }
  }

  function storeDisneyVariantKey(key) {
    try {
      if (key) sessionStorage.setItem(DISNEY_VARIANT_KEY, String(key));
      else sessionStorage.removeItem(DISNEY_VARIANT_KEY);
    } catch (e) {}
  }

  // Escalera real del master que el player pidió, para no inventar opciones.
  // Se llena sola desde los interceptores de red. Guardamos las variantes
  // completas (altura + bitrate + codec de video) y las alturas únicas.
  let disneyLadder = { url: null, heights: [], variants: [], at: 0, href: null };
  let disneyIntercepted = false;
  let disneyFiltered = 0;

  function parseDisneyStreamInf(line, uri) {
    const res = /RESOLUTION=(\d+)x(\d+)/i.exec(line);
    if (!res) return null;
    const height = parseInt(res[2], 10);
    if (!height) return null;
    const bw = /(?:^|,)BANDWIDTH=(\d+)/i.exec(line);
    const avg = /(?:^|,)AVERAGE-BANDWIDTH=(\d+)/i.exec(line);
    const codecs = /CODECS="([^"]*)"/i.exec(line);
    const frame = /FRAME-RATE=([\d.]+)/i.exec(line);
    const audio = /AUDIO="([^"]*)"/i.exec(line);
    const bandwidth = bw ? parseInt(bw[1], 10) : 0;
    return {
      width: parseInt(res[1], 10),
      height,
      bandwidth,
      avgBandwidth: avg ? parseInt(avg[1], 10) : bandwidth,
      codecs: codecs ? codecs[1] : "",
      frameRate: frame ? parseFloat(frame[1]) : 0,
      audio: audio ? audio[1] : "",
      uri: uri || "",
    };
  }

  function parseDisneyVariants(text) {
    const lines = text.split(/\r?\n/);
    const out = [];
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].indexOf("#EXT-X-STREAM-INF") !== 0) continue;
      // La URI de la variante es la próxima línea que no sea comentario ni
      // esté vacía.
      let j = i + 1;
      while (
        j < lines.length &&
        (!lines[j].trim() || lines[j].trim().charAt(0) === "#")
      ) {
        j++;
      }
      const v = parseDisneyStreamInf(lines[i], (lines[j] || "").trim());
      if (v) out.push(v);
      i = j;
    }
    return out;
  }

  function disneyVideoCodec(v) {
    const first = String((v && v.codecs) || "").split(",")[0].trim();
    return first;
  }

  // Disney+ suele poner el bitrate nominal del video en la URI
  // (composite_2400k_aac.m3u8). Lo usamos para agrupar las variantes que solo
  // cambian el audio (aac/ec-3) y no duplicar la lista.
  function disneyVariantKey(v) {
    if (!v) return "";
    const m = /(?:^|[^\d])(\d+)k(?=[._-]|$)/i.exec(v.uri || "");
    const rate = m
      ? parseInt(m[1], 10) + "k"
      : String(Math.round((v.avgBandwidth || v.bandwidth || 0) / 100000));
    return `${v.height}|${rate}|${disneyVideoCodec(v)}`;
  }

  function disneyVariantBitrate(v) {
    // Bitrate nominal del video si la URI lo trae (composite_2400k...);
    // si no, el promedio declarado en el master.
    const m = /(?:^|[^\d])(\d+)k(?=[._-]|$)/i.exec((v && v.uri) || "");
    if (m) return parseInt(m[1], 10) * 1000;
    return (v && (v.avgBandwidth || v.bandwidth)) || 0;
  }

  function disneyVariantLabel(v) {
    const rate = disneyVariantBitrate(v);
    const mbps = rate / 1000000;
    const bitrateTxt =
      mbps >= 1
        ? `${mbps.toFixed(1).replace(".", ",")} Mbps`
        : `${Math.round(rate / 1000)} kbps`;
    return `${v.height}p · ${bitrateTxt}`;
  }

  function rememberDisneyLadder(url, text) {
    try {
      const href = location.href;
      // La escalera es por título: si cambió la URL, no arrastramos las
      // variantes del título anterior.
      if (disneyLadder.href && disneyLadder.href !== href) {
        disneyLadder = { url: null, heights: [], variants: [], at: 0, href };
      }
      const parsed = parseDisneyVariants(text);
      if (!parsed.length) return;
      // El player puede pedir más de un master en la misma sesión (por audio,
      // por DRM o al recrear la sesión). Fusionamos para no perder variantes.
      const byKey = new Map();
      const add = (v) => {
        const key = disneyVariantKey(v);
        if (!byKey.has(key)) byKey.set(key, v);
      };
      (disneyLadder.variants || []).forEach(add);
      parsed.forEach(add);
      const variants = Array.from(byKey.values()).sort((a, b) => {
        if (b.height !== a.height) return b.height - a.height;
        return (b.avgBandwidth || b.bandwidth) - (a.avgBandwidth || a.bandwidth);
      });
      const heights = [];
      variants.forEach((v) => {
        if (heights.indexOf(v.height) === -1) heights.push(v.height);
      });
      disneyLadder = { url, heights, variants, at: Date.now(), href };
    } catch (e) {}
  }

  // Al reemplazar la respuesta, el player pierde la URL base para resolver las
  // rutas relativas del master, así que las pasamos a absolutas.
  function absolutizeDisneyUris(text, baseUrl) {
    if (!baseUrl) return text;
    return text
      .split(/\r?\n/)
      .map((line) => {
        if (!line) return line;
        if (line.charAt(0) === "#") {
          return line.replace(/URI="([^"]+)"/g, (all, uri) => {
            try {
              return 'URI="' + new URL(uri, baseUrl).href + '"';
            } catch (e) {
              return all;
            }
          });
        }
        try {
          return new URL(line.trim(), baseUrl).href;
        } catch (e) {
          return line;
        }
      })
      .join("\n");
  }

  // Deja en el master solo las variantes que correspondan: con un tope
  // elegido, exactamente esa altura; en Auto, las que estén en el piso o por
  // encima (así no arranca en 480). Si no queda ninguna, devuelve el original:
  // preferimos no romper la reproducción antes que dejar al player sin
  // variantes.
  function filterDisneyMaster(text, height, baseUrl, variantKey) {
    const floor = height || variantKey ? 0 : getDisneyFloor();
    if (!height && !variantKey && !floor) return text;
    const lines = text.split(/\r?\n/);
    const out = [];
    let kept = 0;
    let total = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.indexOf("#EXT-X-STREAM-INF") !== 0) {
        out.push(line);
        continue;
      }
      total++;
      // La URI de la variante es la próxima línea que no sea comentario ni
      // esté vacía.
      let j = i + 1;
      while (
        j < lines.length &&
        (!lines[j].trim() || lines[j].trim().charAt(0) === "#")
      ) {
        j++;
      }
      const v = parseDisneyStreamInf(line, (lines[j] || "").trim());
      const h = v ? v.height : 0;
      const key = v ? disneyVariantKey(v) : "";
      const keep = variantKey
        ? key === variantKey
        : height
        ? h === height
        : h >= floor;
      if (keep) {
        out.push(line);
        for (let k = i + 1; k <= j && k < lines.length; k++) out.push(lines[k]);
        kept++;
      }
      i = j;
    }
    if (!kept) return text;
    // Si no se descartó nada, no hace falta reescribir la respuesta.
    if (kept === total) return text;
    return absolutizeDisneyUris(out.join("\n"), baseUrl);
  }

  function installDisneyXhrPatch(xhr, url, textDesc, respDesc) {
    if (xhr.__qsDisneyPatched || !textDesc || !textDesc.get) return;
    xhr.__qsDisneyPatched = true;
    let filtered = null;
    let parsed = false;

    const readFiltered = () => {
      if (parsed) return filtered;
      let raw = null;
      try {
        raw = textDesc.get.call(xhr);
      } catch (e) {
        return null;
      }
      if (typeof raw !== "string" || !/#EXT-X-STREAM-INF/i.test(raw)) {
        return null;
      }
      parsed = true;
      disneyIntercepted = true;
      rememberDisneyLadder(url, raw);
      const cap = getDisneyCap();
      const variantKey = getDisneyVariantKey();
      // En Auto también se filtra, pero por el piso (no por un tope exacto).
      if (!cap && !variantKey && !getDisneyFloor()) return null;
      const out = filterDisneyMaster(raw, cap, url, variantKey);
      filtered = out === raw ? null : out;
      if (filtered) disneyFiltered++;
      return filtered;
    };

    try {
      Object.defineProperty(xhr, "responseText", {
        configurable: true,
        get() {
          const f = readFiltered();
          return f == null ? textDesc.get.call(this) : f;
        },
      });
    } catch (e) {}

    if (respDesc && respDesc.get) {
      try {
        Object.defineProperty(xhr, "response", {
          configurable: true,
          get() {
            if (this.responseType && this.responseType !== "text") {
              return respDesc.get.call(this);
            }
            const f = readFiltered();
            return f == null ? respDesc.get.call(this) : f;
          },
        });
      } catch (e) {}
    }
  }

  function installDisneyInterceptors() {
    if (!isDisneyHost()) return;

    try {
      const origFetch = window.fetch;
      if (typeof origFetch === "function") {
        window.fetch = function (input, init) {
          const promise = origFetch.apply(this, arguments);
          let url = null;
          try {
            url = typeof input === "string" ? input : input && input.url;
          } catch (e) {}
          if (!url || !/\.m3u8(\?|$)/i.test(url)) return promise;
          return promise.then((res) => {
            try {
              if (!res || !res.ok) return res;
              return res
                .clone()
                .text()
                .then((text) => {
                  if (
                    typeof text !== "string" ||
                    !/#EXT-X-STREAM-INF/i.test(text)
                  ) {
                    return res;
                  }
                  disneyIntercepted = true;
                  rememberDisneyLadder(url, text);
                  const cap = getDisneyCap();
                  const variantKey = getDisneyVariantKey();
                  if (!cap && !variantKey && !getDisneyFloor()) return res;
                  const out = filterDisneyMaster(text, cap, url, variantKey);
                  if (out === text) return res;
                  disneyFiltered++;
                  const headers = new Headers(res.headers);
                  headers.delete("content-length");
                  headers.delete("content-encoding");
                  const filteredRes = new Response(out, {
                    status: res.status,
                    statusText: res.statusText,
                    headers,
                  });
                  try {
                    Object.defineProperty(filteredRes, "url", {
                      value: url,
                      configurable: true,
                    });
                  } catch (e) {}
                  return filteredRes;
                })
                .catch(() => res);
            } catch (e) {
              return res;
            }
          });
        };
      }
    } catch (e) {}

    try {
      const proto = XMLHttpRequest.prototype;
      const origOpen = proto.open;
      const textDesc = Object.getOwnPropertyDescriptor(proto, "responseText");
      const respDesc = Object.getOwnPropertyDescriptor(proto, "response");
      proto.open = function (method, url) {
        try {
          if (url && /\.m3u8(\?|$)/i.test(String(url))) {
            installDisneyXhrPatch(this, String(url), textDesc, respDesc);
          }
        } catch (e) {}
        return origOpen.apply(this, arguments);
      };
    } catch (e) {}
  }

  installDisneyInterceptors();

  // --- Disney+: destope opt-in (experimento) -------------------------------
  //
  // El techo de 720p no lo pone el DRM: el adapter del player declara
  // getConstraintData() → resolutionConstraint "datasaver" / 720 y un
  // preferredResolutionMax que cae a res1280x720. Con esas constraints el PBO
  // pide el master con r=720 y el ABR no tiene nada mejor para elegir.
  //
  // Este parche reemplaza esas dos respuestas del brandedPlaybackAdapter ANTES
  // de que se cree la sesión, para que el player pida el master sin tope.
  // Apagado por defecto; sirve para responder dos preguntas: ¿hay 1080p en
  // Chrome? y ¿el Auto deja de arrancar en 480?
  //
  // Prender:  sessionStorage.setItem("qs-disney-uncap", "1") + recargar
  // Apagar:   sessionStorage.removeItem("qs-disney-uncap") + recargar

  const DISNEY_UNCAP_KEY = "qs-disney-uncap";

  function isDisneyUncapEnabled() {
    try {
      return sessionStorage.getItem(DISNEY_UNCAP_KEY) === "1";
    } catch (e) {
      return false;
    }
  }

  let disneyUncappedSessions = 0;
  let disneyUncapPatched = false;

  function uncapDisneyAdapter(adapter) {
    if (!adapter) return false;
    let proto = null;
    try {
      proto = Object.getPrototypeOf(adapter);
    } catch (e) {
      return false;
    }
    if (!proto) return false;
    try {
      if (proto.__qsDisneyUncapped) return true;
      Object.defineProperty(proto, "getConstraintData", {
        configurable: true,
        writable: true,
        value() {
          return {
            bandwidthConstraint: "none",
            resolutionConstraint: "none",
            localBandwidthConstraintType: "none",
            localBandwidthConstraintValue: "0",
            resolutionConstraintValue: "0",
          };
        },
      });
      Object.defineProperty(proto, "preferredResolutionMax", {
        configurable: true,
        get() {
          return ["res1920x1080", "res1280x720", "res854x480"];
        },
      });
      if (typeof proto.isResolutionCappedByDRM === "function") {
        Object.defineProperty(proto, "isResolutionCappedByDRM", {
          configurable: true,
          writable: true,
          value() {
            return false;
          },
        });
      }
      Object.defineProperty(proto, "__qsDisneyUncapped", {
        configurable: true,
        value: true,
      });
      disneyUncapPatched = true;
      return true;
    } catch (e) {
      return false;
    }
  }

  function uncapDisneySession(session) {
    if (!session || !isDisneyUncapEnabled()) return;
    let adapter = null;
    try {
      adapter = session.brandedPlaybackAdapter;
    } catch (e) {}
    if (adapter) {
      if (uncapDisneyAdapter(adapter)) disneyUncappedSessions++;
      return;
    }
    // El adapter puede crearse dentro de prepare: interceptamos la asignación
    // para parchearlo apenas exista.
    try {
      if (!Object.prototype.hasOwnProperty.call(session, "brandedPlaybackAdapter")) {
        let value = null;
        Object.defineProperty(session, "brandedPlaybackAdapter", {
          configurable: true,
          get() {
            return value;
          },
          set(v) {
            value = v;
            if (uncapDisneyAdapter(v)) disneyUncappedSessions++;
          },
        });
      }
    } catch (e) {}
  }

  function wrapDisneySessionCtor(Ctor) {
    if (!Ctor || typeof Ctor !== "function") return false;
    const proto = Ctor.prototype;
    if (!proto) return false;
    try {
      if (proto.__qsDisneyWrapped) return true;
    } catch (e) {}
    const wrap = (name) => {
      const orig = proto[name];
      if (typeof orig !== "function") return;
      const wrapped = function () {
        try {
          uncapDisneySession(this);
        } catch (e) {}
        return orig.apply(this, arguments);
      };
      try {
        Object.defineProperty(wrapped, "name", { value: name, configurable: true });
      } catch (e) {}
      proto[name] = wrapped;
    };
    try {
      wrap("initialize");
      wrap("prepare");
      Object.defineProperty(proto, "__qsDisneyWrapped", {
        configurable: true,
        value: true,
      });
      return true;
    } catch (e) {
      return false;
    }
  }

  function findPlaybackSessionCtor(ns) {
    const ok = (v) =>
      typeof v === "function" &&
      v.prototype &&
      typeof v.prototype.prepare === "function";
    if (!ns) return null;
    if (typeof ns === "function") return ok(ns) ? ns : null;
    if (typeof ns !== "object") return null;
    const direct = [ns.PlaybackSession, ns.default];
    for (let i = 0; i < direct.length; i++) {
      if (ok(direct[i])) return direct[i];
      const d = direct[i];
      if (d && typeof d === "object" && ok(d.PlaybackSession)) {
        return d.PlaybackSession;
      }
    }
    try {
      const keys = Object.keys(ns);
      for (let i = 0; i < keys.length; i++) {
        let v = null;
        try {
          v = ns[keys[i]];
        } catch (e) {}
        if (ok(v) && typeof v.prototype.release === "function") return v;
      }
    } catch (e) {}
    return null;
  }

  function installDisneyUncap() {
    if (!isDisneyHost() || !isDisneyUncapEnabled()) return;
    let tries = 0;
    const timer = setInterval(() => {
      tries++;
      let ns = null;
      try {
        ns = window["playback-session"];
      } catch (e) {}
      const Ctor = findPlaybackSessionCtor(ns);
      if (Ctor && wrapDisneySessionCtor(Ctor)) {
        clearInterval(timer);
        return;
      }
      if (tries >= 600) clearInterval(timer); // ~60 s y dejamos de buscar
    }, 100);
  }

  installDisneyUncap();

  function getDisneyPlayer() {
    if (!isDisneyHost()) return null;
    try {
      const dp = document.querySelector("disney-web-player");
      if (!dp) return null;
      const mp = dp.mediaPlayer;
      if (!mp || typeof mp.play !== "function") return null;
      return dp;
    } catch (e) {
      return null;
    }
  }

  function getDisneyVideoHeight(dp) {
    try {
      const el = dp && dp.mediaElement;
      return (el && el.videoHeight) || 0;
    } catch (e) {
      return 0;
    }
  }

  // Un script de la página puede despachar qs-set-quality muchas veces por
  // segundo. Agrupamos las recargas: como máximo una cada 10 s, y varias
  // elecciones seguidas se resuelven en una sola recarga.
  let disneyReloadTimer = null;
  let disneyLastReloadAt = 0;
  function scheduleDisneyReload() {
    if (disneyReloadTimer) return;
    const wait = Math.max(0, 10000 - (Date.now() - disneyLastReloadAt));
    disneyReloadTimer = setTimeout(() => {
      disneyReloadTimer = null;
      disneyLastReloadAt = Date.now();
      try {
        location.reload();
      } catch (e) {}
    }, wait);
  }

  function setDisneyQuality(dp, id) {
    // Variante exacta (altura + bitrate + codec): fija ese bitrate y deja que
    // el player elija el audio. Se guarda como string ("v:...") para no
    // confundirla con un tope de altura.
    if (typeof id === "string" && id.indexOf("v:") === 0) {
      const key = id.slice(2);
      const changed =
        getDisneyVariantKey() !== key ||
        getDisneyCap() !== null ||
        isDisneyUncapEnabled();
      storeDisneyVariantKey(key);
      storeDisneyCap(null);
      try {
        sessionStorage.removeItem(DISNEY_UNCAP_KEY);
      } catch (e) {}
      if (!changed) return;
      scheduleDisneyReload();
      return;
    }

    // Tope por altura (o Auto con -1). Cualquier elección explícita apaga el
    // destope y la variante exacta: vuelve al comportamiento por altura.
    const height = id === -1 ? null : parseInt(id, 10) || null;
    const changed =
      (getDisneyCap() || null) !== (height || null) ||
      getDisneyVariantKey() !== null ||
      isDisneyUncapEnabled();
    try {
      sessionStorage.removeItem(DISNEY_UNCAP_KEY);
    } catch (e) {}
    storeDisneyVariantKey(null);
    storeDisneyCap(height);
    if (!changed) return;
    // El master se pide una sola vez por sesión: hay que recrearla. La
    // preferencia queda en sessionStorage, así que sobrevive a la recarga.
    scheduleDisneyReload();
  }

  // Diagnóstico rápido desde la consola: __qsDisneyDebug()
  try {
    window.__qsDisneyDebug = () => ({
      host: location.hostname,
      cap: getDisneyCap(),
      floor: getDisneyFloor(),
      intercepted: disneyIntercepted,
      filtered: disneyFiltered,
      ladder: disneyLadder,
      variant: getDisneyVariantKey(),
      uncap: isDisneyUncapEnabled(),
      uncapped: disneyUncapPatched,
      uncappedSessions: disneyUncappedSessions,
    });
  } catch (e) {}

  // --- Adaptador de HBO/Max --------------------------------------------------
  //
  // Max usa el motor Gluon (GLUON_BROWSER 11.x). El player no está en window:
  // hay que llegar por el árbol de fibers de React desde el <video>.
  //
  // La calidad la decide el VariantSelector del buffer controller:
  //   sess._loadedData.buffer._variantSelector.getVariant(lista)
  // y esa lista sale de _selectedVariants (las variantes que el motor permite;
  // el filtro de DRM deja afuera las que este equipo no puede decodificar).
  //
  // El override oficial (setBitrateOverride) elige bien, pero en este build
  // _closestItem está roto: _closestItemIndex usa list.find({bandwidth}) y
  // siempre devuelve -1, así que el override nunca matchea. Lo reemplazamos
  // una vez por sesión por un "bitrate más cercano" real.
  //
  // La aplicación al pipeline es diferida: la selección cambia al instante,
  // pero el video decodifica la nueva variante recién cuando el buffer se
  // renueva (~30 s medidos en vivo, con un buffer estable de ~10 s). Por eso
  // el adapter aplica una sola vez y no re-aplica: pelear con el ABR solo
  // genera cortes. Mientras tanto, la opción elegida queda marcada.
  //
  // La 640p (0-v2) no aparece porque el filtro de DRM la rechaza en este
  // equipo; el techo real es 512p.

  function isHboHost() {
    try {
      return /(^|\.)(hbomax|max)\.com$/i.test(location.hostname);
    } catch (e) {
      return false;
    }
  }

  // null = Auto, { mode: "exact", id, bitrate, height } o
  // { mode: "cap", height }. Es solo memoria: si el player recrea la sesión
  // (otro título), vuelve a Auto en vez de re-aplicar a ciegas.
  let hboSelection = null;
  let hboSessionCache = null;

  function hboPartsFromSession(obj) {
    if (!obj || typeof obj !== "object") return null;
    try {
      let engine = obj._playbackEngine;
      if (!engine && obj._playbackEngineAdapter) {
        engine = obj._playbackEngineAdapter._playbackEngine;
      }
      const player = engine && engine._player;
      let session = null;
      if (player) {
        session =
          (typeof player.getSession === "function" && player.getSession()) ||
          player._session ||
          null;
      }
      if (!session) session = obj;

      const loaded = session._loadedData;
      const buffer = loaded && loaded.buffer;
      const selector =
        (buffer && buffer._variantSelector) || session._variantSelector;
      const forecaster = selector && selector._forecaster;
      const period = session._period;
      if (!buffer || !selector || !forecaster || !period) return null;
      return { session, player, buffer, selector, forecaster, period };
    } catch (e) {
      return null;
    }
  }

  // Recorre los fibers hacia arriba desde el <video> buscando la sesión. Es
  // el mismo camino que usamos en el diagnóstico: el player no está en window.
  function hboFindSession() {
    if (!isHboHost()) return null;
    const cached = hboPartsFromSession(hboSessionCache);
    if (cached) return hboSessionCache;

    hboSessionCache = null;
    try {
      const videos = [];
      collectVideosDeep(document, videos);
      for (const video of videos) {
        let node = video;
        let hops = 0;
        while (node && hops < 20) {
          let key = null;
          try {
            key = Object.keys(node).find(
              (k) =>
                k.indexOf("__reactFiber$") === 0 ||
                k.indexOf("__reactInternalInstance$") === 0
            );
          } catch (e) {}
          if (key) {
            const found = hboScanFiber(node[key]);
            if (found) {
              hboSessionCache = found;
              return found;
            }
          }
          node = node.parentElement;
          hops++;
        }
      }
    } catch (e) {}
    return null;
  }

  function hboScanFiber(fiber) {
    const seen = new Set();
    let hops = 0;
    while (fiber && hops < 40) {
      hops++;
      if (seen.has(fiber)) break;
      seen.add(fiber);

      const candidates = [];
      if (fiber.stateNode && typeof fiber.stateNode === "object") {
        candidates.push(fiber.stateNode);
      }
      let hook = fiber.memoizedState;
      let hookHops = 0;
      while (hook && hookHops < 25) {
        hookHops++;
        const val = hook.memoizedState;
        if (val && typeof val === "object") {
          if ("current" in val) candidates.push(val.current);
          candidates.push(val);
        }
        hook = hook.next;
      }

      for (const candidate of candidates) {
        const parts = hboPartsFromSession(candidate);
        if (parts) return parts.session;
      }
      fiber = fiber.return;
    }
    return null;
  }

  // Las listas de Gluon no siempre son arrays: pueden ser colecciones con
  // length + getAt(), o traer un toArray(). Las aplanamos sin asumir formato.
  function hboListToArray(list) {
    const out = [];
    if (!list) return out;
    if (Array.isArray(list)) return list.slice();
    try {
      if (
        typeof list.getAt === "function" &&
        typeof list.length === "number"
      ) {
        for (let i = 0; i < list.length; i++) {
          const item = list.getAt(i);
          if (item) out.push(item);
        }
        return out;
      }
      if (typeof list.toArray === "function") {
        const arr = list.toArray();
        return Array.isArray(arr) ? arr : out;
      }
      if (typeof list.forEach === "function") {
        list.forEach((item) => {
          if (item) out.push(item);
        });
        return out;
      }
      if (typeof list.length === "number") {
        for (let i = 0; i < list.length; i++) {
          if (list[i]) out.push(list[i]);
        }
      }
    } catch (e) {}
    return out;
  }

  // Cada entrada de la lista puede ser la variante de video o un envoltorio
  // { video, audio }. Normalizamos siempre al objeto de video, que es el que
  // tiene id, bandwidth y height.
  function hboVideoOf(v) {
    if (!v) return null;
    const inner = v.video;
    return inner && typeof inner === "object" ? inner : v;
  }

  function hboMapList(map, period) {
    if (!map) return null;
    try {
      const pid = period && (period.id || period.periodId);
      const keys = [period, pid, pid == null ? null : String(pid)];
      for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        if (key == null) continue;
        let list = null;
        if (typeof map.get === "function") list = map.get(key);
        else if (typeof map.tryGet === "function") list = map.tryGet(key);
        if (list) return list;
      }
      // Último recurso: cualquier lista no vacía que haya en el mapa.
      if (typeof map.forEach === "function") {
        let found = null;
        map.forEach((value) => {
          if (!found && hboListToArray(value).length) found = value;
        });
        if (found) return found;
      }
    } catch (e) {}
    return null;
  }

  function hboCachedList(parts) {
    const maps = [
      parts.buffer && parts.buffer._selectedVariants,
      parts.selector && parts.selector._selectedVariants,
      parts.buffer &&
        parts.buffer._variantSelector &&
        parts.buffer._variantSelector._selectedVariants,
    ];
    for (let i = 0; i < maps.length; i++) {
      const list = hboMapList(maps[i], parts.period);
      if (list && hboListToArray(list).length) return list;
    }
    return null;
  }

  // Variantes que el motor realmente ofrece para el período. La lista ya viene
  // filtrada (DRM incluido), así que no inventamos opciones.
  function hboVariants(parts) {
    const sources = [];
    sources.push(hboCachedList(parts));
    sources.push(parts.period && parts.period.video);
    try {
      const periods = hboListToArray(
        parts.forecaster && parts.forecaster._manifest
          ? parts.forecaster._manifest.periods
          : null
      );
      const pid = parts.period && (parts.period.id || parts.period.periodId);
      const match =
        periods.find((p) => p === parts.period) ||
        periods.find(
          (p) => p && pid != null && (p.id === pid || p.periodId === pid)
        ) ||
        periods[0];
      if (match) sources.push(match.video);
    } catch (e) {}

    let out = [];
    for (let i = 0; i < sources.length; i++) {
      out = hboListToArray(sources[i]);
      if (out.length) break;
    }

    const byId = new Map();
    out.forEach((raw) => {
      const v = hboVideoOf(raw);
      const id = v && v.id;
      if (id && !byId.has(id)) byId.set(id, v);
    });
    return Array.from(byId.values()).sort(
      (a, b) => (b.bandwidth || 0) - (a.bandwidth || 0)
    );
  }

  function hboVideoElement() {
    try {
      const videos = [];
      collectVideosDeep(document, videos);
      return videos.find((v) => v.videoWidth) || videos[0] || null;
    } catch (e) {
      return null;
    }
  }

  function hboDecodedHeight() {
    const el = hboVideoElement();
    return (el && el.videoHeight) || 0;
  }

  function hboSelectedHeight(parts) {
    try {
      const sel = parts.buffer._selectedVariantMap.tryGet(parts.period);
      const v = sel && (sel.video || sel);
      if (v && v.height) return v.height;
    } catch (e) {}
    return hboDecodedHeight();
  }

  function hboVariantLabel(v) {
    const height = (v && v.height) || 0;
    const rate = (v && v.bandwidth) || 0;
    const mbps = rate / 1000000;
    const bitrateTxt =
      mbps >= 1
        ? `${mbps.toFixed(2).replace(".", ",")} Mbps`
        : `${Math.round(rate / 1000)} kbps`;
    return height ? `${height}p · ${bitrateTxt}` : bitrateTxt;
  }

  // _closestItem roto en este build: lo reemplazamos por el más cercano de
  // verdad. Es idempotente y solo afecta al override (que solo usamos acá).
  function hboEnsureClosestFix(forecaster) {
    if (!forecaster || forecaster.__qsClosestFixed) return;
    forecaster.__qsClosestFixed = true;
    forecaster.__qsOriginalClosestItem = forecaster._closestItem;
    forecaster._closestItem = function (list, bandwidth) {
      let best = null;
      let bestDiff = Infinity;
      for (let i = 0; i < (list.length || 0); i++) {
        const item =
          typeof list.getAt === "function" ? list.getAt(i) : list[i];
        if (!item) continue;
        const v = hboVideoOf(item) || {};
        const diff = Math.abs((v.bandwidth || 0) - bandwidth);
        if (diff < bestDiff) {
          bestDiff = diff;
          best = item;
        }
      }
      return best;
    };
  }

  function hboRequestSelect(parts) {
    try {
      const result = parts.buffer.selectVariant(parts.period);
      if (result && typeof result.catch === "function") {
        result.catch(() => {});
      }
    } catch (e) {}
  }

  function applyHboQuality(parts, id) {
    if (!parts) return false;
    hboEnsureClosestFix(parts.forecaster);

    // Auto: sin override y sin tope, el ABR vuelve a decidir.
    if (id === -1) {
      try {
        parts.forecaster._options.maxBandwidth = undefined;
      } catch (e) {}
      try {
        parts.selector.setBitrateOverride(undefined);
      } catch (e) {}
      hboSelection = null;
      hboRequestSelect(parts);
      return true;
    }

    // Tope por altura (ABR): el ABR elige el bitrate dentro de esa altura.
    if (typeof id === "string" && id.indexOf("c:") === 0) {
      const height = parseInt(id.slice(2), 10);
      if (!height) return false;
      const group = hboVariants(parts)
        .filter((v) => v.height === height)
        .sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0));
      if (!group.length) return false;
      try {
        parts.selector.setBitrateOverride(undefined);
      } catch (e) {}
      try {
        parts.forecaster._options.maxBandwidth = group[0].bandwidth;
      } catch (e) {}
      hboSelection = { mode: "cap", height };
      hboRequestSelect(parts);
      return true;
    }

    // Variante exacta: fija el bitrate y deja que el ABR no elija otra.
    if (typeof id === "string" && id.indexOf("v:") === 0) {
      const key = id.slice(2);
      const target = hboVariants(parts).find((v) => v.id === key);
      if (!target) return false;
      try {
        parts.forecaster._options.maxBandwidth = undefined;
      } catch (e) {}
      try {
        parts.selector.setBitrateOverride(target.bandwidth);
      } catch (e) {}
      hboSelection = {
        mode: "exact",
        id: key,
        bitrate: target.bandwidth,
        height: target.height,
      };
      hboRequestSelect(parts);
      return true;
    }

    return false;
  }

  function getHboQualities(parts) {
    const variants = hboVariants(parts);
    const list = variants.map((v) => ({
      id: "v:" + v.id,
      label: hboVariantLabel(v),
      active: !!(
        hboSelection &&
        hboSelection.mode === "exact" &&
        hboSelection.id === v.id
      ),
    }));

    // Tope por altura: solo tiene sentido si hay más de una variante en esa
    // altura; si hay una sola, la variante exacta ya hace lo mismo.
    const heights = [];
    variants.forEach((v) => {
      if (v.height && heights.indexOf(v.height) === -1) heights.push(v.height);
    });
    heights.forEach((height) => {
      if (variants.filter((v) => v.height === height).length < 2) return;
      list.push({
        id: "c:" + height,
        label: `${height}p (ABR)`,
        active: !!(
          hboSelection &&
          hboSelection.mode === "cap" &&
          hboSelection.height === height
        ),
      });
    });

    sortQualitiesDesc(list);
    let autoLabel = "Auto";
    if (!hboSelection) {
      const current = hboDecodedHeight() || hboSelectedHeight(parts);
      if (current) autoLabel = `Auto (${current}p)`;
    }
    list.push({ id: -1, label: autoLabel, active: !hboSelection });
    return list;
  }

  // Diagnóstico rápido desde la consola: __qsHboDebug()
  try {
    window.__qsHboDebug = () => {
      const session = hboFindSession();
      const parts = hboPartsFromSession(session);
      const el = hboVideoElement();
      const cached = parts ? hboCachedList(parts) : null;
      const rawSample = cached ? hboListToArray(cached)[0] : null;
      const sample = hboVideoOf(rawSample);
      return {
        host: location.hostname,
        found: !!parts,
        periodId: parts && parts.period && (parts.period.id || parts.period.periodId),
        cachedCount: cached ? hboListToArray(cached).length : 0,
        periodVideoCount: parts
          ? hboListToArray(parts.period && parts.period.video).length
          : 0,
        sampleKeys: sample ? Object.keys(sample).slice(0, 12) : [],
        wrapped: !!(rawSample && rawSample.video),
        selection: hboSelection,
        variants: parts
          ? hboVariants(parts).map((v) => ({
              id: v.id,
              height: v.height,
              bandwidth: v.bandwidth,
            }))
          : [],
        selected: parts ? hboSelectedHeight(parts) : null,
        decoded: el ? `${el.videoWidth}x${el.videoHeight}` : null,
        closestFixed: parts ? !!parts.forecaster.__qsClosestFixed : false,
        override: parts ? parts.forecaster._abrOverride : null,
        maxBandwidth: parts
          ? parts.forecaster._options && parts.forecaster._options.maxBandwidth
          : null,
      };
    };
  } catch (e) {}

  // --- Adaptador de Twitch --------------------------------------------------
  //
  // Twitch usa un player propio (React) y no expone hls.js/dash.js/Shaka, pero
  // sí una API interna en el objeto del player:
  //   player.getQualities() -> [{ name, group, height, bitrate, framerate, ... }]
  //   player.getQuality()   -> calidad actual
  //   player.setQuality(q)  -> cambia a esa calidad (recibe el objeto)
  //
  // El player no está en window: se llega por el fiber de React del nodo
  // [data-a-target="video-player"]. Es el mismo camino que usan los userscripts
  // de Twitch, así que no dependemos de clicks en el menú.
  //
  // La elección se persiste en localStorage (video-quality / quality-bitrate /
  // video-quality-highest-available) para que Twitch la respete al recargar.

  function isTwitchHost() {
    try {
      return /(^|\.)twitch\.tv$/i.test(location.hostname);
    } catch (e) {
      return false;
    }
  }

  let twitchCachedPlayer = null;
  let twitchPlayerNode = null;
  let twitchLastWindowScan = 0;
  let twitchLastFindAttempt = 0;
  let twitchCachedUrl = "";

  // Red de seguridad: Twitch ahora usa Amazon IVS. Si el SDK expone
  // window.IVSPlayer, envolvemos create() en document_start para quedarnos
  // con la instancia real, sin depender del árbol de React.
  let twitchCapturedIvs = null;
  // Solo Twitch usa este SDK: no parcheamos un global ajeno en otros sitios.
  if (isTwitchHost()) {
  try {
    let ivsRef = window.IVSPlayer;
    const wrapIvs = (obj) => {
      if (!obj || typeof obj !== "object" || obj.__qsIvsWrapped) return obj;
      const original = obj.create;
      if (typeof original === "function") {
        obj.create = function () {
          const player = original.apply(this, arguments);
          try {
            twitchCapturedIvs = player;
          } catch (e) {}
          return player;
        };
        try {
          obj.__qsIvsWrapped = true;
        } catch (e) {}
      }
      return obj;
    };
    if (ivsRef) wrapIvs(ivsRef);
    Object.defineProperty(window, "IVSPlayer", {
      configurable: true,
      get() {
        return ivsRef;
      },
      set(v) {
        ivsRef = wrapIvs(v);
      },
    });
  } catch (e) {}
  }

  function twitchLooksLikePlayer(obj) {
    if (!obj || (typeof obj !== "object" && typeof obj !== "function"))
      return false;
    try {
      return (
        typeof obj.getQualities === "function" &&
        typeof obj.setQuality === "function"
      );
    } catch (e) {
      return false;
    }
  }

  // Recorre un árbol (fiber de React, store, etc.) con límites duros para no
  // colgar la pestaña. Devuelve el primer objeto que se comporte como player.
  function twitchWalkForPlayer(root, maxDepth, maxVisited) {
    let found = null;
    let visited = 0;
    const seen = new WeakSet();
    (function walk(obj, depth) {
      if (found || !obj || typeof obj !== "object") return;
      if (seen.has(obj)) return;
      try {
        if (obj instanceof Node || obj === window) return;
      } catch (e) {}
      seen.add(obj);
      if (++visited > maxVisited) return;
      if (twitchLooksLikePlayer(obj)) {
        found = obj;
        return;
      }
      if (depth >= maxDepth) return;
      let keys = [];
      try {
        keys = Object.keys(obj);
      } catch (e) {}
      for (let i = 0; i < keys.length; i++) {
        let val;
        try {
          val = obj[keys[i]];
        } catch (e) {
          continue;
        }
        walk(val, depth + 1);
        if (found) return;
      }
    })(root, 0);
    return found;
  }

  function twitchAnchors() {
    const out = [];
    const push = (el) => {
      if (el && out.indexOf(el) === -1) out.push(el);
    };
    [
      '[data-a-target="video-player"]',
      '[data-test-selector="video-player"]',
      ".video-player",
      "#video-player",
    ].forEach((sel) => {
      try {
        document.querySelectorAll(sel).forEach(push);
      } catch (e) {}
    });

    // Respaldo: el <video> real. Priorizamos el que está reproduciendo y
    // ocupa más pantalla, para no enganchar un preview de la grilla.
    let videos = [];
    try {
      videos = Array.from(document.querySelectorAll("video"));
    } catch (e) {}
    videos
      .map((v) => {
        let score = 0;
        try {
          if (!v.paused && !v.ended) score += 4;
          if (v.videoWidth) score += 2;
          const rect = v.getBoundingClientRect();
          if (rect.width * rect.height > 200000) score += 3;
        } catch (e) {}
        return { v, score };
      })
      .sort((a, b) => b.score - a.score)
      .forEach((item) => push(item.v));

    return out;
  }

  function twitchPlayerFromNode(node) {
    // Algunas versiones cuelgan el player directo del nodo (expando). Se
    // revisan nombres y símbolos: no todos los wrappers usan props normales.
    try {
      const keys = Object.getOwnPropertyNames(node).concat(
        Object.getOwnPropertySymbols(node)
      );
      for (let i = 0; i < keys.length; i++) {
        let val;
        try {
          val = node[keys[i]];
        } catch (e) {
          continue;
        }
        if (twitchLooksLikePlayer(val)) return val;
      }
    } catch (e) {}

    let fiberKey = null;
    try {
      fiberKey = Object.keys(node).find(
        (k) =>
          k.indexOf("__reactFiber$") === 0 ||
          k.indexOf("__reactInternalInstance$") === 0
      );
    } catch (e) {}
    if (!fiberKey) return null;
    return twitchWalkForPlayer(node[fiberKey], 10, 120000);
  }

  function twitchFindPlayer() {
    if (!isTwitchHost()) return null;

    // Instancia capturada del SDK de IVS: es la vía más directa.
    if (twitchCapturedIvs && twitchLooksLikePlayer(twitchCapturedIvs)) {
      twitchCachedPlayer = twitchCapturedIvs;
      twitchPlayerNode = null;
      twitchCachedUrl = location.href;
      return twitchCapturedIvs;
    }

    // Al cambiar de canal en la SPA conviene volver a resolver: el nodo puede
    // seguir siendo el mismo, pero el player se recrea.
    if (twitchCachedPlayer && twitchCachedUrl !== location.href) {
      twitchCachedPlayer = null;
      twitchPlayerNode = null;
    }

    // Cache: si el nodo sigue en el DOM y el player responde, no repetimos
    // el recorrido de React (es caro).
    if (
      twitchCachedPlayer &&
      typeof twitchCachedPlayer.getQualities === "function"
    ) {
      if (!twitchPlayerNode || document.contains(twitchPlayerNode)) {
        return twitchCachedPlayer;
      }
    }

    // El popup consulta el estado cada 250 ms. Si todavía no hay player, no
    // repetimos el recorrido profundo en cada consulta.
    const now = Date.now();
    if (now - twitchLastFindAttempt < 1500) return null;
    twitchLastFindAttempt = now;

    const anchors = twitchAnchors();
    for (let i = 0; i < anchors.length; i++) {
      const found = twitchPlayerFromNode(anchors[i]);
      if (found) {
        twitchCachedPlayer = found;
        twitchPlayerNode = anchors[i];
        twitchCachedUrl = location.href;
        return found;
      }
    }

    // Último recurso: algunos builds guardan el player en un store global.
    // Como máximo cada 3 s para no colgar el popup.
    if (now - twitchLastWindowScan > 3000) {
      twitchLastWindowScan = now;
      let props = [];
      try {
        props = Object.getOwnPropertyNames(window);
      } catch (e) {}
      for (let i = 0; i < props.length; i++) {
        let val;
        try {
          val = window[props[i]];
        } catch (e) {
          continue;
        }
        if (!val || typeof val !== "object") continue;
        try {
          if (val instanceof Node) continue;
        } catch (e) {}
        if (twitchLooksLikePlayer(val)) {
          twitchCachedPlayer = val;
          twitchPlayerNode = null;
          twitchCachedUrl = location.href;
          return val;
        }
        const found = twitchWalkForPlayer(val, 3, 30000);
        if (found) {
          twitchCachedPlayer = found;
          twitchPlayerNode = null;
          twitchCachedUrl = location.href;
          return found;
        }
      }
    }

    return null;
  }

  function twitchQualityKey(q) {
    if (!q) return "";
    return String(q.group || q.name || "");
  }

  function twitchQualityLabel(q) {
    if (!q) return "Auto";
    const name = String(q.name || "");
    if (name === "audio_only" || /audio.?only/i.test(name)) return "Audio Only";
    const height = Number(q.height) || 0;
    const fps = Number(q.framerate) || 0;
    const isSource = name === "chunked" || /source/i.test(name);
    if (!height) return isSource ? "Source" : name || "Calidad";
    const label = `${height}p${fps >= 50 ? Math.round(fps) : ""}`;
    return isSource ? `${label} (Source)` : label;
  }

  function twitchCurrentQuality(player) {
    try {
      return player.getQuality() || null;
    } catch (e) {
      return null;
    }
  }

  function twitchIsAuto(player) {
    try {
      if (typeof player.isAutoQualityMode === "function") {
        return !!player.isAutoQualityMode();
      }
    } catch (e) {}
    const key = twitchQualityKey(twitchCurrentQuality(player));
    if (!key || key === "auto") return true;
    try {
      const raw = localStorage.getItem("video-quality");
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && parsed.default === "auto") return true;
      }
    } catch (e) {}
    return false;
  }

  function getTwitchQualities(player) {
    let qualities = [];
    try {
      qualities = player.getQualities() || [];
    } catch (e) {}
    const current = twitchCurrentQuality(player);
    const currentKey = twitchQualityKey(current);
    const auto = twitchIsAuto(player);

    const list = [];
    const seen = new Set();
    qualities.forEach((q) => {
      const key = twitchQualityKey(q);
      if (!key || key === "auto" || seen.has(key)) return;
      seen.add(key);
      list.push({
        id: "q:" + key,
        label: twitchQualityLabel(q),
        active: !auto && key === currentKey,
        __bitrate: q.bitrate || 0,
      });
    });
    list.sort((a, b) => b.__bitrate - a.__bitrate);
    list.forEach((q) => delete q.__bitrate);

    list.push({
      id: "auto",
      label: "Auto",
      active: auto,
    });
    return list;
  }

  function twitchPersist(q) {
    try {
      if (!q) {
        localStorage.setItem(
          "video-quality",
          JSON.stringify({ default: "auto" })
        );
        return;
      }
      const group = twitchQualityKey(q);
      if (group) {
        localStorage.setItem(
          "video-quality",
          JSON.stringify({ default: group })
        );
      }
      const bitrate = Number(q.bitrate);
      if (Number.isFinite(bitrate) && bitrate > 0) {
        localStorage.setItem("quality-bitrate", String(bitrate));
      }
      localStorage.setItem("video-quality-highest-available", "false");
    } catch (e) {}
  }

  function twitchSetAuto(player) {
    // Amazon IVS (el player nuevo de Twitch) expone setAutoQualityMode. Es la
    // forma correcta de volver a Auto; setQuality desactiva el ABR.
    try {
      if (typeof player.setAutoQualityMode === "function") {
        player.setAutoQualityMode(true);
        return true;
      }
    } catch (e) {}
    try {
      player.setQuality({ name: "auto", group: "auto" });
      return true;
    } catch (e) {}
    try {
      player.setQuality("auto");
      return true;
    } catch (e) {}
    try {
      player.setQuality(null);
      return true;
    } catch (e) {}
    return false;
  }

  function applyTwitchQuality(player, id) {
    if (!player) return false;

    if (id === "auto") {
      const ok = twitchSetAuto(player);
      if (ok) twitchPersist(null);
      return ok;
    }

    let qualities = [];
    try {
      qualities = player.getQualities() || [];
    } catch (e) {}
    const key = String(id).replace(/^q:/, "");
    const target = qualities.find((q) => twitchQualityKey(q) === key);
    if (!target) return false;

    let ok = false;
    try {
      player.setQuality(target);
      ok = true;
    } catch (e) {}
    // Algunas versiones del player aceptan el string del grupo en vez del
    // objeto (es lo que documenta la API pública de embeds).
    if (!ok) {
      try {
        player.setQuality(target.group || target.name);
        ok = true;
      } catch (e) {}
    }
    if (!ok) {
      try {
        player.setQuality(target.name);
        ok = true;
      } catch (e) {}
    }
    if (!ok) return false;

    twitchPersist(target);
    return true;
  }

  // Diagnóstico rápido desde la consola: __qsTwitchDebug()
  try {
    window.__qsTwitchDebug = () => {
      const player = twitchFindPlayer();
      let qualities = [];
      let current = null;
      try {
        qualities = player ? player.getQualities() || [] : [];
      } catch (e) {}
      try {
        current = player ? player.getQuality() : null;
      } catch (e) {}
      return {
        host: location.hostname,
        found: !!player,
        auto: player ? twitchIsAuto(player) : null,
        ivsCaptured: !!twitchCapturedIvs,
        ivsGlobal: typeof window.IVSPlayer,
        current: current
          ? {
              name: current.name,
              group: current.group,
              height: current.height,
              bitrate: current.bitrate,
              framerate: current.framerate,
            }
          : null,
        qualities: qualities.map((q) => ({
          name: q.name,
          group: q.group,
          height: q.height,
          bitrate: q.bitrate,
          framerate: q.framerate,
        })),
        storage: (() => {
          try {
            return {
              videoQuality: localStorage.getItem("video-quality"),
              bitrate: localStorage.getItem("quality-bitrate"),
            };
          } catch (e) {
            return null;
          }
        })(),
      };
    };
  } catch (e) {}

  // Diagnóstico profundo (solo si __qsTwitchDebug() no encuentra el player):
  // __qsTwitchProbe(). Recorre los fibers con más profundidad y reporta
  // anclas, videos y candidatos con métodos de player.
  try {
    window.__qsTwitchProbe = () => {
      const out = {
        host: location.hostname,
        anchors: [],
        videos: [],
        candidates: [],
        windowCandidates: [],
        visited: 0,
      };
      const safe = (f, fallback) => {
        try {
          return f();
        } catch (e) {
          return fallback;
        }
      };
      const methodNames = [
        "getQualities",
        "setQuality",
        "getQuality",
        "isAutoQualityMode",
        "setAutoQualityMode",
        "getAutoMaxQuality",
        "setAutoMaxQuality",
        "attachHTMLVideoElement",
        "getHTMLVideoElement",
        "getState",
        "getVersion",
        "getSessionId",
      ];
      const methodsOf = (o) => {
        const ms = [];
        methodNames.forEach((n) => {
          if (safe(() => typeof o[n] === "function", false)) ms.push(n);
        });
        return ms;
      };
      const ctorOf = (o) =>
        safe(() => (o.constructor && o.constructor.name) || "", "");
      const reactKeysOf = (el) =>
        safe(
          () => Object.keys(el).filter((k) => k.indexOf("__react") === 0),
          []
        );
      const expandoOf = (el) =>
        safe(
          () => Object.keys(el).filter((k) => k.indexOf("__") === 0),
          []
        );

      const anchors = twitchAnchors();
      out.anchors = anchors.map((el) => ({
        tag: el.tagName,
        id: el.id || null,
        cls: String(el.className || "").slice(0, 80),
        dataTarget: safe(() => el.getAttribute("data-a-target"), null),
        react: reactKeysOf(el),
        expando: expandoOf(el),
      }));

      out.videos = safe(
        () =>
          Array.from(document.querySelectorAll("video")).map((v) => ({
            src: String(v.currentSrc || v.src || "").slice(0, 120),
            width: v.videoWidth,
            height: v.videoHeight,
            paused: v.paused,
            react: reactKeysOf(v),
            expando: expandoOf(v),
          })),
        []
      );

      const seen = new WeakSet();
      let visited = 0;
      const walk = (obj, depth, path, rootLabel) => {
        if (!obj || typeof obj !== "object") return;
        if (seen.has(obj)) return;
        if (safe(() => obj instanceof Node || obj === window, false)) return;
        seen.add(obj);
        if (++visited > 200000) return;
        const ms = methodsOf(obj);
        if (ms.length) {
          out.candidates.push({
            root: rootLabel,
            path: path.join("."),
            depth,
            ctor: ctorOf(obj),
            methods: ms,
            keys: safe(() => Object.keys(obj).slice(0, 14), []),
          });
        }
        if (depth >= 12) return;
        let keys = [];
        try {
          keys = Object.keys(obj);
        } catch (e) {}
        for (let i = 0; i < keys.length; i++) {
          let val;
          try {
            val = obj[keys[i]];
          } catch (e) {
            continue;
          }
          walk(val, depth + 1, path.concat(keys[i]), rootLabel);
        }
      };

      anchors.forEach((el, idx) => {
        const label = "anchor#" + idx;
        const rk = safe(
          () =>
            Object.keys(el).find(
              (k) =>
                k.indexOf("__reactFiber") === 0 ||
                k.indexOf("__reactInternalInstance") === 0
            ),
          null
        );
        if (rk) walk(el[rk], 0, [rk], label);
        expandoOf(el).forEach((k) => {
          const val = safe(() => el[k], null);
          const ms = val && typeof val === "object" ? methodsOf(val) : [];
          if (ms.length) {
            out.candidates.push({
              root: label + ".expando",
              path: k,
              depth: 0,
              ctor: ctorOf(val),
              methods: ms,
              keys: safe(() => Object.keys(val).slice(0, 14), []),
            });
          }
        });
      });

      safe(
        () =>
          Object.getOwnPropertyNames(window).forEach((k) => {
            const val = safe(() => window[k], null);
            if (!val || typeof val !== "object") return;
            if (safe(() => val instanceof Node, false)) return;
            const ms = methodsOf(val);
            if (ms.length) {
              out.windowCandidates.push({
                key: k,
                ctor: ctorOf(val),
                methods: ms,
                keys: safe(() => Object.keys(val).slice(0, 14), []),
              });
            }
          }),
        null
      );

      out.visited = visited;
      out.candidateCount = out.candidates.length;
      out.candidates = out.candidates.slice(0, 20);
      return out;
    };
  } catch (e) {}

  // --- Kick: calidad a través del menú ARIA del player ----------------------
  //
  // Kick no expone hls.js, Shaka ni una API de calidad. La única fuente real
  // es su propio menú ⚙️, hecho con primitivas ARIA: las opciones son
  // [role="menuitemradio"] y la elegida lleva aria-checked="true". Un .click()
  // pelado lo ignora, así que hay que simular la secuencia de puntero.
  //
  // Leer la lista implica abrir el menú, por eso lo hacemos solo cuando el
  // popup lo pide y cacheamos el resultado unos minutos por URL. Todo es
  // best-effort: si el sitio cambia sus selectores, el selector queda en Auto
  // y el resto de la extensión (velocidad, volumen) sigue funcionando.

  const KICK_ITEM_SELECTOR =
    '[role="menuitemradio"], [role="radio"], [role="menuitemcheckbox"]';
  const KICK_BUTTON_SELECTOR = 'button[aria-haspopup="menu"]';
  const KICK_QUALITY_TTL_MS = 180000;
  // No cacheamos los fracasos: lo más común es que la primera lectura caiga
  // mientras el player todavía está cargando, y un cache negativo hacía que
  // pareciera roto hasta que expiraba. El popup reintenta una vez solo.
  const KICK_FAIL_TTL_MS = 0;
  const KICK_STEP_MS = 140;
  const KICK_MENU_TICKS = 16;
  // Palabras con las que Kick puede rotular la entrada/sección de calidad.
  const KICK_QUALITY_WORD = /calidad|quality|resoluci[oó]n|resolution/i;
  // Presupuesto amplio: puede haber que probar hasta 3 botones (subtítulos
  // primero, audio, recién después ajustes) y cada intento espera el menú.
  const KICK_SCAN_BUDGET_MS = 4500;
  const KICK_SET_BUDGET_MS = 4500;

  let kickQualityCache = { href: null, at: 0, ttl: KICK_QUALITY_TTL_MS, list: [] };
  let kickQualityScan = null;
  let kickSetInFlight = false;
  // Motivo del último fracaso, para que el aviso del popup diga algo útil:
  // "sin-video", "sin-engranaje", "menu-no-abrio", "menu-equivocado" o
  // "menu-vacio".
  let kickLastFail = null;

  function isKickHost() {
    try {
      return /(^|\.)kick\.com$/i.test(location.hostname);
    } catch (e) {
      return false;
    }
  }

  function kickSleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function kickLabelOf(node) {
    return String((node && node.textContent) || "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function kickKeyOf(text) {
    const key = String(text || "")
      .replace(/\s+/g, "")
      .toLowerCase();
    // El menú puede etiquetar Auto como "Auto (720p60)": cualquier etiqueta
    // que empiece con "auto" es la misma opción.
    return key.indexOf("auto") === 0 ? "auto" : key;
  }

  function kickSameQuality(a, b) {
    const ka = kickKeyOf(a);
    return !!ka && ka === kickKeyOf(b);
  }

  function kickMainVideo() {
    let best = null;
    let bestArea = 0;
    try {
      document.querySelectorAll("video").forEach((v) => {
        if (!isRealMediaElement(v)) return;
        const rect = v.getBoundingClientRect();
        const area = rect.width * rect.height;
        if (area > bestArea) {
          best = v;
          bestArea = area;
        }
      });
    } catch (e) {}
    return best;
  }

  // Las etiquetas reales de Kick son "1080p60", "720p", "Auto", etc. Filtrar
  // por forma evita confundir un radiogroup de ajustes con la lista de
  // calidades.
  function kickLooksLikeQuality(text) {
    const t = String(text || "").trim();
    if (!t) return false;
    if (/^auto\b/i.test(t)) return true;
    if (/^(source|original)\b/i.test(t)) return true;
    return /^\d{3,4}\s*p/i.test(t);
  }

  function kickMenuItems() {
    let items = [];
    try {
      items = Array.from(document.querySelectorAll(KICK_ITEM_SELECTOR));
    } catch (e) {
      items = [];
    }
    // Si el menú no usa radios ARIA, probamos las opciones del menú/diálogo
    // que esté abierto.
    if (!items.length) {
      try {
        const scopes = Array.from(
          document.querySelectorAll(
            '[role="menu"], [role="dialog"], [role="listbox"]'
          )
        );
        scopes.forEach((scope) => {
          try {
            scope
              .querySelectorAll('[role="option"], button')
              .forEach((el) => items.push(el));
          } catch (e) {}
        });
      } catch (e) {}
    }
    return items.filter((item) => {
      try {
        if (!item.getClientRects().length) return false;
        return kickLooksLikeQuality(kickLabelOf(item));
      } catch (e) {
        return false;
      }
    });
  }

  // Contenedores de menú que están visibles ahora mismo. Kick usa
  // [role="menu"] para el menú de ajustes, pero por las dudas cubrimos
  // diálogos y listboxes.
  function kickVisibleMenuNodes() {
    try {
      return Array.from(
        document.querySelectorAll(
          '[role="menu"], [role="dialog"], [role="listbox"]'
        )
      ).filter((node) => !kickIsHidden(node));
    } catch (e) {
      return [];
    }
  }

  function kickAnyMenuOpen() {
    return kickVisibleMenuNodes().length > 0;
  }

  // Hay un menú abierto, sea el de calidades (radios) o cualquier otro
  // contenedor ARIA.
  function kickMenuIsOpen() {
    return kickMenuItems().length > 0 || kickAnyMenuOpen();
  }

  // El click abrió un menú que no es el de calidades (subtítulos, audio,
  // idioma…). Si hay opciones con forma de calidad no está equivocado; si el
  // texto menciona "Calidad"/"Quality" es un menú de nivel superior al que
  // todavía hay que entrar.
  function kickMenuLooksWrong() {
    if (kickMenuItems().length) return false;
    const nodes = kickVisibleMenuNodes();
    if (!nodes.length) return false;
    const text = nodes.map((node) => kickLabelOf(node)).join(" ");
    return !KICK_QUALITY_WORD.test(text);
  }

  function kickPointerEvent(type, extra) {
    const init = {
      bubbles: true,
      cancelable: true,
      composed: true,
      pointerId: 1,
      pointerType: "mouse",
      isPrimary: true,
    };
    if (extra) Object.assign(init, extra);
    try {
      return typeof PointerEvent === "function"
        ? new PointerEvent(type, init)
        : new MouseEvent(type, init);
    } catch (e) {
      return new MouseEvent(type, init);
    }
  }

  // El menú de Kick ignora .click(): hay que pasar por toda la secuencia.
  //
  // OJO: no llamamos el.focus(). Un focus en la página le saca el foco al popup
  // de la extensión y Chrome lo cierra, justo mientras estamos leyendo el menú.
  // Los eventos sintéticos no disparan acciones por defecto, así que alcanza
  // con la secuencia de puntero.
  function kickClick(el) {
    if (!el) return;
    [
      "pointerover",
      "pointerenter",
      "pointerdown",
      "mousedown",
      "pointerup",
      "mouseup",
      "click",
    ].forEach((type) => {
      try {
        el.dispatchEvent(kickPointerEvent(type));
      } catch (e) {}
    });
  }

  // Los controles se ocultan por inactividad; sin esto el engranaje no existe
  // en el DOM cuando el popup pregunta.
  function kickRevealControls(video) {
    const player = video.closest("video-player") || video.parentElement || video;
    let rect;
    try {
      rect = video.getBoundingClientRect();
    } catch (e) {
      return;
    }
    const point = {
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
    };
    // Mezclamos PointerEvent y MouseEvent igual que el userscript de
    // referencia: algunos handlers de Kick escuchan solo uno de los dos.
    [video, player].forEach((target) => {
      if (!target) return;
      ["pointerover", "pointermove"].forEach((type) => {
        try {
          target.dispatchEvent(kickPointerEvent(type, point));
        } catch (e) {}
      });
      ["mouseover", "mousemove"].forEach((type) => {
        try {
          target.dispatchEvent(
            new MouseEvent(type, {
              bubbles: true,
              cancelable: true,
              composed: true,
              clientX: point.clientX,
              clientY: point.clientY,
            })
          );
        } catch (e) {}
      });
    });
  }

  function kickIsHidden(el) {
    try {
      if (!el || !el.isConnected) return true;
      const rects = el.getClientRects();
      return !rects || !rects.length;
    } catch (e) {
      return true;
    }
  }

  function kickButtonLabel(btn) {
    try {
      return [
        btn.getAttribute("aria-label"),
        btn.getAttribute("title"),
        btn.getAttribute("data-tooltip"),
        btn.textContent,
      ]
        .filter(Boolean)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
    } catch (e) {
      return "";
    }
  }

  function kickIconName(btn) {
    try {
      const svg = btn.querySelector("svg[data-ds-icon]");
      if (svg) return svg.getAttribute("data-ds-icon") || "";
      const use = btn.querySelector("use");
      if (use) {
        return (
          use.getAttribute("href") || use.getAttribute("xlink:href") || ""
        );
      }
    } catch (e) {}
    return "";
  }

  // El botón de subtítulos también es un menú del player: si lo clickeamos
  // abrimos CC en vez de calidad. Lo identificamos por etiqueta o por ícono.
  function kickIsCaptionButton(btn) {
    try {
      const label = kickButtonLabel(btn);
      const icon = kickIconName(btn);
      if (/\b(subtitles?|captions?|closed-?captions?|cc)\b/i.test(label))
        return true;
      return /(^cc|subtitle|caption|closed-?caption)/i.test(icon);
    } catch (e) {
      return false;
    }
  }

  function kickRejectButton(btn) {
    try {
      if (btn.closest("header, nav")) return true;
      if (btn.querySelector("img")) return true;
      if (kickIsCaptionButton(btn)) return true;
      return /avatar|profile|account|user|follow|subscribe|share|report|chat|\b(play|pause|volume|mute|unmute|fullscreen|theater|cinema|picture|cast|airplay|download|clip|like|gift|reward|audio|language|idioma|subtítulos|subtitulos)\b/i.test(
        kickButtonLabel(btn)
      );
    } catch (e) {
      return true;
    }
  }

  // Candidatos a engranaje, del más al menos probable. No abrimos nada acá:
  // esto también lo usa el diagnóstico.
  function kickCogCandidates(video) {
    const root =
      (video && video.closest("video-player")) ||
      (video && video.parentElement) ||
      document;
    const out = [];
    const push = (el, from) => {
      if (!el || out.some((c) => c.el === el)) return;
      out.push({ el, from });
    };
    const query = (scope, sel) => {
      try {
        return Array.from(scope.querySelectorAll(sel));
      } catch (e) {
        return [];
      }
    };
    const named = /settings|setting|ajustes|config|quality|calidad/i;
    const addNamed = (b, from) => {
      if (named.test(kickButtonLabel(b)) || named.test(kickIconName(b)))
        push(b, from);
    };

    // 1) Botones de menú dentro del player (el engranaje suele ser uno).
    query(root, KICK_BUTTON_SELECTOR).forEach((b) => push(b, "haspopup-root"));
    query(root, '[role="button"][aria-haspopup="menu"]').forEach((b) =>
      push(b, "haspopup-root")
    );
    // 2) Lo mismo en todo el documento: los controles pueden estar montados
    //    fuera del contenedor del <video>.
    if (root !== document) {
      query(document, KICK_BUTTON_SELECTOR).forEach((b) =>
        push(b, "haspopup-doc")
      );
      query(document, '[role="button"][aria-haspopup="menu"]').forEach((b) =>
        push(b, "haspopup-doc")
      );
    }
    // 3) Botones con nombre o ícono de ajustes/calidad.
    query(root, "button").forEach((b) => addNamed(b, "named"));
    if (root !== document) {
      query(document, "button").forEach((b) => addNamed(b, "named-doc"));
    }
    // Nada de "cualquier botón": un fallback a ciegas podía terminar
    // clickeando play, volumen o pantalla completa.
    return out.filter((c) => !kickRejectButton(c.el));
  }

  // Orden de candidatos a engranaje: primero nombre/ícono de ajustes, después
  // por cercanía a la esquina inferior derecha. El primero es el que se usa;
  // los siguientes permiten recuperarse si el primero abre otro menú.
  function kickCogOrder(video) {
    const candidates = kickCogCandidates(video);
    if (!candidates.length) return [];
    // Un engranaje oculto (los controles se esconden por inactividad) igual
    // sirve: el handler de React existe aunque el botón no se vea.
    const visible = candidates.filter((c) => !kickIsHidden(c.el));
    const pool = visible.length ? visible : candidates;
    let rect = null;
    try {
      rect = video.getBoundingClientRect();
    } catch (e) {}
    const rank = (c) => {
      const label = kickButtonLabel(c.el);
      const icon = kickIconName(c.el);
      // Nombre o ícono explícito de ajustes: gana sobre cualquier otro menú
      // del player (subtítulos, audio, idioma).
      if (/settings|ajustes|config/i.test(label)) return -3000;
      if (/setting|gear|cog/i.test(icon)) return -2500;
      if (!rect) return 1e6;
      let r;
      try {
        r = c.el.getBoundingClientRect();
      } catch (e) {
        return 1e6;
      }
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const inside =
        cx >= rect.left &&
        cx <= rect.right &&
        cy >= rect.top - 20 &&
        cy <= rect.bottom + 80;
      const dist = Math.hypot(rect.right - cx, rect.bottom - cy);
      // Los que están fuera del video van al final.
      return inside ? dist : 1e5 + dist;
    };
    return pool
      .slice()
      .sort((a, b) => rank(a) - rank(b))
      .map((c) => c.el);
  }

  function kickSettingsButton(video) {
    return kickCogOrder(video)[0] || null;
  }

  // Abre el menú y espera a que aparezcan los radios. Devuelve el botón que lo
  // abrió (para poder cerrarlo), o null si no se abrió.
  //
  // Kick tiene varios botones con aria-haspopup="menu" (subtítulos, audio,
  // ajustes). Si el primero abre el menú equivocado, lo cerramos y probamos el
  // siguiente candidato en vez de rendirnos.
  async function kickOpenMenu(budgetMs) {
    const deadline = Date.now() + budgetMs;
    let reason = "sin-video";
    const tried = new Set();
    for (let attempt = 0; attempt < 3 && Date.now() < deadline; attempt++) {
      const video = kickMainVideo();
      if (!video) {
        reason = "sin-video";
        await kickSleep(KICK_STEP_MS);
        continue;
      }
      kickRevealControls(video);
      await kickSleep(KICK_STEP_MS);
      const order = kickCogOrder(video).filter((el) => !tried.has(el));
      if (!order.length) {
        // Si no había ningún candidato, es "sin-engranaje"; si ya los probamos
        // todos, conservamos el motivo del último intento.
        if (!tried.size) reason = "sin-engranaje";
        break;
      }
      const cog = order[0];
      tried.add(cog);
      reason = "menu-no-abrio";
      kickClick(cog);
      let wrongMenu = false;
      for (let tick = 0; tick < KICK_MENU_TICKS && Date.now() < deadline; tick++) {
        await kickSleep(KICK_STEP_MS);
        if (kickMenuItems().length) {
          kickLastFail = null;
          return cog;
        }
        // Algunos layouts abren primero un menú de nivel superior con una
        // entrada "Calidad"/"Quality".
        if (tick === 3) {
          let entry = null;
          try {
            entry = Array.from(
              document.querySelectorAll('[role="menuitem"]')
            ).find(
              (n) =>
                n.getClientRects().length &&
                KICK_QUALITY_WORD.test(n.textContent || "")
            );
          } catch (e) {}
          if (entry) kickClick(entry);
        }
        // Pasado medio segundo, si hay un menú abierto y no tiene opciones con
        // forma de calidad, es el equivocado (subtítulos, audio…): cerramos y
        // pasamos al siguiente botón.
        if (tick >= 5 && kickMenuLooksWrong()) {
          wrongMenu = true;
          break;
        }
      }
      if (wrongMenu) {
        reason = "menu-equivocado";
        await kickCloseMenu(cog);
        await kickSleep(KICK_STEP_MS);
        continue;
      }
      // No se abrió (o quedó a medio abrir): cerrar y reintentar.
      if (kickMenuIsOpen()) await kickCloseMenu(cog);
      await kickSleep(KICK_STEP_MS);
    }
    kickLastFail = reason;
    return null;
  }

  // Cierra el menú que esté abierto, sin importar cuál sea. No usamos click
  // sobre el <video> para no arriesgar un play/pause.
  async function kickCloseMenu(cog) {
    await kickSleep(60);
    if (!kickMenuIsOpen()) return;
    // El mismo botón que lo abrió lo cierra (toggle).
    if (cog) kickClick(cog);
    await kickSleep(KICK_STEP_MS);
    if (!kickMenuIsOpen()) return;
    // Escape cierra los menús ARIA.
    try {
      document.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          code: "Escape",
          bubbles: true,
        })
      );
    } catch (e) {}
    await kickSleep(90);
    if (!kickMenuIsOpen()) return;
    // Último recurso: click fuera del menú (nunca sobre el <video>, para no
    // arriesgar un play/pause).
    try {
      const outside = document.body || document.documentElement;
      if (outside) kickClick(outside);
    } catch (e) {}
    await kickSleep(60);
  }

  function kickReadMenu() {
    const seen = new Set();
    const list = [];
    kickMenuItems().forEach((item) => {
      const label = kickLabelOf(item);
      const key = kickKeyOf(label);
      if (!key || seen.has(key)) return;
      seen.add(key);
      list.push({
        id: label,
        label,
        active: item.getAttribute("aria-checked") === "true",
      });
    });
    return list;
  }

  function kickScanQualities() {
    if (kickQualityScan) return kickQualityScan;
    kickQualityScan = (async () => {
      let list = [];
      kickLastFail = null;
      try {
        const cog = await kickOpenMenu(KICK_SCAN_BUDGET_MS);
        if (cog) {
          list = kickReadMenu();
          if (!list.length) kickLastFail = "menu-vacio";
          await kickCloseMenu(cog);
        }
      } catch (e) {
        kickLastFail = kickLastFail || "error";
      } finally {
        kickQualityScan = null;
      }
      if (list.length) sortQualitiesDesc(list);
      kickQualityCache = {
        href: location.href,
        at: Date.now(),
        ttl: list.length ? KICK_QUALITY_TTL_MS : KICK_FAIL_TTL_MS,
        list,
      };
      return list;
    })();
    return kickQualityScan;
  }

  function kickCachedQualities() {
    if (kickQualityCache.href !== location.href) return [];
    return kickQualityCache.list.map((q) => ({ ...q }));
  }

  function kickWithAuto(list) {
    const out = (list || []).map((q) => ({ ...q }));
    // Si el menú no ofrece Auto, igual damos una entrada: es la única
    // elección segura cuando no hay nada mejor.
    if (!out.some((q) => kickSameQuality("auto", q.label))) {
      out.push({
        id: "auto",
        label: "Auto",
        active: !out.some((q) => q.active),
      });
    }
    return out;
  }

  function getKickQualities() {
    const fresh =
      kickQualityCache.href === location.href &&
      Date.now() - kickQualityCache.at < kickQualityCache.ttl;
    // Mientras se está aplicando una calidad no abrimos el menú otra vez: el
    // popup refresca la lista ~500 ms después de elegir y pelearía con el
    // cambio en curso.
    if (fresh || kickSetInFlight) {
      return Promise.resolve(kickWithAuto(kickCachedQualities()));
    }
    return kickScanQualities().then((list) => {
      const out = list.length ? list.map((q) => ({ ...q })) : kickCachedQualities();
      return kickWithAuto(out);
    });
  }

  function kickMarkActive(label) {
    if (kickQualityCache.href !== location.href) return;
    kickQualityCache = {
      href: location.href,
      at: Date.now(),
      ttl: KICK_QUALITY_TTL_MS,
      list: kickQualityCache.list.map((q) => ({
        ...q,
        active: kickSameQuality(q.label, label),
      })),
    };
  }

  async function kickSetQuality(id) {
    const wanted = kickKeyOf(id);
    if (!wanted) return false;
    kickSetInFlight = true;
    // Optimista: el popup refresca ~500 ms después y así muestra lo elegido
    // sin volver a abrir el menú. Si el click falla, se invalida el cache.
    kickMarkActive(id);
    let ok = false;
    try {
      const cog = await kickOpenMenu(KICK_SET_BUDGET_MS);
      if (cog) {
        const target = kickMenuItems().find((item) =>
          kickSameQuality(kickLabelOf(item), id)
        );
        if (target) {
          kickClick(target);
          const deadline = Date.now() + 1200;
          for (let tick = 0; tick < 12; tick++) {
            await kickSleep(100);
            if (
              target.getAttribute("aria-checked") === "true" ||
              !target.isConnected ||
              // El menú puede quedar montado pero oculto: si la opción ya no
              // se ve, el click cerró el menú y el cambio se aplicó.
              !target.getClientRects().length
            ) {
              ok = true;
              break;
            }
            if (Date.now() > deadline) break;
          }
        }
        await kickCloseMenu(cog);
      }
    } catch (e) {}
    kickSetInFlight = false;
    if (!ok) kickQualityCache.at = 0;
    return ok;
  }

  function kickFailLabel() {
    switch (kickLastFail) {
      case "sin-video":
        return "no hay <video>";
      case "sin-engranaje":
        return "no encontré el botón ⚙️";
      case "menu-no-abrio":
        return "el menú no se abrió";
      case "menu-equivocado":
        return "abrí otro menú (subtítulos/audio)";
      case "menu-vacio":
        return "el menú no mostró calidades";
      case "error":
        return "error inesperado";
      default:
        return "motivo desconocido";
    }
  }

  // Diagnóstico rápido desde la consola: __qsKickDebug() (no abre el menú).
  // Para forzar una lectura: __qsKickScan(). Para ver por qué falla:
  // __qsKickProbe() y __qsKickProbe(true).
  try {
    window.__qsKickDebug = () => {
      const video = kickMainVideo();
      return {
        host: location.hostname,
        video: video
          ? { width: video.videoWidth, height: video.videoHeight, paused: video.paused }
          : null,
        cachedAt: kickQualityCache.at || null,
        cached: kickCachedQualities(),
        openItems: kickReadMenu(),
        menuBusy: !!kickQualityScan,
        lastFail: kickLastFail,
      };
    };
    window.__qsKickScan = () => {
      kickQualityCache = {
        href: null,
        at: 0,
        ttl: KICK_QUALITY_TTL_MS,
        list: [],
      };
      return kickScanQualities().then((list) => list.map((q) => q.label));
    };
    // Sonda para cuando el menú no se deja leer. Sin argumentos NO toca nada:
    // devuelve videos, botones candidatos, menús y opciones que haya ahora.
    // Con `true` intenta abrir el menú y reporta el motivo si falla.
    window.__qsKickProbe = (openMenu) => {
      const video = kickMainVideo();
      const playerRoot = video
        ? video.closest("video-player") || video.parentElement
        : null;
      const describe = (el) => {
        if (!el) return null;
        let r = null;
        try {
          r = el.getBoundingClientRect();
        } catch (e) {}
        return {
          tag: el.tagName,
          role: el.getAttribute("role"),
          haspopup: el.getAttribute("aria-haspopup"),
          ariaLabel: el.getAttribute("aria-label"),
          title: el.getAttribute("title"),
          icon: kickIconName(el),
          text: kickLabelOf(el).slice(0, 60),
          visible: !kickIsHidden(el),
          rect: r
            ? [
                Math.round(r.left),
                Math.round(r.top),
                Math.round(r.width),
                Math.round(r.height),
              ]
            : null,
        };
      };
      const buttons = [];
      try {
        (playerRoot || document).querySelectorAll("button").forEach((b) => {
          buttons.push(describe(b));
        });
      } catch (e) {}
      const rawItems = [];
      try {
        document
          .querySelectorAll(
            '[role="menuitemradio"], [role="radio"], [role="menuitemcheckbox"], [role="menuitem"], [role="option"]'
          )
          .forEach((el) => {
            if (kickIsHidden(el)) return;
            rawItems.push({
              role: el.getAttribute("role"),
              text: kickLabelOf(el).slice(0, 60),
              checked: el.getAttribute("aria-checked"),
            });
          });
      } catch (e) {}
      const menus = [];
      try {
        document
          .querySelectorAll('[role="menu"], [role="dialog"], [role="listbox"]')
          .forEach((m) => {
            if (kickIsHidden(m)) return;
            menus.push({
              role: m.getAttribute("role"),
              text: kickLabelOf(m).slice(0, 160),
            });
          });
      } catch (e) {}
      const out = {
        host: location.hostname,
        href: location.href,
        video: video
          ? {
              w: video.clientWidth,
              h: video.clientHeight,
              videoW: video.videoWidth,
              videoH: video.videoHeight,
              paused: video.paused,
              muted: video.muted,
              inVideoPlayer: !!video.closest("video-player"),
            }
          : null,
        playerRoot: playerRoot ? playerRoot.tagName : null,
        cogPicked: describe(kickSettingsButton(video)),
        cogOrder: kickCogOrder(video)
          .slice(0, 6)
          .map(describe),
        cogs: kickCogCandidates(video)
          .slice(0, 12)
          .map((c) => ({ from: c.from, ...describe(c.el) })),
        buttons: buttons.slice(0, 24),
        menus: menus.slice(0, 8),
        rawItems: rawItems.slice(0, 24),
        items: kickReadMenu(),
        lastFail: kickLastFail,
        cacheAge: kickQualityCache.at ? Date.now() - kickQualityCache.at : null,
        cached: kickCachedQualities(),
      };
      if (!openMenu) return out;
      return kickScanQualities().then((list) => ({
        ...out,
        opened: list.map((q) => q.label),
        lastFail: kickLastFail,
      }));
    };
  } catch (e) {}

  // Recorre las propiedades de window en profundidad limitada (no solo el
  // primer nivel) buscando algo que matchee alguna de las firmas de arriba.
  // Muchas apps modernas (React/Redux, típico de servicios como HBO Max)
  // guardan la instancia del reproductor adentro del estado de la app en
  // vez de como una variable suelta de window, así que un escaneo de un
  // solo nivel no la encuentra.
  function scanForPlayer() {
    const seen = new Set();
    let visited = 0;
    const MAX_VISITED = 4000; // tope de seguridad para no colgar la página
    const MAX_DEPTH = 4;

    function tryValue(val) {
      if (!val || typeof val !== "object") return null;
      if (seen.has(val)) return null;
      seen.add(val);
      const res = classify(val);
      return res;
    }

    // video.js expone un registro global con todos los reproductores
    // instanciados, cada uno con su "tech" interno (que puede envolver
    // hls.js, dash.js o Shaka). Si existe, es la forma más directa de
    // encontrar la instancia real sin adivinar nombres.
    function tryVideoJs() {
      try {
        if (typeof window.videojs !== "function") return null;
        const players = window.videojs.getPlayers
          ? window.videojs.getPlayers()
          : {};
        for (const key in players) {
          const p = players[key];
          if (!p) continue;
          const tech = typeof p.tech === "function" ? p.tech({ IWillNotUseThisInPlugins: true }) : null;
          const candidates = [
            tech && tech.hls,
            tech && tech.dash && tech.dash.mediaPlayer,
            tech && tech.shaka,
            p.tech_,
          ];
          for (const c of candidates) {
            const res = tryValue(c);
            if (res) return res;
          }
        }
      } catch (e) {}
      return null;
    }

    // Recorre un objeto en profundidad limitada. Ya no descarta nodos del
    // DOM por completo: Object.getOwnPropertyNames() de un elemento solo
    // devuelve lo que alguna librería le "colgó" explícitamente (las
    // propiedades normales del DOM como .children o .parentNode viven en el
    // prototipo, no como propiedad propia), así que es seguro mirarlas —y es
    // justo ahí donde vimos que Disney+ guarda cosas como "mediaPlayer" o
    // "mediaClientElement". Sí evitamos reentrar en window/document enteros
    // para no volver a escanear toda la página en loop si algo tiene una
    // referencia circular a ellos.
    function walk(obj, depth) {
      try {
        if (visited > MAX_VISITED || depth > MAX_DEPTH) return null;
        if (!obj || typeof obj !== "object") return null;
        if (seen.has(obj)) return null;
        if (obj === window || obj === document) return null;
        seen.add(obj);
        visited++;

        const direct = classify(obj);
        if (direct) return direct;

        let keys;
        try {
          keys = getAllOwnKeys(obj);
        } catch (e) {
          return null;
        }

        for (const key of keys) {
          if (visited > MAX_VISITED) return null;
          let val;
          try {
            val = obj[key];
          } catch (e) {
            continue;
          }
          if (!val || typeof val !== "object") continue;
          const res = walk(val, depth + 1);
          if (res) return res;
        }
        return null;
      } catch (e) {
        // Cualquier otra rareza (proxies revocados, getters hostiles,
        // objetos exóticos de algún framework): no dejamos que esto tire
        // abajo el escaneo entero.
        return null;
      }
    }

    // React guarda una referencia interna en cada nodo del DOM que maneja
    // (la clave empieza con "__reactFiber$" o "__reactInternalInstance$"
    // según la versión). Subiendo desde el <video> por esa cadena de
    // "fibers" llegamos a los componentes que lo envuelven, y ahí miramos
    // sus refs (useRef), su estado (hooks) y sus props buscando algo que
    // matchee la firma de hls.js/dash.js/Shaka. Es mucho más directo que
    // buscar a ciegas por todo window, porque partimos de un lugar que
    // sabemos que está conectado al video real.
    function getReactFiberKey(domNode) {
      try {
        return Object.keys(domNode).find(
          (k) =>
            k.indexOf("__reactFiber$") === 0 ||
            k.indexOf("__reactInternalInstance$") === 0
        );
      } catch (e) {
        return null;
      }
    }

    function scanReactFiberFrom(domNode) {
      try {
        const key = getReactFiberKey(domNode);
        if (!key) return null;
        let fiber = domNode[key];
        const seenFibers = new Set();
        let hops = 0;

        while (fiber && hops < 40) {
          hops++;
          if (seenFibers.has(fiber)) break;
          seenFibers.add(fiber);

          const candidates = [];

          // Instancia de componente de clase (si lo es)
          if (fiber.stateNode && typeof fiber.stateNode === "object") {
            candidates.push(fiber.stateNode);
            try {
              Object.keys(fiber.stateNode).forEach((k) =>
                candidates.push(fiber.stateNode[k])
              );
            } catch (e) {}
          }

          // Hooks de componentes de función: memoizedState es una lista
          // enlazada; useRef() da un objeto {current: valor}.
          let hook = fiber.memoizedState;
          let hookHops = 0;
          while (hook && hookHops < 25) {
            hookHops++;
            const val = hook.memoizedState;
            if (val && typeof val === "object") {
              if ("current" in val) candidates.push(val.current);
              candidates.push(val);
            }
            hook = hook.next;
          }

          // Por si el reproductor viene como prop en vez de estado propio
          if (fiber.memoizedProps && typeof fiber.memoizedProps === "object") {
            try {
              Object.keys(fiber.memoizedProps).forEach((k) =>
                candidates.push(fiber.memoizedProps[k])
              );
            } catch (e) {}
          }

          for (const c of candidates) {
            const res = tryValue(c);
            if (res) return res;
          }

          fiber = fiber.return;
        }
      } catch (e) {}
      return null;
    }

    function tryReactFiber() {
      try {
        const videos = [];
        collectVideosDeep(document, videos);
        for (const v of videos) {
          // El <video> muchas veces lo inserta imperativamente la propia
          // librería del reproductor, no React vía JSX, así que la clave de
          // fiber puede estar en algún elemento padre (el contenedor que sí
          // renderiza React) y no en el video mismo. Subimos unos cuantos
          // niveles probando en cada uno.
          let node = v;
          let hops = 0;
          while (node && hops < 20) {
            const res = scanReactFiberFrom(node);
            if (res) return res;
            node = node.parentElement;
            hops++;
          }
        }
      } catch (e) {}
      return null;
    }

    // Fallback genérico para frameworks que no son React, y también para
    // Web Components propios de cada sitio (ej: <disney-web-player>, que
    // cuelga directamente propiedades como "mediaPlayer", "stateStore",
    // etc.). Miramos las propiedades "expando" propias de cada elemento
    // (normalmente un elemento del DOM no tiene propiedades propias
    // enumerables más allá de las que un framework/componente le cuelga) en
    // el video y sus ancestros, y desde cada una reusamos la búsqueda en
    // profundidad (walk) por si el reproductor real está anidado un par de
    // niveles más adentro de esa propiedad.
    function tryDomExpandoProps() {
      try {
        const videos = [];
        collectVideosDeep(document, videos);

        for (const v of videos) {
          let node = v;
          let hops = 0;
          while (node && hops < 20) {
            hops++;
            let keys;
            try {
              keys = getAllOwnKeys(node);
            } catch (e) {
              node = node.parentElement;
              continue;
            }
            for (const k of keys) {
              let val;
              try {
                val = node[k];
              } catch (e) {
                continue;
              }
              const res = walk(val, 0);
              if (res) return res;
            }
            node = node.parentElement;
          }
        }
      } catch (e) {}
      return null;
    }

    // 0) Netflix: su player no expone la firma de hls.js/dash.js/Shaka, así
    // que lo detectamos por su API de sesión y por el playback interno.
    // Solo en netflix.com.
    function tryNetflix() {
      const internal = getNetflixInternal();
      if (!internal) return null;
      return { type: "netflix", instance: internal };
    }
    const viaNetflix = tryNetflix();
    if (viaNetflix) return viaNetflix;

    // 0.1) YouTube: no usa hls.js/dash.js/Shaka, tiene su propio reproductor
    // con una API bien documentada y accesible directo en el DOM. Mucho más
    // simple y confiable que el escaneo genérico, así que va primero.
    //
    // Ojo con Shorts: en la misma página puede haber más de un
    // .html5-video-player (el de un video normal que quedó atrás y el de
    // Shorts). Elegimos el que está visible y con video activo, no el primero.
    function youtubePlayerScore(el) {
      let score = 0;
      try {
        const rect = el.getBoundingClientRect();
        if (rect.width > 100 && rect.height > 100) score += 4;
        const video = el.querySelector("video");
        if (video) {
          if (video.videoWidth) score += 4;
          if (!video.paused && !video.ended) score += 3;
          if (video.currentSrc || video.src) score += 1;
        }
        const levels = el.getAvailableQualityLevels() || [];
        if (levels.some((l) => l && l !== "auto")) score += 2;
      } catch (e) {}
      return score;
    }

    function tryYouTube() {
      try {
        const list = [];
        const push = (el) => {
          if (el && list.indexOf(el) === -1) list.push(el);
        };
        push(document.getElementById("movie_player"));
        document.querySelectorAll(".html5-video-player").forEach(push);
        let best = null;
        let bestScore = 0;
        list.forEach((el) => {
          if (typeof el.getAvailableQualityLevels !== "function") return;
          const score = youtubePlayerScore(el);
          if (score > bestScore) {
            bestScore = score;
            best = el;
          }
        });
        if (best) return { type: "youtube", instance: best };
      } catch (e) {}
      return null;
    }
    const viaYoutube = tryYouTube();
    if (viaYoutube) return viaYoutube;

    // 0.1.1) Twitch: player propio (React). No usa hls.js/dash.js/Shaka, así
    // que se detecta por su API interna. Solo en twitch.tv.
    const viaTwitch = twitchFindPlayer();
    if (viaTwitch) return { type: "twitch", instance: viaTwitch };

    // 0.1.2) Kick: tampoco expone hls.js/Shaka. La calidad se lee del menú
    // ARIA (ver adaptador de Kick más arriba). Exigimos un <video> real para
    // que el iframe de chat no se haga pasar por reproductor.
    if (isKickHost()) {
      const kickVideo = kickMainVideo();
      if (kickVideo) return { type: "kick", instance: kickVideo };
    }

    // 0.2) Disney+: player propio (Web Component <disney-web-player>) con su
    // mediaPlayer colgado como propiedad. Tampoco usa hls.js/dash.js/Shaka.
    const viaDisney = getDisneyPlayer();
    if (viaDisney) return { type: "disney", instance: viaDisney };

    // 0.3) HBO/Max: el player vive en el árbol de React (motor Gluon), no en
    // window. Solo en hbomax.com / max.com.
    const viaHbo = hboFindSession();
    if (viaHbo) return { type: "hbo", instance: viaHbo };

    // 1) Instancias registradas explícitamente por el sitio (algunos lo hacen
    //    para debug), ej: window.hls, window.player, window.dashPlayer, etc.
    const commonNames = [
      "hls",
      "Hls",
      "player",
      "videoPlayer",
      "dashPlayer",
      "shakaPlayer",
      "__player",
    ];
    for (const name of commonNames) {
      const res = tryValue(window[name]);
      if (res) return res;
    }

    // 2) video.js, si está presente
    const viaVideoJs = tryVideoJs();
    if (viaVideoJs) return viaVideoJs;

    // 2.5) Árbol de fibers de React, anclado en el/los <video> reales (y sus
    // ancestros)
    const viaReact = tryReactFiber();
    if (viaReact) return viaReact;

    // 2.6) Fallback genérico (Vue, Preact, frameworks propios)
    const viaExpando = tryDomExpandoProps();
    if (viaExpando) return viaExpando;

    // 3) Escaneo genérico en profundidad de todo window
    let props;
    try {
      props = Object.getOwnPropertyNames(window);
    } catch (e) {
      props = [];
    }

    for (const key of props) {
      if (visited > MAX_VISITED) break;
      let val;
      try {
        val = window[key];
      } catch (e) {
        continue;
      }
      const res = walk(val, 0);
      if (res) return res;
    }

    return null;
  }

  // Si ya encontramos una instancia antes, la reusamos en vez de volver a
  // escanear: si la página tiene más de un reproductor (por ejemplo uno
  // oculto para previews o publicidad), rescanear en cada llamada podía
  // hacer que agarráramos una instancia distinta cada vez, lo que se veía
  // como que "Auto" quedaba pegado o que la calidad no respetaba lo elegido.
  let cachedPlayer = null;
  let lastPlayerScanAt = 0;
  // Recorrer el árbol de objetos de la página cuesta (hasta 4000 nodos). Sin
  // este tope, cada consulta del popup disparaba un escaneo completo —y el
  // popup consulta varias veces por segundo—, lo que en Twitch (donde no hay
  // hls.js/dash/Shaka que encontrar) era trabajo puro tirado a la basura.
  const PLAYER_SCAN_TTL_MS = 3000;

  function isPlayerStillAlive(res) {
    if (!res) return false;
    try {
      if (res.type === "hls") return Array.isArray(res.instance.levels);
      if (res.type === "dash")
        return typeof res.instance.getBitrateInfoListFor === "function";
      if (res.type === "shaka")
        return Array.isArray(res.instance.getVariantTracks());
      if (res.type === "netflix") {
        if (!res.instance || !res.instance.pb) return false;
        if (!isNetflixPlayback(res.instance.pb)) return false;
        const id = res.instance.session && res.instance.session.sessionId;
        return collectNetflixSessions().some((s) => s.sessionId === id);
      }
      if (res.type === "youtube") {
        if (!document.body.contains(res.instance)) return false;
        if (typeof res.instance.getAvailableQualityLevels !== "function")
          return false;
        // Si el player quedó oculto o sin video (por ejemplo al pasar de un
        // video normal a Shorts en la misma pestaña), hay que re-detectar.
        const rect = res.instance.getBoundingClientRect();
        if (!rect.width && !rect.height) return false;
        return !!res.instance.querySelector("video");
      }
      if (res.type === "twitch") {
        if (twitchPlayerNode && !document.contains(twitchPlayerNode))
          return false;
        return typeof res.instance.getQualities === "function";
      }
      if (res.type === "kick") {
        // El <video> de Kick se reemplaza al cambiar de stream: si el que
        // guardamos ya no está en el documento, hay que re-detectar.
        return (
          isKickHost() &&
          isRealMediaElement(res.instance) &&
          document.contains(res.instance)
        );
      }
      if (res.type === "disney")
        return (
          document.body.contains(res.instance) &&
          !!res.instance.mediaPlayer &&
          typeof res.instance.mediaPlayer.play === "function"
        );
      if (res.type === "hbo") return !!hboPartsFromSession(res.instance);
    } catch (e) {
      return false;
    }
    return false;
  }

  function getActivePlayer() {
    if (isPlayerStillAlive(cachedPlayer)) return cachedPlayer;
    const now = Date.now();
    // "No hay player" también se cachea, con el mismo TTL.
    if (!cachedPlayer && now - lastPlayerScanAt < PLAYER_SCAN_TTL_MS) {
      return null;
    }
    lastPlayerScanAt = now;
    const found = scanForPlayer();
    // Un player de streaming sin media real no nos sirve y, además, casi
    // siempre es un falso positivo (objetos de la página con pinta de hls.js
    // que no lo son). Se descarta y se vuelve a escanear en el próximo TTL.
    // Netflix queda afuera de este chequeo a propósito: su playback interno
    // ya es una señal fuerte y el <video> puede tardar en aparecer (o estar en
    // otro frame), lo que antes hacía que el popup dijera "no se pudo acceder".
    const needsMedia =
      found &&
      (found.type === "hls" ||
        found.type === "dash" ||
        found.type === "shaka");
    cachedPlayer =
      found && (!needsMedia || getMediaElementForPlayer(found)) ? found : null;
    return cachedPlayer;
  }

  // --- Listar calidades disponibles según el tipo de reproductor ---

  // Muchas librerías de streaming listan varios "levels"/"tracks" para la
  // MISMA resolución (por ejemplo, el mismo 720p emparejado con pistas de
  // audio distintas, o codecs distintos). Esta función agrupa por
  // resolución/etiqueta y se queda con la variante de mayor bitrate de cada
  // grupo, guardando también todos los ids que comparten esa etiqueta para
  // poder detectar correctamente si el grupo está activo.
  function dedupeByLabel(rawItems, { getLabel, getRate, getId, getActive }) {
    const groups = new Map(); // label -> { bestId, bestRate, ids: [], active }

    rawItems.forEach((item) => {
      const label = getLabel(item);
      const rate = getRate(item) || 0;
      const id = getId(item);
      const active = getActive ? !!getActive(item) : false;

      if (!groups.has(label)) {
        groups.set(label, { bestId: id, bestRate: rate, ids: [id], active });
      } else {
        const g = groups.get(label);
        g.ids.push(id);
        if (active) g.active = true;
        if (rate > g.bestRate) {
          g.bestRate = rate;
          g.bestId = id;
        }
      }
    });

    // Ordenar de mayor a menor calidad (por bitrate)
    return Array.from(groups.entries())
      .sort((a, b) => b[1].bestRate - a[1].bestRate)
      .map(([label, g]) => ({
        id: g.bestId,
        ids: g.ids,
        label,
        active: g.active,
      }));
  }

  // Algunos players de YouTube (Shorts, embeds, o el player recién cargado)
  // devuelven solo "auto" en getAvailableQualityLevels(). Los formatos existen
  // igual en el player response, así que armamos la escalera desde ahí.
  //
  // En Shorts verticales (1080x1920) el campo height es 1920, pero YouTube
  // etiqueta la calidad por el lado corto ("1080p"). Por eso usamos
  // qualityLabel y, si falta, el menor entre width y height.
  function youtubeNominalHeight(f) {
    const label = String((f && f.qualityLabel) || "");
    const m = /^(\d+)p/i.exec(label);
    if (m) return parseInt(m[1], 10);
    const height = Number(f && f.height) || 0;
    const width = Number(f && f.width) || 0;
    if (height && width && width < height) return width;
    return height;
  }

  function youtubeQualitiesFromResponse(el) {
    const nameByHeight = {
      4320: "highres",
      2160: "hd2160",
      1440: "hd1440",
      1080: "hd1080",
      720: "hd720",
      480: "large",
      360: "medium",
      240: "small",
      144: "tiny",
    };
    const out = [];
    try {
      const response =
        typeof el.getPlayerResponse === "function"
          ? el.getPlayerResponse()
          : null;
      const data = response && response.streamingData;
      const formats = []
        .concat((data && data.adaptiveFormats) || [])
        .concat((data && data.formats) || []);
      const byHeight = new Map();
      formats.forEach((f) => {
        const mime = String((f && f.mimeType) || "");
        if (mime && mime.indexOf("video/") !== 0) return;
        const height = youtubeNominalHeight(f);
        if (!height || !nameByHeight[height]) return;
        const bitrate = Number(f && f.bitrate) || 0;
        const prev = byHeight.get(height);
        if (!prev || bitrate > prev.bitrate) {
          byHeight.set(height, {
            height,
            bitrate,
            fps: f.fps,
            label: String((f && f.qualityLabel) || ""),
          });
        }
      });
      Array.from(byHeight.values())
        .sort((a, b) => b.height - a.height)
        .forEach((v) => {
          const fpsTxt =
            !v.label && v.fps && v.fps >= 50
              ? ` ${Math.round(v.fps)}fps`
              : "";
          out.push({
            id: nameByHeight[v.height],
            label: v.label || `${v.height}p${fpsTxt}`,
            active: false,
          });
        });
    } catch (e) {}
    return out;
  }

  // Diagnóstico rápido desde la consola: __qsYouTubeDebug()
  try {
    window.__qsYouTubeDebug = () => {
      const players = [];
      const push = (el) => {
        if (el && players.indexOf(el) === -1) players.push(el);
      };
      push(document.getElementById("movie_player"));
      document.querySelectorAll(".html5-video-player").forEach(push);
      return players.map((el) => {
        const safe = (f) => {
          try {
            return f();
          } catch (e) {
            return null;
          }
        };
        const rect = safe(() => el.getBoundingClientRect());
        const video = safe(() => el.querySelector("video"));
        const response = safe(() =>
          typeof el.getPlayerResponse === "function"
            ? el.getPlayerResponse()
            : null
        );
        const formats =
          (response &&
            response.streamingData &&
            response.streamingData.adaptiveFormats) ||
          [];
        return {
          id: el.id || null,
          visible: !!(rect && rect.width && rect.height),
          levels: safe(() => el.getAvailableQualityLevels()),
          quality: safe(() => el.getPlaybackQuality()),
          video: video
            ? {
                width: video.videoWidth,
                height: video.videoHeight,
                paused: video.paused,
              }
            : null,
          heights: formats
            .filter((f) => String(f.mimeType || "").indexOf("video/") === 0)
            .map((f) => f.height)
            .filter(Boolean),
        };
      });
    };
  } catch (e) {}

  // Altura nominal de una etiqueta de calidad ("1080p · 5,0 Mbps" -> 1080).
  // Es la única fuente que comparten todos los adapters, así que el tope se
  // calcula sobre la lista final y nunca sobre variantes que el player no
  // puede usar.
  function qualityHeightFromLabel(label) {
    const m = /^\s*(\d{3,4})p/i.exec(String(label || ""));
    return m ? parseInt(m[1], 10) : 0;
  }

  function qualityCapFromList(list) {
    let best = null;
    for (const q of list || []) {
      if (!q) continue;
      // "Auto" y los modos (p. ej. "Máxima fija") no son una calidad concreta.
      if (q.id === -1 || q.id === -2 || q.id === "auto") continue;
      const height = qualityHeightFromLabel(q.label);
      if (!height) continue;
      if (!best || height > best.height) best = { height, label: q.label };
    }
    return best;
  }

  // La calidad más alta primero: al abrir el selector, el techo real queda a la
  // vista sin scrollear. Es estable, así que no reordena entradas de la misma
  // altura (variante exacta y su tope "(ABR)").
  function sortQualitiesDesc(list) {
    return list.sort((a, b) => {
      const ha = qualityHeightFromLabel(a && a.label);
      const hb = qualityHeightFromLabel(b && b.label);
      return hb - ha;
    });
  }

  // "¿Hasta qué calidad llega la cuenta?" Se responde con el techo real de la
  // sesión, calculado sobre la lista que el selector muestra.
  //
  // En Netflix comparamos además contra la lista cruda del player: si hay
  // variantes más altas que el filtro bloqueó, el límite es del equipo/DRM;
  // si no hay nada más arriba, el servidor no mandó nada mejor y el tope es de
  // la cuenta (plan o título).
  function getQualityCap(player, list) {
    try {
      const best = qualityCapFromList(list);
      if (!best) return null;
      if (player && player.type === "netflix") {
        const pb = player.instance && player.instance.pb;
        let rawMax = 0;
        for (const s of getNetflixVideoStreams(pb)) {
          const h =
            s.height ||
            s.videoHeight ||
            (s.videoTrack && s.videoTrack.height) ||
            0;
          if (h > rawMax) rawMax = h;
        }
        if (rawMax > best.height) {
          return {
            height: best.height,
            text: `Tope: ${best.height}p (${rawMax}p bloqueado)`,
          };
        }
        return { height: best.height, text: `Cuenta: hasta ${best.height}p` };
      }
      if (player && player.type === "kick") {
        // Kick no tiene planes: el techo es el que trae el stream.
        return { height: best.height, text: `Máx. del stream: ${best.label}` };
      }
      return { height: best.height, text: `Tope: ${best.height}p` };
    } catch (e) {
      // El tope es informativo: si algo falla, el selector sigue funcionando.
      return null;
    }
  }

  function getQualities(player) {
    if (!player) return [];

    if (player.type === "hls") {
      const levels = player.instance.levels || [];
      const currentLevel = player.instance.currentLevel;
      const list = dedupeByLabel(
        levels.map((lvl, i) => ({ ...lvl, __id: i })),
        {
          getLabel: (lvl) =>
            lvl.height
              ? `${lvl.height}p`
              : `${Math.round((lvl.bitrate || 0) / 1000)} kbps`,
          getRate: (lvl) => lvl.bitrate,
          getId: (lvl) => lvl.__id,
          getActive: (lvl) => lvl.__id === currentLevel,
        }
      );
      list.push({
        id: -1,
        label: "Auto",
        active: currentLevel === -1,
      });
      return list;
    }

    if (player.type === "dash") {
      let rawList = [];
      try {
        rawList = player.instance.getBitrateInfoListFor("video") || [];
      } catch (e) {}
      const currentIdx = (() => {
        try {
          return player.instance.getQualityFor("video");
        } catch (e) {
          return -1;
        }
      })();
      const autoOn = (() => {
        try {
          return player.instance.getSettings().streaming.abr.autoSwitchBitrate
            .video;
        } catch (e) {
          return true;
        }
      })();
      const list = dedupeByLabel(
        rawList.map((b, i) => ({ ...b, __id: i })),
        {
          getLabel: (b) =>
            b.height
              ? `${b.height}p`
              : `${Math.round((b.bitrate || 0) / 1000)} kbps`,
          getRate: (b) => b.bitrate,
          getId: (b) => b.__id,
          getActive: (b) => !autoOn && b.__id === currentIdx,
        }
      );
      list.push({ id: -1, label: "Auto", active: autoOn });
      return list;
    }

    if (player.type === "shaka") {
      let tracks = [];
      try {
        tracks = player.instance.getVariantTracks() || [];
      } catch (e) {}
      tracks = tracks.filter((t) => t.type === "variant" || !t.type);
      const list = dedupeByLabel(tracks, {
        getLabel: (t) =>
          t.height
            ? `${t.height}p`
            : `${Math.round((t.bandwidth || 0) / 1000)} kbps`,
        getRate: (t) => t.bandwidth,
        getId: (t) => t.id,
        getActive: (t) => t.active,
      });
      const lock = lockedInstances.get(player.instance);
      // "Máxima fija" es distinto de elegir el 1080p de la lista: acá
      // apagamos el ABR y seleccionamos la variante más alta, con
      // minHeight = maxHeight como segunda barrera. Puede cortar si la red no
      // aguanta, por eso es una opción explícita y no el comportamiento por
      // defecto.
      if (list.length) {
        list.unshift({
          id: -2,
          label: "Máxima fija",
          active: !!(lock && lock.hard),
        });
      }
      // "Auto" está activo si no tenemos un lock puesto por nosotros para
      // esta instancia.
      list.push({ id: -1, label: "Auto", active: !lock });
      return list;
    }

    if (player.type === "netflix") {
      const pb = player.instance && player.instance.pb;
      if (!pb) return [];
      const streams = getNetflixSelectableStreams(pb);
      // Un solo botón por bitrate: Netflix puede exponer la misma variante
      // repetida para distintos perfiles/codecs.
      const byBitrate = new Map();
      for (const s of streams) {
        if (!byBitrate.has(s.bitrate)) byBitrate.set(s.bitrate, s);
      }
      const list = Array.from(byBitrate.values())
        .sort((a, b) => b.bitrate - a.bitrate)
        .map((s) => ({
          id: s.bitrate,
          label: netflixLabel(s),
          active: !!(
            netflixSelection &&
            netflixSelection.mode === "bitrate" &&
            netflixSelection.bitrate === s.bitrate
          ),
        }));
      const current = getNetflixCurrentStream(pb);
      const autoLabel =
        !netflixSelection && current && current.height
          ? `Auto (${current.height}p)`
          : "Auto";
      list.push({ id: -1, label: autoLabel, active: !netflixSelection });
      return list;
    }

    if (player.type === "disney") {
      const dp = player.instance;
      const variants = (disneyLadder.variants || []).slice();
      const heights = (disneyLadder.heights || []).slice();
      // Si el interceptor no vio el master (por ejemplo, si el player lo pide
      // desde un Worker) no inventamos una escalera típica: mostramos solo lo
      // que realmente se leyó, más Auto.

      // Una preferencia vieja (de otro título) no debe quedar activa ni
      // filtrar la sesión actual: si la altura o la variante ya no existen,
      // la limpiamos y volvemos a Auto.
      let cap = getDisneyCap();
      if (cap && heights.indexOf(cap) === -1) {
        storeDisneyCap(null);
        cap = null;
      }
      let variantKey = getDisneyVariantKey();
      if (
        variantKey &&
        !variants.some((v) => disneyVariantKey(v) === variantKey)
      ) {
        storeDisneyVariantKey(null);
        variantKey = null;
      }

      const floor = getDisneyFloor();
      const current = getDisneyVideoHeight(dp);
      const list = [];

      if (variants.length) {
        // Etiquetas repetidas (misma altura y bitrate, distinto codec de
        // video): agregamos el codec para poder distinguirlas.
        const counts = {};
        variants.forEach((v) => {
          const label = disneyVariantLabel(v);
          counts[label] = (counts[label] || 0) + 1;
        });
        variants.forEach((v) => {
          const key = disneyVariantKey(v);
          let label = disneyVariantLabel(v);
          if (counts[label] > 1) label += ` (${disneyVideoCodec(v)})`;
          list.push({
            id: "v:" + key,
            label,
            active: !cap && variantKey === key,
          });
        });
        // Tope por altura: deja que el ABR elija el bitrate dentro de esa
        // altura. Solo si hay más de una variante en esa altura; si hay una
        // sola, el botón de la variante ya hace lo mismo.
        heights.forEach((h) => {
          const count = variants.filter((v) => v.height === h).length;
          if (count > 1) {
            list.push({
              id: h,
              label: `${h}p (ABR)`,
              active: cap === h && !variantKey,
            });
          }
        });
      } else {
        heights.forEach((h) => {
          list.push({ id: h, label: `${h}p`, active: cap === h });
        });
      }

      sortQualitiesDesc(list);
      let autoLabel = "Auto";
      if (!cap && !variantKey) {
        if (floor) autoLabel = `Auto (mín. ${floor}p)`;
        else if (current) autoLabel = `Auto (${current}p)`;
      }
      list.push({
        id: -1,
        label: autoLabel,
        active: !cap && !variantKey,
      });
      return list;
    }

    if (player.type === "hbo") {
      const parts = hboPartsFromSession(player.instance);
      return parts ? getHboQualities(parts) : [];
    }

    if (player.type === "twitch") {
      return getTwitchQualities(player.instance);
    }

    if (player.type === "youtube") {
      const labelMap = {
        highres: "4320p",
        hd2160: "2160p",
        hd1440: "1440p",
        hd1080: "1080p",
        hd720: "720p",
        large: "480p",
        medium: "360p",
        small: "240p",
        tiny: "144p",
      };
      let levels = [];
      let current = null;
      try {
        levels = player.instance.getAvailableQualityLevels() || [];
      } catch (e) {}
      try {
        current = player.instance.getPlaybackQuality();
      } catch (e) {}

      let list = levels
        .filter((l) => l !== "auto")
        .map((l) => ({
          id: l,
          label: labelMap[l] || l,
          active: l === current,
        }));

      // Shorts (y algunos embeds) solo listan "auto". Armamos la escalera con
      // los formatos reales del player response, que sí están disponibles.
      if (!list.length) {
        list = youtubeQualitiesFromResponse(player.instance);
        if (current && current !== "auto") {
          list.forEach((q) => {
            q.active = q.id === current;
          });
        }
      }

      sortQualitiesDesc(list);
      list.push({
        id: "auto",
        label: "Auto",
        active: current === "auto" || !list.some((q) => q.active),
      });
      return list;
    }

    return [];
  }

  // --- Forzar una calidad específica (id -1 = volver a automático) ---

  function setQuality(player, id) {
    if (!player) return;

    if (player.type === "youtube") {
      try {
        player.instance.setPlaybackQuality(id);
        // Método menos conocido que fija un rango (min, max) en vez de un
        // solo valor "sugerido"; en algunas versiones del player hace que
        // se respete un poco mejor.
        if (typeof player.instance.setPlaybackQualityRange === "function") {
          if (id === "auto") {
            player.instance.setPlaybackQualityRange("tiny", "highres");
          } else {
            player.instance.setPlaybackQualityRange(id, id);
          }
        }
      } catch (e) {}
      return;
    }

    if (player.type === "twitch") {
      applyTwitchQuality(player.instance, id);
      return;
    }

    if (player.type === "netflix") {
      const pb = player.instance && player.instance.pb;
      if (!pb) return;

      if (id === -1) {
        if (resetNetflixBitrate(pb)) netflixSelection = null;
        ensureNetflixGuards(getNetflixVideoElement());
        return;
      }

      if (applyNetflixBitrate(pb, Number(id))) {
        netflixSelection = { mode: "bitrate", bitrate: Number(id) };
        // Si Netflix reemplazó el <video>, los guards del elemento anterior
        // ya no sirven. Se enganchan al actual.
        ensureNetflixGuards(getNetflixVideoElement());
      }
      return;
    }

    if (player.type === "disney") {
      setDisneyQuality(player.instance, id);
      return;
    }

    if (player.type === "hbo") {
      const parts = hboPartsFromSession(player.instance);
      if (parts) applyHboQuality(parts, id);
      return;
    }

    if (player.type === "hls") {
      if (id === -1) {
        lockedInstances.delete(player.instance);
        player.instance.currentLevel = -1; // vuelve a automático
      } else {
        lockedInstances.set(player.instance, { type: "hls", id });
        attachHlsGuards(player.instance);
        player.instance.currentLevel = id;
      }
      return;
    }

    if (player.type === "dash") {
      if (id === -1) {
        lockedInstances.delete(player.instance);
        player.instance.updateSettings({
          streaming: { abr: { autoSwitchBitrate: { video: true } } },
        });
      } else {
        lockedInstances.set(player.instance, { type: "dash", id });
        player.instance.updateSettings({
          streaming: { abr: { autoSwitchBitrate: { video: false } } },
        });
        player.instance.setQualityFor("video", id);
      }
      return;
    }

    if (player.type === "shaka") {
      if (id === -2) {
        // "Máxima fija": no es elegir el 1080p de la lista. Acá apagamos el
        // ABR y seleccionamos la variante más alta. Las restrictions
        // min = max quedan como segunda barrera: si algo vuelve a encender
        // el ABR, igual no tiene a dónde bajar.
        const variants = getShakaVariants(player.instance);
        const best = variants
          .slice()
          .sort(
            (a, b) =>
              (b.height || 0) - (a.height || 0) ||
              (b.bandwidth || 0) - (a.bandwidth || 0)
          )[0];
        if (!best) return;

        const heights = Array.from(
          new Set(variants.filter((t) => t.height).map((t) => t.height))
        ).sort((a, b) => b - a);
        const restrictions = heights.length
          ? { minHeight: heights[0], maxHeight: heights[0] }
          : { minBandwidth: best.bandwidth, maxBandwidth: best.bandwidth };

        const lock = {
          type: "shaka",
          id: best.id,
          height: best.height,
          bandwidth: best.bandwidth,
          restrictions,
          abrRestrictions: restrictions,
          hard: true,
          lastReselect: Date.now(),
        };
        lockedInstances.set(player.instance, lock);
        attachShakaGuards(player.instance);

        // Cada paso por separado: si uno falla (build viejo, clave
        // desconocida), los demás igual se aplican.
        configureShakaSafe(player.instance, { restrictions });
        configureShakaSafe(player.instance, { abr: { restrictions } });
        configureShakaSafe(player.instance, { abr: { enabled: false } });

        // clearBuffer=true hace el cambio ya. Es un corte puntual y
        // deliberado: el usuario pidió el máximo, no "el máximo cuando el
        // buffer viejo se termine".
        try {
          player.instance.selectVariantTrack(best, true);
        } catch (e) {
          const target = findShakaTarget(player.instance, lock);
          if (target) {
            try {
              player.instance.selectVariantTrack(target, true);
            } catch (e2) {}
          }
        }
        return;
      }

      if (id === -1) {
        lockedInstances.delete(player.instance);
        const unrestricted = {
          minHeight: 0,
          maxHeight: Infinity,
          minBandwidth: 0,
          maxBandwidth: Infinity,
        };
        configureShakaSafe(player.instance, { restrictions: unrestricted });
        configureShakaSafe(player.instance, {
          abr: { restrictions: unrestricted },
        });
        configureShakaSafe(player.instance, { abr: { enabled: true } });
      } else {
        const tracks = player.instance.getVariantTracks();
        const track = tracks.find((t) => t.id === id);
        if (track) {
          let restrictions;
          if (track.height) {
            // Dejamos un escalón de margen hacia abajo en vez de pinear el
            // valor exacto: si el servidor deja de ofrecer esta resolución
            // por un rato (algo normal en streams en vivo cuando el encoder
            // recorta la escalera de calidades), el ABR puede caer al
            // escalón siguiente en vez de quedarse sin ninguna variante
            // válida y desplomarse hasta la más baja. maxHeight sigue siendo
            // el techo elegido: nunca sube más allá de eso.
            const heights = Array.from(
              new Set(tracks.filter((t) => t.height).map((t) => t.height))
            ).sort((a, b) => b - a);
            const idx = heights.indexOf(track.height);
            const oneStepDown =
              idx >= 0 && idx + 1 < heights.length ? heights[idx + 1] : 0;
            restrictions = { minHeight: oneStepDown, maxHeight: track.height };
          } else {
            restrictions = {
              minBandwidth: track.bandwidth,
              maxBandwidth: track.bandwidth,
            };
          }

          lockedInstances.set(player.instance, {
            type: "shaka",
            id: track.id,
            height: track.height,
            bandwidth: track.bandwidth,
            restrictions,
            abrRestrictions: restrictions,
            hard: false,
          });
          attachShakaGuards(player.instance);

          configureShakaSafe(player.instance, { restrictions });
          configureShakaSafe(player.instance, { abr: { restrictions } });
          configureShakaSafe(player.instance, { abr: { enabled: true } });
          // Un solo empujón inicial para no esperar a que el ABR reaccione
          // solo (puede tardar unos segundos).
          try {
            player.instance.selectVariantTrack(track, false);
          } catch (e) {}
        }
      }
      return;
    }
  }

  // --- Control de velocidad (para "alcanzar" el vivo y reducir el delay) ---

  // ¿Es un <video>/<audio> de verdad? `instanceof` solo es confiable dentro
  // del mismo realm, así que además chequeamos las propiedades que usamos.
  // Descarta los falsos positivos del escaneo de players (objetos que se
  // parecen a hls.js pero cuyo .media no es un elemento de video).
  function isRealMediaElement(el) {
    if (!el || typeof el !== "object") return false;
    try {
      if (typeof HTMLMediaElement !== "undefined" && el instanceof HTMLMediaElement) {
        return true;
      }
    } catch (e) {}
    try {
      return (
        typeof el.playbackRate === "number" &&
        typeof el.currentTime === "number" &&
        typeof el.paused === "boolean" &&
        el.buffered != null &&
        el.seekable != null
      );
    } catch (e) {
      return false;
    }
  }

  function getMediaElementForPlayer(player) {
    if (!player) return null;
    let el = null;
    try {
      if (player.type === "netflix") el = getNetflixVideoElement();
      else if (player.type === "kick") el = player.instance || kickMainVideo();
      else if (player.type === "disney") {
        // En Disney+ el <video> correcto es el del player; un
        // querySelector("video") puede devolver otro elemento vacío.
        el = player.instance.mediaElement || null;
      } else if (player.type === "hls") el = player.instance.media || null;
      else if (player.type === "dash")
        el =
          typeof player.instance.getVideoElement === "function"
            ? player.instance.getVideoElement()
            : null;
      else if (player.type === "shaka") {
        if (typeof player.instance.getMediaElement === "function") {
          el = player.instance.getMediaElement();
        }
        // Algunos wrappers no exponen getMediaElement pero sí guardan el
        // elemento en una propiedad interna con nombres habituales.
        if (!el) {
          for (const key of ["video_", "mediaElement_", "videoElement", "video"]) {
            if (isRealMediaElement(player.instance[key])) {
              el = player.instance[key];
              break;
            }
          }
        }
      }
      // Un "player" que no apunta a un media real no sirve: es un falso
      // positivo del escaneo. Lo vimos en Twitch: un objeto con pinta de
      // hls.js (levels/currentLevel/on) cuyo .media no era un <video>, y
      // desde ahí todo el control leía paused/duration/currentTime como
      // undefined. Devolvemos null para caer al <video> del DOM.
      return isRealMediaElement(el) ? el : null;
    } catch (e) {}
    return null;
  }

  function collectVideosDeep(root, out) {
    if (!root) return;
    let elements;
    try {
      elements = root.querySelectorAll("*");
    } catch (e) {
      return;
    }
    elements.forEach((el) => {
      if (el.tagName === "VIDEO") out.push(el);
      const shadow = el.shadowRoot || __qsShadowRegistry.get(el);
      if (shadow) collectVideosDeep(shadow, out);
    });
  }

  function getFallbackVideoElement() {
    const videos = [];
    try {
      collectVideosDeep(document, videos);
    } catch (e) {}
    let best = null;
    let bestScore = -1;
    videos.forEach((v) => {
      if (!isRealMediaElement(v)) return;
      let area = 0;
      try {
        const rect = v.getBoundingClientRect();
        area = rect.width * rect.height;
      } catch (e) {}
      // El área manda; entre dos iguales, gana el que está reproduciendo.
      // Así no elegimos un <video> vacío/hidden antes que el player real.
      const score = area + (v.paused === false ? 1 : 0);
      if (score > bestScore) {
        bestScore = score;
        best = v;
      }
    });
    return best;
  }

  function resolveVideoElement(player) {
    return getMediaElementForPlayer(player) || getFallbackVideoElement();
  }

  // Distancia al vivo: la diferencia entre el final del rango "seekable" y
  // el tiempo actual. Esto funciona igual para hls.js, dash.js y Shaka
  // porque todos escriben sobre el mismo <video> con Media Source
  // Extensions, así que el navegador expone el rango sin que necesitemos
  // ninguna API específica de cada librería.
  //
  // OJO con Twitch/IVS: no reportan el borde del vivo como un timestamp,
  // usan un centinela gigante (2^30 s, "infinito"). Ver MAX_SANE_LIVE_SECONDS.
  const MAX_SANE_LIVE_SECONDS = 8 * 24 * 3600; // una semana

  function getLiveDelaySeconds(video) {
    // YouTube con DVR no siempre expone el borde del vivo en seekable.end;
    // su propio player sí lo sabe (getProgressState().seekableEnd).
    try {
      const player = getPlayerForVideo(video);
      if (player && player.type === "youtube") {
        const inst = player.instance;
        if (typeof inst.getProgressState === "function") {
          const ps = inst.getProgressState();
          if (ps) {
            const end = ps.seekableEnd;
            const cur =
              typeof ps.current === "number" ? ps.current : video.currentTime;
            if (
              typeof end === "number" &&
              isFinite(end) &&
              end <= MAX_SANE_LIVE_SECONDS
            ) {
              return Math.max(0, end - cur);
            }
          }
        }
      }
    } catch (e) {}
    try {
      if (video.seekable && video.seekable.length > 0) {
        const end = video.seekable.end(video.seekable.length - 1);
        // Si el "borde" está absurdamente lejos, es un centinela y no un
        // tiempo real: preferimos "desconocido" antes que 1.073.741.720 s.
        if (!isFinite(end) || end > MAX_SANE_LIVE_SECONDS) return null;
        return Math.max(0, end - video.currentTime);
      }
    } catch (e) {}
    return null;
  }

  // Cuánto video ya descargado (buffered) hay por delante de la posición
  // actual de reproducción. Esto es DISTINTO de la distancia al vivo: cerca
  // del vivo ambos números se parecen, pero lo que realmente predice un
  // corte es quedarte sin buffer, no solo estar "cerca" del vivo.
  function getBufferAheadSeconds(video) {
    try {
      const t = video.currentTime;
      const buffered = video.buffered;
      for (let i = 0; i < buffered.length; i++) {
        if (buffered.start(i) <= t && t <= buffered.end(i)) {
          return Math.max(0, buffered.end(i) - t);
        }
      }
    } catch (e) {}
    return null;
  }

  // --- Adaptador del player (Twitch / Kick / Amazon IVS) --------------------
  //
  // Ni Twitch ni Kick exponen hls.js, dash.js ni Shaka de forma detectable,
  // así que getActivePlayer() casi siempre devuelve null ahí y todo el control
  // de velocidad termina escribiendo directo sobre el <video>.
  //
  // El problema es que esos players mantienen SU PROPIO estado de velocidad y
  // corren un control de latencia que reescribe playbackRate cuando detecta
  // "drift". Si escribimos solo el elemento, los dos estados quedan
  // desincronizados: el player nos corrige una y otra vez. Eso es el vaivén.
  //
  // Acá buscamos la instancia interna del player —la misma que usa su menú
  // ⚙️— a través del árbol de fibers de React (o de los expandos del DOM, si
  // el sitio no usa React), y le avisamos el cambio con su propio método. Así
  // su estado coincide con el del elemento y deja de corregirnos.
  //
  // Es best-effort a propósito: si el sitio cambia su bundle o el método no
  // existe, devuelve null y seguimos funcionando como antes (escribiendo el
  // <video>).

  const ADAPTER_HOST = /(^|\.)(twitch\.tv|kick\.com)$/i;

  function isAdapterPage() {
    try {
      return ADAPTER_HOST.test(location.hostname);
    } catch (e) {
      return false;
    }
  }

  function fiberKeyOf(node) {
    try {
      return Object.keys(node).find(
        (k) =>
          k.indexOf("__reactFiber$") === 0 ||
          k.indexOf("__reactInternalInstance$") === 0
      );
    } catch (e) {
      return null;
    }
  }

  const ADAPTER_SET_METHODS = ["setPlaybackRate", "setRate", "setSpeed"];
  const ADAPTER_GET_METHODS = ["getPlaybackRate", "getRate", "getSpeed"];
  const ADAPTER_WRAPPER_KEYS = [
    "player",
    "core",
    "player_",
    "_player",
    "playerCore",
    "videoPlayer",
    "ivsPlayer",
  ];

  function looksLikeAdapterPlayer(o, video) {
    if (!o || typeof o !== "object") return false;
    try {
      if (!ADAPTER_SET_METHODS.some((m) => typeof o[m] === "function")) {
        return false;
      }
      if (typeof o.getVideo === "function") {
        try {
          return o.getVideo() === video;
        } catch (e) {}
      }
      if (o.videoElement instanceof HTMLMediaElement) {
        return o.videoElement === video;
      }
      if (o.video instanceof HTMLMediaElement) return o.video === video;
      // Sin una referencia verificable al video, exigimos que además sepa
      // reportar la velocidad actual: es la firma típica del core del player.
      return ADAPTER_GET_METHODS.some((m) => typeof o[m] === "function");
    } catch (e) {
      return false;
    }
  }

  const playerAdapter = {
    player: null,
    video: null,
    checkedAt: 0,
    missAt: 0,
  };

  function rememberPlayerAdapter(found, video, now) {
    playerAdapter.player = found;
    playerAdapter.video = video;
    playerAdapter.checkedAt = now;
    playerAdapter.missAt = 0;
    return found;
  }

  function findPlayerAdapter(video) {
    if (!video || !isAdapterPage()) return null;
    const now = Date.now();
    if (
      playerAdapter.video === video &&
      playerAdapter.player &&
      now - playerAdapter.checkedAt < 5000
    ) {
      return playerAdapter.player;
    }
    // Un intento fallido no se repite en cada tick (4 veces por segundo):
    // recorrer fibers es caro y en el 99% de los casos el resultado no cambia.
    if (now - playerAdapter.missAt < 5000) return null;

    function consider(o) {
      if (!o || typeof o !== "object") return null;
      if (looksLikeAdapterPlayer(o, video)) return o;
      // Algunas versiones envuelven el core en otra capa.
      for (const k of ADAPTER_WRAPPER_KEYS) {
        let inner;
        try {
          inner = o[k];
        } catch (e) {
          continue;
        }
        if (
          inner &&
          typeof inner === "object" &&
          looksLikeAdapterPlayer(inner, video)
        ) {
          return inner;
        }
      }
      return null;
    }

    const seenFibers = new Set();
    let node = video;
    let hops = 0;
    while (node && hops < 20) {
      hops++;
      const key = fiberKeyOf(node);
      let fiber = key ? node[key] : null;
      let fhops = 0;
      while (fiber && fhops < 40) {
        fhops++;
        if (seenFibers.has(fiber)) break;
        seenFibers.add(fiber);

        let found = null;
        try {
          if (fiber.stateNode) {
            found = consider(fiber.stateNode);
            if (!found) {
              for (const k of Object.keys(fiber.stateNode)) {
                found = consider(fiber.stateNode[k]);
                if (found) break;
              }
            }
          }
        } catch (e) {}

        if (!found) {
          let hook = fiber.memoizedState;
          let hookHops = 0;
          while (hook && hookHops < 25 && !found) {
            hookHops++;
            const val = hook.memoizedState;
            if (val && typeof val === "object") {
              found =
                consider("current" in val ? val.current : null) || consider(val);
            }
            hook = hook.next;
          }
        }

        if (
          !found &&
          fiber.memoizedProps &&
          typeof fiber.memoizedProps === "object"
        ) {
          try {
            for (const k of Object.keys(fiber.memoizedProps)) {
              found = consider(fiber.memoizedProps[k]);
              if (found) break;
            }
          } catch (e) {}
        }

        if (found) return rememberPlayerAdapter(found, video, now);
        fiber = fiber.return;
      }
      node = node.parentElement;
    }

    // Kick puede no usar React para el player: probamos los expandos que las
    // librerías cuelgan del propio <video>/contenedor y unos globals típicos.
    // Es barato y solo corre cuando el recorrido de fibers no encontró nada.
    try {
      let el = video;
      let elHops = 0;
      while (el && elHops < 8) {
        elHops++;
        for (const k of Object.keys(el)) {
          if (k.indexOf("__react") === 0) continue;
          let val;
          try {
            val = el[k];
          } catch (e) {
            continue;
          }
          const found = consider(val);
          if (found) return rememberPlayerAdapter(found, video, now);
        }
        el = el.parentElement;
      }
    } catch (e) {}

    for (const name of [
      "player",
      "videoPlayer",
      "kickPlayer",
      "ivsPlayer",
      "playerInstance",
      "__player",
    ]) {
      let val;
      try {
        val = window[name];
      } catch (e) {
        continue;
      }
      const found = consider(val);
      if (found) return rememberPlayerAdapter(found, video, now);
    }

    playerAdapter.player = null;
    playerAdapter.video = video;
    playerAdapter.missAt = now;
    return null;
  }

  // Le avisa al player (Twitch/Kick) la velocidad que queremos, para que su
  // estado interno no quede en desacuerdo con el <video>. Devuelve true si pudo.
  function syncPlayerRate(video, rate) {
    try {
      const player = findPlayerAdapter(video);
      if (!player) return false;
      for (const m of ADAPTER_SET_METHODS) {
        if (typeof player[m] === "function") {
          try {
            player[m](rate);
            return true;
          } catch (e) {}
        }
      }
    } catch (e) {}
    return false;
  }

  // --- Ponerse al día (solo vivo) -------------------------------------------
  //
  // En vivo, acelerar no sirve para reducir delay de forma sostenida: el
  // player de Twitch reescribe playbackRate a 1x (lo comprobamos con el
  // player real). Lo que sí funciona es un ÚNICO salto hacia adelante dentro
  // de lo que ya está buffereado: se recorta el atraso de golpe, sin pelear
  // contra nadie.
  //
  // Es lo mismo que hace el botón "ir al vivo" del reproductor. La diferencia
  // con escribir video.currentTime a mano es que, si el player expone
  // seekTo(), se lo pedimos a él para que su estado interno quede en sync.
  const CATCHUP_CFG = {
    // Cuánto dejamos por delante después del salto. Saltar justo al final del
    // buffer es pedir un corte: el player se queda sin datos por un instante.
    marginSeconds: 0.5,
    // Con menos de esto ya estamos al día y no hay nada que recortar.
    minBufferAhead: 1.0,
  };

  function catchUpToLive(video) {
    const result = { ok: false, reason: null };
    if (!video) {
      result.reason = "no-video";
      return result;
    }
    if (!isLiveVideo(video)) {
      result.reason = "not-live";
      return result;
    }
    const bufferAhead = getBufferAheadSeconds(video);
    result.bufferAhead = bufferAhead;
    if (bufferAhead == null) {
      result.reason = "no-buffer";
      return result;
    }
    if (bufferAhead <= CATCHUP_CFG.minBufferAhead) {
      result.reason = "already-live";
      result.bufferAhead = bufferAhead;
      return result;
    }

    const beforeTime = video.currentTime;
    const target = beforeTime + bufferAhead - CATCHUP_CFG.marginSeconds;
    result.beforeTime = beforeTime;
    result.target = target;
    result.jumpSeconds = target - beforeTime;

    let via = null;
    const player = findPlayerAdapter(video);
    if (player && typeof player.seekTo === "function") {
      try {
        player.seekTo(target);
        via = "api";
      } catch (e) {}
    }
    // Si no hay seekTo() o no movió el video, escribimos el elemento. Se
    // chequea un instante después porque un seek no es síncrono.
    setTimeout(() => {
      try {
        const moved = Math.abs(video.currentTime - result.beforeTime) > 0.1;
        if (via === "api" && moved) return;
        video.currentTime = target;
        result.via = "elemento";
      } catch (e) {
        result.seekError = String(e);
      }
    }, 150);

    result.ok = true;
    result.via = via || "elemento";
    return result;
  }

  // --- "Pin" de playbackRate ------------------------------------------------
  //
  // Historial de este bloque, para no repetir errores:
  //   v1: interceptaba la propiedad con Object.defineProperty.
  //   v2: esperaba 'ratechange' y corregía con backoff.
  //   v3: reafirmaba la velocidad en CADA FRAME con requestAnimationFrame.
  //
  // v3 es la que rompía Twitch: 60 escrituras por segundo contra un player
  // que también escribe playbackRate producen un vaivén visible, y el loop
  // no se apagaba nunca (ni al cerrar el popup).
  //
  // v4 (esta), un solo mecanismo y mucho más tranquilo:
  //  1. Un tick cada 250 ms revisa si el elemento sigue en el valor pedido.
  //  2. Si lo revirtieron, se reafirma UNA vez y se anota el evento.
  //  3. Si hay demasiadas reversiones en poco tiempo, se SUELTA el control en
  //     vez de pelear para siempre: el popup lo informa y el video queda en lo
  //     que decida el sitio.
  //  4. En vivo, acelerar solo tiene sentido hasta llegar al borde del vivo:
  //     más allá no hay datos para reproducir más rápido y el player TIENE
  //     que devolvernos a 1x. Cerca del borde volvemos a 1x nosotros mismos,
  //     en vez de pelear contra algo físicamente imposible.
  //  5. Con el video pausado no se reafirma nada.

  const rateControlState = new WeakMap(); // video -> estado de control

  const RATE_CFG = {
    tickMs: 250, // ritmo de re-afirmación (antes: cada frame)
    tolerance: 0.02,
    fightWindowMs: 2000, // ventana para contar reversiones ajenas
    fightMaxHits: 3, // reversiones dentro de la ventana => soltar
    edgeDelay: 1.0, // vivo: con <=1s de delay ya no se puede acelerar
    edgeResumeDelay: 3.0, // vivo: se vuelve a acelerar si el delay supera esto
  };

  // --- Detección de "es vivo" -----------------------------------------------
  //
  // duration sola no alcanza: YouTube con DVR reporta una duración finita y
  // algunos VOD (Disney/Shaka) reportan Infinity durante los primeros segundos
  // mientras carga el manifest. Por eso preguntamos primero al player, que es
  // la fuente confiable, y dejamos duration solo como respaldo.
  //
  // Devuelve "live" | "vod" | "unknown". "unknown" = todavía no hay datos
  // suficientes; quien llame decide si esperar o no.

  const videoPlayerCache = new WeakMap(); // video -> player ya identificado
  let lastPlayerProbeAt = 0;

  function looksPossiblyLive(video) {
    try {
      if (/(^|\.)youtube\.com$/i.test(location.hostname)) return true;
    } catch (e) {}
    try {
      const d = video.duration;
      return (
        d === Infinity ||
        (typeof d === "number" && isFinite(d) && d > MAX_SANE_LIVE_SECONDS)
      );
    } catch (e) {
      return false;
    }
  }

  // Devuelve el player que corresponde a este <video>, sin escanear la página
  // en cada tick: reusa el que ya conocemos y, si no hay ninguno, prueba una
  // vez cada 3 s y solo cuando el video podría ser vivo.
  function getPlayerForVideo(video) {
    if (!video) return null;
    // Twitch/Kick no exponen un player de streaming detectable: para ellos
    // alcanza con el respaldo por duration y no tiene sentido escanear.
    if (isAdapterPage()) return null;
    const cached = videoPlayerCache.get(video);
    if (cached && isPlayerStillAlive(cached)) return cached;

    const matches = (p) => {
      if (!p || !isPlayerStillAlive(p)) return false;
      if (p.type === "netflix") return false; // sin detección de vivo
      if (p.type === "youtube") return true; // hay uno solo por frame
      return getMediaElementForPlayer(p) === video;
    };

    for (const p of [currentPlayer, cachedPlayer]) {
      if (matches(p)) {
        videoPlayerCache.set(video, p);
        return p;
      }
    }

    // En un VOD no hay nada que detectar y el escaneo es caro.
    if (!looksPossiblyLive(video)) return null;
    const now = Date.now();
    if (now - lastPlayerProbeAt < 3000) return null;
    lastPlayerProbeAt = now;
    const p = getActivePlayer();
    if (matches(p)) {
      videoPlayerCache.set(video, p);
      return p;
    }
    return null;
  }

  function playerLiveHint(player) {
    if (!player || !player.instance) return "unknown";
    const inst = player.instance;
    try {
      if (player.type === "youtube") {
        // API no oficial, pero es la única señal confiable para lives con DVR.
        if (typeof inst.getVideoData === "function") {
          const vd = inst.getVideoData();
          if (vd && typeof vd.isLive === "boolean") {
            return vd.isLive ? "live" : "vod";
          }
        }
        if (typeof inst.getPlayerResponse === "function") {
          const pr = inst.getPlayerResponse();
          const vd = pr && pr.videoDetails;
          if (vd && typeof vd.isLive === "boolean") {
            return vd.isLive ? "live" : "vod";
          }
          // isLiveContent también vale true en repeticiones de directos, así que
          // por sí solo no alcanza: solo lo damos por vivo si la duración es
          // infinita (un vivo real). Con duración finita es un VOD.
          if (vd && typeof vd.isLiveContent === "boolean") {
            if (!vd.isLiveContent) return "vod";
            try {
              const el = resolveVideoElement(player);
              const d = el ? el.duration : NaN;
              if (d === Infinity) return "live";
              if (typeof d === "number" && isFinite(d) && d > 0) return "vod";
            } catch (e) {}
            return "unknown";
          }
        }
        return "unknown";
      }
      if (player.type === "shaka") {
        if (typeof inst.isLive === "function") {
          return inst.isLive() ? "live" : "vod";
        }
        return "unknown";
      }
      if (player.type === "hls") {
        const levels = Array.isArray(inst.levels) ? inst.levels : [];
        const level = levels[inst.currentLevel] || levels[0] || null;
        const details = (level && level.details) || inst.latestLevelDetails;
        if (details && typeof details.live === "boolean") {
          return details.live ? "live" : "vod";
        }
        return "unknown";
      }
      if (player.type === "dash") {
        if (typeof inst.isDynamic === "function") {
          return inst.isDynamic() ? "live" : "vod";
        }
        return "unknown";
      }
      if (player.type === "disney") {
        // El mediaPlayer de Disney+ expone isLive (método o booleano según la
        // versión del SDK).
        const mp = inst.mediaPlayer;
        if (mp && typeof mp.isLive === "function") {
          return mp.isLive() ? "live" : "vod";
        }
        if (mp && typeof mp.isLive === "boolean") {
          return mp.isLive ? "live" : "vod";
        }
        return "unknown";
      }
    } catch (e) {}
    return "unknown";
  }

  function detectLive(video) {
    if (!video) return "unknown";
    const hint = playerLiveHint(getPlayerForVideo(video));
    if (hint !== "unknown") return hint;
    // Respaldo por duración, solo si el player no pudo responder.
    try {
      const d = video.duration;
      if (d === Infinity) return "live";
      if (typeof d !== "number" || !isFinite(d)) return "unknown";
      if (d > MAX_SANE_LIVE_SECONDS) return "live";
      return "vod";
    } catch (e) {
      return "unknown";
    }
  }

  function isLiveVideo(video) {
    return detectLive(video) === "live";
  }

  // Última velocidad elegida por el usuario. Se guarda aparte del estado por
  // <video> para que sobreviva a un cambio de elemento (nuevo episodio, el
  // reproductor recreándose, etc.) sin que el sitio recupere el control.
  let userRateChoice = null;

  function getRateControlState(video) {
    let state = rateControlState.get(video);
    if (!state) {
      state = {
        desired: 1,
        timer: null,
        released: false,
        releaseReason: null,
        hits: [],
        atLiveEdge: false,
        syncedRate: null,
        // true = el usuario eligió esta velocidad a mano (incluido 1x). Es la
        // única fuente de verdad: el sitio no la puede cambiar por su cuenta.
        userPinned: false,
        // true mientras escribe la propia extensión: esas escrituras sí pasan
        // aunque no coincidan con "desired" (por ejemplo, 1x cerca del borde
        // del vivo cuando el usuario pidió 2x).
        internalWrite: false,
        // Cuántas veces el sitio intentó imponer otra velocidad y fue ignorado.
        blockedSiteWrites: 0,
      };
      rateControlState.set(video, state);
    }
    return state;
  }

  function stopRateTick(state) {
    if (state.timer != null) {
      clearInterval(state.timer);
      state.timer = null;
    }
  }

  function resetRateCounters(state) {
    state.hits.length = 0;
    state.syncedRate = null;
    state.atLiveEdge = false;
    state.released = false;
    state.releaseReason = null;
  }

  function releaseRatePin(state, reason) {
    // Una velocidad elegida explícitamente por el usuario no se suelta sola:
    // si el sitio la revierte, se reafirma. Solo se abandona si el usuario
    // elige otra cosa o recarga.
    if (state.userPinned) return;
    state.released = true;
    state.releaseReason = reason;
    state.hits.length = 0;
    state.syncedRate = null;
    state.atLiveEdge = false;
    stopRateTick(state);
  }

  // En vivo, la velocidad efectiva no es la pedida: cuando ya estamos pegados
  // al borde del vivo no hay nada más que "adelantar", así que bajamos a 1x
  // (que es exactamente lo que haría Twitch por su cuenta). Cuando el delay
  // vuelve a crecer, retomamos la velocidad pedida.
  function effectiveRateFor(video, state) {
    if (state.desired === 1) return 1;
    if (!isLiveVideo(video)) return state.desired;
    const delay = getLiveDelaySeconds(video);
    if (delay == null) return state.desired;
    if (state.desired > 1) {
      if (state.atLiveEdge) {
        if (delay > RATE_CFG.edgeResumeDelay) state.atLiveEdge = false;
        else return 1;
      }
      if (delay <= RATE_CFG.edgeDelay) {
        state.atLiveEdge = true;
        return 1;
      }
      return state.desired;
    }
    // <1x en vivo: bajar la velocidad no compite con el borde del vivo.
    return state.desired;
  }

  function applyRate(video, state, target) {
    // internalWrite deja pasar esta escritura por el bloqueo de velocidad
    // aunque "target" no coincida con "desired" (borde del vivo).
    state.internalWrite = true;
    try {
      // 1) Avisarle al player (Twitch/Kick) para que su estado interno no quede
      // desincronizado.
      if (state.syncedRate !== target) {
        state.syncedRate = syncPlayerRate(video, target) ? target : null;
      }
      // 2) Escribir el elemento, que es lo que realmente cambia la velocidad.
      try {
        video.playbackRate = target;
      } catch (e) {}
    } finally {
      state.internalWrite = false;
    }
  }

  function rateTick(video, state) {
    if (state.released) {
      stopRateTick(state);
      return;
    }
    // Sin elección explícita, 1x significa "no tocar": dejamos que el sitio
    // haga lo suyo. Con elección explícita, 1x también se defiende (DGO, por
    // ejemplo, baja a 0.95 después de un seek grande).
    if (state.desired === 1 && !state.userPinned) {
      stopRateTick(state);
      return;
    }
    let paused = false;
    try {
      paused = video.paused || video.ended;
    } catch (e) {}
    if (paused) {
      // Pausado no hay pelea posible; tampoco acumulamos reversiones.
      state.hits.length = 0;
      return;
    }
    // Durante un seek grande el player suele quedar sin datos y bajar la
    // velocidad a propósito. No peleamos ahí: reafirmamos cuando ya puede
    // reproducir de nuevo (el guard de "seeked" y este mismo tick lo hacen).
    let seeking = false;
    let ready = 4;
    try {
      seeking = !!video.seeking;
      ready = typeof video.readyState === "number" ? video.readyState : 4;
    } catch (e) {}
    if (seeking || ready < 2) {
      state.hits.length = 0;
      return;
    }
    const target = effectiveRateFor(video, state);
    let current = 1;
    try {
      current = video.playbackRate;
    } catch (e) {}
    if (Math.abs(current - target) < RATE_CFG.tolerance) {
      // Todo en orden: si veníamos de una racha de reversiones, se cortó.
      state.hits.length = 0;
      return;
    }
    const now = Date.now();
    state.hits = state.hits.filter((t) => now - t < RATE_CFG.fightWindowMs);
    state.hits.push(now);
    if (state.hits.length >= RATE_CFG.fightMaxHits) {
      if (state.userPinned) {
        // El usuario pidió esta velocidad: seguimos reafirmando. El sitio
        // suele escribir su valor temporal (0.95 tras un seek) y después
        // aceptar el nuestro.
        state.hits.length = 0;
      } else {
        // Perdimos (o el sitio no permite esta velocidad): soltamos el control.
        releaseRatePin(state, "site-overrides");
        return;
      }
    }
    // Si el sitio escribió otra velocidad, su estado interno también quedó
    // desincronizado: forzamos a reavisarle al player además del <video>.
    state.syncedRate = null;
    applyRate(video, state, target);
  }

  // Esto SIEMPRE devuelve la velocidad real del <video>, leída
  // directamente. No depende de qué botón se apretó en el popup — si por lo
  // que sea el video terminó a una velocidad distinta de la que pedimos,
  // esto lo va a reflejar tal cual está.
  function getActualRate(video) {
    try {
      return video.playbackRate;
    } catch (e) {
      return 1;
    }
  }

  // opts.user = true => fue una elección explícita del usuario. Solo eso
  // limpia un "release" anterior y marca la velocidad como autoritativa: los
  // ajustes automáticos no deben revivir un pin que ya se soltó.
  function pinPlaybackRate(video, rate, opts) {
    const state = getRateControlState(video);
    const userInitiated = !!(opts && opts.user);
    const changed = Math.abs(state.desired - rate) >= RATE_CFG.tolerance;

    if (userInitiated) {
      resetRateCounters(state);
      state.userPinned = true;
      userRateChoice = rate;
      ensureRateGuard(video);
    }
    state.desired = rate;

    if (rate === 1 && !state.userPinned) {
      stopRateTick(state);
      state.atLiveEdge = false;
      if (changed || userInitiated) {
        state.syncedRate = null;
        try {
          video.playbackRate = 1;
        } catch (e) {}
        state.syncedRate = syncPlayerRate(video, 1) ? 1 : null;
      }
      return;
    }

    if (state.released) return;

    // 1x elegido a mano también se defiende: si el sitio lo baja a 0.95 tras
    // un seek, volvemos a 1x en el próximo tick.
    applyRate(video, state, effectiveRateFor(video, state));
    if (state.timer == null) {
      state.timer = setInterval(() => {
        try {
          rateTick(video, state);
        } catch (e) {}
      }, RATE_CFG.tickMs);
    }
  }

  // Reafirmar apenas termina un seek. DGO escribe 0.95 un instante después de
  // los saltos grandes; el tick de 250 ms ya lo corrige, pero esto lo hace
  // inmediato y cubre el caso en que el player escriba tarde.
  const rateGuarded = new WeakSet();

  // Bloqueo duro de velocidad. Una vez que el usuario elige una velocidad,
  // cualquier escritura del sitio sobre video.playbackRate que no coincida con
  // la elegida se ignora en el acto: ni siquiera se aplica por un instante.
  // Antes solo se corregía en el siguiente tick (~250 ms) o al terminar un
  // seek, así que el sitio podía dejarla en 0.95 un momento y, si insistía,
  // había un vaivén visible.
  const rateLocked = new WeakSet();
  let nativeRateDescriptors = null;

  function getNativeRateDescriptors() {
    if (nativeRateDescriptors !== null) return nativeRateDescriptors;
    let playbackRate = null;
    let defaultPlaybackRate = null;
    try {
      playbackRate =
        Object.getOwnPropertyDescriptor(
          HTMLMediaElement.prototype,
          "playbackRate"
        ) || null;
      defaultPlaybackRate =
        Object.getOwnPropertyDescriptor(
          HTMLMediaElement.prototype,
          "defaultPlaybackRate"
        ) || null;
    } catch (e) {}
    nativeRateDescriptors = { playbackRate, defaultPlaybackRate };
    return nativeRateDescriptors;
  }

  function lockRateProperty(video, name, native) {
    if (
      !native ||
      typeof native.get !== "function" ||
      typeof native.set !== "function"
    ) {
      return false;
    }
    try {
      Object.defineProperty(video, name, {
        configurable: true,
        enumerable: native.enumerable !== false,
        get() {
          return native.get.call(this);
        },
        set(value) {
          const state = rateControlState.get(video);
          if (
            state &&
            state.userPinned &&
            !state.released &&
            !state.internalWrite &&
            typeof value === "number" &&
            isFinite(value) &&
            Math.abs(value - state.desired) >= RATE_CFG.tolerance
          ) {
            // El sitio quiso imponer otra velocidad (DGO: 0.95 tras un seek).
            state.blockedSiteWrites++;
            return;
          }
          native.set.call(this, value);
        },
      });
      return true;
    } catch (e) {
      return false;
    }
  }

  function installPlaybackRateLock(video) {
    if (!video || rateLocked.has(video)) return;
    const native = getNativeRateDescriptors();
    const okPlayback = lockRateProperty(
      video,
      "playbackRate",
      native.playbackRate
    );
    // defaultPlaybackRate también se bloquea: el sitio podría fijar 0.95 ahí
    // y esperar que se aplique solo al recargar la fuente.
    lockRateProperty(video, "defaultPlaybackRate", native.defaultPlaybackRate);
    if (okPlayback) rateLocked.add(video);
  }

  // La elección del usuario sobrevive a un cambio de <video> (nuevo episodio,
  // reproductor recreado, anuncio). Se reaplica sola al arrancar el video.
  function applyPersistedUserRate(video) {
    if (userRateChoice == null || !video) return;
    const state = rateControlState.get(video);
    if (state && state.userPinned && !state.released) {
      ensureRateGuard(video);
      return;
    }
    try {
      pinPlaybackRate(video, userRateChoice, { user: true });
    } catch (e) {}
  }

  function ensureRateGuard(video) {
    if (!video) return;
    installPlaybackRateLock(video);
    if (rateGuarded.has(video)) return;
    rateGuarded.add(video);
    const reassert = () => {
      const state = rateControlState.get(video);
      if (!state || !state.userPinned || state.released) return;
      try {
        rateTick(video, state);
      } catch (e) {}
    };
    try {
      video.addEventListener("seeked", () => {
        reassert();
        setTimeout(reassert, 300);
      });
    } catch (e) {}
  }

  // Soltar el pin: volver a 1x una vez y dejar de reafirmar. Lo usa el final
  // de la rampa única de arranque.
  function unpinPlaybackRate(video) {
    const state = getRateControlState(video);
    // Carrera con la rampa: si el usuario fijó una velocidad justo antes de
    // que la rampa termine, gana el usuario. La rampa automática no la pisa.
    if (state.userPinned) return;
    resetRateCounters(state);
    state.desired = 1;
    stopRateTick(state);
    try {
      video.playbackRate = 1;
    } catch (e) {}
    state.syncedRate = syncPlayerRate(video, 1) ? 1 : null;
  }

  // --- Rampa única de arranque (vivo con segmentos en ráfagas) ---------------
  //
  // En DGO/Shaka la latencia mínima sin cortes la fija el tamaño del segmento,
  // no el delay que queramos alcanzar. Si cada segmento dura ~4 s y el buffer
  // se llena de a una ráfaga, saltar a 0,5 s del borde del buffer garantiza un
  // corte. Y acelerar todo el tiempo tampoco es opción: un vivo produce 1,00x,
  // así que un 1,06x sostenido termina drenando el buffer.
  //
  // Solución: UNA sola rampa al principio de la transmisión.
  //   1) medimos el tamaño de la ráfaga mirando cada cuánto se agranda el
  //      buffer (el intervalo entre saltos ≈ duración del segmento);
  //   2) cuando hay 2 ráfagas buffereadas ponemos 1,06x;
  //   3) al bajar a 1,6 ráfagas volvemos a 1,00x y desarmamos el control.
  //
  // Son dos escrituras de velocidad al inicio y ninguna más. Si la ráfaga
  // medida es < 3 s (Twitch, por ejemplo) no se activa: su buffer ya es corto
  // y "Ponerse al día" sigue siendo el camino. Tampoco se activa si el
  // usuario eligió una velocidad.

  const RAMP_CFG = {
    rate: 1.06,
    sampleMs: 500,
    minBurstSeconds: 3.0,
    // Arrancamos apenas el buffer llega a ~2 ráfagas y frenamos en ~1,3.
    // El umbral de arranque no puede ser exactamente 2,0: en un régimen
    // estable con segmentos de 4 s el buffer oscila un poco por debajo de 8 s
    // y la rampa no se activaría nunca.
    startBufferBursts: 1.9,
    stopBufferBursts: 1.3,
    // Nunca dejamos menos de esto por delante, aunque la medición haya sido
    // optimista. Es el colchón contra un corte.
    minBufferFloorSeconds: 3.5,
    maxRampMs: 180000,
    measureTimeoutMs: 45000,
    minBurstGapSeconds: 2.0,
    maxBurstGapSeconds: 12.0,
    maxGapSamples: 8,
    // La rampa solo arranca con "vivo" confirmado por el player durante este
    // tiempo. Evita que un VOD que reporta Infinity por unos segundos (Disney)
    // dispare el ajuste automático.
    liveConfirmMs: 3000,
    // Si durante la rampa el player deja de responder ("unknown"), damos este
    // margen antes de abortar. Un "vod" explícito aborta al instante.
    liveLostGraceMs: 5000,
  };

  function medianOf(values) {
    if (!values.length) return null;
    const sorted = values.slice().sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2
      ? sorted[mid]
      : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  const rampState = {
    video: null,
    timer: null,
    phase: "idle", // idle | measuring | ramping | done | skipped
    reason: null,
    burst: null,
    gaps: [],
    bufferPeak: 0,
    lastBuffer: null,
    lastSampleAt: 0,
    lastBurstStartAt: 0,
    inGrowthRun: false,
    startedAt: 0,
    rampStartedAt: 0,
    stopBuffer: null,
    writes: 0,
    liveSince: 0,
    liveLostSince: 0,
  };

  const rampWatched = new WeakSet();

  function rampDisabledByUser() {
    try {
      const value = localStorage.getItem("qs-ramp");
      return value === "0" || value === "off" || value === "false";
    } catch (e) {
      return false;
    }
  }

  // Suelta el 1,06x que puso la rampa, sin tocar una velocidad elegida por el
  // usuario. Sin esto, un aborto o un cambio de fuente dejaba el pin huérfano
  // y el video quedaba clavado en 1,06x para siempre.
  function releaseRampRate() {
    const video = rampState.video;
    if (!video) return;
    const state = rateControlState.get(video);
    if (!state || state.userPinned) return;
    if (Math.abs(state.desired - RAMP_CFG.rate) > 0.02) return;
    unpinPlaybackRate(video);
  }

  function startRampTimer() {
    if (rampState.timer != null) return;
    if (rampState.phase === "done" || rampState.phase === "skipped") return;
    rampState.timer = setInterval(() => {
      try {
        rampSample();
      } catch (e) {}
    }, RAMP_CFG.sampleMs);
  }

  function resetStartupRamp(video, reason) {
    if (rampState.phase === "ramping") releaseRampRate();
    if (rampState.timer) {
      clearInterval(rampState.timer);
      rampState.timer = null;
    }
    rampState.video = video || null;
    rampState.phase = video ? "measuring" : "idle";
    rampState.reason = reason || null;
    rampState.burst = null;
    rampState.gaps.length = 0;
    rampState.bufferPeak = 0;
    rampState.lastBuffer = null;
    rampState.lastSampleAt = 0;
    rampState.lastBurstStartAt = 0;
    rampState.inGrowthRun = false;
    rampState.startedAt = performance.now();
    rampState.rampStartedAt = 0;
    rampState.stopBuffer = null;
    rampState.writes = 0;
    rampState.liveSince = 0;
    rampState.liveLostSince = 0;
    if (video) startRampTimer();
  }

  function stopRampTimer() {
    if (rampState.timer) {
      clearInterval(rampState.timer);
      rampState.timer = null;
    }
  }

  // Terminó la rampa: una única escritura a 1,00x y se suelta el pin. No se
  // vuelve a tocar la velocidad en lo que reste de la transmisión.
  function finishStartupRamp(reason) {
    const video = rampState.video;
    rampState.phase = "done";
    rampState.reason = reason || "done";
    if (video) {
      unpinPlaybackRate(video);
      rampState.writes++;
    }
    stopRampTimer();
  }

  // Abortar sin escribir velocidad: lo usa el control manual del usuario o
  // una reversión del sitio. Nunca pisamos una elección explícita.
  function abortStartupRamp(reason) {
    releaseRampRate();
    rampState.phase = "skipped";
    rampState.reason = reason;
    stopRampTimer();
  }

  function skipStartupRamp(reason) {
    releaseRampRate();
    rampState.phase = "skipped";
    rampState.reason = reason;
    stopRampTimer();
  }

  function rampSample() {
    const video = rampState.video;
    if (!video) return;
    let connected = true;
    try {
      connected = video.isConnected !== false;
    } catch (e) {}
    if (!connected) {
      resetStartupRamp(null, "video-desconectado");
      return;
    }

    const now = performance.now();

    // Twitch/Kick no exponen un player Shaka: la rampa no aplica ahí.
    if (isAdapterPage()) {
      skipStartupRamp("motor-no-shaka");
      return;
    }

    // La rampa es solo para Shaka/DGO: es el único motor con segmentos en
    // ráfagas donde aporta. Si el player ya se identificó y no es Shaka
    // (YouTube, hls.js, Twitch, Kick…), no tocamos la velocidad.
    const rampPlayer = getPlayerForVideo(video);
    const shakaPlayer = !!(rampPlayer && rampPlayer.type === "shaka");
    if (rampPlayer && !shakaPlayer) {
      if (rampState.phase === "ramping") {
        finishStartupRamp("motor-no-shaka");
      } else {
        skipStartupRamp("motor-no-shaka");
      }
      return;
    }
    if (rampDisabledByUser()) {
      skipStartupRamp("deshabilitada");
      return;
    }

    // La rampa es solo para vivos reales. duration por sí sola miente en los
    // dos sentidos (YouTube live con DVR da finita; Disney VOD da Infinity un
    // rato al cargar), así que preguntamos al player.
    const liveState = detectLive(video);
    if (liveState === "live") {
      if (!rampState.liveSince) rampState.liveSince = now;
      rampState.liveLostSince = 0;
    } else {
      rampState.liveSince = 0;
    }

    if (rampState.phase === "ramping") {
      // Si dejó de ser vivo, volvemos a 1,00x ya mismo y terminamos.
      if (liveState === "vod") {
        finishStartupRamp("dejo-de-ser-vivo");
        return;
      }
      // "unknown" puede ser un parpadeo del player: damos un margen corto.
      if (liveState === "unknown") {
        if (!rampState.liveLostSince) rampState.liveLostSince = now;
        if (now - rampState.liveLostSince >= RAMP_CFG.liveLostGraceMs) {
          finishStartupRamp("vivo-desconocido");
          return;
        }
      }
    } else if (liveState === "vod") {
      skipStartupRamp("no-es-vivo");
      return;
    } else if (liveState === "unknown") {
      if (now - rampState.startedAt > RAMP_CFG.measureTimeoutMs) {
        skipStartupRamp("vivo-desconocido");
      }
      return;
    }

    // Exigimos varios segundos de "vivo" confirmado antes de tocar nada.
    const liveConfirmed =
      rampState.liveSince &&
      now - rampState.liveSince >= RAMP_CFG.liveConfirmMs;

    const buffer = getBufferAheadSeconds(video);
    if (buffer == null) return;

    const dt = rampState.lastSampleAt
      ? (now - rampState.lastSampleAt) / 1000
      : 0;

    if (rampState.lastBuffer != null && dt > 0.05) {
      const growth = buffer - rampState.lastBuffer;
      // Un salto claramente más rápido que la reproducción = llegó una
      // ráfaga. Si en cambio el buffer crece a ~1x, no hay ráfagas que
      // medir y la rampa no se activa (mejor no tocar nada).
      const fastGrowth = growth > Math.max(0.6, dt * 1.5);
      if (fastGrowth) {
        if (!rampState.inGrowthRun || now - rampState.lastBurstStartAt > 1000) {
          if (rampState.lastBurstStartAt) {
            const gap = (now - rampState.lastBurstStartAt) / 1000;
            if (
              gap >= RAMP_CFG.minBurstGapSeconds &&
              gap <= RAMP_CFG.maxBurstGapSeconds
            ) {
              rampState.gaps.push(gap);
              if (rampState.gaps.length > RAMP_CFG.maxGapSamples) {
                rampState.gaps.shift();
              }
              rampState.burst = medianOf(rampState.gaps);
            }
          }
          rampState.lastBurstStartAt = now;
        }
        rampState.inGrowthRun = true;
      } else if (growth < dt * 0.4) {
        rampState.inGrowthRun = false;
      }
      rampState.bufferPeak = Math.max(rampState.bufferPeak, buffer);
    }
    rampState.lastBuffer = buffer;
    rampState.lastSampleAt = now;

    if (rampState.phase === "measuring") {
      if (rampState.burst == null) {
        if (now - rampState.startedAt > RAMP_CFG.measureTimeoutMs) {
          skipStartupRamp("sin-rafagas");
        }
        return;
      }
      if (rampState.burst < RAMP_CFG.minBurstSeconds) {
        skipStartupRamp("rafaga-corta");
        return;
      }

      if (!liveConfirmed) {
        if (now - rampState.startedAt > RAMP_CFG.measureTimeoutMs) {
          skipStartupRamp("vivo-sin-confirmar");
        }
        return;
      }

      const rateState = rateControlState.get(video);
      if (
        rateState &&
        (rateState.userPinned ||
          rateState.released ||
          Math.abs(rateState.desired - 1) > 0.02)
      ) {
        skipStartupRamp("control-manual");
        return;
      }

      // Sin Shaka confirmado no arrancamos: puede ser un motor que no
      // necesita la rampa o un falso "vivo" (YouTube, repeticiones, etc.).
      if (!shakaPlayer) {
        if (now - rampState.startedAt > RAMP_CFG.measureTimeoutMs) {
          skipStartupRamp("motor-no-shaka");
        }
        return;
      }

      if (buffer >= RAMP_CFG.startBufferBursts * rampState.burst) {
        rampState.stopBuffer = Math.max(
          RAMP_CFG.minBufferFloorSeconds,
          RAMP_CFG.stopBufferBursts * rampState.burst
        );
        rampState.phase = "ramping";
        rampState.rampStartedAt = now;
        pinPlaybackRate(video, RAMP_CFG.rate);
        rampState.writes++;
      }
      return;
    }

    if (rampState.phase !== "ramping") return;

    const rateState = rateControlState.get(video);
    if (rateState && rateState.userPinned) {
      // El usuario eligió una velocidad: la rampa automática no puede pisarla.
      abortStartupRamp("control-manual");
      return;
    }
    if (rateState && rateState.released) {
      abortStartupRamp("sitio-revierte");
      return;
    }
    if (rateState && Math.abs(rateState.desired - RAMP_CFG.rate) > 0.02) {
      // El usuario eligió otra velocidad: no la pisamos.
      abortStartupRamp("control-manual");
      return;
    }

    const timedOut = now - rampState.rampStartedAt >= RAMP_CFG.maxRampMs;
    if (buffer <= rampState.stopBuffer || timedOut) {
      finishStartupRamp(timedOut ? "tope-tiempo" : "margen-seguro");
    }
  }

  function ensureRampWatch(video) {
    if (!video || !isRealMediaElement(video)) return;
    if (rampDisabledByUser()) {
      if (rampState.phase === "measuring" || rampState.phase === "ramping") {
        skipStartupRamp("deshabilitada");
      }
      return;
    }

    const current = rampState.video;
    if (current && current !== video) {
      let currentPlaying = false;
      let newPlaying = false;
      try {
        currentPlaying = !current.paused && !current.ended;
      } catch (e) {}
      try {
        newPlaying = !video.paused && !video.ended;
      } catch (e) {}
      // Si el que ya seguimos está reproduciendo y el nuevo no, no cambiamos
      // de objetivo: evita que un aviso o una publicidad en otro <video>
      // corte la rampa de la transmisión principal.
      if (currentPlaying && !newPlaying) return;
      resetStartupRamp(video, "nuevo-video");
    } else if (!current) {
      resetStartupRamp(video, "inicio");
    }

    if (!rampWatched.has(video)) {
      rampWatched.add(video);

      // Un cambio de fuente es una transmisión nueva: se suelta cualquier
      // rampa en curso (aunque esté midiendo o rampeando) y se vuelve a medir.
      const restart = () => {
        if (rampState.video !== video) return;
        if (rampState.phase === "ramping") {
          finishStartupRamp("nueva-fuente");
        }
        resetStartupRamp(video, "nueva-fuente");
      };
      try {
        video.addEventListener("emptied", restart);
        video.addEventListener("loadstart", restart);
        video.addEventListener("durationchange", () => {
          if (rampState.video === video && rampState.phase === "idle") {
            resetStartupRamp(video, "metadata");
          }
        });
        // "playing" solo arranca si todavía no empezamos con este video (por
        // ejemplo, si el play() ocurrió antes de que existiera el hook). No
        // re-arma después de una pausa: el usuario pidió UN ajuste por
        // transmisión, no uno cada vez que reanuda.
        video.addEventListener("playing", () => {
          if (rampState.video === video && rampState.phase === "idle") {
            resetStartupRamp(video, "playing");
          }
        });
      } catch (e) {}
    }

    if (rampState.phase === "idle") resetStartupRamp(video, "watch");
    if (
      rampState.timer == null &&
      rampState.phase !== "done" &&
      rampState.phase !== "skipped"
    ) {
      rampState.timer = setInterval(() => {
        try {
          rampSample();
        } catch (e) {}
      }, RAMP_CFG.sampleMs);
    }
  }

  // Enganche barato: cuando cualquier media llama a play(), seguimos ese
  // elemento. No altera para nada el comportamiento de play().
  try {
    const mediaProto = HTMLMediaElement.prototype;
    const originalPlay = mediaProto.play;
    if (typeof originalPlay === "function" && !originalPlay.__qsRampHook) {
      const hookedPlay = function () {
        try {
          ensureRampWatch(this);
          applyPersistedUserRate(this);
        } catch (e) {}
        return originalPlay.apply(this, arguments);
      };
      hookedPlay.__qsRampHook = true;
      mediaProto.play = hookedPlay;
    }
  } catch (e) {}

  window.addEventListener("qs-get-speed-info", (event) => {
    const requestId = event && event.detail && event.detail.requestId;
    let detail;
    try {
      currentPlayer = getActivePlayer();
      const video = resolveVideoElement(currentPlayer);
      if (video) {
        ensureRampWatch(video);
        // Si el reproductor cambió de <video>, reaplicar la elección del
        // usuario antes de informar, para que el popup no muestre otra cosa.
        applyPersistedUserRate(video);
      }
      const state = video ? rateControlState.get(video) : null;
      detail = {
        found: !!video,
        rate: video ? getActualRate(video) : 1,
        // Si el usuario fijó una velocidad, el popup muestra esa como la
        // elegida: el sitio ya no puede imponer otra.
        pinned: !!(state && state.userPinned),
        // Escrituras del sitio bloqueadas por el candado de velocidad.
        blockedWrites: state ? state.blockedSiteWrites : 0,
        // Si el pin está soltado, "desired" no significa nada: el sitio manda.
        desired: state && !state.released ? state.desired : video ? getActualRate(video) : 1,
        released: !!(state && state.released),
        releaseReason: state ? state.releaseReason : null,
        atLiveEdge: !!(state && state.atLiveEdge),
        live: video ? isLiveVideo(video) : false,
        speedViaPlayerApi: !!(video && playerAdapter.video === video && playerAdapter.player),
        delaySeconds: video ? getLiveDelaySeconds(video) : null,
        bufferSeconds: video ? getBufferAheadSeconds(video) : null,
        // Estado de la rampa única de arranque (DGO/Shaka). Solo informativo
        // para el popup.
        rampPhase: rampState.phase,
        rampReason: rampState.reason,
        rampBurst: rampState.burst,
        rampWrites: rampState.writes,
      };
    } catch (e) {
      detail = { found: false, error: true };
    }
    detail.requestId = requestId;
    window.dispatchEvent(
      new CustomEvent("qs-speed-info-response", { detail })
    );
  });

  // Diagnóstico rápido en consola: __qsSpeedDebug()
  window.__qsSpeedDebug = () => {
    let video = null;
    try {
      video = resolveVideoElement(getActivePlayer());
    } catch (e) {}
    const state = video ? rateControlState.get(video) : null;
    return {
      desired: state ? state.desired : null,
      actual: video ? getActualRate(video) : null,
      pinned: !!(state && state.userPinned),
      released: !!(state && state.released),
      blockedSiteWrites: state ? state.blockedSiteWrites : 0,
      userRateChoice,
      locked: !!(video && rateLocked.has(video)),
      live: video ? detectLive(video) : null,
      rampPhase: rampState.phase,
      rampReason: rampState.reason,
      rampBurst: rampState.burst,
      rampWrites: rampState.writes,
      rampDisabled: rampDisabledByUser(),
    };
  };

  window.addEventListener("qs-set-speed", (event) => {
    const requestId = event && event.detail && event.detail.requestId;
    let detail;
    try {
      currentPlayer = getActivePlayer();
      const video = resolveVideoElement(currentPlayer);
      if (!video) {
        detail = { ok: false, reason: "no-video" };
      } else {
        const { rate } = event.detail;
        if (typeof rate === "number" && Number.isFinite(rate)) {
          abortStartupRamp("velocidad-manual");
          // Elección explícita del usuario: limpia cualquier "release" previo
          // y reafirma la velocidad con el ritmo tranquilo de v4.
          pinPlaybackRate(video, rate, { user: true });
          const state = rateControlState.get(video);
          detail = {
            ok: true,
            actualRate: getActualRate(video),
            desired: rate,
            released: !!(state && state.released),
            atLiveEdge: !!(state && state.atLiveEdge),
          };
        } else {
          detail = { ok: true };
        }
      }
    } catch (err) {
      detail = { ok: false, reason: "error" };
    }
    detail.requestId = requestId;
    window.dispatchEvent(
      new CustomEvent("qs-set-speed-response", { detail })
    );
  });

  // "Ponerse al día": un solo salto hacia adelante dentro del buffer, para
  // recortar el atraso del vivo sin pelear con el control de latencia del
  // player. Responde después de ~450 ms para poder informar cómo quedó.
  window.addEventListener("qs-catch-up-live", (event) => {
    const requestId = event && event.detail && event.detail.requestId;
    let video = null;
    let result = { ok: false, reason: "no-video" };
    try {
      currentPlayer = getActivePlayer();
      video = resolveVideoElement(currentPlayer);
      if (video) result = catchUpToLive(video);
    } catch (e) {
      result = { ok: false, reason: "error", error: String(e) };
    }

    const finish = () => {
      // `found` permite que el popup elija esta respuesta entre las de todos
      // los frames aunque el salto no se haya podido hacer (por ejemplo
      // "already-live"), en vez de quedarse con el "no-video" de otro frame.
      result.found = !!video;
      result.requestId = requestId;
      if (video && result.ok) {
        try {
          // Si el salto no quedó cerca de donde pedimos (por ejemplo, porque
          // la API de Twitch interpreta el tiempo en otra unidad), lo
          // corregimos escribiendo el elemento.
          if (Math.abs(video.currentTime - result.target) > 3) {
            video.currentTime = result.target;
            result.via = "elemento";
            result.corrected = true;
          }
          result.afterTime = video.currentTime;
          result.afterBuffer = getBufferAheadSeconds(video);
        } catch (e) {}
      }
      window.dispatchEvent(
        new CustomEvent("qs-catch-up-live-response", { detail: result })
      );
    };

    if (video && result.ok) setTimeout(finish, 450);
    else finish();
  });

  // --- Preconnect al CDN del stream ---
  //
  // Esto NO hace que los datos lleguen más rápido (eso depende de tu
  // conexión y del servidor). Lo único que hace es que el navegador arranque
  // el handshake TCP/TLS con el host del CDN de antemano, en vez de esperar
  // a que la librería pida el primer segmento para recién ahí conectarse.
  // Ahorra, como mucho, un puñado de cientos de milisegundos en la conexión
  // inicial — no es magia, es evitar un paso secuencial innecesario.

  function addPreconnectHint(host) {
    if (!host) return;
    try {
      if (document.querySelector(`link[data-qs-preconnect="${host}"]`)) return;
      const pre = document.createElement("link");
      pre.rel = "preconnect";
      pre.href = `https://${host}`;
      pre.crossOrigin = "anonymous";
      pre.dataset.qsPreconnect = host;
      document.head.appendChild(pre);

      const dns = document.createElement("link");
      dns.rel = "dns-prefetch";
      dns.href = `https://${host}`;
      document.head.appendChild(dns);
    } catch (e) {}
  }

  function hostFromUrl(u) {
    try {
      return new URL(u, location.href).host;
    } catch (e) {
      return null;
    }
  }

  function preconnectToStreamHosts(player) {
    if (!player) return;
    const hosts = new Set();
    try {
      if (player.type === "hls") {
        (player.instance.levels || []).forEach((lvl) => {
          const u = lvl.url || lvl.uri;
          const arr = Array.isArray(u) ? u : u ? [u] : [];
          arr.forEach((one) => {
            const h = hostFromUrl(one);
            if (h) hosts.add(h);
          });
        });
      } else if (player.type === "dash") {
        try {
          const h = hostFromUrl(player.instance.getSource());
          if (h) hosts.add(h);
        } catch (e) {}
      } else if (player.type === "shaka") {
        try {
          const h = hostFromUrl(player.instance.getManifestUri());
          if (h) hosts.add(h);
        } catch (e) {}
      }
    } catch (e) {}
    // Tope chico: preconectar a demasiados hosts a la vez no suma nada y
    // desperdicia handshakes que quizás nunca se usen.
    Array.from(hosts)
      .slice(0, 4)
      .forEach(addPreconnectHint);
  }

  // --- Puente de comunicación con el content script aislado (bridge.js) ---

  // El popup persiste la preferencia en chrome.storage; bridge.js la traduce
  // a este evento porque page-hook corre en el MAIN world y no ve chrome.*.
  window.addEventListener("qs-request-qualities", (event) => {
    const requestId = event && event.detail && event.detail.requestId;
    const send = (detail) => {
      const payload = Object.assign({}, detail, { requestId });
      window.dispatchEvent(
        new CustomEvent("qs-qualities-response", { detail: payload })
      );
    };
    let detail;
    try {
      currentPlayer = getActivePlayer();
      preconnectToStreamHosts(currentPlayer);
      let notice = null;
      if (isNetflixHost()) {
        notice = "Netflix: experimental y contra sus ToS.";
        if (!currentPlayer || currentPlayer.type !== "netflix") {
          notice += ` ${netflixDiagnosticText()}`;
        }
      } else if (isDisneyHost()) {
        notice = "Disney+: experimental. Elegir calidad recarga la pestaña.";
        if (!disneyIntercepted) {
          notice += " No se leyó el master: solo Auto disponible.";
        }
      } else if (isHboHost()) {
        notice = "HBO/Max: experimental. El cambio puede tardar ~30 s.";
      } else if (isTwitchHost()) {
        notice = "Twitch: experimental. La elección se recuerda al recargar.";
      } else if (isKickHost()) {
        notice = "Kick: el menú ⚙️ se abre y se cierra para leer las calidades.";
      }

      // Kick no tiene API: hay que abrir su menú, así que la respuesta es
      // asíncrona (bridge.js espera hasta 4 s).
      if (currentPlayer && currentPlayer.type === "kick") {
        const kickPlayer = currentPlayer;
        getKickQualities().then((qualities) => {
          const hasReal = qualities.some(
            (q) => q.id !== "auto" && q.id !== -1
          );
          send({
            found: true,
            type: "kick",
            qualities,
            cap: getQualityCap(kickPlayer, qualities),
            notice: hasReal
              ? notice
              : `Kick: no se pudo leer el menú (${kickFailLabel()}); solo Auto disponible.`,
          });
        }).catch(() => {
          send({ found: false, error: true, notice });
        });
        return;
      }

      const qualities = getQualities(currentPlayer);
      detail = {
        found: !!currentPlayer,
        type: currentPlayer ? currentPlayer.type : null,
        qualities,
        cap: getQualityCap(currentPlayer, qualities),
        notice,
      };
    } catch (e) {
      detail = { found: false, error: true };
    }
    send(detail);
  });

  window.addEventListener("qs-set-quality", (e) => {
    try {
      currentPlayer = getActivePlayer();
      if (currentPlayer && currentPlayer.type === "kick") {
        kickSetQuality(e.detail.id);
        return;
      }
      setQuality(currentPlayer, e.detail.id);
    } catch (err) {}
  });
})();

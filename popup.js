// chrome.i18n no siempre sustituye $1 cuando el mensaje no declara
// placeholders, así que rellenamos los marcadores nosotros. Es idempotente:
// si Chrome ya los cambió, no queda nada que reemplazar.
function fillI18n(text, subs) {
  let out = String(text == null ? "" : text);
  const args = Array.isArray(subs) ? subs : subs == null ? [] : [subs];
  args.forEach((value, i) => {
    out = out.split("$" + (i + 1)).join(String(value));
  });
  return out;
}

document.addEventListener("DOMContentLoaded", () => {
  const statusEl = document.getElementById("status");
  const qualitySelectEl = document.getElementById("quality-select");
  const qualityCapEl = document.getElementById("quality-cap");
  const qualityNoteEl = document.getElementById("quality-note");
  const refreshBtn = document.getElementById("refresh");
  const speedStatusEl = document.getElementById("speed-status");
  const speedMetaEl = document.getElementById("speed-meta");
  const speedSliderEl = document.getElementById("speed-slider");
  const speedNoteEl = document.getElementById("speed-note");
  const rampStatusEl = document.getElementById("ramp-status");
  const volumeStatusEl = document.getElementById("volume-status");
  const volumeSliderEl = document.getElementById("volume-slider");
  const volumeValueEl = document.getElementById("volume-value");
  const volumeRestoreEl = document.getElementById("volume-restore");
  const volumeStopEl = document.getElementById("volume-stop");

  // chrome.i18n elige el idioma de la UI del navegador (ver _locales/). El
  // fallback en español mantiene el popup legible si la API no está disponible.
  function t(key, fallback, subs) {
    try {
      const value = chrome.i18n && chrome.i18n.getMessage(key, subs);
      return fillI18n(value || fallback, subs);
    } catch (e) {
      return fillI18n(fallback, subs);
    }
  }

  function applyStaticI18n() {
    try {
      const lang =
        chrome.i18n &&
        chrome.i18n.getUILanguage &&
        chrome.i18n.getUILanguage();
      if (lang) document.documentElement.lang = String(lang).split("-")[0];
    } catch (e) {}
    document.querySelectorAll("[data-i18n]").forEach((el) => {
      el.textContent = t(el.dataset.i18n, el.textContent);
    });
    document.querySelectorAll("[data-i18n-title]").forEach((el) => {
      el.title = t(el.dataset.i18nTitle, el.title);
    });
    document.querySelectorAll("[data-i18n-aria]").forEach((el) => {
      el.setAttribute(
        "aria-label",
        t(el.dataset.i18nAria, el.getAttribute("aria-label") || "")
      );
    });
  }

  // page-hook.js corre en el MAIN world y no tiene chrome.i18n: recibe este
  // paquete con los textos ya traducidos en cada pedido de calidades.
  // Los que tienen $1/$2 se piden con el propio marcador como sustitución:
  // Chrome vacía las sustituciones inexistentes y page-hook las rellena después.
  const UI_STRINGS = {
    noticeNetflix: t("noticeNetflix", "Netflix: experimental y contra sus ToS."),
    noticeDisney: t("noticeDisney", "Disney+: experimental. Elegir calidad recarga la pestaña."),
    noticeDisneyNoMaster: t("noticeDisneyNoMaster", " No se leyó el master: solo Auto disponible."),
    noticeHbo: t("noticeHbo", "HBO/Max: experimental. El cambio puede tardar ~30 s."),
    noticeTwitch: t("noticeTwitch", "Twitch: experimental. La elección se recuerda al recargar."),
    noticeKick: t("noticeKick", "Kick: el menú ⚙️ se abre y se cierra para leer las calidades."),
    noticeKickFail: t("noticeKickFail", "Kick: no se pudo leer el menú ($1); solo Auto disponible.", ["$1"]),
    capBlocked: t("capBlocked", "Tope: $1p ($2p bloqueado)", ["$1", "$2"]),
    capAccount: t("capAccount", "Cuenta: hasta $1p", ["$1"]),
    capKick: t("capKick", "Máx. del stream: $1", ["$1"]),
    capGeneric: t("capGeneric", "Tope: $1p", ["$1"]),
    qualityMaxFixed: t("qualityMaxFixed", "Máxima fija"),
    autoMin: t("autoMin", "Auto (mín. $1p)", ["$1"]),
    diagMissing: t("diagMissing", "Diagnóstico: faltó $1.", ["$1"]),
    diagFailed: t("diagFailed", "Diagnóstico: no se pudo usar el selector (playback $1, streams $2, video $3).", ["$1", "$2", "$3"]),
    mSessions: t("mSessions", "sesiones"),
    mStreams: t("mStreams", "streams de video"),
    mQualities: t("mQualities", "lista de calidades"),
    kNoVideo: t("kNoVideo", "no hay <video>"),
    kNoGear: t("kNoGear", "no encontré el botón ⚙️"),
    kMenuClosed: t("kMenuClosed", "el menú no se abrió"),
    kWrongMenu: t("kWrongMenu", "abrí otro menú (subtítulos/audio)"),
    kEmptyMenu: t("kEmptyMenu", "el menú no mostró calidades"),
    kError: t("kError", "error inesperado"),
    kUnknown: t("kUnknown", "motivo desconocido"),
  };

  applyStaticI18n();

  function getActiveTab(cb) {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      cb(tabs && tabs[0] ? tabs[0] : null);
    });
  }

  function getActiveTabId(cb) {
    getActiveTab((tab) => cb(tab ? tab.id : null));
  }

  let requestSeq = 0;
  function nextRequestId() {
    requestSeq++;
    return `nds-${Date.now().toString(36)}-${requestSeq}`;
  }

  // Los datos vienen de content scripts que corren dentro de páginas (y de
  // iframes de terceros). Nunca confiamos en su tipo: un valor inesperado no
  // debe romper el popup ni filtrarse a un reproductor ajeno.
  function finiteNumber(value, fallback) {
    if (value === null || value === undefined || value === "") return fallback;
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  function safeText(value) {
    return value === null || value === undefined ? "" : String(value);
  }

  // El reproductor real puede estar en un iframe (Twitch, por ejemplo), no
  // siempre en el frame principal de la pestaña. Mandamos el mensaje a
  // TODOS los frames de la pestaña y nos quedamos con el primero que
  // realmente encontró algo (found/ok en true), en vez de asumir que
  // siempre está en el frame de arriba.
  function getAllFrameIds(tabId, cb) {
    if (chrome.webNavigation && chrome.webNavigation.getAllFrames) {
      chrome.webNavigation.getAllFrames({ tabId }, (frames) => {
        if (chrome.runtime.lastError || !frames || !frames.length) {
          cb([0]);
        } else {
          cb(frames.map((f) => f.frameId));
        }
      });
    } else {
      cb([0]);
    }
  }

  function sendToFrame(tabId, frameId, message, callback) {
    const full = Object.assign(
      { target: "nds-bridge", requestId: nextRequestId() },
      message
    );
    chrome.tabs.sendMessage(tabId, full, { frameId }, (res) => {
      callback(res || null, !!chrome.runtime.lastError, frameId);
    });
  }

  function sendToAllFrames(tabId, message, callback) {
    getAllFrameIds(tabId, (frameIds) => {
      let remaining = frameIds.length;
      const responses = [];
      const requestId = nextRequestId();
      let anyCommError = false;
      let bestFrameId = null;
      if (remaining === 0) {
        callback(null, true, null);
        return;
      }
      frameIds.forEach((frameId) => {
        const full = Object.assign(
          { target: "nds-bridge", requestId },
          message
        );
        chrome.tabs.sendMessage(tabId, full, { frameId }, (res) => {
          remaining--;
          if (chrome.runtime.lastError) {
            anyCommError = true;
          } else if (res) {
            responses.push({ res, frameId });
          }
          if (remaining === 0) {
            // Esperamos a que contesten TODOS los frames antes de elegir,
            // así una respuesta vacía que llega primero (un frame sin
            // video) no le gana para siempre a la respuesta buena que
            // llega un poco después.
            const best =
              responses.find((r) => r.res && (r.res.found || r.res.ok)) ||
              responses[0] ||
              null;
            // El aviso de plataforma (p. ej. Netflix) puede venir de un frame
            // distinto del que tiene el reproductor. Si la respuesta elegida
            // no lo trae, lo tomamos de cualquier otra.
            if (best && best.res && !best.res.notice) {
              const withNotice = responses.find((r) => r.res && r.res.notice);
              if (withNotice) best.res.notice = withNotice.res.notice;
            }
            bestFrameId = best ? best.frameId : null;
            callback(best ? best.res : null, !best && anyCommError, bestFrameId);
          }
        });
      });
    });
  }

  // Kick lee su menú abriéndolo: si el player todavía está cargando, la
  // primera lectura puede devolver solo Auto. Reintentamos una vez, sin
  // dejar al usuario con la sensación de que "no anda".
  let kickAutoRetryTimer = null;
  // Id del frame que realmente tiene el reproductor.Los comandos se mandan
  // solo ahí: un iframe de terceros no puede inducirnos a cambiar la calidad
  // del video del frame principal.
  let speedFrameId = null;
  let qualityFrameId = null;

  function loadQualities(opts) {
    const isKickRetry = !!(opts && opts.kickRetry);
    if (kickAutoRetryTimer) {
      clearTimeout(kickAutoRetryTimer);
      kickAutoRetryTimer = null;
    }
    statusEl.textContent = t("searching", "Buscando…");
    statusEl.classList.remove("ok", "error");
    qualitySelectEl.innerHTML = "";
    qualitySelectEl.hidden = true;
    qualitySelectEl.disabled = false;
    qualityCapEl.hidden = true;
    qualityCapEl.textContent = "";
    qualityCapEl.removeAttribute("title");
    qualityNoteEl.hidden = true;
    qualityNoteEl.textContent = "";
    qualityNoteEl.removeAttribute("title");

    getActiveTabId((tabId) => {
      sendToAllFrames(
        tabId,
        { type: "get-qualities", strings: UI_STRINGS },
        (response, commError, frameId) => {
          if (response && response.found) qualityFrameId = frameId;
          if (commError) {
            statusEl.textContent = t("cannotConnect", "No se pudo conectar. Recargá la pestaña.");
            statusEl.classList.add("error");
            return;
          }

          const notice = safeText(response && response.notice);
          if (notice) {
            qualityNoteEl.textContent = notice;
            qualityNoteEl.title = notice;
            qualityNoteEl.hidden = false;
          }

          if (!response || !response.found) {
            statusEl.textContent =
              notice
                ? t("cannotOpenExperimental", "No se pudo abrir el selector experimental.")
                : response && response.reason === "timeout"
                ? t("pageNoResponse", "La página no respondió. Recargá la pestaña.")
                : t("noCompatiblePlayer", "Sin reproductor compatible.");
            statusEl.classList.add("error");
            return;
          }

          const typeLabels = {
            hls: "hls.js",
            dash: "dash.js",
            shaka: "Shaka Player",
            youtube: "YouTube",
            netflix: "Netflix (experimental)",
            disney: "Disney+ (experimental)",
            hbo: "HBO/Max (experimental)",
            twitch: "Twitch (experimental)",
            kick: "Kick (experimental)",
          };
          statusEl.textContent = typeLabels[response.type] || safeText(response.type);
          statusEl.classList.add("ok");

          const capText = response.cap && safeText(response.cap.text);
          if (capText) {
            qualityCapEl.textContent = capText;
            qualityCapEl.title =
              response.type === "kick"
                ? t("capTitleKick", "Calidad más alta que trae este stream (Kick no tiene planes).")
                : t("capTitleGeneric", "Techo real de la sesión: la calidad más alta que el reproductor puede alcanzar con esta cuenta y este equipo.");
            qualityCapEl.hidden = false;
          }

          // Un frame hostil puede mandar una lista cualquiera: descartamos
          // entradas sin id primitivo y limitamos el tamaño.
          const qualities = Array.isArray(response.qualities)
            ? response.qualities
                .filter(
                  (q) =>
                    q &&
                    (typeof q.id === "number" || typeof q.id === "string") &&
                    String(q.id).length <= 200
                )
                .slice(0, 100)
                .map((q) => ({
                  id: q.id,
                  label: safeText(q.label),
                  active: !!q.active,
                }))
            : [];
          const realQualities = qualities.filter(
            (q) => q.id !== "auto" && q.id !== -1
          );
          if (response.type === "kick" && !isKickRetry && !realQualities.length) {
            kickAutoRetryTimer = setTimeout(() => {
              kickAutoRetryTimer = null;
              loadQualities({ kickRetry: true });
            }, 1500);
          }
          if (!qualities.length) {
            qualitySelectEl.hidden = true;
            return;
          }

          qualities.forEach((q, i) => {
            const opt = document.createElement("option");
            opt.value = String(i);
            opt.textContent = q.label;
            if (q.active) opt.selected = true;
            qualitySelectEl.appendChild(opt);
          });
          qualitySelectEl.hidden = false;
          qualitySelectEl.onchange = () => {
            const q = qualities[Number(qualitySelectEl.value)];
            if (!q) return;
            qualitySelectEl.disabled = true;
            const send = (cb) => {
              const msg = { type: "set-quality", id: q.id };
              if (qualityFrameId != null) {
                sendToFrame(tabId, qualityFrameId, msg, (res, err) => {
                  if (!err) return cb(res);
                  sendToAllFrames(tabId, msg, cb);
                });
              } else {
                sendToAllFrames(tabId, msg, cb);
              }
            };
            send(() => setTimeout(loadQualities, 500));
          };
        }
      );
    });
  }

  const speedButtonsEl = document.getElementById("speed-buttons");
  const RATES = [0.75, 1, 1.25, 2];

  let speedSliderDragging = false;
  let speedPollActive = false;
  // El arrastre dispara decenas de eventos input por segundo. Agrupamos los
  // envíos y siempre mandamos el valor final en change.
  let speedSliderTimer = null;
  let speedSliderPending = null;
  // Mensaje temporal que gana sobre el aviso contextual del poll (que se
  // recalcula cada 250 ms y si no, lo pisaría al instante).
  let transientNote = null;

  function showTransientNote(text, ms) {
    transientNote = { text, until: Date.now() + (ms || 6000) };
    speedNoteEl.hidden = false;
    speedNoteEl.textContent = text;
  }

  function formatSpeedMeta(info) {
    const parts = [];
    const delay = finiteNumber(info.delaySeconds, null);
    const buffer = finiteNumber(info.bufferSeconds, null);
    if (delay != null) {
      parts.push(t("delayMeta", "$1 s delay", [delay.toFixed(1)]));
    }
    if (buffer != null) {
      parts.push(t("bufferMeta", "$1 s buffer", [buffer.toFixed(1)]));
    }
    return parts.join(" · ");
  }

  function updateSpeedNote(info) {
    if (transientNote) {
      if (Date.now() < transientNote.until) {
        speedNoteEl.hidden = false;
        speedNoteEl.textContent = transientNote.text;
        return;
      }
      transientNote = null;
    }
    if (!info || !info.found) {
      speedNoteEl.hidden = true;
      return;
    }
    if (info.released) {
      speedNoteEl.hidden = false;
      speedNoteEl.textContent =
        info.releaseReason === "site-overrides"
          ? t("siteReverted", "El sitio revirtió la velocidad; se soltó el control.")
          : t("controlReleased", "Control de velocidad liberado.");
      return;
    }
    const desired = finiteNumber(info.desired, null);
    const rate = finiteNumber(info.rate, null);
    if (
      info.pinned &&
      desired != null &&
      rate != null &&
      Math.abs(desired - rate) > 0.01
    ) {
      speedNoteEl.hidden = false;
      speedNoteEl.textContent = t("reaffirming", "El sitio puso otro valor; reafirmando.");
      return;
    }
    if (info.atLiveEdge && desired != null && desired > 1) {
      speedNoteEl.hidden = false;
      speedNoteEl.textContent = t("liveEdge", "Borde del vivo: 1× hasta que crezca el delay.");
      return;
    }
    speedNoteEl.hidden = true;
  }

  function sendSetSpeed(tabId, rate, onDone) {
    const msg = { type: "set-speed", rate };
    const handle = (res, commError) => {
      if (commError) {
        speedStatusEl.textContent = "—";
        speedNoteEl.hidden = false;
        speedNoteEl.textContent = t("cannotConnect", "No se pudo conectar. Recargá la pestaña.");
        return;
      }
      if (res && res.ok === false && res.reason === "blocked") {
        speedNoteEl.hidden = false;
        speedNoteEl.textContent = t("speedBlocked", "Este sitio bloquea los cambios de velocidad.");
        return;
      }
      if (onDone) onDone();
    };
    if (speedFrameId != null) {
      sendToFrame(tabId, speedFrameId, msg, (res, err) => {
        if (!err) return handle(res, false);
        sendToAllFrames(tabId, msg, handle);
      });
    } else {
      sendToAllFrames(tabId, msg, handle);
    }
  }

  function flushSpeedSlider() {
    if (speedSliderPending == null) return;
    const rate = speedSliderPending;
    speedSliderPending = null;
    if (speedSliderTimer != null) {
      clearTimeout(speedSliderTimer);
      speedSliderTimer = null;
    }
    getActiveTabId((tabId) => sendSetSpeed(tabId, rate));
  }

  function buildSpeedButtons() {
    speedButtonsEl.innerHTML = "";
    RATES.forEach((rate) => {
      const btn = document.createElement("button");
      btn.dataset.rate = String(rate);
      btn.textContent = `${rate}×`;
      btn.className = "quality-btn";
      btn.addEventListener("click", () => {
        speedSliderEl.value = String(Math.round(rate * 100));
        getActiveTabId((tabId) => {
          sendSetSpeed(tabId, rate, () => pollSpeedOnce(tabId));
        });
      });
      speedButtonsEl.appendChild(btn);
    });
  }

  function updateRampStatus(info) {
    const phase = info && info.rampPhase;
    if (!info || !info.found || !info.live || phase !== "ramping") {
      rampStatusEl.hidden = true;
      return;
    }
    rampStatusEl.hidden = false;
    rampStatusEl.textContent = t("rampBadge", "Ajuste 1,06×");
  }

  function updateSpeedStatus(info) {
    if (!info || !info.found) {
      speedStatusEl.textContent = "—";
      speedStatusEl.classList.remove("pinned");
      speedStatusEl.removeAttribute("title");
      speedMetaEl.textContent = "";
      speedNoteEl.hidden = true;
      rampStatusEl.hidden = true;
      catchUpBtn.hidden = true;
      return;
    }
    // El slider y los botones reflejan la velocidad PEDIDA, no la efectiva.
    // En vivo, cerca del borde la efectiva es 1× a propósito; si el slider
    // siguiera eso, saltaría todo el tiempo entre 1× y el valor elegido.
    const desired = finiteNumber(info.desired, null);
    const actual = finiteNumber(info.rate, null);
    const shownRate =
      info.pinned || (desired != null && desired !== 1) ? desired : actual;
    const shown = finiteNumber(shownRate, 1);
    speedStatusEl.textContent = `${shown.toFixed(2)}×`;
    speedStatusEl.classList.toggle("pinned", !!info.pinned);
    let title = "";
    if (info.pinned) {
      title = t("pinnedTitle", "Velocidad fijada por vos.");
      const blocked = finiteNumber(info.blockedWrites, 0);
      if (blocked > 0) {
        title += t(
          blocked === 1 ? "blockedOne" : "blockedMany",
          blocked === 1
            ? ` El sitio intentó cambiarla ${blocked} vez; bloqueado.`
            : ` El sitio intentó cambiarla ${blocked} veces; bloqueado.`,
          [String(blocked)]
        );
      }
    }
    speedStatusEl.title = title;
    speedMetaEl.textContent = formatSpeedMeta(info);
    catchUpBtn.hidden = !info.live;
    updateSpeedNote(info);
    updateRampStatus(info);
    if (!speedSliderDragging) {
      speedSliderEl.value = String(Math.round(shown * 100));
    }
    speedButtonsEl.querySelectorAll(".quality-btn").forEach((btn) => {
      const rate = parseFloat(btn.dataset.rate);
      const active = Math.abs(shown - rate) < 0.01;
      btn.classList.toggle("active", active);
    });
  }

  function handleSpeedInfo(tabId, info, commError, frameId) {
    if (!commError && info && info.found && frameId != null) {
      speedFrameId = frameId;
    }
    updateSpeedStatus(commError ? null : info);
  }

  function pollSpeedOnce(tabId) {
    sendToAllFrames(tabId, { type: "get-speed-info" }, (info, commError, frameId) => {
      handleSpeedInfo(tabId, info, commError, frameId);
    });
  }

  // En vez de un intervalo fijo (ej. cada 1000ms), antes esto volvía a
  // preguntar apenas llegaba la respuesta anterior, lo que en la práctica
  // significaba cientos de mensajes por segundo y un escaneo de página por
  // cada uno. Ahora hay un piso de 250 ms: sigue siendo fluido para el
  // contador de buffer y deja de castigar la pestaña.
  const SPEED_POLL_INTERVAL_MS = 250;

  function speedPollLoop(tabId) {
    if (!speedPollActive) return;
    const deliver = (info, commError, frameId) => {
      handleSpeedInfo(tabId, info, commError, frameId);
      if (speedPollActive) {
        setTimeout(() => speedPollLoop(tabId), SPEED_POLL_INTERVAL_MS);
      }
    };

    // Cuando ya sabemos qué frame tiene el reproductor, consultamos solo ahí:
    // antes cada 250 ms llegábamos a todos los iframes (chat, ads, embeddings)
    // y cada uno escaneaba su DOM aunque no tuviera video.
    if (speedFrameId != null) {
      sendToFrame(
        tabId,
        speedFrameId,
        { type: "get-speed-info" },
        (res, commError, frameId) => {
          if (!commError && res && res.found === true) {
            deliver(res, false, frameId);
            return;
          }
          // El player pudo mudarse de frame o el frame pudo desaparecer.
          speedFrameId = null;
          sendToAllFrames(tabId, { type: "get-speed-info" }, deliver);
        }
      );
      return;
    }

    sendToAllFrames(tabId, { type: "get-speed-info" }, deliver);
  }

  function loadSpeed() {
    getActiveTabId((tabId) => {
      sendToAllFrames(tabId, { type: "get-speed-info" }, (info, commError, frameId) => {
        handleSpeedInfo(tabId, info, commError, frameId);
        // El polling se arranca pase lo que pase (aunque todavía no se haya
        // encontrado nada), para que el estado se actualice apenas aparezca el
        // video.
        if (!speedPollActive) {
          speedPollActive = true;
          speedPollLoop(tabId);
        }
      });
    });
  }

  speedSliderEl.addEventListener("input", () => {
    speedSliderDragging = true;
    const rate = parseInt(speedSliderEl.value, 10) / 100;
    speedStatusEl.textContent = `${rate.toFixed(2)}×`;
    speedSliderPending = rate;
    if (speedSliderTimer == null) {
      speedSliderTimer = setTimeout(() => {
        speedSliderTimer = null;
        flushSpeedSlider();
      }, 100);
    }
  });

  speedSliderEl.addEventListener("change", () => {
    speedSliderDragging = false;
    flushSpeedSlider();
  });

  const catchUpBtn = document.getElementById("catch-up-live");

  function catchUpMessage(res) {
    if (!res || res.ok === false) {
      const reason = res && res.reason;
      if (reason === "already-live") return t("alreadyLive", "Ya estás al día.");
      if (reason === "not-live") return t("notLive", "Solo para transmisiones en vivo.");
      if (reason === "no-buffer") return t("noBuffer", "Falta buffer. Esperá un poco.");
      if (reason === "no-video") return t("noVideo", "No encontré el video.");
      if (reason === "timeout") return t("pageNoResponseShort", "La página no respondió.");
      return t("catchUpFailed", "No se pudo saltar al vivo.");
    }
    const jumpValue = finiteNumber(res.jumpSeconds, null);
    const jump = jumpValue != null ? `${jumpValue.toFixed(1)} s` : t("aBit", "un tramo");
    return t("jumped", "Saltamos $1 hacia el vivo.", [jump]);
  }

  catchUpBtn.addEventListener("click", () => {
    const label = t("goLive", "Ir al vivo");
    catchUpBtn.disabled = true;
    catchUpBtn.textContent = t("jumping", "Saltando…");
    getActiveTabId((tabId) => {
      const msg = { type: "catch-up-live" };
      const handle = (res, commError) => {
        catchUpBtn.disabled = false;
        catchUpBtn.textContent = label;
        if (commError) {
          showTransientNote(t("cannotConnect", "No se pudo conectar. Recargá la pestaña."));
          return;
        }
        showTransientNote(catchUpMessage(res), 8000);
        pollSpeedOnce(tabId);
      };
      if (speedFrameId != null) {
        sendToFrame(tabId, speedFrameId, msg, (res, err) => {
          if (!err) return handle(res, false);
          sendToAllFrames(tabId, msg, handle);
        });
      } else {
        sendToAllFrames(tabId, msg, handle);
      }
    });
  });

  // --- Volumen por captura de pestaña (tabCapture) ---------------------------
  //
  // Igual que Volume Master: se captura el audio ya mezclado de la pestaña y
  // se le aplica una ganancia. No se toca el <video> ni la Web Audio del
  // sitio, así que funciona también con contenido DRM y con varios
  // reproductores a la vez.
  //
  // El slider NO representa porcentajes: representa índices de una lista de
  // valores (0..9 de a 1, después 10..600 de a 10), igual que Volume Master.
  // Así los valores bajos tienen precisión fina y el resto va de 10 en 10.

  const VOLUME_VALUE_MAX = 600;
  const VOLUME_VALUE_DEFAULT = 100;
  const VOLUME_DOMAIN_KEY = "nds-volume-domains";
  const VOLUME_SLIDER_VALUES = (() => {
    const values = [];
    for (let i = 0; i < 10; i++) values.push(i);
    for (let i = 10; i <= VOLUME_VALUE_MAX; i += 10) values.push(i);
    return values;
  })();

  let volumeValue = VOLUME_VALUE_DEFAULT;
  let volumeSliderDragging = false;
  let volumePollTimer = null;
  let volumeDomain = null;
  let volumeActive = false;
  let volumeBusy = false;
  let volumeBusyText = "";
  let volumeLastWheelAt = 0;
  // Igual que en velocidad: el input llega muy seguido al arrastrar. El
  // etiquetado se actualiza enseguida y el mensaje se agrupa.
  let volumeSliderTimer = null;
  let volumeSliderPending = null;

  function clampVolume(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return VOLUME_VALUE_DEFAULT;
    return Math.max(0, Math.min(VOLUME_VALUE_MAX, Math.round(n)));
  }

  function volumeIndexOf(percent) {
    const target = clampVolume(percent);
    let best = 0;
    let bestDiff = Infinity;
    VOLUME_SLIDER_VALUES.forEach((value, index) => {
      const diff = Math.abs(value - target);
      if (diff < bestDiff) {
        bestDiff = diff;
        best = index;
      }
    });
    return best;
  }

  function volumePercentAt(index) {
    const i = Math.max(
      0,
      Math.min(VOLUME_SLIDER_VALUES.length - 1, parseInt(index, 10) || 0)
    );
    return VOLUME_SLIDER_VALUES[i];
  }

  function renderVolumeValue(percent) {
    volumeValue = clampVolume(percent);
    volumeValueEl.textContent = String(volumeValue);
    // No pisamos el slider mientras el usuario lo está arrastrando, para que
    // no "salte" bajo su dedo/mouse.
    if (!volumeSliderDragging) {
      volumeSliderEl.value = String(volumeIndexOf(volumeValue));
    }
  }

  function persistDomainVolume(percent) {
    if (!volumeDomain) return;
    chrome.storage.local.get({ [VOLUME_DOMAIN_KEY]: {} }, (data) => {
      const all = data[VOLUME_DOMAIN_KEY] || {};
      if (percent === VOLUME_VALUE_DEFAULT) {
        delete all[volumeDomain];
      } else {
        all[volumeDomain] = { volume: percent };
      }
      chrome.storage.local.set({ [VOLUME_DOMAIN_KEY]: all });
    });
  }

  function loadDomainMemory(tab) {
    if (!tab || !tab.url) {
      volumeDomain = null;
      volumeRestoreEl.hidden = true;
      return;
    }
    try {
      const url = new URL(tab.url);
      if (url.protocol !== "http:" && url.protocol !== "https:") return;
      volumeDomain = url.hostname;
    } catch (e) {
      return;
    }
    chrome.storage.local.get({ [VOLUME_DOMAIN_KEY]: {} }, (data) => {
      const all = data[VOLUME_DOMAIN_KEY] || {};
      const saved = all[volumeDomain] && all[volumeDomain].volume;
      if (Number.isInteger(saved) && saved >= 0 && saved <= VOLUME_VALUE_MAX) {
        volumeRestoreEl.textContent = t("restore", "Restaurar $1%", [String(saved)]);
        volumeRestoreEl.title = t("restoreTitle", "Volver a $1% en $2", [
          String(saved),
          volumeDomain,
        ]);
        volumeRestoreEl.dataset.percent = String(saved);
        // Igual que Volume Master: si ya hay captura activa, no ofrecemos
        // restaurar (el valor que manda es el que está aplicado).
        volumeRestoreEl.hidden = volumeActive;
      } else {
        volumeRestoreEl.hidden = true;
      }
    });
  }

  function setVolumeStatus(text, isError) {
    volumeStatusEl.textContent = text;
    volumeStatusEl.classList.toggle("error", !!isError);
  }

  function flushVolumeSlider() {
    if (volumeSliderPending == null) return;
    const percent = volumeSliderPending;
    volumeSliderPending = null;
    if (volumeSliderTimer != null) {
      clearTimeout(volumeSliderTimer);
      volumeSliderTimer = null;
    }
    applyVolume(percent);
  }

  function applyVolume(percent, opts) {
    const value = clampVolume(percent);
    renderVolumeValue(value);
    volumeRestoreEl.hidden = true;
    volumeBusy = false;
    setVolumeStatus(t("activating", "Activando…"));
    if (opts && opts.persist) persistDomainVolume(value);

    getActiveTab((tab) => {
      if (!tab) {
        setVolumeStatus(t("cannotReadTab", "No se pudo leer la pestaña."), true);
        return;
      }
      loadDomainMemory(tab);
      const tabId = tab.id;
      chrome.runtime.sendMessage(
        { target: "nds-background", type: "nds-volume-set", tabId, percent: value },
        (res) => {
          if (chrome.runtime.lastError) {
            volumeActive = false;
            setVolumeStatus(t("cannotTalkExt", "No se pudo hablar con la extensión."), true);
            return;
          }
          if (!res || !res.ok) {
            volumeActive = false;
            if (res && res.reason === "busy") {
              volumeBusy = true;
              volumeBusyText =
                res.message || t("busyFallback", "Otra extensión está capturando esta pestaña.");
              setVolumeStatus(volumeBusyText, true);
            } else {
              setVolumeStatus(
                (res && res.message) || t("captureFailed", "No se pudo activar la captura."),
                true
              );
            }
            return;
          }
          volumeActive = true;
          volumeBusy = false;
          const applied = finiteNumber(res.percent, value);
          renderVolumeValue(applied);
          setVolumeStatus(t("captureActive", "Captura activa"));
          volumeStopEl.hidden = false;
          chrome.action.setBadgeText({ text: String(applied), tabId }).catch(() => {});
        }
      );
    });
  }

  function updateVolumeFromStatus(res) {
    if (!res) return;
    if (res.active) {
      volumeActive = true;
      volumeBusy = false;
      volumeStopEl.hidden = false;
      const percent = clampVolume(
        res.percent != null ? res.percent : volumeValue
      );
      renderVolumeValue(percent);
      setVolumeStatus(t("captureActive", "Captura activa"));
      volumeRestoreEl.hidden = true;
      return;
    }
    volumeActive = false;
    if (!volumeBusy) {
      setVolumeStatus(t("noCapture", "Sin captura"));
      volumeStopEl.hidden = true;
    }
  }

  function pollVolumeStatus() {
    getActiveTab((tab) => {
      if (!tab) return;
      chrome.runtime.sendMessage(
        {
          target: "nds-background",
          type: "nds-volume-get",
          tabId: tab.id,
        },
        (res) => {
          if (chrome.runtime.lastError) return;
          updateVolumeFromStatus(res);
        }
      );
    });
  }

  function loadVolume() {
    getActiveTab((tab) => {
      if (!tab) {
        setVolumeStatus(t("cannotReadTab", "No se pudo leer la pestaña."), true);
        return;
      }
      loadDomainMemory(tab);
      chrome.runtime.sendMessage(
        {
          target: "nds-background",
          type: "nds-volume-get",
          tabId: tab.id,
        },
        (res) => {
          if (chrome.runtime.lastError) return;
          if (res && res.active) {
            updateVolumeFromStatus(res);
          } else {
            setVolumeStatus(t("noCapture", "Sin captura"));
          }
        }
      );
      if (!volumePollTimer) {
        volumePollTimer = setInterval(pollVolumeStatus, 1500);
      }
    });
  }

  volumeSliderEl.addEventListener("input", () => {
    volumeSliderDragging = true;
    const percent = volumePercentAt(volumeSliderEl.value);
    renderVolumeValue(percent);
    volumeRestoreEl.hidden = true;
    volumeSliderPending = percent;
    if (volumeSliderTimer == null) {
      volumeSliderTimer = setTimeout(() => {
        volumeSliderTimer = null;
        flushVolumeSlider();
      }, 120);
    }
  });

  volumeSliderEl.addEventListener("change", () => {
    volumeSliderDragging = false;
    flushVolumeSlider();
    persistDomainVolume(volumeValue);
  });

  // Rueda del mouse: un paso por vez y como máximo un cambio cada 100 ms,
  // igual que Volume Master. deltaY positivo sube el índice (rueda abajo).
  volumeSliderEl.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      const now = Date.now();
      if (now - volumeLastWheelAt < 100) return;
      volumeLastWheelAt = now;
      const current = parseInt(volumeSliderEl.value, 10) || 0;
      const next = Math.max(
        0,
        Math.min(
          VOLUME_SLIDER_VALUES.length - 1,
          current + Math.sign(e.deltaY)
        )
      );
      volumeSliderEl.value = String(next);
      volumeSliderEl.dispatchEvent(new Event("input"));
      volumeSliderEl.dispatchEvent(new Event("change"));
    },
    { passive: false }
  );

  document.querySelectorAll("#volume-presets .quality-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      applyVolume(parseInt(btn.dataset.percent, 10), { persist: true });
    });
  });

  volumeRestoreEl.addEventListener("click", () => {
    const saved = parseInt(volumeRestoreEl.dataset.percent, 10);
    if (Number.isInteger(saved)) applyVolume(saved, { persist: true });
  });

  volumeStopEl.addEventListener("click", () => {
    getActiveTab((tab) => {
      if (!tab) return;
      const tabId = tab.id;
      chrome.runtime.sendMessage(
        { target: "nds-background", type: "nds-volume-stop", tabId },
        () => {
          volumeActive = false;
          volumeBusy = false;
          volumeStopEl.hidden = true;
          setVolumeStatus(t("noCapture", "Sin captura"));
          chrome.action.setBadgeText({ text: "", tabId }).catch(() => {});
        }
      );
    });
  });

  // Teclas numéricas dentro del popup: 0 = 0%, 1 = 100%, ... 6 = 600%.
  // Las que caen fuera del rango (7, 8, 9) se ignoran, igual que Volume Master.
  document.addEventListener("keydown", (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const target = e.target;
    const tag = target && target.tagName;
    const isTextField =
      tag === "TEXTAREA" ||
      tag === "SELECT" ||
      (tag === "INPUT" &&
        target.type !== "range" &&
        target.type !== "checkbox" &&
        target.type !== "radio") ||
      (target && target.isContentEditable);
    if (isTextField) return;
    if (typeof e.key !== "string" || e.key.length !== 1) return;
    const digit = Number(e.key);
    if (!Number.isInteger(digit)) return;
    const percent = digit * 100;
    if (percent > VOLUME_VALUE_MAX) return;
    e.preventDefault();
    applyVolume(percent, { persist: true });
  });

  window.addEventListener("unload", () => {
    speedPollActive = false;
    if (volumePollTimer) clearInterval(volumePollTimer);
    if (speedSliderTimer) clearTimeout(speedSliderTimer);
    if (volumeSliderTimer) clearTimeout(volumeSliderTimer);
  });

  refreshBtn.addEventListener("click", () => {
    loadQualities();
    loadSpeed();
    loadVolume();
  });

  buildSpeedButtons();
  loadQualities();
  loadSpeed();
  loadVolume();
});

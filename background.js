// Service worker: es el dueño del "trámite" de captura de la pestaña.
//
// El audio NO se procesa acá: chrome.tabCapture.getMediaStreamId() devuelve un
// identificador y el AudioContext + GainNode viven en un documento offscreen
// (offscreen.js), que es el único contexto de la extensión donde se puede
// llamar a getUserMedia sin una ventana visible.
//
// Flujo (el mismo que usa Volume Master):
//   popup -> background: "quiero X% en esta pestaña"
//   background -> chrome.tabCapture.getMediaStreamId({ targetTabId })
//   background -> offscreen: "capturá este streamId y poné gain = X/100"
//
// Ojo: una sola captura por pestaña. Si ya hay otra extensión capturando,
// avisamos y NO tocamos nada (seguir adelante dejaría la pestaña en silencio).

const OFFSCREEN_PATH = "offscreen.html";
const BG_TARGET = "nds-background";
const OFFSCREEN_TARGET = "nds-offscreen";
const VOLUME_VALUE_MAX = 600;
const VOLUME_VALUE_DEFAULT = 100;

//chrome.i18n elige el idioma de la UI del navegador (ver _locales/).
//El fallback en español mantiene los mensajes legibles en entornos de test
//(o si la API no estuviera disponible) y evita tocar la lógica de captura.
function t(key, fallback, subs) {
  try {
    const value = chrome.i18n && chrome.i18n.getMessage(key, subs);
    return value || fallback;
  } catch (e) {
    return fallback;
  }
}

let creatingOffscreen = null;
// Serializa los pedidos por pestaña: si el usuario arrastra el slider llegan
// muchos mensajes seguidos y no queremos pedir diez streamIds en paralelo.
const perTabQueue = new Map();
// pestañas con captura propia -> URL al momento de activarla. Se usa para
// soltar la captura en cuanto la pestaña navega a otra página.
const capturedTabs = new Map();
// Generación por pestaña: si navega mientras una activación está en vuelo, la
// tarea se descarta antes de crear la captura. Si no, el "stop" se ejecuta
// primero y la captura nace después, sin nadie que la suelte.
const tabGenerations = new Map();
// Página de la pestaña cuando arrancó la tarea en vuelo, para distinguir un
// cambio de documento de un simple pushState/hash aunque todavía no haya
// captura registrada.
const inFlightPages = new Map();
// Último texto puesto en el badge por pestaña: evita escribir lo mismo en cada
// poll del popup, que consulta el estado varias veces por segundo.
const badgeTexts = new Map();

// El número de volumen aparece en el icono solo cuando la ganancia cambió de
// 100 %. 100 % (o sin captura) deja el badge vacío.
async function setVolumeBadge(tabId, percent) {
  let text = "";
  if (percent != null) {
    const n = clampVolume(percent);
    if (n !== VOLUME_VALUE_DEFAULT) text = String(n);
  }
  if (badgeTexts.get(tabId) === text) return;
  badgeTexts.set(tabId, text);
  try {
    await chrome.action.setBadgeText({ text, tabId });
  } catch (e) {
    badgeTexts.delete(tabId);
  }
}

function bumpTabGeneration(tabId) {
  const next = (tabGenerations.get(tabId) || 0) + 1;
  tabGenerations.set(tabId, next);
  return next;
}

// pushState/query/hash no cambian el documento: comparar la URL completa
// cortaba la captura aunque el <video> siga siendo el mismo.
function navigationPage(url) {
  try {
    const u = new URL(url);
    return u.origin + u.pathname;
  } catch (e) {
    return String(url || "");
  }
}

function isFromPopup(sender) {
  return !!(
    sender &&
    sender.id === chrome.runtime.id &&
    !sender.tab &&
    sender.url === chrome.runtime.getURL("popup.html")
  );
}

async function operableTabUrl(tabId) {
  if (!Number.isInteger(tabId) || tabId < 0) return null;
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab || !tab.url) return null;
    const url = new URL(tab.url);
    return url.protocol === "http:" || url.protocol === "https:"
      ? tab.url
      : null;
  } catch (e) {
    return null;
  }
}

function clampVolume(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 100;
  return Math.max(0, Math.min(VOLUME_VALUE_MAX, Math.round(n)));
}

async function hasOffscreenDocument() {
  try {
    if (chrome.runtime.getContexts) {
      const contexts = await chrome.runtime.getContexts({
        contextTypes: ["OFFSCREEN_DOCUMENT"],
        documentUrls: [chrome.runtime.getURL(OFFSCREEN_PATH)],
      });
      return contexts.length > 0;
    }
  } catch (e) {}
  // Chrome < 116 no tiene getContexts. Ahí no podemos averiguarlo sin
  // intentar crear el documento; el intento de creación tolera el "ya existe".
  return false;
}

async function ensureOffscreenDocument() {
  if (await hasOffscreenDocument()) return;
  if (creatingOffscreen) {
    await creatingOffscreen;
    return;
  }
  creatingOffscreen = chrome.offscreen
    .createDocument({
      url: OFFSCREEN_PATH,
      reasons: ["USER_MEDIA"],
      justification:
        "Capturar el audio de la pestaña activa para aplicar ganancia (chrome.tabCapture).",
    })
    .catch((e) => {
      const msg = String(e || "");
      // Si otro pedido lo creó primero, no es un error.
      if (!/single offscreen|already exists/i.test(msg)) throw e;
    })
    .finally(() => {
      creatingOffscreen = null;
    });
  await creatingOffscreen;
}

async function sendToOffscreen(message) {
  const payload = Object.assign({ target: OFFSCREEN_TARGET }, message);
  try {
    return await chrome.runtime.sendMessage(payload);
  } catch (e) {
    // El documento recién creado puede tardar un instante en registrar su
    // listener. Un reintento corto evita el falso "no responde".
    await new Promise((r) => setTimeout(r, 120));
    return await chrome.runtime.sendMessage(payload);
  }
}

function enqueueForTab(tabId, task) {
  const prev = perTabQueue.get(tabId) || Promise.resolve();
  const next = prev.catch(() => {}).then(task);
  perTabQueue.set(tabId, next);
  // finally() devuelve otra promesa: si next rechaza, esa derivada también.
  const cleanup = () => {
    inFlightPages.delete(tabId);
    if (perTabQueue.get(tabId) === next) perTabQueue.delete(tabId);
  };
  next.then(cleanup, cleanup);
  return next;
}

// ¿La pestaña ya está capturada por otra extensión? getCapturedTabs incluye
// las capturas en curso. Miramos solo "active": un "requested" puede ser un
// pedido nuestro que quedó a medias y bloquearía los reintentos para siempre.
// Si otra extensión está arrancando su captura, el error de getUserMedia nos
// lo va a decir igual (isBusyError) sin haber tocado el audio.
async function isTabCapturedBySomeone(tabId) {
  try {
    if (!chrome.tabCapture.getCapturedTabs) return false;
    const tabs = await chrome.tabCapture.getCapturedTabs();
    return (tabs || []).some(
      (t) => t && t.tabId === tabId && t.status === "active"
    );
  } catch (e) {
    return false;
  }
}

function isBusyError(error) {
  const msg = String(error || "");
  // Chrome usa mensajes como "Cannot capture a tab with an active stream" o
  // "Could not start audio source". El primero es inequívoco; el segundo
  // suele aparecer cuando otra extensión ya tiene el audio tomado.
  return /active stream|already.*captur|could not start audio source|not allowed/i.test(
    msg
  );
}

async function setVolumeForTab(tabId, percentValue) {
  const percent = clampVolume(percentValue);
  const generation = tabGenerations.get(tabId) || 0;
  const stale = () => (tabGenerations.get(tabId) || 0) !== generation;
  const navigated = () => ({ ok: false, reason: "navigated", percent });

  // La pestaña tiene que existir y ser una página http(s). Esto evita capturar
  // chrome://, extensiones, la nueva pestaña o un tabId inventado.
  const url = await operableTabUrl(tabId);
  if (stale()) return navigated();
  if (url) inFlightPages.set(tabId, navigationPage(url));
  if (!url) {
    return {
      ok: false,
      reason: "no-tab",
      percent,
      message: t(
        "bgNoTab",
        "La pestaña ya no está disponible o no es una página web."
      ),
    };
  }

  // 1) ¿Ya tenemos captura nosotros? Entonces solo cambiamos la ganancia.
  if (await hasOffscreenDocument()) {
    const status = await sendToOffscreen({
      type: "nds-offscreen-get",
      tabId,
    });
    if (stale()) return navigated();
    if (status && status.active) {
      const updated = await sendToOffscreen({
        type: "nds-offscreen-set",
        tabId,
        percent,
      });
      if (stale()) return navigated();
      if (updated && updated.ok) {
        capturedTabs.set(tabId, url);
        await setVolumeBadge(tabId, updated.percent != null ? updated.percent : percent);
        return updated;
      }
      // Si falló, seguimos abajo y probamos recrear la captura.
    }
  }

  // 2) Nadie de los nuestros la tiene. Antes de pedir el streamId, miramos si
  //    ya está capturada: en ese caso avisamos y no tocamos el audio.
  if (await isTabCapturedBySomeone(tabId)) {
    if (stale()) return navigated();
    return {
      ok: false,
      reason: "busy",
      percent,
      message: t(
        "captureBusy",
        "La pestaña ya está siendo capturada por otra extensión (por ejemplo Volume Master). Desactivala o recargá la pestaña para usar el volumen de Stream Control."
      ),
    };
  }

  // 3) Pedir el id del stream y crear la captura en el offscreen.
  let streamId;
  try {
    streamId = await chrome.tabCapture.getMediaStreamId({
      targetTabId: tabId,
    });
  } catch (e) {
    return {
      ok: false,
      reason: isBusyError(e) ? "busy" : "capture-failed",
      percent,
      error: String(e),
      message: isBusyError(e)
        ? t(
            "bgBusyError",
            "No se pudo capturar el audio: puede que otra extensión esté usando esta pestaña. No se modificó el audio."
          )
        : t(
            "bgCaptureStart",
            "No se pudo iniciar la captura de audio de la pestaña."
          ),
    };
  }

  if (stale()) return navigated();
  await ensureOffscreenDocument();
  if (stale()) return navigated();
  let result;
  try {
    result = await sendToOffscreen({
      type: "nds-offscreen-set",
      tabId,
      percent,
      streamId,
    });
  } catch (e) {
    result = { ok: false, error: String(e), reason: "capture-failed" };
  }
  if (stale()) {
    // El offscreen puede haber creado la captura justo antes del stop de
    // onUpdated: la soltamos acá también para no dejarla huérfana.
    try {
      await sendToOffscreen({ type: "nds-offscreen-stop", tabId });
    } catch (e) {}
    capturedTabs.delete(tabId);
    await setVolumeBadge(tabId, null);
    return navigated();
  }
  if (result && result.ok) {
    capturedTabs.set(tabId, url);
    await setVolumeBadge(tabId, result.percent != null ? result.percent : percent);
    return result;
  }

  return {
    ok: false,
    reason: isBusyError(result && result.error) ? "busy" : "capture-failed",
    percent,
    error: (result && result.error) || "sin respuesta del offscreen",
    message: t(
      "bgActivateFailed",
      "No se pudo activar la captura de audio. Si tenés Volume Master activo en esta pestaña, desactivalo: dos extensiones no pueden capturar el mismo audio."
    ),
  };
}

async function handleMessage(msg, sender) {
  if (!msg || msg.target !== BG_TARGET) return undefined;
  // Capturar y silenciar una pestaña es privilegiado: solo el popup puede
  // pedirlo. No hay externally_connectable, así que un sitio no llega acá;
  // esto es defensa en profundidad.
  if (!isFromPopup(sender)) return undefined;

  if (msg.type === "nds-volume-get") {
    const inactive = async () => {
      await setVolumeBadge(msg.tabId, null);
      return { ok: true, active: false, percent: null };
    };
    if (!(await operableTabUrl(msg.tabId))) return inactive();
    if (!(await hasOffscreenDocument())) return inactive();
    try {
      const status = await sendToOffscreen({
        type: "nds-offscreen-get",
        tabId: msg.tabId,
      });
      if (!status || !status.active) return inactive();
      await setVolumeBadge(msg.tabId, status.percent);
      return status;
    } catch (e) {
      return inactive();
    }
  }

  if (msg.type === "nds-volume-set") {
    const url = await operableTabUrl(msg.tabId);
    if (!url) return { ok: false, reason: "no-tab" };
    inFlightPages.set(msg.tabId, navigationPage(url));
    return enqueueForTab(msg.tabId, () =>
      setVolumeForTab(msg.tabId, msg.percent)
    );
  }

  if (msg.type === "nds-volume-stop") {
    if (!(await operableTabUrl(msg.tabId))) {
      return { ok: false, reason: "no-tab" };
    }
    return enqueueForTab(msg.tabId, async () => {
      if (!(await hasOffscreenDocument())) return { ok: true, active: false };
      try {
        const result = await sendToOffscreen({
          type: "nds-offscreen-stop",
          tabId: msg.tabId,
        });
        capturedTabs.delete(msg.tabId);
        await setVolumeBadge(msg.tabId, null);
        return result;
      } catch (e) {
        return { ok: false, error: String(e) };
      }
    });
  }

  return undefined;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== BG_TARGET) return false;
  handleMessage(msg, sender)
    .then((result) => {
      sendResponse(
        result === undefined ? { ok: false, reason: "unknown" } : result
      );
    })
    .catch((e) => {
      sendResponse({ ok: false, reason: "error", error: String(e) });
    });
  return true; // respuesta asíncrona
});

// Si la pestaña navega a otro documento, el tabId no cambia: sin esto
// seguiríamos capturando su audio (por ejemplo al pasar de un video a una
// llamada). onCommitted NO se dispara para pushState/replaceState ni cambios
// de hash, así que una SPA que cambia el pathname sin recargar no corta el
// volumen. Tampoco comparamos URLs: una recarga de la misma URL sí es un
// documento nuevo y debe soltar la captura.
async function handleDocumentNavigation(tabId) {
  // Invalidar primero: una activación en vuelo debe abandonarse antes de
  // crear la captura, y el stop se encola detrás de lo que ya esté corriendo.
  bumpTabGeneration(tabId);
  const hadCapture = capturedTabs.delete(tabId);
  const hadInFlight = inFlightPages.has(tabId);
  if (hadCapture || hadInFlight) {
    await enqueueForTab(tabId, async () => {
      if (!(await hasOffscreenDocument())) return;
      try {
        await sendToOffscreen({ type: "nds-offscreen-stop", tabId });
      } catch (e) {}
    });
  }
  await setVolumeBadge(tabId, null);
}

if (chrome.webNavigation && chrome.webNavigation.onCommitted) {
  chrome.webNavigation.onCommitted.addListener((details) => {
    if (!details || details.frameId !== 0) return; // documento principal
    return handleDocumentNavigation(details.tabId);
  });
}

chrome.tabs.onRemoved.addListener(async (tabId) => {
  bumpTabGeneration(tabId);
  capturedTabs.delete(tabId);
  try {
    if (await hasOffscreenDocument()) {
      await sendToOffscreen({ type: "nds-offscreen-stop", tabId });
    }
  } catch (e) {}
  await setVolumeBadge(tabId, null);
  badgeTexts.delete(tabId);
  perTabQueue.delete(tabId);
});

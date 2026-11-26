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

let creatingOffscreen = null;
// Serializa los pedidos por pestaña: si el usuario arrastra el slider llegan
// muchos mensajes seguidos y no queremos pedir diez streamIds en paralelo.
const perTabQueue = new Map();
// pestañas con captura propia -> URL al momento de activarla. Se usa para
// soltar la captura en cuanto la pestaña navega a otra página.
const capturedTabs = new Map();

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
  next.finally(() => {
    if (perTabQueue.get(tabId) === next) perTabQueue.delete(tabId);
  });
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

  // La pestaña tiene que existir y ser una página http(s). Esto evita capturar
  // chrome://, extensiones, la nueva pestaña o un tabId inventado.
  const url = await operableTabUrl(tabId);
  if (!url) {
    return {
      ok: false,
      reason: "no-tab",
      percent,
      message: "La pestaña ya no está disponible o no es una página web.",
    };
  }

  // 1) ¿Ya tenemos captura nosotros? Entonces solo cambiamos la ganancia.
  if (await hasOffscreenDocument()) {
    const status = await sendToOffscreen({
      type: "nds-offscreen-get",
      tabId,
    });
    if (status && status.active) {
      const updated = await sendToOffscreen({
        type: "nds-offscreen-set",
        tabId,
        percent,
      });
      if (updated && updated.ok) {
        capturedTabs.set(tabId, url);
        return updated;
      }
      // Si falló, seguimos abajo y probamos recrear la captura.
    }
  }

  // 2) Nadie de los nuestros la tiene. Antes de pedir el streamId, miramos si
  //    ya está capturada: en ese caso avisamos y no tocamos el audio.
  if (await isTabCapturedBySomeone(tabId)) {
    return {
      ok: false,
      reason: "busy",
      percent,
      message:
        "La pestaña ya está siendo capturada por otra extensión (por ejemplo Volume Master). Desactivala o recargá la pestaña para usar el volumen de Stream Control.",
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
        ? "No se pudo capturar el audio: puede que otra extensión esté usando esta pestaña. No se modificó el audio."
        : "No se pudo iniciar la captura de audio de la pestaña.",
    };
  }

  await ensureOffscreenDocument();
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
  if (result && result.ok) {
    capturedTabs.set(tabId, url);
    return result;
  }

  return {
    ok: false,
    reason: isBusyError(result && result.error) ? "busy" : "capture-failed",
    percent,
    error: (result && result.error) || "sin respuesta del offscreen",
    message:
      "No se pudo activar la captura de audio. Si tenés Volume Master activo en esta pestaña, desactivalo: dos extensiones no pueden capturar el mismo audio.",
  };
}

async function handleMessage(msg, sender) {
  if (!msg || msg.target !== BG_TARGET) return undefined;
  // Capturar y silenciar una pestaña es privilegiado: solo el popup puede
  // pedirlo. No hay externally_connectable, así que un sitio no llega acá;
  // esto es defensa en profundidad.
  if (!isFromPopup(sender)) return undefined;

  if (msg.type === "nds-volume-get") {
    if (!(await operableTabUrl(msg.tabId))) {
      return { ok: true, active: false, percent: null };
    }
    if (!(await hasOffscreenDocument())) {
      return { ok: true, active: false, percent: null };
    }
    try {
      const status = await sendToOffscreen({
        type: "nds-offscreen-get",
        tabId: msg.tabId,
      });
      return status || { ok: true, active: false, percent: null };
    } catch (e) {
      return { ok: true, active: false, percent: null };
    }
  }

  if (msg.type === "nds-volume-set") {
    if (!(await operableTabUrl(msg.tabId))) {
      return { ok: false, reason: "no-tab" };
    }
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

// Si la pestaña navega a otra URL, el tabId no cambia: sin esto seguiríamos
// capturando su audio (por ejemplo al pasar de un video a una llamada).
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (!changeInfo || changeInfo.url === undefined) return;
  const capturedUrl = capturedTabs.get(tabId);
  if (!capturedUrl || changeInfo.url === capturedUrl) return;
  capturedTabs.delete(tabId);
  perTabQueue.delete(tabId);
  try {
    if (await hasOffscreenDocument()) {
      await sendToOffscreen({ type: "nds-offscreen-stop", tabId });
    }
  } catch (e) {}
  try {
    chrome.action.setBadgeText({ text: "", tabId });
  } catch (e) {}
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  capturedTabs.delete(tabId);
  try {
    if (await hasOffscreenDocument()) {
      await sendToOffscreen({ type: "nds-offscreen-stop", tabId });
    }
  } catch (e) {}
  try {
    chrome.action.setBadgeText({ text: "", tabId });
  } catch (e) {}
  perTabQueue.delete(tabId);
});

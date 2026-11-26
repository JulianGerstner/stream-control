// Corre en el "isolated world" de la extensión: no ve las variables del
// sitio directamente, pero sí puede hablar con chrome.runtime (el popup)
// y con window (mediante eventos) para comunicarse con page-hook.js.

const BRIDGE_TARGET = "nds-bridge";

// Espera una respuesta con un requestId concreto y un timeout de seguridad:
// si por algún motivo page-hook.js nunca contesta (una excepción no atajada,
// una versión vieja del script todavía corriendo, etc.), no dejamos el popup
// colgado para siempre.
// La lista de calidades de Kick se pide con más margen: leerla implica abrir
// y cerrar su menú ⚙️ y, si el primer botón abre subtítulos, probar otro; el
// adapter puede tardar ~4,5 s.
function waitForResponse(eventName, sendResponse, timeoutMs, requestId) {
  let done = false;
  const handler = (e) => {
    // Cualquier script de la página puede despachar estos eventos: solo
    // aceptamos la respuesta de este pedido, no una vieja o inventada.
    const detail = e.detail;
    if (!detail || detail.requestId !== requestId) return;
    if (done) return;
    done = true;
    window.removeEventListener(eventName, handler);
    sendResponse(detail);
  };
  window.addEventListener(eventName, handler);
  setTimeout(() => {
    if (done) return;
    done = true;
    window.removeEventListener(eventName, handler);
    sendResponse({ found: false, ok: false, reason: "timeout", requestId });
  }, timeoutMs || 4000);
}

function isFromPopup(sender) {
  return !!(
    sender &&
    sender.id === chrome.runtime.id &&
    !sender.tab &&
    sender.url === chrome.runtime.getURL("popup.html")
  );
}

function validQualityId(id) {
  return (
    (typeof id === "number" && Number.isFinite(id)) ||
    (typeof id === "string" && id.length > 0 && id.length <= 200)
  );
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== BRIDGE_TARGET || !isFromPopup(sender)) {
    return false;
  }
  const requestId = msg.requestId;
  if (typeof requestId !== "string" || !requestId) return false;

  if (msg.type === "get-qualities") {
    // page-hook.js corre en el MAIN world y no tiene chrome.i18n: el popup le
    // manda los textos ya traducidos. Solo aceptamos strings cortos y en
    // cantidad acotada, igual que con cualquier dato que venga del popup.
    const strings = {};
    if (msg.strings && typeof msg.strings === "object") {
      Object.keys(msg.strings)
        .slice(0, 60)
        .forEach((key) => {
          const value = msg.strings[key];
          if (typeof value === "string" && value.length <= 300) {
            strings[key] = value;
          }
        });
    }
    waitForResponse("qs-qualities-response", sendResponse, 7000, requestId);
    window.dispatchEvent(
      new CustomEvent("qs-request-qualities", {
        detail: { requestId, strings },
      })
    );
    return true; // respuesta asincrónica
  }

  if (msg.type === "set-quality") {
    if (!validQualityId(msg.id)) {
      sendResponse({ ok: false, reason: "invalid-id" });
      return false;
    }
    window.dispatchEvent(
      new CustomEvent("qs-set-quality", {
        detail: { id: msg.id, requestId },
      })
    );
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === "get-speed-info") {
    waitForResponse("qs-speed-info-response", sendResponse, 4000, requestId);
    window.dispatchEvent(
      new CustomEvent("qs-get-speed-info", { detail: { requestId } })
    );
    return true;
  }

  if (msg.type === "set-speed") {
    const rate = Number(msg.rate);
    if (!Number.isFinite(rate) || rate < 0 || rate > 10) {
      sendResponse({ ok: false, reason: "invalid-rate" });
      return false;
    }
    waitForResponse("qs-set-speed-response", sendResponse, 4000, requestId);
    window.dispatchEvent(
      new CustomEvent("qs-set-speed", {
        detail: { rate, requestId },
      })
    );
    return true; // respuesta asincrónica (puede tardar ~150ms en confirmar)
  }

  // "Ponerse al día": un salto único dentro del buffer del vivo.
  if (msg.type === "catch-up-live") {
    waitForResponse("qs-catch-up-live-response", sendResponse, 3000, requestId);
    window.dispatchEvent(
      new CustomEvent("qs-catch-up-live", { detail: { requestId } })
    );
    return true;
  }

  return false;
});

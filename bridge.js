// Corre en el "isolated world" de la extensión: no ve las variables del
// sitio directamente, pero sí puede hablar con chrome.runtime (el popup)
// y con window (mediante eventos) para comunicarse con page-hook.js.

// Espera un evento de respuesta con un timeout de seguridad: si por algún
// motivo page-hook.js nunca contesta (una excepción no atajada, una versión
// vieja del script todavía corriendo, etc.), no dejamos el popup colgado
// para siempre — a los 4 segundos respondemos con un timeout explícito.
// La lista de calidades de Kick se pide con más margen: leerla implica abrir
// y cerrar su menú ⚙️ y, si el primer botón abre subtítulos, probar otro; el
// adapter puede tardar ~4,5 s.
function waitForResponse(eventName, sendResponse, timeoutMs) {
  let done = false;
  const handler = (e) => {
    if (done) return;
    done = true;
    window.removeEventListener(eventName, handler);
    sendResponse(e.detail);
  };
  window.addEventListener(eventName, handler);
  setTimeout(() => {
    if (done) return;
    done = true;
    window.removeEventListener(eventName, handler);
    sendResponse({ found: false, ok: false, reason: "timeout" });
  }, timeoutMs || 4000);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "get-qualities") {
    waitForResponse("qs-qualities-response", sendResponse, 7000);
    window.dispatchEvent(new CustomEvent("qs-request-qualities"));
    return true; // respuesta asincrónica
  }

  if (msg.type === "set-quality") {
    window.dispatchEvent(
      new CustomEvent("qs-set-quality", { detail: { id: msg.id } })
    );
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === "get-speed-info") {
    waitForResponse("qs-speed-info-response", sendResponse);
    window.dispatchEvent(new CustomEvent("qs-get-speed-info"));
    return true;
  }

  if (msg.type === "set-speed") {
    waitForResponse("qs-set-speed-response", sendResponse);
    window.dispatchEvent(
      new CustomEvent("qs-set-speed", {
        detail: { rate: msg.rate },
      })
    );
    return true; // respuesta asincrónica (puede tardar ~150ms en confirmar)
  }

  // "Ponerse al día": un salto único dentro del buffer del vivo.
  if (msg.type === "catch-up-live") {
    waitForResponse("qs-catch-up-live-response", sendResponse, 3000);
    window.dispatchEvent(new CustomEvent("qs-catch-up-live"));
    return true;
  }
});

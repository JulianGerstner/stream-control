// Documento offscreen: acá vive el AudioContext que procesa el audio de la
// pestaña capturada.
//
// Cadena: stream de la pestaña -> MediaStreamSource -> GainNode -> destination
//
// Chrome silencia la salida normal de la pestaña en cuanto empieza la captura;
// el único audio audible pasa a ser el que sale por este contexto. Por eso el
// GainNode tiene que quedar conectado y el AudioContext "running" siempre.
// Si por lo que sea el contexto se suspende, lo reanudamos: si no, la pestaña
// queda muda.

const OFFSCREEN_TARGET = "nds-offscreen";
const VOLUME_VALUE_DEFAULT = 100;
const VOLUME_VALUE_MAX = 600;

// tabId -> { ctx, source, gain, stream, percent }
const audioStates = new Map();
// Un streamId solo puede abrir un AudioContext. Si un contexto comprometido
// reenvía el mismo id con otro tabId, lo descartamos en vez de crear capturas
// infinitas.
const usedStreamIds = new Set();
const MAX_AUDIO_STATES = 32;

function isFromBackground(sender) {
  return !!(
    sender &&
    sender.id === chrome.runtime.id &&
    !sender.tab
  );
}

function validTabId(tabId) {
  return Number.isInteger(tabId) && tabId >= 0;
}

function clampVolume(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return VOLUME_VALUE_DEFAULT;
  return Math.max(0, Math.min(VOLUME_VALUE_MAX, Math.round(n)));
}

async function getTabStream(streamId) {
  if (typeof streamId !== "string" || !streamId.trim()) {
    throw new Error("falta el streamId de la pestaña");
  }
  return navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId,
      },
    },
    video: false,
  });
}

function connectStream(tabId, stream, percent) {
  const ctx = new AudioContext();
  const source = ctx.createMediaStreamSource(stream);
  const gain = ctx.createGain();
  gain.gain.value = clampVolume(percent) / 100;
  source.connect(gain);
  gain.connect(ctx.destination);

  const state = { ctx, source, gain, stream, percent: clampVolume(percent) };
  audioStates.set(tabId, state);

  // El contexto puede arrancar suspendido por la política de autoplay. En un
  // documento offscreen con USER_MEDIA normalmente no pasa, pero si pasa la
  // pestaña quedaría en silencio: lo reanudamos y lo vigilamos.
  const resume = () => {
    if (ctx.state === "suspended") ctx.resume().catch(() => {});
  };
  resume();
  ctx.addEventListener("statechange", resume);

  // Si la captura se corta (por ejemplo, porque el usuario recargó la
  // extensión o Chrome cerró el stream), liberamos todo para no dejar un
  // estado fantasma que diga "capturando" cuando ya no hay audio.
  const track = stream.getAudioTracks()[0];
  if (track) {
    track.addEventListener("ended", () => {
      if (audioStates.get(tabId) === state) stopTab(tabId);
    });
  }

  return state;
}

function stopTab(tabId) {
  const state = audioStates.get(tabId);
  if (!state) return false;
  audioStates.delete(tabId);
  try {
    state.source.disconnect();
  } catch (e) {}
  try {
    state.gain.disconnect();
  } catch (e) {}
  try {
    state.stream.getTracks().forEach((t) => t.stop());
  } catch (e) {}
  try {
    state.ctx.close().catch(() => {});
  } catch (e) {}
  return true;
}

async function handleMessage(msg, sender) {
  if (!msg || msg.target !== OFFSCREEN_TARGET) return undefined;
  if (!isFromBackground(sender)) return undefined;
  if (!validTabId(msg.tabId)) return { ok: false, reason: "invalid-tab" };

  if (msg.type === "nds-offscreen-get") {
    const state = audioStates.get(msg.tabId);
    if (!state) return { ok: true, active: false, percent: null };
    return {
      ok: true,
      active: true,
      percent: state.percent,
      contextState: state.ctx.state,
    };
  }

  if (msg.type === "nds-offscreen-set") {
    const tabId = msg.tabId;
    const percent = clampVolume(msg.percent);
    const existing = audioStates.get(tabId);

    if (existing) {
      existing.gain.gain.value = percent / 100;
      existing.percent = percent;
      if (existing.ctx.state === "suspended") {
        existing.ctx.resume().catch(() => {});
      }
      return {
        ok: true,
        active: true,
        percent,
        contextState: existing.ctx.state,
      };
    }

    // Solo el background entrega un streamId, y lo hace una vez por captura.
    if (
      typeof msg.streamId !== "string" ||
      !msg.streamId.trim() ||
      usedStreamIds.has(msg.streamId)
    ) {
      return { ok: false, reason: "invalid-stream", percent };
    }
    if (audioStates.size >= MAX_AUDIO_STATES) {
      return { ok: false, reason: "too-many-tabs", percent };
    }

    try {
      const stream = await getTabStream(msg.streamId);
      usedStreamIds.add(msg.streamId);
      const state = connectStream(tabId, stream, percent);
      return {
        ok: true,
        active: true,
        started: true,
        percent,
        contextState: state.ctx.state,
      };
    } catch (e) {
      return {
        ok: false,
        reason: "capture-failed",
        error: String(e && e.message ? e.message : e),
        percent,
      };
    }
  }

  if (msg.type === "nds-offscreen-stop") {
    const stopped = stopTab(msg.tabId);
    return { ok: true, active: false, stopped };
  }

  return undefined;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== OFFSCREEN_TARGET) return false;
  handleMessage(msg, sender)
    .then((result) => {
      sendResponse(result === undefined ? { ok: false, reason: "unknown" } : result);
    })
    .catch((e) => {
      sendResponse({ ok: false, reason: "error", error: String(e) });
    });
  return true; // respuesta asíncrona
});

// Tests de las optimizaciones de CPU/RAM (sin tocar el repo).
// Extraen código real de los scripts y lo corren con mocks mínimos.
const fs = require("fs");
const vm = require("vm");
const path = require("path");

const REPO = path.join(__dirname, "..");
const read = (name) => fs.readFileSync(path.join(REPO, name), "utf8");
const hook = read("page-hook.js");
const popup = read("popup.js");
const offscreenSrc = read("offscreen.js");

let failures = 0;
function ok(name, cond) {
  console.log(`${cond ? "PASS" : "FAIL"} | ${name}`);
  if (!cond) failures++;
}
function slice(src, start, end, label) {
  const a = src.indexOf(start);
  const b = src.indexOf(end, a < 0 ? 0 : a);
  if (a < 0 || b < 0) throw new Error(`no se encontró el bloque: ${label}`);
  return src.slice(a, b);
}

// 1) El timer de locks solo existe mientras haya calidad fijada.
function testLockTimer() {
  const code = slice(
    hook,
    "  let lockCheckTimer = null;",
    '  // --- Detección por "duck typing"',
    "lock timer"
  );
  let nextId = 1;
  const timers = new Map();
  const lockedInstances = new Map();
  let reasserts = 0;
  const api = new Function(
    "deps",
    `const {setInterval,clearInterval,lockedInstances,reassertShakaLock}=deps;
     ${code}
     return {ensureLockCheckTimer,releaseLockCheckTimer,getTimer:()=>lockCheckTimer};`
  )({
    setInterval: (fn) => {
      const id = nextId++;
      timers.set(id, fn);
      return id;
    },
    clearInterval: (id) => timers.delete(id),
    lockedInstances,
    reassertShakaLock: () => reasserts++,
  });

  api.ensureLockCheckTimer();
  ok("sin locks no se crea ningún interval", timers.size === 0);

  const instance = { currentLevel: 2, levels: [] };
  lockedInstances.set(instance, { type: "hls", id: 1 });
  api.ensureLockCheckTimer();
  ok("al fijar calidad se crea exactamente un interval", timers.size === 1);
  api.ensureLockCheckTimer();
  ok("no se duplica el interval", timers.size === 1);

  instance.currentLevel = 9;
  timers.values().next().value();
  ok("el interval sigue reafirmando la calidad", instance.currentLevel === 1);

  lockedInstances.delete(instance);
  timers.values().next().value();
  ok("al soltar la calidad se apaga el interval", timers.size === 0);
  api.releaseLockCheckTimer();
  ok("no queda timer huérfano", api.getTimer() === null);
}

// 2) qs-get-speed-info no escanea en frames sin video ni shadow roots.
function testSpeedGuard() {
  const code = slice(
    hook,
    "    let hasVideo = false;",
    "    let detail;",
    "speed guard"
  );
  class FakeCustomEvent {
    constructor(type, opts) {
      this.type = type;
      this.detail = opts && opts.detail;
    }
  }
  function run(hasDomVideo, shadowCount) {
    const events = [];
    const api = new Function(
      "deps",
      `const {document,window,CustomEvent,__qsShadowRootCount,requestId}=deps;
       ${code}
       return "continuo";`
    )({
      document: { querySelector: () => (hasDomVideo ? {} : null) },
      window: { dispatchEvent: (e) => events.push(e) },
      CustomEvent: FakeCustomEvent,
      __qsShadowRootCount: shadowCount,
      requestId: "r-1",
    });
    return { events, api };
  }

  let r = run(false, 0);
  ok(
    "frame sin video responde sin escanear",
    r.events.length === 1 &&
      r.events[0].detail.found === false &&
      r.events[0].detail.requestId === "r-1" &&
      r.api !== "continuo"
  );

  r = run(false, 3);
  ok("con shadow roots se sigue con la búsqueda normal", r.events.length === 0 && r.api === "continuo");
  r = run(true, 0);
  ok("con <video> se sigue con la búsqueda normal", r.events.length === 0 && r.api === "continuo");
}

// 3) El safety-net del cartel pasó de 2,5 s a 10 s y no escanea si suena.
function testStillInterval() {
  const start = '  // --- Cartel "¿Sigues viendo?" de YouTube / YouTube Music ---';
  const end = "  // --- Puente de comunicación con el content script aislado (bridge.js) ---";
  const code = slice(hook, start, end, "still watching");

  function scenario(videoPlaying) {
    let intervalFn = null;
    let intervalMs = null;
    let queryCount = 0;
    const win = {
      addEventListener() {},
      __qsStillWatchingDebug: () => ({}),
    };
    win.top = win;
    const sandbox = {
      document: {
        readyState: "complete",
        documentElement: {},
        addEventListener() {},
        querySelectorAll: () => {
          queryCount++;
          return [];
        },
        querySelector: () => ({
          paused: !videoPlaying,
          ended: false,
        }),
      },
      window: win,
      location: { hostname: "www.youtube.com" },
      localStorage: { getItem: () => null, setItem() {} },
      MutationObserver: class {
        observe() {}
      },
      setInterval: (fn, ms) => {
        intervalFn = fn;
        intervalMs = ms;
        return 1;
      },
      setTimeout: () => 1,
      Date,
      Map,
      WeakMap,
      Array,
      String,
      Object,
      Promise,
      console,
      __qsShadowRegistry: new WeakMap(),
      currentPlayer: null,
      getActivePlayer: () => null,
      resolveVideoElement: () => null,
      isRealMediaElement: () => true,
      collectVideosDeep: () => {},
    };
    vm.runInNewContext(code, sandbox, { timeout: 5000 });
    queryCount = 0;
    intervalFn();
    return { intervalMs, ran: queryCount > 0 };
  }

  const paused = scenario(false);
  ok("el safety-net corre cada 10 s", paused.intervalMs === 10000);
  ok("con video pausado sí escanea", paused.ran === true);
  const playing = scenario(true);
  ok("con video sonando no escanea", playing.ran === false);
}

// 4) El polling de velocidad usa el frame conocido y cae al broadcast si falla.
function testSpeedPollTargeting() {
  const code = slice(popup, "  function speedPollLoop(tabId) {", "  function loadSpeed() {", "speed poll");
  function scenario(directResult) {
    const calls = { frame: 0, all: 0, handled: 0 };
    let speedPollActive = true;
    let speedFrameId = 7;
    const api = new Function(
      "deps",
      `const {sendToFrame,sendToAllFrames,handleSpeedInfo,SPEED_POLL_INTERVAL_MS,setTimeout}=deps;
       let speedPollActive = deps.speedPollActive;
       let speedFrameId = deps.speedFrameId;
       ${code}
       return {run:()=>speedPollLoop(42), getFrame:()=>speedFrameId, stop:()=>{speedPollActive=false;}};`
    )({
      sendToFrame: (tabId, frameId, msg, cb) => {
        calls.frame++;
        cb(directResult.res, directResult.commError, frameId);
      },
      sendToAllFrames: (tabId, msg, cb) => {
        calls.all++;
        cb({ found: true }, false, 3);
      },
      handleSpeedInfo: () => calls.handled++,
      SPEED_POLL_INTERVAL_MS: 250,
      setTimeout: () => 1,
      speedPollActive: true,
      speedFrameId: 7,
    });
    api.run();
    return { calls, frame: api.getFrame() };
  }

  let r = scenario({ res: { found: true }, commError: false });
  ok("con frame conocido no se hace broadcast", r.calls.frame === 1 && r.calls.all === 0 && r.calls.handled === 1);
  r = scenario({ res: { found: false }, commError: false });
  ok("si el player se mudó, cae al broadcast", r.calls.frame === 1 && r.calls.all === 1 && r.frame === null);
  r = scenario({ res: null, commError: true });
  ok("si el frame falla, también cae al broadcast", r.calls.all === 1 && r.frame === null);
}

// 5) Los sliders agrupan mensajes y envían el valor final al soltar.
function testSliderThrottle() {
  const code =
    slice(popup, "  function flushSpeedSlider() {", "  function buildSpeedButtons() {", "speed flush") +
    "\n" +
    slice(popup, '  speedSliderEl.addEventListener("input", () => {', "  const catchUpBtn =", "speed handlers");
  const handlers = {};
  const sent = [];
  const pendingTimers = [];
  const slider = {
    value: "100",
    addEventListener: (name, fn) => (handlers[name] = fn),
  };
  new Function(
    "deps",
    `const {speedSliderEl,speedStatusEl,getActiveTabId,sendSetSpeed,setTimeout,clearTimeout}=deps;
     let speedSliderDragging=false, speedSliderTimer=null, speedSliderPending=null;
     ${code}
     return {handlers:null};`
  )({
    speedSliderEl: slider,
    speedStatusEl: { textContent: "" },
    getActiveTabId: (cb) => cb(42),
    sendSetSpeed: (tabId, rate) => sent.push(rate),
    setTimeout: (fn, ms) => {
      pendingTimers.push(fn);
      return pendingTimers.length;
    },
    clearTimeout: () => {},
  });

  for (const v of ["110", "120", "130", "140"]) {
    slider.value = v;
    handlers.input();
  }
  ok("el arrastre no envía un mensaje por evento", sent.length === 0);
  handlers.change();
  ok("al soltar se envía una sola vez", sent.length === 1 && sent[0] === 1.4);
  ok("el timer quedó cancelado", pendingTimers.length === 1);
}

// 6) usedStreamIds es FIFO acotado y se limpian los listeners al soltar.
async function testOffscreenMemory() {
  let listener = null;
  const removed = [];
  class FakeAudioContext {
    constructor() {
      this.state = "running";
      this.destination = {};
    }
    createMediaStreamSource() {
      return { connect() {}, disconnect() {} };
    }
    createGain() {
      return { gain: { value: 0 }, connect() {}, disconnect() {} };
    }
    addEventListener() {}
    removeEventListener(name) {
      removed.push(name);
    }
    close() {
      return Promise.resolve();
    }
  }
  const fakeStream = () => ({
    getAudioTracks: () => [
      {
        addEventListener() {},
        removeEventListener(name) {
          removed.push(name);
        },
      },
    ],
    getTracks: () => [],
  });
  vm.runInNewContext(offscreenSrc, {
    chrome: {
      runtime: {
        id: "ext",
        onMessage: { addListener: (fn) => (listener = fn) },
      },
    },
    AudioContext: FakeAudioContext,
    navigator: { mediaDevices: { getUserMedia: async () => fakeStream() } },
    Map,
    Set,
    Number,
    String,
    Promise,
    console,
  });
  const bg = { id: "ext" };
  const call = (msg) => new Promise((resolve) => listener(msg, bg, resolve));

  // Soltamos cada captura para no chocar con MAX_AUDIO_STATES: lo que queremos
  // probar es el crecimiento del Set de ids, no el límite de AudioContexts.
  for (let i = 0; i <= 64; i++) {
    const res = await call({
      target: "nds-offscreen",
      type: "nds-offscreen-set",
      tabId: 100,
      percent: 100,
      streamId: `s-${i}`,
    });
    if (!res.ok) throw new Error(`falló la captura ${i}: ${JSON.stringify(res)}`);
    await call({ target: "nds-offscreen", type: "nds-offscreen-stop", tabId: 100 });
  }
  const reused = await call({
    target: "nds-offscreen",
    type: "nds-offscreen-set",
    tabId: 500,
    percent: 100,
    streamId: "s-0",
  });
  ok("el id más viejo se libera al superar el tope", reused.ok === true && reused.started === true);

  const stopped = await call({
    target: "nds-offscreen",
    type: "nds-offscreen-stop",
    tabId: 500,
  });
  ok(
    `al soltar la captura se remueven los listeners (${removed.slice(-4).join(",")})`,
    stopped.stopped === true && removed.indexOf("statechange") !== -1 && removed.indexOf("ended") !== -1
  );
}

(async () => {
  testLockTimer();
  testSpeedGuard();
  testStillInterval();
  testSpeedPollTargeting();
  testSliderThrottle();
  await testOffscreenMemory();
  console.log(failures === 0 ? "TODO OK" : `FALLARON ${failures}`);
  process.exitCode = failures ? 1 : 0;
})();

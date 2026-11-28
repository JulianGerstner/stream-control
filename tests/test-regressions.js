// Regresiones de los 5 arreglos funcionales posteriores a 1.5.8.
// Igual que el resto de la suite: extrae código real y lo corre en un vm.
const fs = require("fs");
const vm = require("vm");
const path = require("path");

const REPO = path.join(__dirname, "..");
const read = (name) => fs.readFileSync(path.join(REPO, name), "utf8");
const bg = read("background.js");
const hook = read("page-hook.js");
const popup = read("popup.js");
const offscreen = read("offscreen.js");

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
function run(code, sandbox) {
  vm.runInNewContext(code, sandbox, { timeout: 10000 });
}
function wait() {
  return new Promise((r) => setImmediate(r));
}

// 1) La cola no deja promesas rechazadas sin atrapar.
async function testQueue() {
  const code = slice(
    bg,
    "function enqueueForTab(tabId, task) {",
    "// ¿La pestaña ya está capturada",
    "enqueueForTab"
  );
  const perTabQueue = new Map();
  const inFlightPages = new Map();
  const api = new Function(
    "deps",
    `const { perTabQueue, inFlightPages } = deps;
     ${code}
     return { enqueueForTab };`
  )({ perTabQueue, inFlightPages });

  let unhandled = 0;
  const onUnhandled = () => unhandled++;
  process.on("unhandledRejection", onUnhandled);
  try {
    const task = api.enqueueForTab(1, () => Promise.reject(new Error("boom")));
    await task.catch(() => {});
    await wait();
    ok("una tarea que falla no genera unhandledRejection", unhandled === 0);
    ok("la cola se limpia aunque la tarea falle", !perTabQueue.has(1));
  } finally {
    process.removeListener("unhandledRejection", onUnhandled);
  }
}

// 2) pushState/query/hash no cuentan como navegación de documento.
function testNavigationPage() {
  const code = slice(
    bg,
    "function navigationPage(url) {",
    "function isFromPopup(sender) {",
    "navigationPage"
  );
  const api = new Function(
    "deps",
    `const { URL, String } = deps;
     ${code}
     return { navigationPage };`
  )({ URL, String });
  const a = api.navigationPage("https://video.example/watch?v=1#t=20");
  ok(
    "query/hash no cortan la captura",
    a === api.navigationPage("https://video.example/watch?v=9#t=300")
  );
  ok(
    "otro path sí corta la captura",
    a !== api.navigationPage("https://video.example/llamada")
  );
}

// 3) Navegar durante una activación no deja la captura creada después.
async function testNavigationRace() {
  const listeners = [];
  const committed = [];
  const sent = [];
  let releaseStream;
  let streamGate = new Promise((r) => (releaseStream = r));
  const chromeMock = {
    runtime: {
      id: "ext",
      getURL: (p) => `chrome-extension://ext/${p}`,
      onMessage: { addListener: (fn) => listeners.push(fn) },
      getContexts: async () => [],
      sendMessage: async (msg) => {
        sent.push(msg);
        return msg.type === "nds-offscreen-set"
          ? { ok: true, active: true, percent: msg.percent }
          : { ok: true };
      },
    },
    tabs: {
      get: async (id) => ({ id, url: "https://video.example/watch" }),
      onUpdated: { addListener: () => {} },
      onRemoved: { addListener: () => {} },
    },
    tabCapture: {
      getMediaStreamId: async () => streamGate,
      getCapturedTabs: async () => [],
    },
    offscreen: { createDocument: async () => {} },
    action: { setBadgeText: async () => {} },
    webNavigation: {
      onCommitted: { addListener: (fn) => committed.push(fn) },
    },
  };
  run(bg, {
    chrome: chromeMock,
    setTimeout,
    clearTimeout,
    Map,
    Number,
    String,
    URL,
    Promise,
    console,
  });

  const sender = { id: "ext", url: "chrome-extension://ext/popup.html" };
  const setPromise = new Promise((resolve) =>
    listeners[0](
      { target: "nds-background", type: "nds-volume-set", tabId: 7, percent: 150 },
      sender,
      resolve
    )
  );
  await wait();
  await wait(); // dejar que la tarea llegue al getMediaStreamId
  const navPromise = committed[0]({
    tabId: 7,
    frameId: 0,
    url: "https://video.example/otra-pagina",
  });
  releaseStream("stream-1");
  const result = await setPromise;
  await navPromise;
  ok(
    "activación en vuelo se aborta al navegar",
    result && result.reason === "navigated"
  );
  ok(
    "no se crea la captura después del stop",
    !sent.some((m) => m.type === "nds-offscreen-set")
  );

  // pushState/query/hash no disparan onCommitted en Chrome: el background ya
  // no escucha tabs.onUpdated, así que no hay evento que corte la captura.
  ok(
    "la navegación se detecta con webNavigation.onCommitted",
    committed.length === 1 && !/chrome\.tabs\.onUpdated/.test(bg)
  );
  // Un commit de iframe tampoco debe abortar la activación de la pestaña.
  streamGate = new Promise((r) => (releaseStream = r));
  const set2 = new Promise((resolve) =>
    listeners[0](
      { target: "nds-background", type: "nds-volume-set", tabId: 7, percent: 200 },
      sender,
      resolve
    )
  );
  await wait();
  await wait();
  await committed[0]({
    tabId: 7,
    frameId: 3,
    url: "https://video.example/otra-pagina",
  });
  releaseStream("stream-2");
  const result2 = await set2;
  ok("un commit de iframe no aborta la activación", result2 && result2.ok === true);
  ok(
    "esa activación sí crea la captura",
    sent.some((m) => m.type === "nds-offscreen-set" && m.tabId === 7)
  );
}

// 4) El timer reaplica locks de dash, resuelve el bitrate y poda instancias.
function testDashLockTimer() {
  const code = slice(
    hook,
    "  let lockCheckTimer = null;",
    '  // --- Detección por "duck typing"',
    "lock timer"
  );
  let nextId = 1;
  const timers = new Map();
  const lockedInstances = new Map();
  const api = new Function(
    "deps",
    `const { setInterval, clearInterval, lockedInstances, reassertShakaLock } = deps;
     ${code}
     return { ensureLockCheckTimer, dashQualityKey };`
  )({
    setInterval: (fn) => {
      const id = nextId++;
      timers.set(id, fn);
      return id;
    },
    clearInterval: (id) => timers.delete(id),
    lockedInstances,
    reassertShakaLock: () => {},
  });
  const tick = () => timers.values().next().value();

  const calls = [];
  let list = [
    { bitrate: 800000, height: 480 },
    { bitrate: 2400000, height: 720 },
  ];
  const video = { isConnected: true };
  const dash = {
    updateSettings: (s) => calls.push(s),
    setQualityFor: (kind, id) => calls.push(["quality", kind, id]),
    getBitrateInfoListFor: () => list,
    getVideoElement: () => video,
  };
  const key = api.dashQualityKey(dash, 1);
  lockedInstances.set(dash, { type: "dash", id: 1, ...key });
  api.ensureLockCheckTimer();
  tick();
  ok(
    "el timer reapaga el ABR de dash",
    calls.some(
      (c) => c.streaming && c.streaming.abr.autoSwitchBitrate.video === false
    )
  );
  ok(
    "el timer vuelve a fijar la calidad de dash",
    calls.some((c) => Array.isArray(c) && c[0] === "quality" && c[2] === 1)
  );

  // El manifest en vivo reordena la lista: el índice 1 ya no es el mismo
  // bitrate. Tiene que re-resolverlo al 2, no forzar el 1.
  list = [
    { bitrate: 500000, height: 360 },
    { bitrate: 1500000, height: 576 },
    { bitrate: 2400000, height: 720 },
  ];
  tick();
  ok(
    "re-resuelve el bitrate si el manifest reordena la lista",
    calls.some((c) => Array.isArray(c) && c[0] === "quality" && c[2] === 2)
  );

  // Un MediaPlayer destruido conserva sus métodos: se poda por el <video>
  // desconectado, no solo por la forma del objeto.
  const stale = Object.assign({}, dash, { getVideoElement: () => ({ isConnected: false }) });
  lockedInstances.set(stale, { type: "dash", id: 0 });
  tick();
  tick();
  tick();
  ok("se poda un player con el video desconectado", !lockedInstances.has(stale));

  const dead = {};
  lockedInstances.set(dead, { type: "dash", id: 6 });
  tick();
  tick();
  tick();
  ok("se poda una instancia muerta", !lockedInstances.has(dead));
}

// 5) Un timeout viejo de hlsError no reaplica un lock soltado.
function testHlsErrorTimeout() {
  const code = slice(
    hook,
    "  function attachHlsGuards(instance) {",
    "  // Chequeo periódico",
    "hls guards"
  );
  const handlers = {};
  const timeouts = [];
  const lockedInstances = new Map();
  const instance = {
    currentLevel: 3,
    on: (name, fn) => (handlers[name] = fn),
  };
  const api = new Function(
    "deps",
    `const { lockedInstances, setTimeout } = deps;
     ${code}
     return { attachHlsGuards };`
  )({
    lockedInstances,
    setTimeout: (fn) => timeouts.push(fn),
  });
  api.attachHlsGuards(instance);
  lockedInstances.set(instance, { type: "hls", id: 2 });
  handlers.hlsError();
  lockedInstances.delete(instance); // el usuario eligió Auto
  timeouts.forEach((fn) => fn());
  ok("hlsError no reaplica un lock ya soltado", instance.currentLevel === 3);
}

// 6) Space no se interpreta como el dígito 0.
function testSpaceKey() {
  const code = slice(
    popup,
    '  document.addEventListener("keydown", (e) => {',
    '  window.addEventListener("unload"',
    "keydown"
  );
  let handler = null;
  const calls = [];
  new Function(
    "deps",
    `const { document, applyVolume, VOLUME_VALUE_MAX } = deps;
     ${code}`
  )({
    document: {
      addEventListener: (name, fn) => {
        if (name === "keydown") handler = fn;
      },
    },
    applyVolume: (value, opts) => calls.push([value, opts]),
    VOLUME_VALUE_MAX: 600,
  });
  const base = {
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    target: { tagName: "BUTTON" },
    preventDefault() {},
  };
  handler(Object.assign({}, base, { key: " " }));
  ok("space no dispara applyVolume(0)", calls.length === 0);
  handler(Object.assign({}, base, { key: "3" }));
  ok(
    "la tecla 3 sigue dando 300% persistido",
    calls.length === 1 && calls[0][0] === 300 && calls[0][1].persist === true
  );
}

// 7) Cap y variante de Disney quedan scoped al título.
function testDisneyScope() {
  const code = slice(
    hook,
    '  const DISNEY_CAP_KEY = "qs-disney-cap";',
    "  // Escalera real del master",
    "disney storage"
  );
  const store = new Map();
  const sessionStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  const location = { href: "https://disney.example/title-a" };
  const api = new Function(
    "deps",
    `const { sessionStorage, location, Number, parseInt, String, URL } = deps;
     ${code}
     return {
       getDisneyCap,
       storeDisneyCap,
       getDisneyVariantKey,
       storeDisneyVariantKey,
     };`
  )({ sessionStorage, location, Number, parseInt, String, URL });

  api.storeDisneyCap(720);
  ok("el cap se guarda para el título actual", api.getDisneyCap() === 720);
  location.href = "https://disney.example/title-b";
  ok(
    "el cap no se arrastra al título siguiente",
    api.getDisneyCap() === null && !store.has("qs-disney-cap")
  );

  api.storeDisneyVariantKey("1080|2400k|avc1");
  ok(
    "la variante se guarda para el título actual",
    api.getDisneyVariantKey() === "1080|2400k|avc1"
  );
  location.href = "https://disney.example/title-c";
  ok(
    "la variante no se arrastra al título siguiente",
    api.getDisneyVariantKey() === null
  );

  store.set("qs-disney-cap", "480");
  ok(
    "un cap viejo sin href se ancla al título actual",
    api.getDisneyCap() === 480 &&
      store.get("qs-disney-cap-href") === "https://disney.example/title-c"
  );

  location.href = "https://disney.example/title-d?utm=1#capitulos";
  api.storeDisneyCap(480);
  location.href = "https://disney.example/title-d?utm=2#capitulos";
  ok(
    "query y hash no borran la preferencia dentro del mismo título",
    api.getDisneyCap() === 480
  );
  ok(
    "con escalera vacía no se descarta una preferencia válida",
    /const ladderSeen = heights\.length > 0 \|\| variants\.length > 0;/.test(
      hook
    ) && /if \(ladderSeen && cap/.test(hook)
  );
}

// 8) El badge muestra el número solo si el volumen está modificado.
async function testVolumeBadge() {
  const listeners = [];
  const committed = [];
  const badges = [];
  let status = { ok: true, active: false, percent: null };
  const chromeMock = {
    runtime: {
      id: "ext",
      getURL: (p) => `chrome-extension://ext/${p}`,
      onMessage: { addListener: (fn) => listeners.push(fn) },
      getContexts: async () => [{}],
      sendMessage: async (msg) => {
        if (msg.type === "nds-offscreen-get") return status;
        if (msg.type === "nds-offscreen-set") {
          return { ok: true, active: true, percent: msg.percent };
        }
        return { ok: true };
      },
    },
    tabs: {
      get: async (id) => ({ id, url: "https://video.example/watch" }),
      onUpdated: { addListener: () => {} },
      onRemoved: { addListener: () => {} },
    },
    tabCapture: {
      getMediaStreamId: async () => "s-badge",
      getCapturedTabs: async () => [],
    },
    offscreen: { createDocument: async () => {} },
    action: { setBadgeText: async (o) => badges.push(o.text) },
    webNavigation: {
      onCommitted: { addListener: (fn) => committed.push(fn) },
    },
  };
  run(bg, {
    chrome: chromeMock,
    setTimeout,
    clearTimeout,
    Map,
    Number,
    String,
    URL,
    Promise,
    console,
  });
  const sender = { id: "ext", url: "chrome-extension://ext/popup.html" };
  const call = (msg) =>
    new Promise((resolve) => listeners[0](msg, sender, resolve));
  const last = () => badges[badges.length - 1];

  await call({ target: "nds-background", type: "nds-volume-set", tabId: 3, percent: 150 });
  ok("150 % muestra 150 en el icono", last() === "150");
  await call({ target: "nds-background", type: "nds-volume-set", tabId: 3, percent: 100 });
  ok("volver a 100 % limpia el badge", last() === "");
  await call({ target: "nds-background", type: "nds-volume-set", tabId: 3, percent: 0 });
  ok("0 % también se muestra", last() === "0");

  status = { ok: true, active: true, percent: 250 };
  await call({ target: "nds-background", type: "nds-volume-get", tabId: 3 });
  ok("el poll restaura el número si sigue activo", last() === "250");
  status = { ok: true, active: false, percent: null };
  await call({ target: "nds-background", type: "nds-volume-get", tabId: 3 });
  ok("sin captura limpia el badge", last() === "");

  await call({ target: "nds-background", type: "nds-volume-set", tabId: 3, percent: 300 });
  await call({ target: "nds-background", type: "nds-volume-stop", tabId: 3 });
  ok("detener la captura limpia el badge", last() === "");

  await call({ target: "nds-background", type: "nds-volume-set", tabId: 3, percent: 400 });
  await committed[0]({ tabId: 3, frameId: 0, url: "https://video.example/otra" });
  ok("navegar limpia el badge", last() === "");
  ok(
    "no escribe el mismo texto dos veces seguidas",
    badges.filter((b) => b === "400").length === 1
  );
}

// 9) El bitrate de HLS se lee con ':' separador (EXT-X-STREAM-INF).
function testHlsBitrate() {
  const code = slice(
    hook,
    "  function parseDisneyStreamInf(line, uri) {",
    "  function parseDisneyVariants(text) {",
    "parseDisneyStreamInf"
  );
  const api = new Function(
    "deps",
    `const { parseInt, parseFloat, String } = deps;
     ${code}
     return { parseDisneyStreamInf };`
  )({ parseInt, parseFloat, String });
  const v = api.parseDisneyStreamInf(
    '#EXT-X-STREAM-INF:BANDWIDTH=2400000,AVERAGE-BANDWIDTH=2000000,RESOLUTION=1280x720,CODECS="avc1.64001f,mp4a.40.2"',
    "video/720.m3u8"
  );
  ok("BANDWIDTH con ':' se lee", !!v && v.bandwidth === 2400000);
  ok("AVERAGE-BANDWIDTH con ':' se lee", !!v && v.avgBandwidth === 2000000);
}

// 10) Si falla connectStream, se liberan los tracks y el streamId se reintenta.
async function testOffscreenFailure() {
  const code = slice(
    offscreen,
    '  if (msg.type === "nds-offscreen-set") {',
    '  if (msg.type === "nds-offscreen-stop") {',
    "offscreen set"
  );
  const stopped = [];
  const used = new Set();
  const states = new Map();
  const deps = {
    timers: null,
    audioStates: states,
    usedStreamIds: used,
    MAX_AUDIO_STATES: 4,
    clampVolume: (v) => v,
    getTabStream: async () => ({
      getTracks: () => [{ stop: () => stopped.push("track") }],
    }),
    connectStream: () => {
      throw new Error("AudioContext roto");
    },
    rememberStreamId: (id) => used.add(id),
    stopTab: (id) => {
      states.delete(id);
      stopped.push("state");
      return true;
    },
  };
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const run = new AsyncFunction(
    "deps",
    `const { audioStates, usedStreamIds, MAX_AUDIO_STATES, getTabStream,
             connectStream, rememberStreamId, stopTab, clampVolume, msg } = deps;
     ${code}`
  );
  const res = await run(
    Object.assign({}, deps, {
      msg: {
        type: "nds-offscreen-set",
        tabId: 4,
        percent: 150,
        streamId: "s-fail",
      },
    })
  );
  ok(
    "connectStream fallido devuelve error",
    !!res && res.ok === false && res.reason === "capture-failed"
  );
  ok(
    "se liberan los tracks y el estado parcial",
    stopped.includes("track") && stopped.includes("state")
  );
  ok("el streamId no queda consumido", used.size === 0);
}

// 11) Un solo timer de velocidad: al cambiar de <video> se detiene el anterior.
function testSingleRateTimer() {
  const code = slice(
    hook,
    "  function pinPlaybackRate(video, rate, opts) {",
    "  // Reafirmar apenas termina un seek.",
    "pinPlaybackRate"
  );
  const timers = new Map();
  const states = new Map();
  const clearInterval = (id) => timers.delete(id);
  const stopRateTick = (state) => {
    if (state.timer != null) {
      clearInterval(state.timer);
      state.timer = null;
    }
  };
  const getState = (video) => {
    if (!states.has(video))
      states.set(video, {
        desired: 1,
        timer: null,
        released: false,
        userPinned: false,
        hits: [],
      });
    return states.get(video);
  };
  const api = new Function(
    "deps",
    `const { timers, rateControlState, setInterval, clearInterval,
             getRateControlState, resetRateCounters, ensureRateGuard,
             stopRateTick, rateTick, applyRate, effectiveRateFor, RATE_CFG } = deps;
     let lastTimedRateVideo = null;
     ${code}
     return { pinPlaybackRate };`
  )({
    timers,
    rateControlState: states,
    setInterval: (fn) => {
      const id = timers.size + 1;
      timers.set(id, fn);
      return id;
    },
    clearInterval,
    getRateControlState: getState,
    resetRateCounters: (s) => {
      s.hits.length = 0;
      s.released = false;
    },
    ensureRateGuard: () => {},
    stopRateTick,
    rateTick: () => {},
    applyRate: () => {},
    effectiveRateFor: (v, s) => s.desired,
    RATE_CFG: { tickMs: 250 },
  });

  const a = { id: "video-a" };
  const b = { id: "video-b" };
  api.pinPlaybackRate(a, 2, { user: true });
  ok("el primer video tiene su timer", timers.size === 1);
  api.pinPlaybackRate(b, 2, { user: true });
  ok("solo queda un timer tras cambiar de video", timers.size === 1);
  ok(
    "se detuvo el timer del video anterior",
    states.get(a).timer === null && states.get(a).released === true
  );
  ok("el video nuevo queda defendido", states.get(b).timer != null);
}

(async () => {
  await testQueue();
  testNavigationPage();
  await testNavigationRace();
  testDashLockTimer();
  testHlsErrorTimeout();
  testSpaceKey();
  testDisneyScope();
  await testVolumeBadge();
  testHlsBitrate();
  await testOffscreenFailure();
  testSingleRateTimer();
  console.log(failures === 0 ? "TODO OK" : `FALLARON ${failures}`);
  process.exitCode = failures ? 1 : 0;
})();

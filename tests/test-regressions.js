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
  const updated = [];
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
      onUpdated: { addListener: (fn) => updated.push(fn) },
      onRemoved: { addListener: () => {} },
    },
    tabCapture: {
      getMediaStreamId: async () => streamGate,
      getCapturedTabs: async () => [],
    },
    offscreen: { createDocument: async () => {} },
    action: { setBadgeText: async () => {} },
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
  const navPromise = updated[0](7, { url: "https://video.example/otra-pagina" });
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

  // El mismo documento (query/hash) no debe abortar una activación en vuelo.
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
  await updated[0](7, { url: "https://video.example/watch?v=2#t=99" });
  releaseStream("stream-2");
  const result2 = await set2;
  ok(
    "query/hash no aborta una activación en vuelo",
    result2 && result2.ok === true
  );
  ok(
    "esa activación sí crea la captura",
    sent.some((m) => m.type === "nds-offscreen-set" && m.tabId === 7)
  );
}

// 4) El timer reaplica locks de dash y poda instancias muertas.
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
     return { ensureLockCheckTimer };`
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

  const calls = [];
  const dash = {
    updateSettings: (s) => calls.push(s),
    setQualityFor: (kind, id) => calls.push(["quality", kind, id]),
  };
  lockedInstances.set(dash, { type: "dash", id: 5 });
  api.ensureLockCheckTimer();
  timers.values().next().value();
  ok(
    "el timer reapaga el ABR de dash",
    calls.some(
      (c) => c.streaming && c.streaming.abr.autoSwitchBitrate.video === false
    )
  );
  ok(
    "el timer vuelve a fijar la calidad de dash",
    calls.some((c) => Array.isArray(c) && c[0] === "quality" && c[2] === 5)
  );

  const dead = {};
  lockedInstances.set(dead, { type: "dash", id: 6 });
  timers.values().next().value();
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
    `const { sessionStorage, location, Number, parseInt, String } = deps;
     ${code}
     return {
       getDisneyCap,
       storeDisneyCap,
       getDisneyVariantKey,
       storeDisneyVariantKey,
     };`
  )({ sessionStorage, location, Number, parseInt, String });

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
      store.get("qs-disney-cap-href") === location.href
  );
}

// 8) El badge muestra el número solo si el volumen está modificado.
async function testVolumeBadge() {
  const listeners = [];
  const updated = [];
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
      onUpdated: { addListener: (fn) => updated.push(fn) },
      onRemoved: { addListener: () => {} },
    },
    tabCapture: {
      getMediaStreamId: async () => "s-badge",
      getCapturedTabs: async () => [],
    },
    offscreen: { createDocument: async () => {} },
    action: { setBadgeText: async (o) => badges.push(o.text) },
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
  await updated[0](3, { url: "https://video.example/otra" });
  ok("navegar limpia el badge", last() === "");
  ok(
    "no escribe el mismo texto dos veces seguidas",
    badges.filter((b) => b === "400").length === 1
  );
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
  console.log(failures === 0 ? "TODO OK" : `FALLARON ${failures}`);
  process.exitCode = failures ? 1 : 0;
})();

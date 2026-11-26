// Tests de regresión de los 6 arreglos de seguridad de 1.5.4.
// Carga los scripts reales en un VM con mocks mínimos de Chrome/DOM.
const fs = require("fs");
const vm = require("vm");
const path = require("path");

const REPO = path.join(__dirname, "..");
let failures = 0;
function ok(name, cond) {
  console.log(`${cond ? "PASS" : "FAIL"} | ${name}`);
  if (!cond) failures++;
}
function read(name) {
  return fs.readFileSync(path.join(REPO, name), "utf8");
}
function run(code, sandbox) {
  vm.runInNewContext(code, sandbox, { timeout: 10000 });
}
function wait() {
  return new Promise((r) => setImmediate(r));
}

class FakeCustomEvent {
  constructor(type, opts) {
    this.type = type;
    this.detail = opts && opts.detail;
  }
}

// ---------------------------------------------------------------- bridge.js
async function testBridge() {
  const handlers = {};
  const dispatched = [];
  const chromeMock = {
    runtime: {
      id: "ext",
      getURL: (p) => `chrome-extension://ext/${p}`,
      onMessage: { addListener: (fn) => (bridgeListener = fn) },
    },
  };
  let bridgeListener = null;
  const win = {
    addEventListener: (n, fn) => {
      (handlers[n] = handlers[n] || []).push(fn);
    },
    removeEventListener: (n, fn) => {
      handlers[n] = (handlers[n] || []).filter((f) => f !== fn);
    },
    dispatchEvent: (e) => {
      dispatched.push(e);
      return true;
    },
  };
  run(read("bridge.js"), {
    chrome: chromeMock,
    window: win,
    CustomEvent: FakeCustomEvent,
    setTimeout: () => 0,
    console,
  });

  const validSender = { id: "ext", url: "chrome-extension://ext/popup.html" };
  let responses = [];
  bridgeListener(
    { target: "nds-bridge", type: "get-qualities", requestId: "r1" },
    validSender,
    (res) => responses.push(res)
  );
  ok(
    "bridge acepta mensaje del popup y despacha el pedido",
    dispatched.length === 1 &&
      dispatched[0].type === "qs-request-qualities" &&
      dispatched[0].detail.requestId === "r1"
  );

  // Un script de la página puede despachar respuestas falsas: solo sirve la
  // que coincide con el requestId de este pedido.
  handlers["qs-qualities-response"].forEach((fn) =>
    fn({ detail: { found: true, requestId: "otro", qualities: [] } })
  );
  ok("bridge ignora respuesta con requestId ajeno", responses.length === 0);
  handlers["qs-qualities-response"].forEach((fn) =>
    fn({ detail: { found: true, requestId: "r1", qualities: [] } })
  );
  ok("bridge acepta respuesta con el requestId correcto", responses.length === 1);

  responses = [];
  dispatched.length = 0;
  bridgeListener(
    { target: "nds-bridge", type: "get-qualities", requestId: "r2" },
    { id: "ext", url: "https://evil.example" },
    (res) => responses.push(res)
  );
  ok("bridge rechaza mensaje de otro origen", dispatched.length === 0);

  responses = [];
  bridgeListener(
    { target: "nds-bridge", type: "set-speed", rate: "1e9", requestId: "r3" },
    validSender,
    (res) => responses.push(res)
  );
  ok(
    "bridge rechaza velocidad fuera de rango",
    responses.length === 1 && responses[0].reason === "invalid-rate"
  );
}

// ------------------------------------------------------------ offscreen.js
async function testOffscreen() {
  let listener = null;
  const chromeMock = {
    runtime: {
      id: "ext",
      onMessage: { addListener: (fn) => (listener = fn) },
    },
  };
  const fakeGain = { gain: { value: 0 }, connect() {}, disconnect() {} };
  class FakeAudioContext {
    constructor() {
      this.state = "running";
      this.destination = {};
    }
    createMediaStreamSource() {
      return { connect() {}, disconnect() {} };
    }
    createGain() {
      return fakeGain;
    }
    addEventListener() {}
    close() {
      return Promise.resolve();
    }
  }
  const fakeStream = () => ({
    getAudioTracks: () => [{ addEventListener() {} }],
    getTracks: () => [],
  });
  run(read("offscreen.js"), {
    chrome: chromeMock,
    AudioContext: FakeAudioContext,
    navigator: { mediaDevices: { getUserMedia: async () => fakeStream() } },
    Map,
    Set,
    Number,
    String,
    Promise,
    console,
  });

  const bg = { id: "ext" }; // background: mismo id, sin sender.tab
  // Un content script comprometido corre en un renderer de página: tiene tab.
  const contentScript = { id: "ext", tab: { id: 9 }, url: "https://evil.example" };
  const call = (msg, sender) =>
    new Promise((resolve) => listener(msg, sender, resolve));

  let r = await call(
    { target: "nds-offscreen", type: "nds-offscreen-get", tabId: 1 },
    contentScript
  );
  ok("offscreen rechaza mensaje de un content script", r.reason === "unknown");

  r = await call(
    { target: "nds-offscreen", type: "nds-offscreen-get", tabId: "1" },
    bg
  );
  ok("offscreen rechaza tabId no entero", r.reason === "invalid-tab");

  r = await call(
    {
      target: "nds-offscreen",
      type: "nds-offscreen-set",
      tabId: 1,
      percent: 100,
      streamId: "",
    },
    bg
  );
  ok("offscreen rechaza streamId vacío", r.reason === "invalid-stream");

  r = await call(
    {
      target: "nds-offscreen",
      type: "nds-offscreen-set",
      tabId: 1,
      percent: 100,
      streamId: "s-1",
    },
    bg
  );
  ok("offscreen acepta streamId válido", r.ok === true && r.started === true);

  r = await call(
    {
      target: "nds-offscreen",
      type: "nds-offscreen-set",
      tabId: 2,
      percent: 100,
      streamId: "s-1",
    },
    bg
  );
  ok("offscreen no reutiliza un streamId", r.reason === "invalid-stream");
}

// ----------------------------------------------------------- background.js
async function testBackground() {
  const runtimeListeners = [];
  const updatedListeners = [];
  const sentToOffscreen = [];
  const chromeMock = {
    runtime: {
      id: "ext",
      getURL: (p) => `chrome-extension://ext/${p}`,
      onMessage: { addListener: (fn) => runtimeListeners.push(fn) },
      getContexts: async () => [{}],
      sendMessage: async (msg) => {
        sentToOffscreen.push(msg);
        return { ok: true };
      },
    },
    tabs: {
      get: async (id) => ({ id, url: "https://video.example/watch" }),
      onUpdated: { addListener: (fn) => updatedListeners.push(fn) },
      onRemoved: { addListener: () => {} },
    },
    tabCapture: {
      getMediaStreamId: async () => "stream-1",
      getCapturedTabs: async () => [],
    },
    offscreen: { createDocument: async () => {} },
    action: { setBadgeText: async () => {} },
  };
  run(read("background.js"), {
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

  const validSender = { id: "ext", url: "chrome-extension://ext/popup.html" };
  const call = (msg, sender) =>
    new Promise((resolve) => runtimeListeners[0](msg, sender, resolve));

  let r = await call(
    { target: "nds-background", type: "nds-volume-set", tabId: 7, percent: 100 },
    { id: "ext", url: "https://evil.example" }
  );
  ok("background rechaza comando que no viene del popup", r.reason === "unknown");

  r = await call(
    { target: "nds-background", type: "nds-volume-set", tabId: 7, percent: 100 },
    validSender
  );
  ok("background acepta comando del popup", r.ok === true);

  const before = sentToOffscreen.length;
  await updatedListeners[0](7, { url: "https://otro.example/llamada" }, {});
  await wait();
  const stop = sentToOffscreen
    .slice(before)
    .find(
      (m) => m.type === "nds-offscreen-stop" && m.tabId === 7
    );
  ok("background suelta la captura al navegar", !!stop);

  r = await call(
    { target: "nds-background", type: "nds-volume-set", tabId: 7, percent: 100 },
    validSender
  );
  const started = sentToOffscreen.some(
    (m) => m.type === "nds-offscreen-set" && m.streamId && m.tabId === 7
  );
  ok("background pide un streamId nuevo tras navegar", r.ok === true && started);
}

// --------------------------------------------------- popup / page-hook (estático)
function testStatic() {
  const popup = read("popup.js");
  const hook = read("page-hook.js");
  ok("popup valida números antes de .toFixed()", /finiteNumber\(info\.delaySeconds/.test(popup) && /finiteNumber\(res\.jumpSeconds/.test(popup));
  ok("popup no conserva una pestaña vieja", !/volumeTab/.test(popup));
  ok("page-hook hace eco del requestId en las 4 respuestas", (hook.match(/detail\.requestId = requestId|result\.requestId = requestId|requestId \}\)/g) || []).length >= 4);
  ok("Disney+ agrupa las recargas", /scheduleDisneyReload/.test(hook));
  const ivsIndex = hook.indexOf('Object.defineProperty(window, "IVSPlayer"');
  const twitchGateIndex = hook.indexOf("if (isTwitchHost()) {", 2000);
  ok(
    "IVSPlayer solo se parchea en Twitch",
    ivsIndex > twitchGateIndex &&
      hook.indexOf("if (isTwitchHost()) {", 2000) <
        hook.indexOf("function twitchLooksLikePlayer")
  );
}

(async () => {
  await testBridge();
  await testOffscreen();
  await testBackground();
  testStatic();
  console.log(failures === 0 ? "TODO OK" : `FALLARON ${failures}`);
  process.exitCode = failures ? 1 : 0;
})();

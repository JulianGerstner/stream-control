// Test del bloque "¿Sigues viendo?" sin Chrome: extrae el código real de
// page-hook.js y lo corre con un DOM mínimo.
const fs = require("fs");
const vm = require("vm");
const path = require("path");

const REPO = path.join(__dirname, "..");
const src = fs.readFileSync(path.join(REPO, "page-hook.js"), "utf8");
const START = '  // --- Cartel "¿Sigues viendo?" de YouTube / YouTube Music ---';
const END = "  // --- Puente de comunicación con el content script aislado (bridge.js) ---";
const i = src.indexOf(START);
const j = src.indexOf(END, i);
if (i < 0 || j < 0) throw new Error("no se encontró el bloque");
const block = src.slice(i, j);

let failures = 0;
function ok(name, cond) {
  console.log(`${cond ? "PASS" : "FAIL"} | ${name}`);
  if (!cond) failures++;
}

function makeEl(opts) {
  const e = {
    id: opts.id || "",
    innerText: opts.text || "",
    textContent: opts.text || "",
    attrs: opts.attrs || {},
    children: opts.children || [],
    selectors: opts.selectors || [],
    clicks: 0,
    getAttribute(n) {
      return this.attrs[n] || "";
    },
    getBoundingClientRect() {
      return { width: 320, height: 180 };
    },
    getClientRects() {
      return [{ width: 320, height: 180 }];
    },
    matches(sel) {
      return sel
        .split(",")
        .some((s) => this.selectors.indexOf(s.trim()) !== -1);
    },
    querySelectorAll(sel) {
      const out = [];
      const parts = sel.split(",").map((s) => s.trim());
      const visit = (nodes) => {
        nodes.forEach((n) => {
          if (sel === "*" || parts.some((p) => n.selectors.indexOf(p) !== -1)) {
            out.push(n);
          }
          visit(n.children);
        });
      };
      visit(this.children);
      return out;
    },
    click() {
      this.clicks++;
    },
  };
  return e;
}

function collect(nodes, out, filter) {
  nodes.forEach((n) => {
    if (!filter || filter(n)) out.push(n);
    collect(n.children, out, filter);
  });
}

function scenario(opts) {
  const video = { paused: opts.videoPaused !== false, ended: false, currentSrc: "v", play() { this.paused = false; return Promise.resolve(); } };
  const confirmBtn = makeEl({
    id: opts.confirmId || "confirm-button",
    text: opts.confirmText || "Yes, keep watching",
    selectors: ["button"],
  });
  const noBtn = makeEl({ text: "No", selectors: ["button"] });
  const dialog = makeEl({
    text: opts.dialogText || "Video paused. Continue watching?",
    selectors: opts.dialogSelectors || ["ytd-confirm-dialog-renderer", 'role="dialog"'],
    children: [noBtn, confirmBtn],
  });
  const allNodes = [];
  collect([dialog], allNodes);

  const doc = {
    readyState: "complete",
    documentElement: makeEl({ selectors: ["html"] }),
    addEventListener() {},
    querySelectorAll(sel) {
      if (sel === "*") return allNodes.slice();
      const parts = sel.split(",").map((s) => s.trim());
      // El test usa selectores de etiqueta simples en el mock.
      return allNodes.filter((n) => parts.some((p) => n.selectors.indexOf(p) !== -1));
    },
  };

  const storage = new Map();
  if (opts.optOut) storage.set("qs-still-watching", "off");
  const win = {};
  win.top = win;
  win.addEventListener = () => {};

  class MutationObserver {
    constructor() {}
    observe() {}
  }

  const sandbox = {
    document: doc,
    window: win,
    location: { hostname: opts.host || "www.youtube.com" },
    localStorage: {
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, v),
    },
    MutationObserver,
    setInterval: () => 1,
    setTimeout: (fn) => {
      fn();
      return 1;
    },
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
    resolveVideoElement: () => video,
    isRealMediaElement: () => true,
    collectVideosDeep: (root, out) => {
      out.push(video);
    },
  };
  vm.runInNewContext(block, sandbox, { timeout: 5000 });
  return {
    debug: win.__qsStillWatchingDebug(),
    video,
    confirmBtn,
    noBtn,
  };
}

// 1. YouTube: diálogo con #confirm-button y video pausado.
let r = scenario({});
ok("YouTube detecta el diálogo y llama a __qsStillWatchingDebug", r.debug.enabled === true);
ok("YouTube hace click en el botón de confirmar", r.debug.clicks === 1 && r.confirmBtn.clicks === 1);
ok("YouTube no toca el botón 'No'", r.noBtn.clicks === 0);
ok("YouTube reanuda el video", r.debug.resumes >= 1 && r.video.paused === false);

// 2. YouTube Music: ytmusic-you-there-renderer + #button.
r = scenario({
  host: "music.youtube.com",
  dialogText: "Are you still listening?",
  dialogSelectors: ["ytmusic-you-there-renderer"],
  confirmId: "button",
  confirmText: "Yes",
});
ok("YouTube Music confirma y reanuda", r.debug.clicks === 1 && r.video.paused === false);

// 3. Español sin id: botón "Sí, seguir viendo", hay que elegirlo por texto.
r = scenario({
  dialogText: "Video pausado. ¿Sigues viendo?",
  confirmId: "",
  confirmText: "Sí, seguir viendo",
});
ok("Reconoce 'Sí, seguir viendo' en español", r.debug.clicks === 1 && r.confirmBtn.clicks === 1);
ok("En español tampoco toca 'No'", r.noBtn.clicks === 0);

// 4. Otro sitio: no se instala nada.
r = scenario({ host: "www.twitch.tv" });
ok("No se activa fuera de YouTube", r.debug.enabled === false && r.debug.clicks === 0);

// 5. Opt-out.
r = scenario({ optOut: true });
ok("Respeta qs-still-watching=off", r.debug.enabled === false && r.debug.clicks === 0);

// 6. Un diálogo que no es el cartel no se toca.
r = scenario({ dialogText: "¿Salir de la página?" });
ok("Ignora otros diálogos", r.debug.clicks === 0 && r.video.paused === true);

// 7. Video ya reproduciéndose: no cuenta un resume innecesario.
r = scenario({ videoPaused: false });
ok("No reanuda si el video ya estaba andando", r.debug.clicks === 1 && r.debug.resumes === 0);

console.log(failures === 0 ? "TODO OK" : `FALLARON ${failures}`);
process.exitCode = failures ? 1 : 0;

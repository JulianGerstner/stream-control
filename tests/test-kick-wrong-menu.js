// Simula el bug reportado: el primer botón con aria-haspopup="menu" abre
// subtítulos y el de ajustes está más a la izquierda. El adapter debe cerrar
// el menú equivocado y probar el siguiente candidato.
const fs = require("fs");
const path = require("path");
const src = fs.readFileSync(
  path.join(__dirname, "..", "page-hook.js"),
  "utf8"
);

function sliceBetween(startMark, endMark) {
  const a = src.indexOf(startMark);
  if (a < 0) throw new Error("start not found: " + startMark);
  const b = src.indexOf(endMark, a);
  if (b < 0) throw new Error("end not found: " + endMark);
  return src.slice(a, b);
}
function extractFn(name) {
  const start = src.indexOf("function " + name + "(");
  let i = src.indexOf("{", start);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
}
const kickBlock = sliceBetween(
  "  // --- Kick: calidad a través del menú ARIA del player",
  "  // Recorre las propiedades de window en profundidad limitada"
);
const helpers =
  extractFn("qualityHeightFromLabel") + "\n" + extractFn("sortQualitiesDesc");

class El {
  constructor(tag, attrs = {}, text = "", parent = null) {
    this.tagName = tag.toUpperCase();
    this.attrs = attrs;
    this.textContent = text;
    this.parentElement = parent;
    this.children = [];
    this.handlers = {};
    this.isConnected = true;
    this.hidden = false;
    this.rect = { left: 0, top: 0, right: 640, bottom: 360, width: 640, height: 360 };
    if (parent) parent.children.push(this);
  }
  getAttribute(n) {
    return Object.prototype.hasOwnProperty.call(this.attrs, n) ? this.attrs[n] : null;
  }
  setAttribute(n, v) {
    this.attrs[n] = v;
  }
  getBoundingClientRect() {
    return this.rect;
  }
  getClientRects() {
    return this.hidden ? [] : [this.rect];
  }
  closest(sel) {
    let n = this;
    while (n) {
      if (matches(n, sel)) return n;
      n = n.parentElement;
    }
    return null;
  }
  querySelectorAll(sel) {
    const out = [];
    const walk = (n) => {
      n.children.forEach((c) => {
        if (matches(c, sel)) out.push(c);
        walk(c);
      });
    };
    walk(this);
    return out;
  }
  querySelector(sel) {
    return this.querySelectorAll(sel)[0] || null;
  }
  addEventListener(t, fn) {
    (this.handlers[t] = this.handlers[t] || []).push(fn);
  }
  dispatchEvent(ev) {
    let n = this;
    ev.target = ev.target || this;
    while (n) {
      (n.handlers[ev.type] || []).forEach((fn) => fn(ev));
      if (!ev.bubbles) break;
      n = n.parentElement;
    }
    return true;
  }
}
function matches(el, sel) {
  return sel.split(",").some((part) => {
    part = part.trim();
    const m = /^([a-zA-Z0-9-]*)(?:\[([a-zA-Z-]+)="([^"]*)"\])?$/.exec(part);
    if (!m) return false;
    if (m[1] && el.tagName !== m[1].toUpperCase()) return false;
    if (m[2] && el.getAttribute(m[2]) !== m[3]) return false;
    return true;
  });
}

class PointerEventStub {
  constructor(type, init) {
    Object.assign(this, init || {});
    this.type = type;
  }
}

function build() {
  let captionsOpen = false;
  let settingsOpen = false;
  const body = new El("body");
  const player = new El("video-player", {}, "", body);
  const video = new El("video", {}, "", player);
  video.rect = { left: 0, top: 0, right: 640, bottom: 360, width: 640, height: 360 };

  // Sin nombre (como en Kick real): solo aria-haspopup.
  const captions = new El(
    "button",
    { "aria-haspopup": "menu" },
    "",
    player
  );
  // Más cerca de la esquina inferior derecha que ajustes: el orden por
  // posición lo elige primero, reproduciendo el bug.
  captions.rect = { left: 470, top: 320, right: 494, bottom: 344, width: 24, height: 24 };
  const settings = new El("button", { "aria-haspopup": "menu" }, "", player);
  settings.rect = { left: 400, top: 320, right: 424, bottom: 344, width: 24, height: 24 };

  // Menú de subtítulos: no tiene opciones con forma de calidad.
  const captionsMenu = new El("div", { role: "menu" }, "", body);
  const captionsItem = new El("div", { role: "menuitem" }, "Español", captionsMenu);
  const captionsItem2 = new El("div", { role: "menuitem" }, "Desactivado", captionsMenu);
  captionsMenu.hidden = true;
  captionsItem.hidden = true;
  captionsItem2.hidden = true;
  captions.addEventListener("click", () => {
    captionsOpen = !captionsOpen;
    captionsMenu.hidden = !captionsOpen;
    captionsItem.hidden = !captionsOpen;
    captionsItem2.hidden = !captionsOpen;
  });

  // Menú de calidades.
  const labels = ["Auto", "160p", "360p", "480p", "720p60", "1080p60"];
  const items = labels.map((label) => {
    const el = new El(
      "div",
      {
        role: "menuitemradio",
        "aria-checked": label === "720p60" ? "true" : "false",
      },
      label,
      body
    );
    el.hidden = true;
    el.addEventListener("click", () => {
      items.forEach((i) => i.setAttribute("aria-checked", "false"));
      el.setAttribute("aria-checked", "true");
      settingsOpen = false;
      items.forEach((i) => (i.hidden = true));
    });
    return el;
  });
  settings.addEventListener("click", () => {
    settingsOpen = !settingsOpen;
    items.forEach((i) => (i.hidden = !settingsOpen));
  });

  const document = {
    querySelectorAll: (s) => body.querySelectorAll(s),
    querySelector: (s) => body.querySelector(s),
    dispatchEvent: () => true,
  };
  const factory = new Function(
    "window",
    "document",
    "location",
    "PointerEvent",
    "MouseEvent",
    "KeyboardEvent",
    "setTimeout",
    "const isRealMediaElement = (el) => !!el && el.tagName === 'VIDEO';\n" +
      kickBlock +
      "\n" +
      helpers +
      "\nreturn { kickScanQualities, kickSetQuality, getKickQualities, cache: () => kickQualityCache, fail: () => kickLastFail, order: (v) => kickCogOrder(v) };"
  );
  const api = factory(
    {},
    document,
    { href: "https://kick.com/canal", hostname: "kick.com" },
    PointerEventStub,
    PointerEventStub,
    PointerEventStub,
    setTimeout
  );
  return {
    api,
    video,
    captions,
    settings,
    isCaptionsOpen: () => captionsOpen,
    isSettingsOpen: () => settingsOpen,
  };
}

(async () => {
  const { api, video, captions, settings, isCaptionsOpen, isSettingsOpen } =
    build();
  const order = api.order(video);
  console.log(
    "orden:",
    order.map((el) => (el === captions ? "subtitulos" : el === settings ? "ajustes" : "?"))
  );
  const list = await api.kickScanQualities();
  console.log("scan:", list.map((q) => q.label + (q.active ? "*" : "")));
  console.log("subtitulos abierto?", isCaptionsOpen());
  console.log("ajustes abierto?", isSettingsOpen());
  console.log("fail:", api.fail());
  const ok = await api.kickSetQuality("1080p60");
  console.log(
    "set 1080p60:",
    ok,
    api.cache().list.filter((q) => q.active).map((q) => q.label)
  );
  const pass =
    order[0] === captions &&
    list.length === 6 &&
    list.some((q) => q.label === "1080p60") &&
    !isCaptionsOpen() &&
    !isSettingsOpen() &&
    ok;
  console.log(pass ? "PASS" : "FAIL");
})();

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

/* ---------- DOM mínimo con soporte de selectores compuestos ---------- */
class El {
  constructor(tag, attrs = {}, text = "", parent = null) {
    this.tagName = tag.toUpperCase();
    this.attrs = attrs;
    this.textContent = text;
    this.parentElement = parent;
    this.children = [];
    this.isConnected = true;
    this.hidden = false;
    this.rect = { left: 0, top: 0, right: 20, bottom: 20, width: 20, height: 20 };
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
}

function parseCompound(part) {
  part = part.trim();
  const m = /^([a-zA-Z0-9-]*)(.*)$/.exec(part);
  const tag = m[1];
  const attrs = [];
  const re = /\[([a-zA-Z-]+)(?:="([^"]*)")?\]/g;
  let a;
  while ((a = re.exec(m[2]))) attrs.push({ name: a[1], value: a[2] });
  return { tag, attrs };
}

function matches(el, sel) {
  return String(sel)
    .split(",")
    .some((part) => {
      const { tag, attrs } = parseCompound(part);
      if (tag && el.tagName !== tag.toUpperCase()) return false;
      return attrs.every((a) => {
        const val = el.getAttribute(a.name);
        if (val == null) return false;
        return a.value === undefined ? true : val === a.value;
      });
    });
}

function build(buttons) {
  const body = new El("body");
  const player = new El("video-player", {}, "", body);
  const video = new El("video", {}, "", player);
  video.rect = { left: 0, top: 0, right: 640, bottom: 360, width: 640, height: 360 };
  const els = buttons.map((b) => {
    const btn = new El("button", b.attrs || {}, b.text || "", player);
    btn.rect = {
      left: b.x,
      top: b.y,
      right: b.x + 24,
      bottom: b.y + 24,
      width: 24,
      height: 24,
    };
    if (b.icon) {
      const svg = new El("svg", { "data-ds-icon": b.icon }, "", btn);
      svg.rect = btn.rect;
    }
    return btn;
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
      "\nreturn { kickSettingsButton, kickCogCandidates, kickCogOrder, kickIsCaptionButton };"
  );
  const api = factory(
    {},
    document,
    { href: "https://kick.com/canal", hostname: "kick.com" },
    function () {},
    function () {},
    function () {},
    setTimeout
  );
  return { api, video, els, body };
}

function label(btn) {
  return btn ? `${btn.getAttribute("aria-label") || btn.textContent || "?"}` : "null";
}

const scenarios = [
  {
    name: "subtítulos primero en el DOM, ajustes con nombre",
    buttons: [
      { attrs: { "aria-haspopup": "menu", "aria-label": "Captions" }, x: 400, y: 320 },
      { attrs: { "aria-haspopup": "menu", "aria-label": "Settings" }, x: 470, y: 320 },
      { attrs: { "aria-label": "Fullscreen" }, x: 580, y: 320 },
    ],
    expect: "Settings",
  },
  {
    name: "todos sin nombre, ajustes por posición",
    buttons: [
      { attrs: { "aria-haspopup": "menu", "aria-label": "CC" }, x: 400, y: 320 },
      { attrs: { "aria-haspopup": "menu" }, x: 470, y: 320 },
      { attrs: { "aria-label": "Fullscreen" }, x: 580, y: 320 },
    ],
    expect: null,
  },
  {
    name: "ajustes con ícono, sin haspopup",
    buttons: [
      { attrs: { "aria-haspopup": "menu", "aria-label": "Subtitles" }, x: 400, y: 320 },
      { attrs: { "aria-label": "" }, icon: "Settings", x: 470, y: 320 },
    ],
    expect: null,
  },
  {
    name: "solo subtítulos y pantalla completa",
    buttons: [
      { attrs: { "aria-haspopup": "menu", "aria-label": "CC" }, x: 400, y: 320 },
      { attrs: { "aria-label": "Fullscreen" }, x: 580, y: 320 },
    ],
    expect: "null",
  },
];

for (const s of scenarios) {
  const { api, video, els } = build(s.buttons);
  const picked = api.kickSettingsButton(video);
  const got = label(picked);
  const expected =
    s.expect === "Settings"
      ? "Settings"
      : s.expect === "null"
      ? "null"
      : null;
  const pass =
    s.name.includes("por posición")
      ? picked === els[1]
      : s.name.includes("ícono")
      ? picked === els[1]
      : got === expected;
  console.log(`${pass ? "PASS" : "FAIL"} | ${s.name} -> ${got}`);
}

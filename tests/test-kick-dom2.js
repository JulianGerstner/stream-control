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

function build(labelSet, hideCog) {
  let menuOpen = false;
  const body = new El("body");
  const player = new El("video-player", {}, "", body);
  const video = new El("video", {}, "", player);
  const cog = new El(
    "button",
    { "aria-haspopup": "menu", "aria-label": "Settings" },
    "",
    player
  );
  if (hideCog) { player.children = player.children.filter((c) => c !== cog); cog.isConnected = false; }
  const items = labelSet.map((label) => {
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
      menuOpen = false;
      items.forEach((i) => (i.hidden = true));
    });
    return el;
  });
  cog.addEventListener("click", () => {
    menuOpen = !menuOpen;
    items.forEach((i) => (i.hidden = !menuOpen));
  });
  const document = {
    querySelectorAll: (s) => body.querySelectorAll(s),
    querySelector: (s) => body.querySelector(s),
    dispatchEvent: () => true,
  };
  const window = {};
  const location = { href: "https://kick.com/canal", hostname: "kick.com" };
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
      "\nreturn { kickScanQualities, kickSetQuality, getKickQualities, cache: () => kickQualityCache };"
  );
  return {
    api: factory(
      window,
      document,
      location,
      PointerEventStub,
      PointerEventStub,
      PointerEventStub,
      setTimeout
    ),
    isOpen: () => menuOpen,
    items,
  };
}

(async () => {
  console.log("== normal ==");
  {
    const { api, isOpen } = build(
      ["Auto", "160p", "360p", "480p", "720p60", "1080p60"],
      false
    );
    const list = await api.kickScanQualities();
    console.log("scan:", list.map((q) => q.label + (q.active ? "*" : "")));
    console.log("menu open?", isOpen());
    const ok = await api.kickSetQuality("1080p60");
    console.log(
      "set 1080p60:",
      ok,
      api.cache().list.filter((q) => q.active).map((q) => q.label)
    );
  }

  console.log("== sin engranaje ==");
  {
    const { api } = build(["1080p60", "720p60"], true);
    const t0 = Date.now();
    const list = await api.kickScanQualities();
    console.log("scan:", list, "ms:", Date.now() - t0);
    const viaGet = await api.getKickQualities();
    console.log("get:", viaGet.map((q) => q.label + (q.active ? "*" : "")));
  }

  console.log("== Auto compuesto ==");
  {
    const { api } = build(["Auto (720p60)", "720p60", "480p", "360p"], false);
    const list = await api.kickScanQualities();
    console.log("scan:", list.map((q) => q.label));
    const viaGet = await api.getKickQualities();
    console.log("get:", viaGet.map((q) => q.label + (q.active ? "*" : "")));
    const ok = await api.kickSetQuality("auto");
    console.log(
      "set auto:",
      ok,
      api.cache().list.filter((q) => q.active).map((q) => q.label)
    );
  }
})();


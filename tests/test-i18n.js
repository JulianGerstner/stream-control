const fs = require("fs");
const path = require("path");
const vm = require("vm");

const dir = path.join(__dirname, "..") + path.sep;
const read = (f) => fs.readFileSync(dir + f, "utf8");
let failures = 0;
function ok(name, cond) {
  if (cond) {
    console.log("PASS | " + name);
  } else {
    failures++;
    console.log("FAIL | " + name);
  }
}

// chrome.i18n puede devolver el mensaje con $1 sin sustituir. t() debe
// rellenarlo igual, tanto sobre el valor localizado como sobre el fallback.
const popup = read("popup.js");
const match = popup.match(/function fillI18n\(text, subs\) \{[\s\S]*?\n\}/);
ok("popup expone fillI18n", !!match);
let fill = null;

if (match) {
  fill = vm.runInNewContext("(" + match[0] + ")");
  ok("rellena $1 con el buffer real", fill("$1 s buffer", ["3.2"]) === "3.2 s buffer");
  ok(
    "rellena varios marcadores",
    fill("Tope: $1p ($2p)", [1080, 2160]) === "Tope: 1080p (2160p)"
  );
  ok(
    "no modifica textos sin marcadores",
    fill("Captura activa") === "Captura activa"
  );
}

ok(
  "t() rellena marcadores sobre el valor y el fallback",
  /return fillI18n\(value \|\| fallback, subs\)/.test(popup) &&
    /return fillI18n\(fallback, subs\)/.test(popup)
);

// Simulamos el caso reportado: chrome.i18n devuelve "$1 s buffer" sin tocar.
const tMatch = popup.match(/  function t\(key, fallback, subs\) \{[\s\S]*?\n  \}/);
ok("popup expone t()", !!tMatch);
if (tMatch) {
  const fakeChrome = {
    i18n: { getMessage: () => "$1 s buffer" },
  };
  const t = vm.runInNewContext("(" + tMatch[0].trim() + ")", {
    chrome: fakeChrome,
    fillI18n: fill,
  });
  ok(
    "t() devuelve el buffer real aunque i18n no sustituya",
    t("bufferMeta", "$1 s buffer", ["3.2"]) === "3.2 s buffer"
  );
}

const es = JSON.parse(read("_locales/es/messages.json"));
const en = JSON.parse(read("_locales/en/messages.json"));
const esKeys = Object.keys(es);
const enKeys = Object.keys(en);
ok(
  "locales tienen las mismas claves",
  esKeys.length === enKeys.length && esKeys.every((k) => k in en)
);
ok(
  "los textos de delay/buffer existen en ambos idiomas",
  !!es.bufferMeta && !!en.bufferMeta && !!es.delayMeta && !!en.delayMeta
);

console.log(failures === 0 ? "TODO OK" : `FALLARON ${failures}`);
process.exitCode = failures ? 1 : 0;

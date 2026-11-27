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

// Chrome convierte una sustitución inexistente en cadena vacía. Los textos
// diferidos se piden con el marcador como sustitución para que page-hook pueda
// rellenarlos después.
const localeEs = JSON.parse(read("_locales/es/messages.json"));
const chromeSinSubs = {
  i18n: {
    getMessage: (key, subs) => {
      const msg = localeEs[key];
      const text = msg ? msg.message : "";
      return text.replace(/\$(\d)/g, (all, n) => {
        const value = subs && subs[Number(n) - 1];
        return value == null ? "" : String(value);
      });
    },
  },
};
if (tMatch) {
  const tChrome = vm.runInNewContext("(" + tMatch[0].trim() + ")", {
    chrome: chromeSinSubs,
    fillI18n: fill,
  });
  ok(
    "chrome.i18n vacía $1 cuando no hay sustitución",
    tChrome("capGeneric", "Tope: $1p") === "Tope: p"
  );
  ok(
    "UI_STRINGS preserva $1 para rellenarlo en page-hook",
    tChrome("capGeneric", "Tope: $1p", ["$1"]) === "Tope: $1p"
  );
  ok(
    "UI_STRINGS preserva varios marcadores",
    tChrome("capBlocked", "Tope: $1p ($2p bloqueado)", ["$1", "$2"]) ===
      "Tope: $1p ($2p bloqueado)"
  );
}

const deferredKeys = [
  "noticeKickFail",
  "capBlocked",
  "capAccount",
  "capKick",
  "capGeneric",
  "autoMin",
  "diagMissing",
  "diagFailed",
];
ok(
  "todas las claves diferidas pasan sus marcadores",
  deferredKeys.every((key) => {
    const line = popup.split("\n").find((l) => l.includes(`${key}: t(`));
    return !!line && /\[\s*"\$1"/.test(line);
  })
);

// dB: la ganancia es lineal, así que 100 % = 0 dB y 200 % = +6 dB.
const dbMatch = popup.match(/function percentToDb\(percent, lang\) \{[\s\S]*?\n\}/);
ok("popup expone percentToDb", !!dbMatch);
if (dbMatch) {
  const toDb = vm.runInNewContext("(" + dbMatch[0] + ")", { Intl });
  ok("100 % equivale a 0,0 dB", toDb(100, "es") === "0,0 dB");
  ok("200 % equivale a +6,0 dB", toDb(200, "es") === "+6,0 dB");
  ok("600 % equivale a +15,6 dB", toDb(600, "es") === "+15,6 dB");
  ok("50 % equivale a -6,0 dB", toDb(50, "es") === "-6,0 dB");
  ok("0 % es silencio", toDb(0, "es") === "−∞ dB");
  ok("en inglés usa punto decimal", toDb(200, "en") === "+6.0 dB");
}
ok(
  "renderVolumeValue actualiza los dB",
  /volumeDbEl\.textContent = percentToDb\(volumeValue, uiLang\)/.test(popup)
);
ok("popup.html incluye el valor en dB", /id="volume-db"/.test(read("popup.html")));

const es = localeEs;
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

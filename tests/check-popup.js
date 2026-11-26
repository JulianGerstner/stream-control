const fs = require("fs");
const path = require("path");
const dir = path.join(__dirname, "..");
const js = fs.readFileSync(path.join(dir, "popup.js"), "utf8");
const html = fs.readFileSync(path.join(dir, "popup.html"), "utf8");
const ids = new Set(
  [...js.matchAll(/getElementById\(['"]([^'"]+)['"]\)/g)].map((m) => m[1])
);
const htmlIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
const missing = [...ids].filter((id) => !htmlIds.has(id));
const unused = [...htmlIds].filter((id) => !ids.has(id));
console.log("IDs en JS:", ids.size);
console.log("Faltan en HTML:", missing.length ? missing : "ninguno");
console.log("En HTML sin JS:", unused.length ? unused : "ninguno");

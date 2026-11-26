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

const code = sliceBetween("  const RAMP_CFG = {", "  // Enganche barato");
const factory = new Function(
  "deps",
  `const {performance,setInterval,clearInterval,localStorage,isAdapterPage,getPlayerForVideo,detectLive,getBufferAheadSeconds,rateControlState,pinPlaybackRate,unpinPlaybackRate,isRealMediaElement}=deps;
${code}
return { RAMP_CFG, rampState, rampSample, ensureRampWatch, abortStartupRamp, skipStartupRamp, finishStartupRamp, resetStartupRamp, rampDisabledByUser };`
);

function makeEnv(opts) {
  let now = 0;
  let buffer = 0.5;
  let timerId = 1;
  const timers = new Map();
  const writes = [];
  const rateControlState = new Map();

  const video = {
    isConnected: true,
    paused: false,
    ended: false,
    duration: opts.duration !== undefined ? opts.duration : Infinity,
    playbackRate: 1,
    handlers: {},
    addEventListener(type, fn) {
      this.handlers[type] = fn;
    },
  };

  const pinPlaybackRate = (v, rate) => {
    let st = rateControlState.get(v);
    if (!st) {
      st = { desired: 1, userPinned: false, released: false };
      rateControlState.set(v, st);
    }
    st.desired = rate;
    writes.push(rate);
  };
  const unpinPlaybackRate = (v) => {
    const st = rateControlState.get(v);
    if (!st) return;
    st.desired = 1;
    writes.push(1);
  };

  const deps = {
    performance: { now: () => now },
    setInterval: (fn) => {
      const id = timerId++;
      timers.set(id, fn);
      return id;
    },
    clearInterval: (id) => timers.delete(id),
    localStorage: {
      getItem: (k) => (k === "qs-ramp" ? opts.rampPref || null : null),
    },
    isAdapterPage: () => !!opts.adapter,
    getPlayerForVideo: () => opts.player || null,
    detectLive: () => opts.live || "unknown",
    getBufferAheadSeconds: () => buffer,
    rateControlState,
    pinPlaybackRate,
    unpinPlaybackRate,
    isRealMediaElement: () => true,
  };

  const api = factory(deps);
  return {
    api,
    video,
    writes,
    rateControlState,
    tick(ms) {
      now += ms;
      for (const fn of Array.from(timers.values())) fn();
    },
    setTime(t) {
      now = t;
    },
    setBuffer(v) {
      buffer = v;
    },
    getBuffer() {
      return buffer;
    },
  };
}

let failures = 0;
function check(label, cond, extra) {
  if (cond) {
    console.log("PASS | " + label);
  } else {
    failures++;
    console.log("FAIL | " + label + (extra ? " -> " + JSON.stringify(extra) : ""));
  }
}

// --- 1) YouTube: vivo, con ráfagas, no debe tocar la velocidad --------------
{
  const env = makeEnv({ player: { type: "youtube" }, live: "live" });
  env.api.ensureRampWatch(env.video);
  for (let t = 0; t <= 12; t += 0.5) {
    env.setTime(t * 1000);
    env.setBuffer(0.5 + Math.floor(t / 4) * 4);
    env.api.rampSample();
  }
  check(
    "YouTube: rampa descartada por motor",
    env.api.rampState.phase === "skipped" &&
      env.api.rampState.reason === "motor-no-shaka",
    { phase: env.api.rampState.phase, reason: env.api.rampState.reason }
  );
  check("YouTube: nunca escribe 1,06x", !env.writes.includes(1.06), env.writes);
}

// --- 2) Shaka/DGO: la rampa sigue funcionando y vuelve a 1x ----------------
{
  const env = makeEnv({ player: { type: "shaka" }, live: "live" });
  env.api.ensureRampWatch(env.video);
  for (let t = 0.5; t <= 12.5; t += 0.5) {
    env.setTime(t * 1000);
    env.setBuffer(0.5 + Math.floor(t / 4) * 4);
    env.api.rampSample();
  }
  check(
    "Shaka: entra en ramping a 1,06x",
    env.api.rampState.phase === "ramping" && env.writes.includes(1.06),
    { phase: env.api.rampState.phase, writes: env.writes }
  );
  const st = env.rateControlState.get(env.video);
  check("Shaka: pin en 1,06x", st && st.desired === 1.06, st && st.desired);

  // El buffer drena y la rampa termina sola en 1x.
  let buf = env.getBuffer();
  for (let i = 0; i < 40 && env.api.rampState.phase === "ramping"; i++) {
    env.tick(500);
    buf -= 0.53;
    env.setBuffer(buf);
  }
  check(
    "Shaka: termina en 1x",
    env.api.rampState.phase === "done" && env.writes[env.writes.length - 1] === 1,
    { phase: env.api.rampState.phase, writes: env.writes }
  );
}

// --- 3) Abortar la rampa en curso suelta el pin ----------------------------
{
  const env = makeEnv({ player: { type: "shaka" }, live: "live" });
  env.api.ensureRampWatch(env.video);
  for (let t = 0.5; t <= 12.5; t += 0.5) {
    env.setTime(t * 1000);
    env.setBuffer(0.5 + Math.floor(t / 4) * 4);
    env.api.rampSample();
  }
  const before = env.api.rampState.phase;
  env.api.abortStartupRamp("velocidad-manual");
  const st = env.rateControlState.get(env.video);
  check(
    "Abortar en ramping vuelve a 1x",
    before === "ramping" && st.desired === 1 && env.writes[env.writes.length - 1] === 1,
    { before, desired: st.desired, writes: env.writes }
  );
}

// --- 4) Cambio de fuente mientras rampea: limpia y vuelve a medir ----------
{
  const env = makeEnv({ player: { type: "shaka" }, live: "live" });
  env.api.ensureRampWatch(env.video);
  for (let t = 0.5; t <= 12.5; t += 0.5) {
    env.setTime(t * 1000);
    env.setBuffer(0.5 + Math.floor(t / 4) * 4);
    env.api.rampSample();
  }
  const wasRamping = env.api.rampState.phase === "ramping";
  const st = env.rateControlState.get(env.video);
  env.video.handlers.emptied();
  check(
    "Cambio de fuente limpia la rampa y vuelve a medir",
    wasRamping &&
      st.desired === 1 &&
      env.api.rampState.phase === "measuring" &&
      env.api.rampState.reason === "nueva-fuente",
    { wasRamping, desired: st.desired, phase: env.api.rampState.phase, reason: env.api.rampState.reason }
  );
}

// --- 5) Opt-out ------------------------------------------------------------
{
  const env = makeEnv({ player: { type: "shaka" }, live: "live", rampPref: "off" });
  env.api.ensureRampWatch(env.video);
  for (let t = 0.5; t <= 12.5; t += 0.5) {
    env.setTime(t * 1000);
    env.setBuffer(0.5 + Math.floor(t / 4) * 4);
    env.api.rampSample();
  }
  check(
    "qs-ramp=off desactiva la rampa",
    env.api.rampState.phase === "idle" && env.writes.length === 0,
    { phase: env.api.rampState.phase, writes: env.writes }
  );
}

// --- 6) Twitch/Kick (adapter): no toca nada -------------------------------
{
  const env = makeEnv({ adapter: true, live: "live" });
  env.api.ensureRampWatch(env.video);
  env.api.rampSample();
  check(
    "Twitch/Kick: rampa descartada",
    env.api.rampState.phase === "skipped" &&
      env.api.rampState.reason === "motor-no-shaka" &&
      env.writes.length === 0,
    { phase: env.api.rampState.phase, reason: env.api.rampState.reason, writes: env.writes }
  );
}

// --- 7) VOD en Shaka: no rampa -------------------------------------------
{
  const env = makeEnv({ player: { type: "shaka" }, live: "vod", duration: 600 });
  env.api.ensureRampWatch(env.video);
  for (let t = 0.5; t <= 6; t += 0.5) {
    env.setTime(t * 1000);
    env.setBuffer(0.5 + Math.floor(t / 4) * 4);
    env.api.rampSample();
  }
  check(
    "Shaka VOD: no escribe velocidad",
    env.api.rampState.phase === "skipped" &&
      env.api.rampState.reason === "no-es-vivo" &&
      env.writes.length === 0,
    { phase: env.api.rampState.phase, reason: env.api.rampState.reason, writes: env.writes }
  );
}

console.log(failures === 0 ? "TODO OK" : failures + " fallo(s)");
process.exit(failures === 0 ? 0 : 1);

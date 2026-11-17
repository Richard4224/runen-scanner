// UI-Logik im Hauptthread. Kennt die Entzifferung selbst nicht -- die laeuft
// im Worker (siehe worker.js), damit die Seite waehrend der Rechenzeit
// reagieren bleibt. Der Worker-Code wird vom Build als globaler String
// __WORKER_SRC__ eingebettet (Blob-Worker, damit auch offline per file://
// alles in einer einzigen HTML-Datei funktioniert).

import { DICT_WORDS, CUSTOM_WORDS, DICT_NOUN_BITS } from "./generated-dict.js";
import { buildDict } from "./core/dict.js";

const FONTS = [
  "Phoenix-Runen",
  "Phoenix-Taluz",
  "Phoenix-Gobsch",
  "Phoenix-Lacrimat",
  "Phoenix-Xersesch",
  "Phoenix-Nalya",
  "Phoenix-Nalya-Shirin",
  "Phoenix-Lem-Kai",
];
const fontLabel = (f) => f.replace(/^Phoenix-/, "").replace(/-/g, " ");

const PROCESS_DIM_FAST = 1100;
const PROCESS_DIM_DETAIL = 2200;
const DETAIL_STORAGE_KEY = "runen-detail-scan";
/** Watchdog: wenn der Worker so lange nichts meldet, Abbruch mit Fehler. */
const WORKER_TIMEOUT_MS = 120_000;
const WORKER_TIMEOUT_DETAIL_MS = 180_000;
const AMONG_US_RE = /\bAMONG\s*US\b/;
const FLAVOR = [
  "Die Runen werden befragt …",
  "Zeichen um Zeichen wird enthüllt …",
  "Das Gerät hört die alte Sprache …",
  "Tinte und Symbol werden verglichen …",
  "Noch einen Moment Geduld …",
];

const $ = (id) => document.getElementById(id);
const screens = ["start", "crop", "loading", "result", "privacy", "imprint"];
const LEGAL_HASH = { privacy: "#datenschutz", imprint: "#impressum" };
function showScreen(name) {
  for (const s of screens) $(`screen-${s}`).classList.toggle("active", s === name);
  const hash = LEGAL_HASH[name];
  if (hash) {
    if (location.hash !== hash) history.replaceState(null, "", hash);
  } else if (location.hash === "#datenschutz" || location.hash === "#impressum") {
    history.replaceState(null, "", location.pathname + location.search);
  }
}

function openLegal(screen) {
  return (e) => {
    e.preventDefault();
    showScreen(screen);
  };
}
$("privacy-link").addEventListener("click", openLegal("privacy"));
$("imprint-link").addEventListener("click", openLegal("imprint"));
$("privacy-back").addEventListener("click", () => showScreen("start"));
$("imprint-back").addEventListener("click", () => showScreen("start"));
$("screen-privacy").addEventListener("click", (e) => {
  const a = e.target.closest('a[href="impressum.html"]');
  if (!a) return;
  e.preventDefault();
  showScreen("imprint");
});
if (location.hash === "#datenschutz") showScreen("privacy");
else if (location.hash === "#impressum") showScreen("imprint");

const fileInput = $("file-input");
const cropCanvas = $("crop-canvas");
const cropWrap = $("crop-wrap");
const cropRectEl = $("crop-rect");
const fontSelect = $("font-select");
const legacyWrap = $("legacy-wrap");
const legacyToggle = $("legacy-toggle");
const detailWrap = $("detail-wrap");
const detailToggle = $("detail-toggle");
const detailHint = $("detail-hint");

for (const f of FONTS) {
  const opt = document.createElement("option");
  opt.value = f;
  opt.textContent = fontLabel(f);
  fontSelect.appendChild(opt);
}
const autoOpt = document.createElement("option");
autoOpt.value = "__auto__";
autoOpt.textContent = "Automatisch (Legacy, langsamer)";
fontSelect.appendChild(autoOpt);

// Standard ist das Schnellmodell (CRNN); der alte Erkenner nur per Legacy-Modus
// oder bei "Automatisch" (das CRNN braucht eine feste Schrift).
function crnnSelected() {
  return FONTS.includes(fontSelect.value) && !legacyToggle.checked;
}

function detailSelected() {
  return crnnSelected() && detailToggle.checked;
}

function processDim() {
  return detailSelected() ? PROCESS_DIM_DETAIL : PROCESS_DIM_FAST;
}

function updateEngineChoice() {
  const crnn = crnnSelected();
  legacyWrap.classList.toggle("hidden", !FONTS.includes(fontSelect.value));
  detailWrap.classList.toggle("hidden", !crnn);
  detailHint.classList.toggle("hidden", !detailSelected());
}

let sourceImg = null;    // HTMLImageElement, EXIF-korrigiert
let dispScale = 1;       // Canvas-CSS-Px -> Bild-Px
let rect = { x: 0, y: 0, w: 0, h: 0 }; // in Canvas-CSS-Px

if (/WhatsApp|FBAN|FBAV|Instagram|Line\//i.test(navigator.userAgent || "")) {
  $("safari-hint").classList.remove("hidden");
}

fileInput.addEventListener("change", onFilePicked);

function showStartError(msg) {
  const el = $("start-error");
  el.textContent = msg;
  el.classList.toggle("hidden", !msg);
}

function onFilePicked() {
  const file = fileInput.files && fileInput.files[0];
  fileInput.value = "";
  if (!file) return;
  showStartError("");
  loadImageFile(file).then((img) => {
    if (!img.naturalWidth || !img.naturalHeight) {
      showStartError("Das Bild konnte nicht gelesen werden. In Safari öffnen und ein Foto aus der Mediathek wählen.");
      return;
    }
    sourceImg = img;
    layoutCrop();
    showScreen("crop");
  }).catch(() => {
    showStartError("iPhone konnte das Bild nicht öffnen. Datei in Safari oder „Dateien“ öffnen, nicht in WhatsApp.");
  });
}

function loadImageFile(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("image"));
    const reader = new FileReader();
    reader.onload = () => { img.src = reader.result; };
    reader.onerror = () => reject(new Error("read"));
    reader.readAsDataURL(file);
  });
}

function layoutCrop() {
  const maxW = Math.min(window.innerWidth - 32, 720);
  const maxH = window.innerHeight * 0.55;
  const iw = sourceImg.naturalWidth, ih = sourceImg.naturalHeight;
  const fit = Math.min(maxW / iw, maxH / ih, 1);
  const cw = Math.round(iw * fit), ch = Math.round(ih * fit);

  cropCanvas.width = cw;
  cropCanvas.height = ch;
  cropCanvas.style.width = cw + "px";
  cropCanvas.style.height = ch + "px";
  cropWrap.style.width = cw + "px";
  cropWrap.style.height = ch + "px";
  cropCanvas.getContext("2d").drawImage(sourceImg, 0, 0, cw, ch);

  dispScale = iw / cw;

  const rw = cw * 0.85, rh = ch * 0.85;
  rect = { x: (cw - rw) / 2, y: (ch - rh) / 2, w: rw, h: rh };
  renderRect();
  updateCropEstimate();
}

function renderRect() {
  cropRectEl.style.left = rect.x + "px";
  cropRectEl.style.top = rect.y + "px";
  cropRectEl.style.width = rect.w + "px";
  cropRectEl.style.height = rect.h + "px";
}

window.addEventListener("resize", () => { if (sourceImg) layoutCrop(); });
window.addEventListener("pageshow", () => {
  if (sourceImg && $("screen-crop").classList.contains("active")) layoutCrop();
});

// -- Rahmen ziehen/skalieren --
const MIN_RECT = 24;
let drag = null;

cropRectEl.addEventListener("pointerdown", (ev) => {
  const handle = ev.target.dataset.h || null;
  cropRectEl.setPointerCapture(ev.pointerId);
  drag = { handle, startX: ev.clientX, startY: ev.clientY, rect: { ...rect } };
  ev.preventDefault();
});
cropRectEl.addEventListener("pointermove", (ev) => {
  if (!drag) return;
  const dx = ev.clientX - drag.startX, dy = ev.clientY - drag.startY;
  const cw = cropCanvas.width, ch = cropCanvas.height;
  let { x, y, w, h } = drag.rect;

  if (!drag.handle) {
    x = clamp(drag.rect.x + dx, 0, cw - w);
    y = clamp(drag.rect.y + dy, 0, ch - h);
  } else {
    let x1 = drag.rect.x, y1 = drag.rect.y, x2 = drag.rect.x + drag.rect.w, y2 = drag.rect.y + drag.rect.h;
    if (drag.handle.includes("w")) x1 = clamp(x1 + dx, 0, x2 - MIN_RECT);
    if (drag.handle.includes("e")) x2 = clamp(x2 + dx, x1 + MIN_RECT, cw);
    if (drag.handle.includes("n")) y1 = clamp(y1 + dy, 0, y2 - MIN_RECT);
    if (drag.handle.includes("s")) y2 = clamp(y2 + dy, y1 + MIN_RECT, ch);
    x = x1; y = y1; w = x2 - x1; h = y2 - y1;
  }
  rect = { x, y, w, h };
  renderRect();
  updateCropEstimate();
});
function endDrag(ev) { if (drag) { try { cropRectEl.releasePointerCapture(ev.pointerId); } catch {} } drag = null; }
cropRectEl.addEventListener("pointerup", endDrag);
cropRectEl.addEventListener("pointercancel", endDrag);
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function processSize() {
  const sw = rect.w * dispScale, sh = rect.h * dispScale;
  const maxDim = processDim();
  const scale = Math.min(1, maxDim / Math.max(sw, sh));
  const dw = Math.max(1, Math.round(sw * scale));
  const dh = Math.max(1, Math.round(sh * scale));
  const heightFrac = sourceImg ? Math.min(1, sh / sourceImg.naturalHeight) : 1;
  return { dw, dh, px: dw * dh, maxDim, heightFrac };
}

// Zeitschaetzung. Gemessen (Nov 2026, WebKit, 1 Thread, 8 echte Fotos), Schnellmodell:
// ~0,4 s fest (Uebergabe, Anzeige) + ~0,1 s pro Megapixel (Vorbereitung, Zeilensuche)
// + ~0,05 s pro Zeile. Die Zeilenzahl kennt erst die Zeilensuche; vorher wird sie aus
// der Ausschnitthoehe geraten (ganzes Blatt ~40 Zeilen, 9 pt eher mehr, 15 pt weniger).
// Das Tempo pro Zeile wird nach jedem Scan nachgezogen (Handy vs. PC, 1 vs. 4 Threads).
const CRNN_FIXED_S = 0.4;
const CRNN_MP_S = 0.1;
const CRNN_LINE_S = 0.05;
const CRNN_MODEL_S = 0.5;          // Modell laden, einmal pro Schrift und Worker
const RESULT_TAIL_S = 0.3;         // nach der letzten Zeile: Ergebnis uebergeben und anzeigen
const LINES_PER_PAGE = 40;
const LEGACY_FACTOR = 60;          // Erfahrungswert: alter Erkenner ~60x langsamer
let deviceFactor = 1;
let deviceCalibrated = false;
const warmFonts = new Set();       // Schriften, deren Modell im Worker schon geladen ist

function crnnSeconds(lines, px) {
  return CRNN_FIXED_S + (px / 1e6) * CRNN_MP_S + lines * CRNN_LINE_S;
}
function secondsPerLine(engine) {
  return CRNN_LINE_S * deviceFactor * (engine === "crnn" ? 1 : LEGACY_FACTOR);
}
function estimateSeconds({ px, heightFrac, auto, crnn, font }) {
  const lines = Math.max(1, Math.round(LINES_PER_PAGE * heightFrac));
  if (crnn) {
    const model = warmFonts.has(font) ? 0 : CRNN_MODEL_S;
    return Math.max(1, Math.round(deviceFactor * (crnnSeconds(lines, px) + model)));
  }
  const fonts = auto ? FONTS.length : 1;
  return Math.max(1, Math.round(deviceFactor * crnnSeconds(lines, px) * LEGACY_FACTOR * fonts));
}

/** Merkt sich nach einem Schnellmodell-Scan das echte Tempo pro Zeile. */
function calibrate(res) {
  if (!res || !res.ok || res.engine !== "crnn") return;
  warmFonts.add(loadMeta.font);
  // Erst ab einigen Zeilen aussagekraeftig; kleine Ausschnitte verzerren sonst.
  if (!loadMeta.tFirstLine || loadMeta.linesSeen < 5) return;
  const perLine = (performance.now() - loadMeta.tFirstLine) / 1000 / loadMeta.linesSeen;
  const f = Math.min(20, Math.max(0.3, perLine / CRNN_LINE_S));
  deviceFactor = deviceCalibrated ? (deviceFactor + f) / 2 : f;
  deviceCalibrated = true;
}
/** Gesamtdauer = schon vergangen + geschaetzter Rest (nie kleiner als vergangen). */
function projectEta(remainingSec) {
  const elapsed = (Date.now() - startedAt) / 1000;
  return Math.max(Math.ceil(elapsed), Math.round(elapsed + remainingSec));
}
function formatEta(sec) {
  if (sec < 60) return `ca. ${sec} s`;
  const m = Math.floor(sec / 60), s = sec % 60;
  return s ? `ca. ${m} min ${s} s` : `ca. ${m} min`;
}
function updateCropEstimate() {
  const el = $("crop-estimate");
  if (!sourceImg || !el) return;
  const { dw, dh, px, maxDim, heightFrac } = processSize();
  const auto = fontSelect.value === "__auto__";
  const crnn = crnnSelected();
  const detail = detailSelected();
  const sec = estimateSeconds({ px, heightFrac, auto, crnn, font: fontSelect.value });
  // Beim Schnellmodell kostet die Groesse kaum Zeit, nur beim alten Erkenner.
  const big = !crnn && (px > 700_000 || Math.max(dw, dh) >= maxDim);
  el.textContent =
    `Ausschnitt → ${dw}×${dh} px` +
    (big ? " (groß — Rahmen enger = schneller)" : "") +
    ` · Schätzung ${formatEta(sec)}` +
    (auto ? " · Auto prüft alle Schriften" : crnn ? " · Schnellmodell" : " · Legacy-Modus") +
    (detail ? " · hohe Auflösung" : "");
}
fontSelect.addEventListener("change", () => {
  updateEngineChoice();
  updateCropEstimate();
});
legacyToggle.addEventListener("change", () => {
  updateEngineChoice();
  updateCropEstimate();
});
detailToggle.addEventListener("change", () => {
  try { localStorage.setItem(DETAIL_STORAGE_KEY, detailToggle.checked ? "1" : "0"); } catch {}
  updateEngineChoice();
  updateCropEstimate();
});
// "Mehr Details" ist Standard; gespeichert wird nur, wer es selbst umgeschaltet hat.
try {
  const saved = localStorage.getItem(DETAIL_STORAGE_KEY);
  if (saved === "0" || saved === "1") detailToggle.checked = saved === "1";
} catch {}
updateEngineChoice();

$("crop-cancel").addEventListener("click", () => { sourceImg = null; showScreen("start"); });
$("crop-go").addEventListener("click", () => {
  armAmongUsAudio();
  startDecode();
});
$("result-again").addEventListener("click", () => {
  stopAmongUsAudio();
  stopDictCorrection();
  sourceImg = null;
  showScreen("start");
});
$("result-retry").addEventListener("click", () => {
  stopAmongUsAudio();
  stopDictCorrection();
  showScreen("crop");
});
$("loading-cancel").addEventListener("click", () => {
  stopAmongUsAudio();
  stopWorker();
  showScreen("crop");
});

// -- Bild vorbereiten & an den Worker schicken --
function gray(w, h, rgba) {
  const out = new Uint8Array(w * h);
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    out[i] = (rgba[p] * 77 + rgba[p + 1] * 150 + rgba[p + 2] * 29) >> 8;
  }
  return out;
}

function startDecode() {
  const sx = rect.x * dispScale, sy = rect.y * dispScale;
  const sw = rect.w * dispScale, sh = rect.h * dispScale;

  const maxDim = processDim();
  const scale = Math.min(1, maxDim / Math.max(sw, sh));
  const dw = Math.max(1, Math.round(sw * scale));
  const dh = Math.max(1, Math.round(sh * scale));

  const off = document.createElement("canvas");
  off.width = dw; off.height = dh;
  const ctx = off.getContext("2d");
  ctx.drawImage(sourceImg, sx, sy, sw, sh, 0, 0, dw, dh);
  const rgba = ctx.getImageData(0, 0, dw, dh).data;
  const g = gray(dw, dh, rgba);

  const chosen = fontSelect.value;
  const auto = chosen === "__auto__";
  const engine = crnnSelected() ? "crnn" : "classic";
  const detail = engine === "crnn" && detailToggle.checked;
  const heightFrac = Math.min(1, sh / sourceImg.naturalHeight);
  const eta = estimateSeconds({ px: dw * dh, heightFrac, auto, crnn: engine === "crnn", font: chosen });

  showScreen("loading");
  startLoadingAnim({ dw, dh, eta, auto, font: auto ? null : chosen, engine, detail });
  runWorker({
    w: dw,
    h: dh,
    data: g.buffer,
    font: auto ? null : chosen,
    auto,
    engine,
    assetBase: location.href,
  }, g.buffer);
}

let loadingTimer = null, elapsedTimer = null, startedAt = 0, watchdogTimer = null;
let loadMeta = { eta: 0, dw: 0, dh: 0, auto: false, detail: false };

function startLoadingAnim({ dw, dh, eta, auto, font, engine, detail = false }) {
  loadMeta = { eta, dw, dh, auto, font, engine, detail, tFirstLine: 0, linesSeen: 0 };
  let i = 0;
  $("loading-text").textContent = FLAVOR[0];
  $("loading-detail").textContent =
    `${dw}×${dh} px · Schätzung ${formatEta(eta)}` +
    (auto ? " · alle Schriften" : font ? ` · ${fontLabel(font)}` : "") +
    (engine === "crnn" ? " · Schnellmodell" : "") +
    (detail ? " · hohe Auflösung" : "");
  loadingTimer = setInterval(() => {
    i = (i + 1) % FLAVOR.length;
    $("loading-text").textContent = FLAVOR[i];
  }, 2600);
  startedAt = Date.now();
  $("loading-time").textContent = `00:00 / ${formatEta(eta)}`;
  elapsedTimer = setInterval(() => {
    const s = Math.floor((Date.now() - startedAt) / 1000);
    $("loading-time").textContent =
      `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}` +
      ` / ${formatEta(loadMeta.eta)}`;
  }, 250);
  armWatchdog();
}

function armWatchdog() {
  clearTimeout(watchdogTimer);
  watchdogTimer = setTimeout(() => {
    stopWorker();
    showResult({
      ok: false,
      error:
        "Zeitüberschreitung — der Scan hing (oft zu großer Ausschnitt oder schwierige Schrift). " +
        "Rahmen enger setzen und erneut versuchen.",
    });
  }, loadMeta.detail ? WORKER_TIMEOUT_DETAIL_MS : WORKER_TIMEOUT_MS);
}

function onWorkerProgress(msg) {
  armWatchdog(); // lebt noch
  const detail = $("loading-detail");
  if (!detail) return;
  if (msg.phase === "model") {
    detail.textContent = "Schnellmodell wird beim ersten Start vorbereitet …";
  } else if (msg.phase === "prepare") {
    detail.textContent = `Bild ${msg.w}×${msg.h} wird vorbereitet …`;
  } else if (msg.phase === "lines") {
    const fontsLeft = msg.fontTotal ? (msg.fontTotal - (msg.fontI || 1) + 1) : 1;
    loadMeta.eta = projectEta((msg.total || 1) * fontsLeft * secondsPerLine(loadMeta.engine) + RESULT_TAIL_S);
    detail.textContent = `${msg.total} Zeilen erkannt · neu ${formatEta(loadMeta.eta)}`;
  } else if (msg.phase === "line") {
    const fontBit = msg.font ? ` · ${fontLabel(msg.font)}` : "";
    detail.textContent = `Zeile ${msg.i} von ${msg.total}${fontBit}`;
    // Tempo pro Zeile live messen, sobald mindestens eine Zeile fertig ist.
    const now = performance.now();
    if (!loadMeta.tFirstLine) loadMeta.tFirstLine = now;
    loadMeta.linesSeen++;
    if (msg.total) {
      const per = loadMeta.linesSeen > 1
        ? (now - loadMeta.tFirstLine) / 1000 / (loadMeta.linesSeen - 1)
        : secondsPerLine(loadMeta.engine);
      const fontsLeft = msg.fontTotal ? (msg.fontTotal - (msg.fontI || 1) + 1) : 1;
      const linesLeft = Math.max(0, (msg.total - msg.i + 1) + (fontsLeft - 1) * msg.total);
      loadMeta.eta = projectEta(linesLeft * per + RESULT_TAIL_S);
    }
  } else if (msg.phase === "font") {
    detail.textContent = `Schrift ${msg.i}/${msg.total}: ${fontLabel(msg.font)}`;
  }
}

function stopLoadingAnim() {
  clearInterval(loadingTimer); clearInterval(elapsedTimer); clearTimeout(watchdogTimer);
  loadingTimer = elapsedTimer = watchdogTimer = null;
}

let worker = null;
function makeBlobWorker(source) {
  const blob = new Blob([source], { type: "application/javascript" });
  const url = URL.createObjectURL(blob);
  const w = new Worker(url);
  URL.revokeObjectURL(url);
  return w;
}
function makeWorker() { return makeBlobWorker(globalThis.__WORKER_SRC__); }
function stopWorker() {
  stopLoadingAnim();
  if (worker) { worker.terminate(); worker = null; }
  warmFonts.clear();
}
function runWorker(payload, transfer) {
  // Worker wiederverwenden: Das Schnellmodell muss dann nur einmal kompiliert werden.
  if (!worker) worker = makeWorker();
  worker.onmessage = (ev) => {
    const data = ev.data;
    if (data && data.progress) {
      onWorkerProgress(data);
      return;
    }
    calibrate(data);
    stopLoadingAnim();
    showResult(data);
  };
  worker.onerror = (ev) => {
    stopWorker();
    showResult({ ok: false, error: ev.message || "Unbekannter Fehler im Worker" });
  };
  worker.onmessageerror = () => {
    stopWorker();
    showResult({ ok: false, error: "Antwort vom Worker konnte nicht gelesen werden." });
  };
  armWatchdog();
  try {
    worker.postMessage(payload, [transfer]);
  } catch (err) {
    stopWorker();
    showResult({ ok: false, error: String(err && err.message || err) });
  }
}

// -- Woerterbuch-Grunddaten fuer schnelle Gross-/Kleinschreibung. Die teure
//    unscharfe Korrektur laeuft separat in einem abbrechbaren Worker.
const dict = buildDict(DICT_WORDS, CUSTOM_WORDS, DICT_NOUN_BITS);

/** Gruppiert die Zeichenliste des Workers in Wort-Spannen und Trenner. */
function tokenize(chars) {
  const tokens = [];
  let word = [];
  const flush = () => { if (word.length) { tokens.push({ type: "word", chars: word }); word = []; } };
  for (const c of chars) {
    if (c.ch === " " || c.ch === "\n") { flush(); tokens.push({ type: "sep", ch: c.ch }); }
    else word.push(c);
  }
  flush();
  return tokens;
}

function appendChars(container, chars) {
  for (const { ch, alt } of chars) {
    if (ch === "\n") { container.appendChild(document.createElement("br")); continue; }
    if (alt) {
      const span = document.createElement("span");
      span.className = "amb";
      span.textContent = ch;
      container.appendChild(span);
    } else {
      container.appendChild(document.createTextNode(ch));
    }
  }
}

function recaseChars(chars, sentenceStart, isNoun) {
  return chars.map((c, i) => {
    if (c.ch === " " || c.ch === "\n") return c;
    const upper = i === 0 && (sentenceStart || isNoun);
    return { ...c, ch: upper ? c.ch.toUpperCase() : c.ch.toLowerCase() };
  });
}

function renderRaw(container, chars) {
  let sentence = true;
  for (const tok of tokenize(chars)) {
    if (tok.type === "sep") {
      if (tok.ch === "\n") sentence = true;
      container.appendChild(tok.ch === "\n" ? document.createElement("br") : document.createTextNode(" "));
      continue;
    }
    const word = tok.chars.map((c) => c.ch).join("");
    if (word.length === 1) {
      appendChars(container, tok.chars);
    } else {
      const noun = dict.nouns.has(word);
      appendChars(container, recaseChars(tok.chars, sentence, noun));
    }
    sentence = false;
  }
}

const dictToggleWrap = $("dict-toggle-wrap");
const dictToggle = $("dict-toggle");
const dictCancel = $("dict-cancel");
let lastResult = null;
let dictWorker = null, dictJob = 0;

function stopDictCorrection(message = "") {
  dictJob++;
  if (dictWorker) {
    dictWorker.terminate();
    dictWorker = null;
  }
  dictCancel.classList.add("hidden");
  if (message) $("dict-legend").textContent = message;
}

function startDictCorrection(chars) {
  const id = ++dictJob;
  const legend = $("dict-legend");
  const textEl = $("result-text");
  const raw = chars.map((item) => item.ch).join("");
  dictWorker = makeBlobWorker(globalThis.__DICT_WORKER_SRC__);
  dictCancel.classList.remove("hidden");
  legend.textContent = "Wörterbuch wird geprüft …";
  dictWorker.onmessage = (ev) => {
    const data = ev.data;
    if (!data || data.id !== id) return;
    if (data.progress) {
      legend.textContent = `Wörterbuch: Zeile ${data.i} von ${data.total} …`;
      return;
    }
    const finished = dictWorker;
    dictWorker = null;
    finished?.terminate();
    dictCancel.classList.add("hidden");
    if (!data.ok) {
      legend.textContent = `Wörterbuchfehler: ${data.error || "unbekannt"}`;
      return;
    }
    textEl.textContent = data.text;
    legend.textContent = data.changed?.length
      ? "Angepasst: " + data.changed.map(([a, b]) => `${a} → ${b}`).join(", ")
      : "Wörterbuch: keine Änderungen";
  };
  dictWorker.onerror = (ev) => {
    if (id !== dictJob) return;
    stopDictCorrection(`Wörterbuchfehler: ${ev.message || "unbekannt"}`);
  };
  dictWorker.postMessage({ id, text: raw });
}

function showResult(res) {
  const errorBox = $("error-box");
  const metaEl = $("result-meta");
  const textEl = $("result-text");
  const legendEl = $("amb-legend");
  const dictLegendEl = $("dict-legend");
  errorBox.classList.add("hidden");
  metaEl.textContent = "";
  textEl.textContent = "";
  legendEl.textContent = "";
  dictLegendEl.textContent = "";
  dictToggleWrap.classList.add("hidden");
  stopDictCorrection();
  lastResult = res;

  if (!res || !res.ok) {
    errorBox.textContent = "Die Runen ließen sich nicht deuten. " + (res && res.error ? res.error : "");
    errorBox.classList.remove("hidden");
    showScreen("result");
    return;
  }
  if (res.empty) {
    textEl.textContent = "Keine Runen erkannt. Foto möglichst gerade aufnehmen (nicht zur Seite gekippt), Runen groß im Bild, Ausschnitt enger fassen oder andere Sprache wählen.";
    showScreen("result");
    return;
  }

  const sec = res.ms != null ? `  ·  ${(res.ms / 1000).toFixed(1)} s` : "";
  const engine = res.engine === "crnn";
  metaEl.textContent =
    `Sprache: ${fontLabel(res.font)}` +
    (engine ? "  ·  Schnellmodell" : `  ·  Sicherheit: ${Math.round(res.confidence * 100)}%`) +
    (res.lines ? `  ·  ${res.lines} Zeilen` : "") + sec;
  dictToggle.checked = res.engine !== "crnn";
  dictToggleWrap.classList.toggle("hidden", res.engine === "crnn");

  const seen = new Map();
  for (const { alt } of res.chars) if (alt) seen.set(alt, true);
  if (seen.size) {
    legendEl.textContent = "Unsicher (mehrere Runen sehen gleich aus): " + [...seen.keys()].join(", ");
  }

  showScreen("result");
  renderResultText();
  maybePlayAmongUs(res);
}

function renderResultText() {
  if (!lastResult || !lastResult.ok || lastResult.empty) return;
  const textEl = $("result-text");
  const dictLegendEl = $("dict-legend");
  stopDictCorrection();
  textEl.textContent = "";
  renderRaw(textEl, lastResult.chars);
  dictLegendEl.textContent = "";
  if (dictToggle.checked && lastResult.engine !== "crnn") {
    startDictCorrection(lastResult.chars);
  }
}
dictToggle.addEventListener("change", renderResultText);
dictCancel.addEventListener("click", () => {
  dictToggle.checked = false;
  stopDictCorrection("Wörterbuch abgebrochen – Rohtext bleibt sichtbar.");
});

let amongUsAudio = null;
function amongUsSrc() {
  try { return new URL("sound/among-us.mp3", location.href).href; }
  catch { return "sound/among-us.mp3"; }
}
function armAmongUsAudio() {
  if (amongUsAudio) return;
  amongUsAudio = new Audio(amongUsSrc());
  amongUsAudio.preload = "auto";
  amongUsAudio.volume = 0.85;
  amongUsAudio.load();
}
function stopAmongUsAudio() {
  if (!amongUsAudio) return;
  amongUsAudio.pause();
  amongUsAudio.currentTime = 0;
}
function maybePlayAmongUs(res) {
  if (!res || !res.ok || res.empty || !res.chars) {
    stopAmongUsAudio();
    return;
  }
  const text = res.chars.map((c) => c.ch).join("").toUpperCase().replace(/[^A-Z]+/g, " ");
  if (!AMONG_US_RE.test(text)) {
    stopAmongUsAudio();
    return;
  }
  armAmongUsAudio();
  stopAmongUsAudio();
  amongUsAudio.play().catch(() => {});
}

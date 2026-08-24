// UI-Logik im Hauptthread. Kennt die Entzifferung selbst nicht -- die laeuft
// im Worker (siehe worker.js), damit die Seite waehrend der Rechenzeit
// reagieren bleibt. Der Worker-Code wird vom Build als globaler String
// __WORKER_SRC__ eingebettet (Blob-Worker, damit auch offline per file://
// alles in einer einzigen HTML-Datei funktioniert).

import { DICT_WORDS, CUSTOM_WORDS, DICT_NOUN_BITS } from "./generated-dict.js";
import { buildDict, correctWord as guessWord, correctTokens, formatWord } from "./core/dict.js";

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

const MAX_PROCESS_DIM = 1100;
/** Watchdog: wenn der Worker so lange nichts meldet, Abbruch mit Fehler. */
const WORKER_TIMEOUT_MS = 120_000;
const FLAVOR = [
  "Die Runen werden befragt …",
  "Zeichen um Zeichen wird enthüllt …",
  "Das Gerät hört die alte Sprache …",
  "Tinte und Symbol werden verglichen …",
  "Noch einen Moment Geduld …",
];

const $ = (id) => document.getElementById(id);
const screens = ["start", "crop", "loading", "result"];
function showScreen(name) {
  for (const s of screens) $(`screen-${s}`).classList.toggle("active", s === name);
}

const fileInput = $("file-input");
const cropCanvas = $("crop-canvas");
const cropWrap = $("crop-wrap");
const cropRectEl = $("crop-rect");
const fontSelect = $("font-select");
const crnnWrap = $("crnn-wrap");
const crnnToggle = $("crnn-toggle");
const crnnHint = $("crnn-hint");

for (const f of FONTS) {
  const opt = document.createElement("option");
  opt.value = f;
  opt.textContent = fontLabel(f);
  fontSelect.appendChild(opt);
}
const autoOpt = document.createElement("option");
autoOpt.value = "__auto__";
autoOpt.textContent = "Automatisch (langsamer)";
fontSelect.appendChild(autoOpt);

function crnnSelected() {
  return fontSelect.value === "Phoenix-Taluz" && crnnToggle.checked;
}

function updateEngineChoice() {
  const available = fontSelect.value === "Phoenix-Taluz";
  crnnWrap.classList.toggle("hidden", !available);
  crnnHint.classList.toggle("hidden", !available || !crnnToggle.checked);
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

/** Grobe ETA aus Prozess-Pixeln (iPhone ~ ein Kern). */
function processSize() {
  const sw = rect.w * dispScale, sh = rect.h * dispScale;
  const scale = Math.min(1, MAX_PROCESS_DIM / Math.max(sw, sh));
  const dw = Math.max(1, Math.round(sw * scale));
  const dh = Math.max(1, Math.round(sh * scale));
  return { dw, dh, px: dw * dh };
}
function estimateSeconds(px, auto, crnn = false) {
  if (crnn) return Math.max(8, Math.round(6 + px / 400_000));
  // Empirisch: ~1,2e5 Px/s auf einem Kern mit 5+5 Skalen; Auto × Schriftanzahl.
  const fonts = auto ? FONTS.length : 1;
  return Math.max(3, Math.round((px / 1.2e5) * fonts));
}
function formatEta(sec) {
  if (sec < 60) return `ca. ${sec} s`;
  const m = Math.floor(sec / 60), s = sec % 60;
  return s ? `ca. ${m} min ${s} s` : `ca. ${m} min`;
}
function updateCropEstimate() {
  const el = $("crop-estimate");
  if (!sourceImg || !el) return;
  const { dw, dh, px } = processSize();
  const auto = fontSelect.value === "__auto__";
  const crnn = crnnSelected();
  const sec = estimateSeconds(px, auto, crnn);
  const big = px > 700_000 || Math.max(dw, dh) >= MAX_PROCESS_DIM;
  el.textContent =
    `Ausschnitt → ${dw}×${dh} px` +
    (big ? " (groß — Rahmen enger = schneller)" : "") +
    ` · Schätzung ${formatEta(sec)}` +
    (auto ? " · Auto prüft alle Schriften" : crnn ? " · Schnellmodell" : "");
}
fontSelect.addEventListener("change", () => {
  updateEngineChoice();
  updateCropEstimate();
});
crnnToggle.addEventListener("change", () => {
  updateEngineChoice();
  updateCropEstimate();
});

$("crop-cancel").addEventListener("click", () => { sourceImg = null; showScreen("start"); });
$("crop-go").addEventListener("click", startDecode);
$("result-again").addEventListener("click", () => { sourceImg = null; showScreen("start"); });
$("result-retry").addEventListener("click", () => showScreen("crop"));
$("loading-cancel").addEventListener("click", () => { stopWorker(); showScreen("crop"); });

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

  const scale = Math.min(1, MAX_PROCESS_DIM / Math.max(sw, sh));
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
  const eta = estimateSeconds(dw * dh, auto, engine === "crnn");

  showScreen("loading");
  startLoadingAnim({ dw, dh, eta, auto, font: auto ? null : chosen, engine });
  runWorker({ w: dw, h: dh, data: g.buffer, font: auto ? null : chosen, auto, engine }, g.buffer);
}

let loadingTimer = null, elapsedTimer = null, startedAt = 0, watchdogTimer = null;
let loadMeta = { eta: 0, dw: 0, dh: 0, auto: false };

function startLoadingAnim({ dw, dh, eta, auto, font, engine }) {
  loadMeta = { eta, dw, dh, auto, font, engine };
  let i = 0;
  $("loading-text").textContent = FLAVOR[0];
  $("loading-detail").textContent =
    `${dw}×${dh} px · Schätzung ${formatEta(eta)}` +
    (auto ? " · alle Schriften" : font ? ` · ${fontLabel(font)}` : "") +
    (engine === "crnn" ? " · Schnellmodell" : "");
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
  }, WORKER_TIMEOUT_MS);
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
    const eta = Math.max(3, Math.round((msg.total || 1) * (loadMeta.auto ? FONTS.length * 1.2 : 1.2)));
    loadMeta.eta = eta;
    detail.textContent = `${msg.total} Zeilen erkannt · neu ${formatEta(eta)}`;
  } else if (msg.phase === "line") {
    const fontBit = msg.font ? ` · ${fontLabel(msg.font)}` : "";
    detail.textContent = `Zeile ${msg.i} von ${msg.total}${fontBit}`;
    if (msg.total) {
      const per = loadMeta.auto ? 1.2 : 1.2;
      const fontsLeft = msg.fontTotal ? (msg.fontTotal - (msg.fontI || 1) + 1) : 1;
      const linesLeft = Math.max(0, (msg.total - msg.i) + (fontsLeft - 1) * msg.total);
      loadMeta.eta = Math.max(2, Math.round(linesLeft * per));
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
function makeWorker() {
  const blob = new Blob([globalThis.__WORKER_SRC__], { type: "application/javascript" });
  const url = URL.createObjectURL(blob);
  const w = new Worker(url);
  URL.revokeObjectURL(url);
  return w;
}
function stopWorker() {
  stopLoadingAnim();
  if (worker) { worker.terminate(); worker = null; }
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

// -- Woerterbuch: unscharfe Woerter durch das naheliegendste echte Wort
//    ersetzen. Reine Nachbearbeitung des bereits entzifferten Texts, ohne
//    erneuten (teuren) Decode-Lauf -- daher direkt im Hauptthread.
const dict = buildDict(DICT_WORDS, CUSTOM_WORDS, DICT_NOUN_BITS);
const correctWord = (word) => guessWord(word, dict);

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

function renderDict(container, chars) {
  const changed = new Map();
  let sentence = true;
  let lineWords = [];
  let lineSeps = []; // parallel: after each word, what sep follows (space/newline/end)

  const flushLine = () => {
    if (!lineWords.length) return;
    const raw = lineWords.map((t) => t.chars.map((c) => c.ch).join(""));
    const fixed = correctTokens(raw, dict);
    if (fixed.join(" ") !== raw.join(" ")) {
      changed.set(raw.join(" "), fixed.join(" "));
    }
    for (let i = 0; i < fixed.length; i++) {
      if (i) container.appendChild(document.createTextNode(" "));
      const w = fixed[i];
      const span = document.createElement("span");
      if (fixed.join(" ") !== raw.join(" ")) span.className = "corrected";
      span.textContent = formatWord(w, dict, i === 0 && sentence);
      container.appendChild(span);
    }
    sentence = false;
    lineWords = [];
  };

  for (const tok of tokenize(chars)) {
    if (tok.type === "word") {
      lineWords.push(tok);
      continue;
    }
    if (tok.ch === "\n") {
      flushLine();
      container.appendChild(document.createElement("br"));
      sentence = true;
    }
    // Spaces between words on the same line are re-emitted by flushLine.
  }
  flushLine();
  return changed;
}

const dictToggleWrap = $("dict-toggle-wrap");
const dictToggle = $("dict-toggle");
let lastResult = null;

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
  lastResult = res;

  if (!res || !res.ok) {
    errorBox.textContent = "Die Runen ließen sich nicht deuten. " + (res && res.error ? res.error : "");
    errorBox.classList.remove("hidden");
    showScreen("result");
    return;
  }
  if (res.empty) {
    textEl.textContent = "Keine Runen erkannt. Ausschnitt enger fassen oder andere Sprache wählen.";
    showScreen("result");
    return;
  }

  const sec = res.ms != null ? `  ·  ${(res.ms / 1000).toFixed(1)} s` : "";
  const engine = res.engine === "crnn";
  metaEl.textContent =
    `Sprache: ${fontLabel(res.font)}` +
    (engine ? "  ·  Schnellmodell (experimentell)" : `  ·  Sicherheit: ${Math.round(res.confidence * 100)}%`) +
    (res.lines ? `  ·  ${res.lines} Zeilen` : "") + sec;
  dictToggle.checked = res.engine !== "crnn";
  dictToggleWrap.classList.toggle("hidden", res.engine === "crnn");

  const seen = new Map();
  for (const { alt } of res.chars) if (alt) seen.set(alt, true);
  if (seen.size) {
    legendEl.textContent = "Unsicher (mehrere Runen sehen gleich aus): " + [...seen.keys()].join(", ");
  }

  renderResultText();
  showScreen("result");
}

function renderResultText() {
  if (!lastResult || !lastResult.ok || lastResult.empty) return;
  const textEl = $("result-text");
  const dictLegendEl = $("dict-legend");
  textEl.textContent = "";
  if (dictToggle.checked && lastResult.engine !== "crnn") {
    const changed = renderDict(textEl, lastResult.chars);
    dictLegendEl.textContent = changed.size
      ? "Angepasst: " + [...changed.entries()].map(([a, b]) => `${a} → ${b}`).join(", ")
      : "";
  } else {
    renderRaw(textEl, lastResult.chars);
    dictLegendEl.textContent = "";
  }
}
dictToggle.addEventListener("change", renderResultText);

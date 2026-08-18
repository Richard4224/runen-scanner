// UI-Logik im Hauptthread. Kennt die Entzifferung selbst nicht -- die laeuft
// im Worker (siehe worker.js), damit die Seite waehrend der Rechenzeit
// reagieren bleibt. Der Worker-Code wird vom Build als globaler String
// __WORKER_SRC__ eingebettet (Blob-Worker, damit auch offline per file://
// alles in einer einzigen HTML-Datei funktioniert).

import { DICT_WORDS, CUSTOM_WORDS, DICT_NOUN_BITS } from "./generated-dict.js";
import { buildDict, correctWord as guessWord, formatWord } from "./core/dict.js";

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
const pickBtn = $("pick-btn");
const cropCanvas = $("crop-canvas");
const cropWrap = $("crop-wrap");
const cropRectEl = $("crop-rect");
const fontSelect = $("font-select");

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

let sourceImg = null;    // HTMLImageElement, EXIF-korrigiert
let dispScale = 1;       // Canvas-CSS-Px -> Bild-Px
let rect = { x: 0, y: 0, w: 0, h: 0 }; // in Canvas-CSS-Px

pickBtn.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", onFilePicked);

function onFilePicked() {
  const file = fileInput.files && fileInput.files[0];
  fileInput.value = "";
  if (!file) return;
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    sourceImg = img;
    URL.revokeObjectURL(url);
    layoutCrop();
    showScreen("crop");
  };
  img.onerror = () => URL.revokeObjectURL(url);
  img.src = url;
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
}

function renderRect() {
  cropRectEl.style.left = rect.x + "px";
  cropRectEl.style.top = rect.y + "px";
  cropRectEl.style.width = rect.w + "px";
  cropRectEl.style.height = rect.h + "px";
}

window.addEventListener("resize", () => { if (sourceImg) layoutCrop(); });

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
});
function endDrag(ev) { if (drag) { try { cropRectEl.releasePointerCapture(ev.pointerId); } catch {} } drag = null; }
cropRectEl.addEventListener("pointerup", endDrag);
cropRectEl.addEventListener("pointercancel", endDrag);
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

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

  showScreen("loading");
  startLoadingAnim();
  runWorker({ w: dw, h: dh, data: g.buffer, font: auto ? null : chosen, auto }, g.buffer);
}

let loadingTimer = null, elapsedTimer = null, startedAt = 0;
function startLoadingAnim() {
  let i = 0;
  $("loading-text").textContent = FLAVOR[0];
  loadingTimer = setInterval(() => { i = (i + 1) % FLAVOR.length; $("loading-text").textContent = FLAVOR[i]; }, 2600);
  startedAt = Date.now();
  $("loading-time").textContent = "";
  elapsedTimer = setInterval(() => {
    const s = Math.floor((Date.now() - startedAt) / 1000);
    $("loading-time").textContent = `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  }, 250);
}
function stopLoadingAnim() {
  clearInterval(loadingTimer); clearInterval(elapsedTimer);
  loadingTimer = elapsedTimer = null;
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
  stopWorker();
  worker = makeWorker();
  worker.onmessage = (ev) => { stopWorker(); showResult(ev.data); };
  worker.onerror = (ev) => { stopWorker(); showResult({ ok: false, error: ev.message || "Unbekannter Fehler" }); };
  worker.postMessage(payload, [transfer]);
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
  for (const tok of tokenize(chars)) {
    if (tok.type === "sep") {
      if (tok.ch === "\n") sentence = true;
      container.appendChild(tok.ch === "\n" ? document.createElement("br") : document.createTextNode(" "));
      continue;
    }
    const word = tok.chars.map((c) => c.ch).join("");
    const fix = correctWord(word);
    if (fix && fix !== word) {
      const span = document.createElement("span");
      span.className = "corrected";
      span.textContent = fix.split(" ").map((w, i) => formatWord(w, dict, i === 0 && sentence)).join(" ");
      container.appendChild(span);
      changed.set(word, fix);
    } else if (word.length === 1) {
      appendChars(container, tok.chars);
    } else {
      const noun = dict.nouns.has(word);
      appendChars(container, recaseChars(tok.chars, sentence, noun));
    }
    sentence = false;
  }
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

  metaEl.textContent = `Sprache: ${fontLabel(res.font)}  ·  Sicherheit: ${Math.round(res.confidence * 100)}%`;
  dictToggleWrap.classList.remove("hidden");

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
  if (dictToggle.checked) {
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

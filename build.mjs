// Baut aus src/ eine einzige, eigenstaendige dist/index.html: Schriftdaten,
// Worker-Code und UI-Code sind inline eingebettet. Kein fetch(), kein
// <script type=module>, kein separater Worker-Datei-URL -- all das ist unter
// file:// in Safari unzuverlaessig oder verboten. Ergebnis: eine Datei, die
// man per AirDrop aufs Handy legt und in Safari oeffnet, ganz ohne Internet
// oder Server.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import dictionaryDe from "dictionary-de";
import nspell from "nspell";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(here, "src");
const dist = path.join(here, "dist");
const distCloudflare = path.join(here, "dist-cloudflare");
fs.mkdirSync(dist, { recursive: true });
fs.mkdirSync(distCloudflare, { recursive: true });

// 1. Atlas-Daten als JS-Modul bereitstellen (kein JSON-fetch noetig).
const atlasRaw = fs.readFileSync(path.join(src, "atlas.json"), "utf8");
fs.writeFileSync(
  path.join(src, "generated-atlas.js"),
  `// Automatisch erzeugt von build.mjs -- nicht von Hand bearbeiten.\nexport const ATLAS_JSON = ${atlasRaw};\n`,
);

// 1b. Woerterbuch: Haeufigkeitsliste, aber nur Woerter die Hunspell (igerman98)
// als echtes Deutsch kennt -- sonst landen Crawl-Muellwoerter wie TASI vor
// TAXI. Fuer mobile Laufzeit nur die 12.000 haeufigsten bestaetigten Woerter;
// Fantasy-/LARP-Woerter und Bindestrich-Bundeslaender kommen gezielt dazu.
// Die Rune-Fonts kennen keine Umlaute/ß -- Abgleich immer A-Z (ae/oe/ue/ss).
const translit = (w) =>
  w.toUpperCase()
    .replace(/Ä/g, "AE").replace(/Ö/g, "OE").replace(/Ü/g, "UE")
    .replace(/ß/gi, "SS")
    .replace(/[^A-Z]/g, "");

const spell = nspell({
  aff: Buffer.from(dictionaryDe.aff),
  dic: Buffer.from(dictionaryDe.dic),
});

function isGerman(w) {
  if (!w) return false;
  if (spell.correct(w)) return true;
  const lower = w.toLowerCase();
  if (spell.correct(lower)) return true;
  const cap = lower.charAt(0).toUpperCase() + lower.slice(1);
  return spell.correct(cap);
}

const require = (await import("node:module")).createRequire(import.meta.url);
const germanWords = require("an-array-of-german-words");

// 1c. Experimentelles Taluz-CRNN samt WASM-Laufzeit inline einbetten.
// Dadurch bleibt auch der schnelle Modus eine einzige offline-faehige HTML.
const crnnModelFiles = {
  "Phoenix-Runen": "runen-crnn.onnx",
  "Phoenix-Taluz": "taluz-crnn.onnx",
  "Phoenix-Gobsch": "gobsch-crnn.onnx",
  "Phoenix-Lacrimat": "lacrimat-crnn.onnx",
  "Phoenix-Xersesch": "xersesch-crnn.onnx",
  "Phoenix-Nalya": "nalya-crnn.onnx",
  "Phoenix-Nalya-Shirin": "nalya-shirin-crnn.onnx",
  "Phoenix-Lem-Kai": "lem-kai-crnn.onnx",
};
const crnnModels = {};
for (const [font, file] of Object.entries(crnnModelFiles)) {
  crnnModels[font] = fs.readFileSync(path.join(here, "models", file)).toString("base64");
}
const ortWasmPath = require.resolve("onnxruntime-web/ort-wasm-simd-threaded.wasm");
const ortMjsPath = require.resolve("onnxruntime-web/ort-wasm-simd-threaded.mjs");
const ortWasm = fs.readFileSync(ortWasmPath);
function writeCrnnModule(models, wasm) {
  fs.writeFileSync(
    path.join(src, "generated-crnn.js"),
    `// Automatisch erzeugt von build.mjs -- nicht von Hand bearbeiten.\n` +
    `export const CRNN_MODEL_FILES = ${JSON.stringify(crnnModelFiles)};\n` +
    `export const CRNN_MODELS_BASE64 = ${JSON.stringify(models)};\n` +
    `export const ORT_WASM_BASE64 = ${JSON.stringify(wasm)};\n`,
  );
}
writeCrnnModule(crnnModels, ortWasm.toString("base64"));

const customLines = fs.readFileSync(path.join(src, "custom-words.txt"), "utf8")
  .split("\n")
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith("#"));

const dicText = new TextDecoder("utf8").decode(dictionaryDe.dic);
const lowerStems = new Set();
const capStems = new Set();
for (const line of dicText.split(/\r?\n/)) {
  if (!line || line.startsWith("\t") || line.startsWith("#")) continue;
  if (/^\d+$/.test(line.trim())) continue;
  const [raw0, flags = ""] = line.split("/");
  const raw = (raw0 || "").trim();
  if (!/^[A-Za-zÄÖÜäöüß]+$/.test(raw)) continue;
  // ozm/hke: reine Gross-/Kleinschreib-Varianten, keine eigenen Woerter.
  if (flags.includes("ozm") || flags.includes("hke")) continue;
  const t = translit(raw);
  if (t.length < 2) continue;
  if (/^[a-zäöü]/.test(raw)) lowerStems.add(t);
  else if (/^[A-ZÄÖÜ]/.test(raw)) capStems.add(t);
}

function isNounKey(t) {
  return capStems.has(t) && !lowerStems.has(t);
}

const words = [];
const nounFlags = [];
const seen = new Set();
const MAX_COMMON_WORDS = 12_000;
function addWord(t, noun) {
  if (t.length < 2 || seen.has(t)) return;
  seen.add(t);
  words.push(t);
  nounFlags.push(!!noun);
}

for (const w of germanWords) {
  const t = translit(w);
  if (t.length < 2 || seen.has(t) || !isGerman(w)) continue;
  addWord(t, isNounKey(t));
  if (words.length >= MAX_COMMON_WORDS) break;
}

for (const w of [
  "Baden-Württemberg",
  "Mecklenburg-Vorpommern",
  "Nordrhein-Westfalen",
  "Rheinland-Pfalz",
  "Sachsen-Anhalt",
  "Schleswig-Holstein",
]) {
  addWord(translit(w), true);
}

for (const w of customLines) {
  const t = translit(w);
  if (t.length < 2) continue;
  const noun = isNounKey(t) || /^[A-ZÄÖÜ]/.test(w);
  if (seen.has(t)) {
    const i = words.indexOf(t);
    if (i >= 0) nounFlags[i] = nounFlags[i] || noun;
  } else {
    addWord(t, noun);
  }
}

const bytes = Buffer.alloc(Math.ceil(nounFlags.length / 8));
for (let i = 0; i < nounFlags.length; i++) {
  if (nounFlags[i]) bytes[i >> 3] |= 1 << (i & 7);
}

const customSet = new Set(customLines.map(translit).filter((t) => t.length >= 2));
fs.writeFileSync(
  path.join(src, "generated-dict.js"),
  `// Automatisch erzeugt von build.mjs -- nicht von Hand bearbeiten.\n` +
  `export const DICT_WORDS = ${JSON.stringify(words.join(" "))};\n` +
  `export const DICT_NOUN_BITS = ${JSON.stringify(bytes.toString("base64"))};\n` +
  `export const CUSTOM_WORDS = ${JSON.stringify([...customSet].join(" "))};\n`,
);
console.log(`Woerterbuch: ${words.length} Woerter (davon ${customLines.length} eigene, ${nounFlags.filter(Boolean).length} Nomen)`);

// 2. Worker- und App-Code je zu einem IIFE buendeln (keine ES-Module zur
//    Laufzeit -- vermeidet CORS-Stolperfallen bei file://).
async function bundle(entry) {
  const res = await esbuild.build({
    entryPoints: [path.join(src, entry)],
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "safari15",
    write: false,
    logLevel: "silent",
  });
  return res.outputFiles[0].text;
}

const workerCode = await bundle("worker.js");
writeCrnnModule({}, "");
const cloudflareWorkerCode = await bundle("worker.js");
writeCrnnModule(crnnModels, ortWasm.toString("base64"));
const appCode = await bundle("app.js");
const dictWorkerCode = await bundle("dict-worker.js");

// 3. Offline-Einzeldatei und schlanken Cloudflare-Build erzeugen.
const css = fs.readFileSync(path.join(src, "style.css"), "utf8");
function renderHtml(worker) {
  let html = fs.readFileSync(path.join(src, "index.html"), "utf8");
  html = html.replace(
    '<link rel="stylesheet" href="style.css" />',
    `<style>\n${css}\n</style>`,
  );
  return html.replace(
    '<script type="module" src="app.js"></script>',
    `<script>\n` +
    `globalThis.__WORKER_SRC__ = ${JSON.stringify(worker)};\n` +
    `globalThis.__DICT_WORKER_SRC__ = ${JSON.stringify(dictWorkerCode)};\n` +
    `</script>\n<script>\n${appCode}\n</script>`,
  );
}

const outPath = path.join(dist, "index.html");
fs.writeFileSync(outPath, renderHtml(workerCode));
fs.copyFileSync(path.join(src, "_headers"), path.join(dist, "_headers"));
fs.copyFileSync(ortWasmPath, path.join(dist, "ort-wasm-simd-threaded.wasm"));
fs.copyFileSync(ortMjsPath, path.join(dist, "ort-wasm-simd-threaded.mjs"));

const eggSound = path.join(here, "sound", "among-us.mp3");
function copyEggSound(destDir) {
  const soundDir = path.join(destDir, "sound");
  fs.mkdirSync(soundDir, { recursive: true });
  fs.copyFileSync(eggSound, path.join(soundDir, "among-us.mp3"));
}
copyEggSound(dist);

const cloudflarePath = path.join(distCloudflare, "index.html");
fs.writeFileSync(cloudflarePath, renderHtml(cloudflareWorkerCode));
fs.copyFileSync(path.join(src, "_headers"), path.join(distCloudflare, "_headers"));
fs.copyFileSync(ortWasmPath, path.join(distCloudflare, "ort-wasm-simd-threaded.wasm"));
fs.copyFileSync(ortMjsPath, path.join(distCloudflare, "ort-wasm-simd-threaded.mjs"));
for (const file of Object.values(crnnModelFiles)) {
  fs.copyFileSync(path.join(here, "models", file), path.join(distCloudflare, file));
}
copyEggSound(distCloudflare);

const kb = (fs.statSync(outPath).size / 1024).toFixed(0);
const cloudflareKb = (fs.statSync(cloudflarePath).size / 1024).toFixed(0);
console.log(`dist/index.html geschrieben (${kb} KB, offline)`);
console.log(`dist-cloudflare/index.html geschrieben (${cloudflareKb} KB, externe Modelle)`);

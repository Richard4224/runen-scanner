// Paralleler CER-Bench gegen img/real/{Font}-{9|15}pt-{A1|B2}.jpg
//
//   node scripts/bench_real_set.mjs              # alle 16
//   node scripts/bench_real_set.mjs B2           # nur B2
//   node scripts/bench_real_set.mjs Taluz B2
//   node scripts/bench_real_set.mjs --dict

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const imgDir = path.join(root, "img", "real");
const atlasPath = path.join(root, "src", "atlas.json");
const maxDim = 1100;

const useDict = process.argv.includes("--dict");
const filters = process.argv.slice(2).filter((a) => !a.startsWith("-"));

const translit = (w) =>
  w
    .toUpperCase()
    .replace(/Ä/g, "AE")
    .replace(/Ö/g, "OE")
    .replace(/Ü/g, "UE")
    .replace(/ß/gi, "SS")
    .replace(/[^A-Z\s]/g, " ");

const norm = (s) => translit(s).replace(/\s+/g, " ").trim();

// normWant muss serialisierbar in den Worker — dort nochmal lokal.
// Hier nur fuer Ground Truth.
const truth = {
  A1: norm(fs.readFileSync(path.join(root, "test material", "A1"), "utf8")),
  B2: norm(fs.readFileSync(path.join(root, "test material", "B2"), "utf8")),
};

let dictPayload = null;
if (useDict) {
  const gen = path.join(root, "src", "generated-dict.js");
  if (!fs.existsSync(gen)) {
    console.error("src/generated-dict.js fehlt — bitte zuerst: node build.mjs");
    process.exit(1);
  }
  const mod = await import("../src/generated-dict.js");
  dictPayload = { words: mod.DICT_WORDS, custom: mod.CUSTOM_WORDS, nounBits: mod.DICT_NOUN_BITS };
}

const files = fs.readdirSync(imgDir).filter((f) => f.endsWith(".jpg")).sort();
const atlasFonts = Object.keys(JSON.parse(fs.readFileSync(atlasPath, "utf8")).fonts);

const items = [];
for (const file of files) {
  const m = file.match(/^(.+)-(\d+)pt-(A1|B2)\.jpg$/i);
  if (!m) continue;
  const fontShort = m[1];
  const brief = m[3].toUpperCase();
  const font = `Phoenix-${fontShort}`;
  if (!atlasFonts.includes(font)) {
    console.warn(`Unbekannter Font: ${file}`);
    continue;
  }
  if (
    filters.length &&
    !filters.every(
      (f) => font.includes(f) || brief === f.toUpperCase() || fontShort.includes(f),
    )
  ) {
    continue;
  }
  items.push({ file, font, brief, want: truth[brief] });
}

const nWorkers = Math.max(1, Math.min(os.cpus().length, items.length));
const chunks = Array.from({ length: nWorkers }, () => []);
items.forEach((item, i) => chunks[i % nWorkers].push(item));

console.log(
  `${items.length} Fotos auf ${nWorkers} Worker  maxDim=${maxDim}  dict=${useDict ? "an" : "aus"}`,
);
console.log(`A1-Soll ${truth.A1.length} Zeichen, B2-Soll ${truth.B2.length} Zeichen\n`);
const t0 = Date.now();

const results = (
  await Promise.all(
    chunks.map(
      (chunk) =>
        new Promise((resolve, reject) => {
          if (!chunk.length) return resolve([]);
          const w = new Worker(path.join(here, "bench_real_worker.mjs"), {
            workerData: { imgDir, atlasPath, items: chunk, maxDim, dictPayload },
          });
          w.on("message", resolve);
          w.on("error", reject);
        }),
    ),
  )
).flat();

results.sort((a, b) => a.file.localeCompare(b.file));

const byBrief = new Map();
const byFont = new Map();
let shown = 0;

for (const r of results) {
  for (const [map, key] of [
    [byBrief, r.brief],
    [byFont, r.font.replace("Phoenix-", "")],
  ]) {
    const s = map.get(key) || { n: 0, cer: 0, sec: 0 };
    s.n++;
    s.cer += r.cer;
    s.sec += r.sec;
    map.set(key, s);
  }
  console.log(
    `${r.file.padEnd(28)} CER ${(r.cer * 100).toFixed(1).padStart(5)}%  ` +
      `${r.sec.toFixed(1).padStart(5)}s  Zeilen ${String(r.lines).padStart(2)}  ` +
      `conf ${r.conf.toFixed(2)}`,
  );
  if (r.cer > 0.05 && shown < 6) {
    shown++;
    console.log(`  soll: ${r.want.slice(0, 90)}…`);
    console.log(`  ist : ${r.got.slice(0, 90)}…`);
  }
}

function table(title, map) {
  console.log(`\n${title}`);
  console.log("  " + "".padEnd(16) + "  CER      Zeit/Foto");
  for (const [k, s] of [...map.entries()].sort()) {
    console.log(
      `  ${k.padEnd(16)}  ${((s.cer / s.n) * 100).toFixed(1).padStart(5)} %  ` +
        `${(s.sec / s.n).toFixed(1).padStart(5)} s   (n=${s.n})`,
    );
  }
}

table("Nach Brief", byBrief);
table("Nach Font", byFont);
const wall = (Date.now() - t0) / 1000;
const cpu = results.reduce((s, r) => s + r.sec, 0);
console.log(
  `\nWall ${wall.toFixed(1)}s  CPU-Summe ${cpu.toFixed(1)}s  ` +
    `(${(cpu / Math.max(wall, 0.01)).toFixed(1)}x parallel)`,
);

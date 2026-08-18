// Wie run.js, aber verteilt die Testbriefe auf mehrere Worker-Threads --
// die Dekodierung eines Briefs haengt nicht vom naechsten ab, also
// embarrassingly parallel. Auf 16 Kernen ~ Faktor 10-14x schneller als
// der sequentielle Lauf.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(here, "data");
const atlasPath = path.join(here, "..", "src", "atlas.json");
const index = JSON.parse(fs.readFileSync(path.join(dataDir, "index.json"), "utf8"));

const filters = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const verbose = process.argv.includes("-v");
const items = index.filter((item) => filters.every((f) => item.font === f || item.level === f));

const nWorkers = Math.max(1, Math.min(os.cpus().length, items.length));
const chunks = Array.from({ length: nWorkers }, () => []);
items.forEach((item, i) => chunks[i % nWorkers].push(item));

console.log(`${items.length} Briefe auf ${nWorkers} Worker verteilt ...`);
const t0 = Date.now();

const results = await Promise.all(
  chunks.map(
    (chunk) =>
      new Promise((resolve, reject) => {
        if (!chunk.length) return resolve([]);
        const w = new Worker(path.join(here, "run_worker.mjs"), {
          workerData: { dataDir, atlasPath, items: chunk },
        });
        w.on("message", resolve);
        w.on("error", reject);
      }),
  ),
);
const all = results.flat();

const stats = new Map();
let shown = 0;
for (const r of all) {
  for (const key of [r.font, r.level]) {
    const s = stats.get(key) || { n: 0, cer: 0, perfect: 0 };
    s.n++; s.cer += r.cer; s.perfect += r.cer === 0 ? 1 : 0;
    stats.set(key, s);
  }
  if (verbose && r.cer > 0 && shown < 25) {
    shown++;
    console.log(`\n  ${r.font} / ${r.level} / ${r.size}px  CER ${(r.cer * 100).toFixed(1)}%`);
    console.log(`    soll: ${r.text.replace(/\s+/g, " ").trim().toUpperCase()}`);
    console.log(`    ist : ${r.got.replace(/\s+/g, " ").trim().toUpperCase()}`);
  }
}

const rows = [...stats.entries()];
const fonts = rows.filter(([k]) => k.startsWith("Phoenix"));
const levels = rows.filter(([k]) => !k.startsWith("Phoenix"));

function table(title, entries) {
  if (!entries.length) return;
  console.log(`\n${title}`);
  console.log("  " + "".padEnd(24) + "  CER      fehlerfrei");
  for (const [key, s] of entries) {
    const cer = (s.cer / s.n) * 100;
    console.log(
      `  ${key.padEnd(24)}  ${cer.toFixed(1).padStart(5)} %  ` +
      `${String(s.perfect).padStart(4)}/${s.n}`,
    );
  }
}

table("Nach Sprache", fonts);
table("Nach Aufnahmequalitaet", levels);

const totals = fonts.reduce((a, [, s]) => ({ n: a.n + s.n, cer: a.cer + s.cer, perfect: a.perfect + s.perfect }),
  { n: 0, cer: 0, perfect: 0 });
if (totals.n) {
  const dt = (Date.now() - t0) / 1000;
  console.log(`\nGesamt: CER ${((totals.cer / totals.n) * 100).toFixed(1)} %   ` +
    `fehlerfrei ${totals.perfect}/${totals.n}   ` +
    `${dt.toFixed(1)} s total (${(dt / totals.n).toFixed(2)} s/Brief effektiv, ${nWorkers} Worker)`);
}
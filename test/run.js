// Prueflauf gegen die kuenstlichen Testbriefe aus tools/gen_testdata.py.
//
// Gemessen wird die Zeichenfehlerrate (CER): Anteil der Zeichen, die
// eingefuegt, geloescht oder verwechselt werden muessten, um auf den
// bekannten Klartext zu kommen. 0 % = fehlerfrei.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { prepareAtlas } from "../src/core/atlas.js";
import { readPage } from "../src/core/pipeline.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(here, "data");

const atlas = prepareAtlas(
  JSON.parse(fs.readFileSync(path.join(here, "..", "src", "atlas.json"), "utf8")),
);
const index = JSON.parse(fs.readFileSync(path.join(dataDir, "index.json"), "utf8"));

/** Levenshtein-Distanz, zeilenweise Speicher. */
function distance(a, b) {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[b.length];
}

const norm = (s) => s.replace(/\s+/g, " ").trim().toUpperCase();

// Filter: beliebig viele Begriffe, alle muessen passen (Sprache oder Stufe).
// z. B.  node test/run.js Phoenix-Runen leicht -v
const filters = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const verbose = process.argv.includes("-v");
const stats = new Map();
const t0 = Date.now();
let shown = 0;

for (const item of index) {
  if (!filters.every((f) => item.font === f || item.level === f)) continue;

  const buf = fs.readFileSync(path.join(dataDir, item.file));
  const img = { w: item.w, h: item.h, data: new Uint8Array(buf) };

  const res = readPage(img, atlas, item.font);
  const got = norm(res.text);
  const want = norm(item.text);
  const cer = want.length ? distance(got, want) / want.length : 1;

  for (const key of [item.font, item.level]) {
    const s = stats.get(key) || { n: 0, cer: 0, perfect: 0 };
    s.n++; s.cer += cer; s.perfect += cer === 0 ? 1 : 0;
    stats.set(key, s);
  }

  if (verbose && cer > 0 && shown < 25) {
    shown++;
    console.log(`\n  ${item.font} / ${item.level} / ${item.size}px  CER ${(cer * 100).toFixed(1)}%`);
    console.log(`    soll: ${want}`);
    console.log(`    ist : ${got}`);
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

const all = fonts.reduce((a, [, s]) => ({ n: a.n + s.n, cer: a.cer + s.cer, perfect: a.perfect + s.perfect }),
  { n: 0, cer: 0, perfect: 0 });
if (all.n) {
  console.log(`\nGesamt: CER ${((all.cer / all.n) * 100).toFixed(1)} %   ` +
    `fehlerfrei ${all.perfect}/${all.n}   ` +
    `${((Date.now() - t0) / all.n / 1000).toFixed(2)} s pro Brief`);
}

// Gezielte Zeichendiagnose: isolierte Runen, Alphabetzeile, saubere Briefe.
//
//   python tools/gen_letters.py
//   node test/chars.js
//
// Schreibt test/chars_report.txt und eine kurze Tabelle nach stdout.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

const here = path.dirname(fileURLToPath(import.meta.url));
const atlasPath = path.join(here, "..", "src", "atlas.json");
const reportPath = path.join(here, "chars_report.txt");

function decodeAll(dataDir, items) {
  if (!items.length) return Promise.resolve([]);
  const nWorkers = Math.max(1, Math.min(os.cpus().length, items.length));
  const chunks = Array.from({ length: nWorkers }, () => []);
  items.forEach((item, i) => chunks[i % nWorkers].push(item));
  return Promise.all(
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
  ).then((r) => r.flat());
}

function edits(got, want) {
  const n = got.length, m = want.length;
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = 0; i <= n; i++) dp[i][0] = i;
  for (let j = 0; j <= m; j++) dp[0][j] = j;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (got[i - 1] === want[j - 1] ? 0 : 1),
      );
    }
  }
  const out = [];
  let i = n, j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && dp[i][j] === dp[i - 1][j - 1] + (got[i - 1] === want[j - 1] ? 0 : 1)) {
      out.push(got[i - 1] === want[j - 1]
        ? { op: "eq", want: want[j - 1], got: got[i - 1] }
        : { op: "sub", want: want[j - 1], got: got[i - 1] });
      i--; j--;
    } else if (i > 0 && dp[i][j] === dp[i - 1][j] + 1) {
      out.push({ op: "ins", want: "", got: got[i - 1] });
      i--;
    } else {
      out.push({ op: "del", want: want[j - 1], got: "" });
      j--;
    }
  }
  out.reverse();
  return out;
}

const atlas = JSON.parse(fs.readFileSync(atlasPath, "utf8"));
const ambOf = (font, ch) => {
  for (const g of atlas.fonts[font]?.ambiguous || []) {
    if (g.includes(ch)) return g;
  }
  return ch;
};
const sameAmb = (font, a, b) => a && b && ambOf(font, a) === ambOf(font, b) && ambOf(font, a).length > 1;

const charsDir = path.join(here, "chars");
const dataDir = path.join(here, "data");
if (!fs.existsSync(path.join(charsDir, "index.json"))) {
  console.error("Zuerst:  python tools/gen_letters.py");
  process.exit(1);
}

const charIndex = JSON.parse(fs.readFileSync(path.join(charsDir, "index.json"), "utf8"));
const wordIndex = JSON.parse(fs.readFileSync(path.join(dataDir, "index.json"), "utf8"))
  .filter((i) => i.level === "sauber");

console.log(`Dekodiere ${charIndex.length} Zeichenbilder + ${wordIndex.length} saubere Briefe ...`);
const t0 = Date.now();
const [charRes, wordRes] = await Promise.all([
  decodeAll(charsDir, charIndex),
  decodeAll(dataDir, wordIndex),
]);
const dt = ((Date.now() - t0) / 1000).toFixed(1);

const norm = (s) => s.replace(/\s+/g, " ").trim().toUpperCase();
const lines = [];
const log = (s = "") => lines.push(s);

log(`Runen-Zeichenfehler  (${dt}s)`);
log(`isoliert + Alphabetzeile + saubere Briefe. Roh = ohne Mehrdeutigkeit, net = QT/LV usw. ignoriert.`);
log();

// --- isoliert ---
const isoByFont = new Map();
const isoFail = [];
for (const r of charRes.filter((r) => r.level === "isoliert")) {
  const want = r.text.trim().toUpperCase();
  const got = norm(r.got).replace(/ /g, "");
  const ok = got === want || (got.length === 1 && sameAmb(r.font, got, want));
  const s = isoByFont.get(r.font) || { n: 0, ok: 0, fails: [] };
  s.n++; if (ok) s.ok++; else s.fails.push(`${want}→${got || "∅"}`);
  isoByFont.set(r.font, s);
  if (!ok) isoFail.push({ font: r.font, want, got });
}

log("=== Isoliert (eine Rune allein) ===");
log("Font                      richtig   Fehler");
for (const [font, s] of isoByFont) {
  log(`  ${font.replace("Phoenix-", "").padEnd(22)} ${String(s.ok).padStart(2)}/${s.n}    ${s.fails.join("  ") || "—"}`);
}

log("\n=== Alphabetzeile A–Z ===");
for (const r of charRes.filter((x) => x.level === "alphabet")) {
  const want = r.text.replace(/\s/g, "");
  const got = norm(r.got).replace(/ /g, "");
  const ev = edits(got, want);
  const subs = ev.filter((e) => e.op === "sub").map((e) => `${e.want}→${e.got}`);
  const ins = ev.filter((e) => e.op === "ins").map((e) => `+${e.got}`);
  const del = ev.filter((e) => e.op === "del").map((e) => `-${e.want}`);
  const cer = want.length ? r.cer : 1;
  log(`  ${r.font.replace("Phoenix-", "").padEnd(22)} CER ${(cer * 100).toFixed(0).padStart(3)}%  ${[...subs, ...ins, ...del].slice(0, 12).join(" ") || "ok"}`);
  log(`    soll ${want}`);
  log(`    ist  ${got || "∅"}`);
}

// --- sauber words ---
const confRaw = new Map();
const confNet = new Map();
const missRaw = new Map(); // expected letter -> {n, err}
const firstVsRest = { first: { n: 0, err: 0 }, rest: { n: 0, err: 0 } };
const perFontWord = new Map();

function bump(map, key) {
  map.set(key, (map.get(key) || 0) + 1);
}
function miss(font, ch) {
  const k = font + ":" + ch;
  const s = missRaw.get(k) || { n: 0, err: 0, font, ch };
  return s;
}

for (const r of wordRes) {
  const want = norm(r.text);
  const got = norm(r.got);
  const ev = edits(got.replace(/ /g, " "), want); // keep spaces for word-start
  // Use versions WITH spaces to detect word starts
  const evSp = edits(got, want);
  let atWordStart = true;
  const fontStat = perFontWord.get(r.font) || { n: 0, cer: 0, subs: [] };
  fontStat.n++; fontStat.cer += r.cer;
  perFontWord.set(r.font, fontStat);

  for (const e of evSp) {
    if (e.op === "eq") {
      if (e.want === " ") { atWordStart = true; continue; }
      const m = miss(r.font, e.want);
      m.n++; missRaw.set(r.font + ":" + e.want, m);
      const bucket = atWordStart ? firstVsRest.first : firstVsRest.rest;
      bucket.n++;
      atWordStart = false;
    } else if (e.op === "sub") {
      if (e.want === " " || e.got === " ") { atWordStart = e.got === " " || e.want === " "; continue; }
      const m = miss(r.font, e.want);
      m.n++; m.err++; missRaw.set(r.font + ":" + e.want, m);
      bump(confRaw, `${r.font}:${e.want}→${e.got}`);
      if (!sameAmb(r.font, e.want, e.got)) bump(confNet, `${r.font}:${e.want}→${e.got}`);
      const bucket = atWordStart ? firstVsRest.first : firstVsRest.rest;
      bucket.n++; bucket.err++;
      fontStat.subs.push(`${e.want}→${e.got}`);
      atWordStart = false;
    } else if (e.op === "del") {
      if (e.want === " ") { atWordStart = true; continue; }
      const m = miss(r.font, e.want);
      m.n++; m.err++; missRaw.set(r.font + ":" + e.want, m);
      bump(confRaw, `${r.font}:${e.want}→∅`);
      bump(confNet, `${r.font}:${e.want}→∅`);
      const bucket = atWordStart ? firstVsRest.first : firstVsRest.rest;
      bucket.n++; bucket.err++;
      atWordStart = false;
    } else if (e.op === "ins") {
      if (e.got === " ") continue;
      bump(confRaw, `${r.font}:∅→${e.got}`);
      bump(confNet, `${r.font}:∅→${e.got}`);
    }
  }
}

log("\n=== Saubere Briefe, CER je Font ===");
for (const [font, s] of perFontWord) {
  log(`  ${font.replace("Phoenix-", "").padEnd(22)} ${(s.cer / s.n * 100).toFixed(1)}%`);
}

const pct = (e, n) => n ? `${(e / n * 100).toFixed(0)}% (${e}/${n})` : "—";
log("\n=== Wortanfang vs. Rest (sauber, alle Fonts) ===");
log(`  erster Buchstabe  ${pct(firstVsRest.first.err, firstVsRest.first.n)}`);
log(`  weitere           ${pct(firstVsRest.rest.err, firstVsRest.rest.n)}`);

function topEntries(map, k) {
  return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, k);
}

log("\n=== Häufigste Verwechslungen (sauber, ohne Font-Mehrdeutigkeit) ===");
const net = topEntries(confNet, 20);
if (!net.length) log("  —");
for (const [k, n] of net) {
  const [font, pair] = k.split(":");
  log(`  ${String(n).padStart(3)}  ${font.replace("Phoenix-", "").padEnd(16)} ${pair}`);
}

log("\n=== Buchstaben mit der höchsten Fehlerrate, wenn sie erwartet werden (sauber) ===");
const missList = [...missRaw.values()].filter((s) => s.n >= 3);
missList.sort((a, b) => b.err / b.n - a.err / a.n);
for (const s of missList.slice(0, 25)) {
  if (s.err === 0) continue;
  log(`  ${s.font.replace("Phoenix-", "").padEnd(16)} ${s.ch}  ${pct(s.err, s.n)}`);
}

// Isoliert vs Wort: welche Buchstaben isoliert klappen, im Wort nicht (Kontext)
log("\n=== Isoliert ok, im Wort oft falsch (Kontext/Nachbar) ===");
const isoOk = new Set(charRes.filter((r) => r.level === "isoliert").filter((r) => {
  const want = r.text.trim().toUpperCase();
  const got = norm(r.got).replace(/ /g, "");
  return got === want || (got.length === 1 && sameAmb(r.font, got, want));
}).map((r) => r.font + ":" + r.text.trim().toUpperCase()));
let ctxN = 0;
for (const s of missList) {
  if (s.err / s.n < 0.2) continue;
  if (isoOk.has(s.font + ":" + s.ch)) {
    log(`  ${s.font.replace("Phoenix-", "").padEnd(16)} ${s.ch}  isoliert ok, im Wort ${pct(s.err, s.n)}`);
    ctxN++;
  }
}
if (!ctxN) log("  —");

log("\n=== Isoliert schon falsch (Vorlage/Form) ===");
if (!isoFail.length) log("  —");
for (const f of isoFail) {
  log(`  ${f.font.replace("Phoenix-", "").padEnd(16)} ${f.want}→${f.got || "∅"}`);
}

fs.writeFileSync(reportPath, lines.join("\n") + "\n", "utf8");
console.log(lines.join("\n"));
console.log(`\n-> ${reportPath}`);

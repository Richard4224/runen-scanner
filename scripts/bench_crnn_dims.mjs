// Misst CRNN-CER ueber mehrere Prozess-Aufloesungen. Aendert die App nicht.

import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const fonts = [
  ["Runen", "runen"],
  ["Taluz", "taluz"],
  ["Gobsch", "gobsch"],
  ["Lacrimat", "lacrimat"],
  ["Xersesch", "xersesch"],
  ["Nalya", "nalya"],
  ["Nalya-Shirin", "nalya-shirin"],
  ["Lem-Kai", "lem-kai"],
];
const dims = (process.argv[2] || "1100,1600,2200,4000").split(",").map(Number);
const concurrency = Math.min(Number(process.argv[3] || 4), os.availableParallelism?.() || 4);

const items = [];
for (const dim of dims) {
  for (const [photo, model] of fonts) {
    items.push({
      font: photo,
      level: "B2",
      dim,
      photo: `img/real/${photo}-15pt-B2.jpg`,
      model: `models/${model}-crnn.onnx`,
    });
    items.push({
      font: photo,
      level: "A1",
      dim,
      photo: `img/real/${photo}-9pt-A1.jpg`,
      model: `models/${model}-crnn.onnx`,
    });
  }
  items.push({
    font: "Xersesch-Scan",
    level: "B2",
    dim,
    photo: "img/real/Scan-Phoenix-Xersesch-15pt-B2.jpg",
    model: "models/xersesch-crnn.onnx",
  });
}

function run(item) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ["scripts/bench_crnn.mjs", item.photo, item.model, String(item.dim)],
      { cwd: root, windowsHide: true },
    );
    let stdout = "", stderr = "";
    child.stdout.on("data", (data) => { stdout += data; });
    child.stderr.on("data", (data) => { stderr += data; });
    child.on("close", (code) => {
      const cer = stdout.match(/CER exakt ([\d.]+)%\s+Mehrdeutigkeits-bereinigt ([\d.]+)%/);
      const time = stdout.match(/Vorbereitung ([\d.]+)s\s+Inference ([\d.]+)s\s+\(([\d.]+)ms\/Zeile\)/);
      const lines = stdout.match(/Zeilen: (\d+)/);
      const size = stdout.match(/→ (\d+)x(\d+)/);
      resolve({
        ...item,
        ok: code === 0 && !!cer,
        cer: cer ? Number(cer[1]) : NaN,
        adjusted: cer ? Number(cer[2]) : NaN,
        prep: time ? Number(time[1]) : NaN,
        infer: time ? Number(time[2]) : NaN,
        msPerLine: time ? Number(time[3]) : NaN,
        lines: lines ? Number(lines[1]) : 0,
        dw: size ? Number(size[1]) : 0,
        dh: size ? Number(size[2]) : 0,
        error: code === 0 ? "" : (stderr.trim() || stdout.trim()).slice(0, 200),
      });
    });
  });
}

const results = [];
let next = 0;
async function worker() {
  while (next < items.length) {
    const item = items[next++];
    const result = await run(item);
    results.push(result);
    console.log(
      `${String(item.dim).padStart(4)}  ${item.font.padEnd(14)} ${item.level}  ` +
      (result.ok
        ? `CER ${result.adjusted.toFixed(1).padStart(5)}%  ` +
          `${String(result.lines).padStart(2)} Z  ` +
          `${result.dw}x${result.dh}  prep ${result.prep.toFixed(2)}s`
        : `FEHLER ${result.error}`),
    );
  }
}

await Promise.all(Array.from({ length: concurrency }, () => worker()));

const photos = results.filter((r) => r.font !== "Xersesch-Scan");
console.log("\n=== Mittel ueber 16 Handyfotos (bereinigte CER) ===");
for (const dim of dims) {
  const rows = photos.filter((r) => r.dim === dim && r.ok);
  const mean = rows.reduce((s, r) => s + r.adjusted, 0) / Math.max(rows.length, 1);
  const prep = rows.reduce((s, r) => s + r.prep, 0) / Math.max(rows.length, 1);
  const wins = photos.filter((r) => r.ok).reduce((n, r) => {
    const group = photos.filter((x) => x.ok && x.font === r.font && x.level === r.level);
    const best = Math.min(...group.map((x) => x.adjusted));
    return n + (r.dim === dim && r.adjusted === best ? 1 : 0);
  }, 0) / 2; // counted twice via reduce over rows; fix below
  console.log(
    `${dim}px  CER ${mean.toFixed(1)}%  prep ${prep.toFixed(2)}s  ` +
    `${rows.length}/${photos.filter((r) => r.dim === dim).length}`,
  );
}

console.log("\n=== Bester Dim je Foto ===");
const keys = [...new Set(photos.map((r) => `${r.font}\t${r.level}`))];
for (const key of keys) {
  const [font, level] = key.split("\t");
  const group = photos.filter((r) => r.font === font && r.level === level && r.ok);
  if (!group.length) continue;
  const best = group.reduce((a, b) => (a.adjusted < b.adjusted ? a : b));
  const base = group.find((r) => r.dim === dims[0]);
  const delta = base ? best.adjusted - base.adjusted : 0;
  console.log(
    `${font.padEnd(14)} ${level}  best ${String(best.dim).padStart(4)}px  ` +
    `${best.adjusted.toFixed(1)}%  ` +
    (base ? `(${delta >= 0 ? "+" : ""}${delta.toFixed(1)} vs ${dims[0]})` : ""),
  );
}

console.log("\n=== Xersesch-Scan ===");
for (const r of results.filter((x) => x.font === "Xersesch-Scan")) {
  console.log(
    r.ok
      ? `${r.dim}px  CER ${r.adjusted.toFixed(1)}%  ${r.lines} Zeilen  ${r.dw}x${r.dh}  prep ${r.prep.toFixed(2)}s`
      : `${r.dim}px  FEHLER ${r.error}`,
  );
}

if (results.some((r) => !r.ok)) process.exitCode = 1;

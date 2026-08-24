// Benchmarkt alle acht CRNN-Modelle parallel gegen B2 und A1.

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
const items = fonts.flatMap(([photo, model]) => [
  { font: photo, level: "B2", photo: `img/real/${photo}-15pt-B2.jpg`, model: `models/${model}-crnn.onnx` },
  { font: photo, level: "A1", photo: `img/real/${photo}-9pt-A1.jpg`, model: `models/${model}-crnn.onnx` },
]);
const concurrency = Math.min(Number(process.argv[2] || 4), os.availableParallelism?.() || 4);

function run(item) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ["scripts/bench_crnn.mjs", item.photo, item.model, "1100"],
      { cwd: root, windowsHide: true },
    );
    let stdout = "", stderr = "";
    child.stdout.on("data", (data) => { stdout += data; });
    child.stderr.on("data", (data) => { stderr += data; });
    child.on("close", (code) => {
      const cer = stdout.match(/CER exakt ([\d.]+)%\s+Mehrdeutigkeits-bereinigt ([\d.]+)%/);
      const time = stdout.match(/Inference ([\d.]+)s\s+\(([\d.]+)ms\/Zeile\)/);
      const lines = stdout.match(/Zeilen: (\d+)/);
      resolve({
        ...item,
        ok: code === 0 && !!cer,
        cer: cer ? Number(cer[1]) : NaN,
        adjusted: cer ? Number(cer[2]) : NaN,
        seconds: time ? Number(time[1]) : NaN,
        msPerLine: time ? Number(time[2]) : NaN,
        lines: lines ? Number(lines[1]) : 0,
        error: code === 0 ? "" : stderr.trim() || stdout.trim(),
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
      `${item.font.padEnd(13)} ${item.level}  ` +
      (result.ok
        ? `CER ${result.cer.toFixed(1).padStart(5)}%  bereinigt ${result.adjusted.toFixed(1).padStart(5)}%  ` +
          `${String(result.lines).padStart(2)} Zeilen  ${result.msPerLine.toFixed(1)} ms/Z`
        : `FEHLER ${result.error}`),
    );
  }
}

await Promise.all(Array.from({ length: concurrency }, () => worker()));
const valid = results.filter((result) => result.ok);
const mean = valid.reduce((sum, result) => sum + result.adjusted, 0) / Math.max(valid.length, 1);
console.log(`\n${valid.length}/${items.length} erfolgreich · mittlere bereinigte CER ${mean.toFixed(1)}%`);
if (valid.length !== items.length) process.exitCode = 1;

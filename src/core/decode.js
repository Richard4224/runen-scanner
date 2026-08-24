// Der eigentliche Decoder.
//
// Kein "erst zerschneiden, dann erkennen": bei diesen Schriften beruehren sich
// Runen (Phoenix-Runen), zerfallen in Einzelteile (Gobsch) oder haengen ganz
// zusammen (Lacrimat) -- eine Trennung ueber Luecken ist unmoeglich.
//
// Stattdessen wird jede der 26 Runen an jeder Position probeweise eingesetzt
// und bewertet. Ueber dynamische Programmierung ergibt sich daraus die
// Buchstabenfolge, die die Zeile insgesamt am besten erklaert -- die
// Vorschubbreiten des Fonts bestimmen dabei, wo die naechste Rune ansetzt.

/** Skaliert die Glyphen eines Fonts auf eine Ziel-Schriftgroesse. */
export function scaleGlyphs(font, emPx, em, alphabet) {
  const out = {};
  for (const ch of alphabet) {
    const g = font.letters[ch];
    const f = em / emPx;
    const sw = Math.max(1, Math.round(g.w * f));
    const sh = Math.max(1, Math.round(g.h * f));
    out[ch] = {
      adv: g.adv * em,
      dx: Math.round(g.x0 * em),
      dy: Math.round(g.y0 * em),
      w: sw,
      h: sh,
      mask: resample(g.pixels, g.w, g.h, sw, sh),
      ink: 0,
    };
    let s = 0;
    for (const v of out[ch].mask) s += v;
    out[ch].ink = s;
  }
  return out;
}

/** Bilineare Neuabtastung einer Graustufenflaeche auf 0..1. */
function resample(src, sw, sh, dw, dh) {
  const out = new Float32Array(dw * dh);
  if (!sw || !sh) return out;
  for (let y = 0; y < dh; y++) {
    const sy = ((y + 0.5) * sh) / dh - 0.5;
    const y0 = Math.max(0, Math.min(sh - 1, Math.floor(sy)));
    const y1 = Math.min(sh - 1, y0 + 1);
    const fy = Math.max(0, Math.min(1, sy - y0));
    for (let x = 0; x < dw; x++) {
      const sx = ((x + 0.5) * sw) / dw - 0.5;
      const x0 = Math.max(0, Math.min(sw - 1, Math.floor(sx)));
      const x1 = Math.min(sw - 1, x0 + 1);
      const fx = Math.max(0, Math.min(1, sx - x0));
      const a = src[y0 * sw + x0] * (1 - fx) + src[y0 * sw + x1] * fx;
      const b = src[y1 * sw + x0] * (1 - fx) + src[y1 * sw + x1] * fx;
      out[y * dw + x] = (a * (1 - fy) + b * fy) / 255;
    }
  }
  return out;
}

/**
 * Vorberechnung pro Zeilenbild, gecacht ueber die Ink-Referenz: dieselbe
 * Zeile wird pro Buchstabe an jeder Position bis zu 26 * (2*vslack+1) mal
 * abgefragt, bei mehreren Skalierungs-Kandidaten sogar mehrfach mit
 * demselben Zeilenbild (nur die Grundlinie aendert sich). scoreOnce lief
 * bis dahin ueber JEDES Pixel im Buchstabenfenster, auch die -- meist
 * grosse Mehrheit -- leeren. Zwei Tricks entschaerfen das, ohne das
 * Ergebnis zu veraendern:
 *  - imgInk (Tintenmenge im Fenster) ist nur eine Rechtecksumme -> per
 *    Integralbild in O(1) statt O(Fensterflaeche).
 *  - inter (Deckung mit der Buchstabenform) muss nur an Stellen mit Tinte
 *    ausgewertet werden -> Tinten-Lauflaengen je Bildzeile, statt jedes
 *    Pixel einzeln zu pruefen.
 */
const lineCache = new WeakMap();

function prepareLine(line) {
  let c = lineCache.get(line.ink);
  if (c) return c;
  const { w, h, ink } = line;

  const sum = new Int32Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let rs = 0;
    const row = y * w, s0 = y * (w + 1), s1 = (y + 1) * (w + 1);
    for (let x = 0; x < w; x++) {
      rs += ink[row + x];
      sum[s1 + x + 1] = sum[s0 + x + 1] + rs;
    }
  }

  const runs = new Array(h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    const r = [];
    let x = 0;
    while (x < w) {
      if (!ink[row + x]) { x++; continue; }
      const start = x;
      while (x < w && ink[row + x]) x++;
      r.push(start, x);
    }
    runs[y] = r;
  }

  c = { sum, runs, w, h };
  lineCache.set(line.ink, c);
  return c;
}

function boxSum(c, x0, y0, x1, y1) {
  x0 = Math.max(0, x0); y0 = Math.max(0, y0);
  x1 = Math.min(c.w, x1); y1 = Math.min(c.h, y1);
  if (x1 <= x0 || y1 <= y0) return 0;
  const s = c.sum, stride = c.w + 1;
  return s[y1 * stride + x1] - s[y0 * stride + x1] - s[y1 * stride + x0] + s[y0 * stride + x0];
}

/**
 * Bewertet eine Rune an einer Position: Dice-Mass zwischen Vorlage und Tinte.
 * 1 = perfekte Deckung, 0 = keine.
 */
function scoreOnce(line, g, x0, y0, xInk0, xInk1) {
  const c = prepareLine(line);
  // Tinte ueber den ganzen beanspruchten Streifen (Glyphenbox ∪ Vorschub),
  // nicht nur die Boundingbox. Sonst kann eine schmalere Rune ein Teilstueck
  // einer komplexeren (H vs. J/B bei Phoenix-Runen) mit hohem Dice gewinnen.
  const imgInk = boxSum(c, xInk0, y0, xInk1, y0 + g.h);
  if (imgInk === 0) return 0;

  let inter = 0;
  const yStart = Math.max(0, y0), yEnd = Math.min(line.h, y0 + g.h);
  const gx0 = x0, gx1 = x0 + g.w;
  for (let iy = yStart; iy < yEnd; iy++) {
    const rowRuns = c.runs[iy];
    if (!rowRuns.length) continue;
    const mrow = (iy - y0) * g.w;
    for (let i = 0; i < rowRuns.length; i += 2) {
      let rs = rowRuns[i], re = rowRuns[i + 1];
      if (re <= gx0 || rs >= gx1) continue;
      if (rs < gx0) rs = gx0;
      if (re > gx1) re = gx1;
      for (let ix = rs; ix < re; ix++) inter += g.mask[mrow + (ix - x0)];
    }
  }

  const denom = g.ink + imgInk;
  return denom > 0 ? (2 * inter) / denom : 0;
}

/**
 * Wie scoreOnce, aber mit etwas vertikalem Spiel.
 *
 * Nach dem Geraderuecken bleibt fast immer eine Restschraeglage von einem
 * Bruchteil eines Grades. Ueber eine lange Zeile wandert die Grundlinie
 * dadurch um mehrere Pixel -- horizontal faengt das der Vorschub-Spielraum
 * ab, vertikal gaebe es ohne diese Suche kein Gegenmittel.
 */
function scoreAt(line, g, penX, baseline, vslack) {
  const x0 = penX + g.dx;
  const xInk0 = Math.min(x0, penX);
  const xInk1 = Math.max(x0 + g.w, penX + Math.round(g.adv));
  const yb = Math.round(baseline) + g.dy;
  let best = 0;
  for (let dy = -vslack; dy <= vslack; dy++) {
    const s = scoreOnce(line, g, x0, yb + dy, xInk0, xInk1);
    if (s > best) best = s;
  }
  return best;
}

/** Spalten ohne Tinte -- fuer die Worttrennung. */
function columnInk(line) {
  const cols = new Int32Array(line.w);
  for (let y = 0; y < line.h; y++) {
    const row = y * line.w;
    for (let x = 0; x < line.w; x++) if (line.ink[row + x]) cols[x]++;
  }
  return cols;
}

/**
 * Dekodiert eine Zeile.
 *
 * `insertion` ist der Preis, den eine Rune "kosten" muss, damit sie gesetzt
 * wird. Ohne ihn wuerde die Summenbewertung immer moeglichst viele Runen
 * bevorzugen, weil jede zusaetzliche nur Punkte addiert.
 */
export function decodeLine(line, glyphs, alphabet, opts = {}) {
  const {
    insertion = 0.45,
    jitter = 1,
    jitterCost = 0.02,
    // Mindest-Wortluecke in em (nicht avgAdv): Buchstabenabstand ist ~0.05–0.08 em,
    // Phoenix-Runen-Wortzwischenraum ~0.19 em. Schwelle darunter → Spaces mitten im Wort
    // (Taluz), deutlich darueber → echte Spaces verschluckt.
    minGapEm = 0.16,
    gapBonus = 0.05,
    em = null,
    vslack = 2,
  } = opts;
  const W = line.w;
  const cols = columnInk(line);
  const letters = [...alphabet];

  // Praefixsumme der Spaltentinte -> leere Bereiche in konstanter Zeit pruefen
  const pre = new Int32Array(W + 1);
  for (let x = 0; x < W; x++) pre[x + 1] = pre[x] + cols[x];
  const inkBetween = (a, b) => pre[Math.min(W, Math.max(0, b))] - pre[Math.min(W, Math.max(0, a))];
  const mostlyEmpty = (a, b) => inkBetween(a, b) <= Math.max(1, Math.round((b - a) * 0.05));

  const best = new Float64Array(W + 1).fill(-Infinity);
  const from = new Int32Array(W + 1).fill(-1);
  const via = new Array(W + 1).fill(null);
  // cropLine laesst ein paar leere Pixel vor der ersten Tinte. Die sind
  // schmaler als ein Wortzwischenraum -- wuerde die erste Rune bei x=0
  // andocken, sitzt sie neben der Tinte (H wird zu J/B).
  {
    let firstInk = 0;
    while (firstInk < W && cols[firstInk] === 0) firstInk++;
    const start = Math.max(0, firstInk - 2);
    for (let p = start; p <= firstInk; p++) best[p] = 0;
  }

  const avgAdv = letters.reduce((s, c) => s + glyphs[c].adv, 0) / letters.length;
  const emPx = em || avgAdv;
  const gapWidth = Math.max(3, Math.round(emPx * minGapEm));

  for (let p = 0; p <= W; p++) {
    if (best[p] === -Infinity) continue;

    for (const ch of letters) {
      const g = glyphs[ch];
      const base = Math.round(g.adv);
      if (base < 1) continue;
      // Auf den Vorschub bezogen, sonst gewinnen immer die schmalsten Runen:
      // ein fester Bonus pro eingesetztem Zeichen laesst sich mit vielen
      // schmalen Treffern billiger erkaufen als mit wenigen breiten, ganz
      // gleich wie gut die breiten wirklich passen (auffaellig bei Schriften
      // wie Nalya-Shirin, deren schmalste Rune nur ein Viertel der breitesten
      // misst).
      const s = (scoreAt(line, g, p, line.baseline, vslack) - insertion) * (base / avgAdv);
      for (let d = -jitter; d <= jitter; d++) {
        const np = p + base + d;
        if (np <= p || np > W) continue;
        const v = best[p] + s - Math.abs(d) * jitterCost;
        if (v > best[np]) { best[np] = v; from[np] = p; via[np] = ch; }
      }
    }

    // Wortzwischenraum: fast tintenfreie Strecke, mindestens minGapEm.
    // Nur am Ende der Luecke andocken (plus wenig Slack) -- frueher jedes
    // Pixel zu befuellen hat das DP auf Taluz/iPhone praktisch eingefroren.
    {
      const g0 = gapWidth;
      if (p + g0 <= W && mostlyEmpty(p, p + g0)) {
        let gMax = g0;
        while (p + gMax + 1 <= W && mostlyEmpty(p, p + gMax + 1)) gMax++;
        const slack = Math.min(2, Math.max(0, gMax - g0));
        for (let g = gMax - slack; g <= gMax; g++) {
          const np = p + g;
          const v = best[p] + gapBonus;
          if (v > best[np]) { best[np] = v; from[np] = p; via[np] = " "; }
        }
      }
    }
  }

  // Ende: irgendwo im rechten Randbereich, bester normierter Wert
  let endP = -1, endScore = -Infinity;
  const slack = Math.max(2, Math.round(avgAdv * 0.6));
  for (let p = Math.max(0, W - slack); p <= W; p++) {
    if (best[p] > endScore) { endScore = best[p]; endP = p; }
  }
  if (endP < 0 || endScore === -Infinity) return { text: "", score: 0 };

  const chars = [];
  for (let p = endP; p > 0 && from[p] >= 0; p = from[p]) chars.push(via[p]);
  chars.reverse();
  const text = chars.join("").replace(/\s+/g, " ").trim();
  const n = chars.filter((c) => c !== " ").length || 1;
  return { text, score: endScore / n + insertion, glyphCount: n };
}

// Nachbearbeitung: Decoder-Text gegen ein deutsches Woerterbuch halten.
// Absichtlich im Hauptthread -- der teure Decode ist schon fertig.

export function buildDict(dictWords, customWords = "", nounBits = "") {
  const words = dictWords.split(" ").filter(Boolean);
  const dictSet = new Set(words);
  const customSet = new Set(customWords.split(" ").filter(Boolean));
  const rank = new Map(words.map((w, i) => [w, i]));
  const byLen = new Map();
  for (const w of words) {
    const list = byLen.get(w.length) || [];
    list.push(w);
    byLen.set(w.length, list);
  }
  const nouns = unpackNouns(words, nounBits);
  return { dictSet, customSet, rank, byLen, nouns };
}

function unpackNouns(words, b64) {
  const nouns = new Set();
  if (!b64) return nouns;
  const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  for (let i = 0; i < words.length; i++) {
    if (bin[i >> 3] & (1 << (i & 7))) nouns.add(words[i]);
  }
  return nouns;
}

const PLACE_DISPLAY = {
  BADENWUERTTEMBERG: "Baden-Wuerttemberg",
  MECKLENBURGVORPOMMERN: "Mecklenburg-Vorpommern",
  NORDRHEINWESTFALEN: "Nordrhein-Westfalen",
  RHEINLANDPFALZ: "Rheinland-Pfalz",
  SACHSENANHALT: "Sachsen-Anhalt",
  SCHLESWIGHOLSTEIN: "Schleswig-Holstein",
};

/** Ein Grossbuchstaben-Token in deutsche Schreibweise bringen. */
export function formatWord(word, dict, sentenceStart) {
  if (!word) return word;
  if (word.length === 1) return word;
  const place = PLACE_DISPLAY[word];
  let out = place
    || (dict.nouns && dict.nouns.has(word)
      ? word.charAt(0) + word.slice(1).toLowerCase()
      : word.toLowerCase());
  if (sentenceStart) out = out.charAt(0).toUpperCase() + out.slice(1);
  return out;
}

/** Ganzen Decoder-Text (A-Z) nach deutscher Gross-/Kleinschreibung umsetzen. */
export function recaseText(text, dict) {
  let sentence = true;
  return text.replace(/[A-Z]+|[^A-Z]+/g, (tok) => {
    if (!/^[A-Z]+$/.test(tok)) {
      if (/[.!?\n]/.test(tok)) sentence = true;
      return tok;
    }
    const out = formatWord(tok, dict, sentence);
    sentence = false;
    return out;
  });
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[n];
}

function posMatches(a, b) {
  const n = Math.min(a.length, b.length);
  let k = 0;
  for (let i = 0; i < n; i++) if (a[i] === b[i]) k++;
  return k;
}

// Nur diese Buchstabenpaare sind in den Phoenix-Fonts wirklich leicht zu
// verwechseln. In-Dict-Woerter (QUER, NIE) werden nur dann ersetzt, wenn der
// Unterschied so ein Paar ist -- sonst wuerde QUER zu FUER, NIE zu DIE.
const CONFUSIONS = new Set(["EU", "UE", "BH", "HB", "TQ", "QT"]);

function isConfusionSwap(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) continue;
    diff++;
    if (diff > 1 || !CONFUSIONS.has(a[i] + b[i])) return false;
  }
  return diff === 1;
}

function threshold(len) {
  if (len <= 4) return 1;
  if (len <= 7) return 2;
  if (len <= 11) return 3;
  return 4;
}

function guessSingle(word, dict) {
  if (word.length < 2) return null;
  const maxD = threshold(word.length);
  const slack = word.length >= 6 ? 2 : 1;
  const lenLo = Math.max(2, word.length - slack);
  const lenHi = word.length + slack;
  const selfRank = dict.rank.get(word) ?? 99999;
  let best = null, bestDist = Infinity, bestPos = -1, bestSame = false, bestCustom = false, bestRank = Infinity;
  for (let len = lenLo; len <= lenHi; len++) {
    for (const cand of dict.byLen.get(len) || []) {
      if (cand === word) continue;
      const d = levenshtein(word, cand);
      if (d > maxD) continue;
      const custom = dict.customSet.has(cand);
      const rnk = dict.rank.get(cand) ?? 99999;
      if (d >= 2 && rnk > 8000 && !custom) continue;
      const pos = posMatches(word, cand);
      const same = cand.length === word.length;
      const better = !best || d < bestDist
        || (d === bestDist && same && !bestSame)
        || (d === bestDist && same === bestSame && pos > bestPos)
        || (d === bestDist && same === bestSame && pos === bestPos && custom && !bestCustom)
        || (d === bestDist && same === bestSame && pos === bestPos && custom === bestCustom && rnk < bestRank);
      if (better) {
        best = cand; bestDist = d; bestPos = pos; bestSame = same; bestCustom = custom; bestRank = rnk;
      }
    }
  }
  if (!best || bestDist > maxD) return null;
  if (bestPos < Math.ceil(word.length / 3)) return null;
  // Echtes Dict-Wort nur ersetzen, wenn genau ein verwechselbarer Buchstabe
  // anders ist und das Ziel viel haeufiger (BAT→HAT, nicht QUER→FUER).
  if (dict.dictSet.has(word) && bestDist >= 1 && !bestCustom) {
    if (!bestSame || bestDist !== 1 || !isConfusionSwap(word, best)) return null;
    if (bestRank > 100) return null;
    if (bestRank > selfRank / 20) return null;
  }
  return { text: best, dist: bestDist };
}

function guessSplit(word, dict) {
  if (word.length < 6 || word.length > 14) return null;
  let best = null, bestDist = Infinity;
  for (let i = 3; i <= word.length - 3; i++) {
    const left = word.slice(0, i);
    const right = word.slice(i);
    const l = dict.dictSet.has(left) ? { text: left, dist: 0 } : guessSingle(left, dict);
    const r = dict.dictSet.has(right) ? { text: right, dist: 0 } : guessSingle(right, dict);
    if (!l || !r) continue;
    const d = l.dist + r.dist;
    if (d > 1) continue;
    const lRank = dict.rank.get(l.text) ?? 99999;
    const rRank = dict.rank.get(r.text) ?? 99999;
    if ((lRank > 8000 && !dict.customSet.has(l.text)) || (rRank > 8000 && !dict.customSet.has(r.text))) continue;
    if (d < bestDist) {
      bestDist = d;
      best = { text: l.text + " " + r.text, dist: d };
    }
  }
  return best;
}

/**
 * Naechstliegendes Woerterbuchwort, oder null.
 * Bei mehreren gleich nahen Kandidaten das plausibelste: gemeinsame Stellen,
 * gleiche Laenge, eigene LARP-Namen, sonst das haeufigere deutsche Wort.
 * Zusammengeschriebene Tokens (fehlendes Leerzeichen) werden in zwei
 * Woerter zerlegt, wenn beide Seiten ins Woerterbuch passen.
 */
export function correctWord(word, dict) {
  if (word.length < 2) return null;
  if (dict.customSet.has(word)) return null;
  const inDict = dict.dictSet.has(word);
  const single = guessSingle(word, dict);
  const split = inDict ? null : guessSplit(word, dict);
  if (split && (!single || split.dist < single.dist)) return split.text;
  return single ? single.text : null;
}

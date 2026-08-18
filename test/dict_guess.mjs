import { DICT_WORDS, CUSTOM_WORDS, DICT_NOUN_BITS } from "../src/generated-dict.js";
import { buildDict, correctWord, recaseText } from "../src/core/dict.js";

const dict = buildDict(DICT_WORDS, CUSTOM_WORDS, DICT_NOUN_BITS);
const cases = [
  ["ISTTIN", "IST EIN"],
  ["UIN", "EIN"],
  ["EIN", null],
  ["BOQE", "BOTE"],
  ["CER", "DER"],
  ["CUS", "AUS"],
  ["NACHRICHQ", "NACHRICHT"],
  ["HALLO", null],
  ["DER", null],
  ["NACHRICHT", null],
  ["TEST", null],
  ["TAXI", null],
  ["BAYERN", null],
  ["SACHSEN", null],
  ["NORDRHEINWESTFALEN", null],
  ["VURWAHRLOSTEN", "VERWAHRLOSTEN"],
  ["US", "ES"],
  ["UR", "ER"],
  ["BAT", "HAT"],
  ["ES", null],
  ["ER", null],
  ["HAT", null],
  ["QUER", null],
  ["NIE", null],
];
const words = new Set(DICT_WORDS.split(" "));
if (words.has("TASI")) {
  console.log("FAIL  TASI steht noch im Woerterbuch");
  process.exit(1);
}
if (!words.has("TAXI") || !words.has("BAYERN") || !words.has("VERWAHRLOSTEN")) {
  console.log("FAIL  TAXI/BAYERN/VERWAHRLOSTEN fehlen im Woerterbuch");
  process.exit(1);
}
let fail = 0;
for (const [src, want] of cases) {
  const got = correctWord(src, dict);
  const ok = got === want;
  if (!ok) fail++;
  console.log(`${ok ? "ok" : "FAIL"}  ${src} → ${got === null ? "∅" : got}  (soll ${want === null ? "∅" : want})`);
}
const recaseCases = [
  ["DAS IST EIN TEST", "Das ist ein Test"],
  ["FRANZ JAGT IM KOMPLETT VERWAHRLOSTEN TAXI QUER DURCH BAYERN", "Franz jagt im komplett verwahrlosten Taxi quer durch Bayern"],
  ["ES IST SO UND ER HAT ES NIE ZU TUN", "Es ist so und er hat es nie zu tun"],
];
for (const [src, want] of recaseCases) {
  const got = recaseText(src, dict);
  const ok = got === want;
  if (!ok) fail++;
  console.log(`${ok ? "ok" : "FAIL"}  recase ${JSON.stringify(got)}  (soll ${JSON.stringify(want)})`);
}
process.exit(fail ? 1 : 0);

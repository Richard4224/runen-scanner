# Taluz-CRNN-Spike – Ergebnis

Stand: 24. August 2026. Gemessen auf einem Intel Core i5-12600K, Node 24 und
ONNX Runtime CPU. Das Modell wurde nur aus dem Phoenix-Taluz-TTF synthetisch
trainiert; die echten Fotos waren nicht im Training.

## Modell

- Architektur: kleine CNN + bidirektionale GRU + CTC
- Parameter: 268.844
- ONNX-Größe: 1,03 MB
- Eingabe: binäre Zeile, 48 Pixel hoch, dynamische Breite
- Ausgabe: A-Z und Leerzeichen
- Synthetische Validierungs-CER nach Absatz-Finetuning: 1,79 %

Taluz hat optisch identische Zeichen (`Q=T`, `V=L`). Im Training werden diese
auf `T` und `L` kanonisiert. Die endgültige Wahl muss später ein Sprachmodell
oder Wörterbuch treffen.

## Echte Fotos

### Taluz-15pt-B2

- 25 erkannte Zeilen
- Vorbereitung: 0,09 s
- ONNX-Inferenz: 0,05 s / 2,0 ms pro Zeile
- rohe CER: 39,1 %
- um Taluz-Mehrdeutigkeiten bereinigte CER: 38,8 %

Zum Vergleich braucht der bisherige Sliding-Window-DP auf demselben,
EXIF-korrigierten Foto 13,9 s Decode-Zeit und erreicht 94,9 % CER.

### Taluz-9pt-A1

- 47 erkannte Zeilen
- Vorbereitung: 0,12 s
- ONNX-Inferenz: 0,12 s / 2,5 ms pro Zeile
- rohe CER: 33,6 %
- bereinigte CER: 33,3 %

## Urteil

Der Spike erfüllt Größe und Geschwindigkeit deutlich, aber noch nicht das
Ziel von unter 10 % CER auf echten Fotos. Tiny-CRNN+CTC ist damit als
Laufzeit-Architektur plausibel, aber noch nicht bereit für die Website.

Der Generator rendert inzwischen vollständige Absätze, binarisiert sie als
Ganzes und schneidet danach dieselben periodischen Zeilenbänder wie der
Browser aus. Das verbessert besonders A1, schließt den Domain-Gap aber nicht.

Der größte verbliebene Fehler entsteht bei eng gesetztem Taluz: benachbarte
Runen überlappen vertikal, sodass die Projektionssegmentierung Zeilen nur über
den periodischen Grundlinienabstand trennt. Die synthetischen Absatzausschnitte
decken diese realen Ausschnitte trotz Absatz-Finetuning noch nicht genau genug
ab. Ein Wörterbuchlauf senkte B2 in diesem Zustand nicht und war wesentlich
langsamer als die Inferenz.

## Experimenteller Browsermodus

Das Modell ist als ausdrücklich experimenteller Taluz-Schalter in die statische
Website integriert. ONNX Runtime Web, WASM und Modell liegen vollständig in
`dist/index.html`; der Modus bleibt daher offline nutzbar. Das macht die Datei
etwa 21 MB groß. Ein End-to-End-Test in Chromium benötigte beim ersten Lauf
0,8 s und beim zweiten Lauf mit wiederverwendetem Worker 0,6 s. Die Laufzeit
auf iPhone/Safari muss Benedikt noch real messen.

Sinnvoller nächster Genauigkeitsschritt ist echtes Domain-Adaptation-Training
mit getrenntem Trainings-/Validierungsfoto oder ein CTC-Beam mit Sprachmodell.

Außerdem wurde ein Benchmarkfehler behoben: `jpeg-js` berücksichtigt die
iPhone-EXIF-Ausrichtung nicht. Alle Realbild-Benchmarks wenden sie jetzt vor
Skalierung und Zeilenerkennung an.

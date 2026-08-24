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
- Synthetische Validierungs-CER: 4,28 %

Taluz hat optisch identische Zeichen (`Q=T`, `V=L`). Im Training werden diese
auf `T` und `L` kanonisiert. Die endgültige Wahl muss später ein Sprachmodell
oder Wörterbuch treffen.

## Echte Fotos

### Taluz-15pt-B2

- 25 erkannte Zeilen
- Vorbereitung: 0,09 s
- ONNX-Inferenz: 0,06 s / 2,2 ms pro Zeile
- rohe CER: 39,7 %
- um Taluz-Mehrdeutigkeiten bereinigte CER: 39,6 %

Zum Vergleich braucht der bisherige Sliding-Window-DP auf demselben,
EXIF-korrigierten Foto 13,9 s Decode-Zeit und erreicht 94,9 % CER.

### Taluz-9pt-A1

- 47 erkannte Zeilen
- Vorbereitung: 0,12 s
- ONNX-Inferenz: 0,14 s / 3,0 ms pro Zeile
- rohe CER: 36,3 %
- bereinigte CER: 35,9 %

## Urteil

Der Spike erfüllt Größe und Geschwindigkeit deutlich, aber noch nicht das
Ziel von unter 10 % CER auf echten Fotos. Tiny-CRNN+CTC ist damit als
Laufzeit-Architektur plausibel, aber noch nicht bereit für die Website.

Der größte verbliebene Fehler entsteht bei eng gesetztem Taluz: benachbarte
Runen überlappen vertikal, sodass die Projektionssegmentierung Zeilen nur über
den periodischen Grundlinienabstand trennt. Die synthetischen Einzelzeilen
decken diese realen Ausschnitte noch nicht genau genug ab. Ein Wörterbuchlauf
senkte B2 in diesem Zustand nicht und war wesentlich langsamer als die
Inferenz.

Sinnvoller nächster Versuch:

1. synthetische ganze Absätze mit exakt der ODT-Zeilenhöhe rendern,
2. nach derselben Projektion wie echte Fotos in Zeilen schneiden,
3. B2 weiterhin nur validieren,
4. erst bei deutlich niedrigerer echter CER ONNX Runtime Web integrieren.

Außerdem wurde ein Benchmarkfehler behoben: `jpeg-js` berücksichtigt die
iPhone-EXIF-Ausrichtung nicht. Alle Realbild-Benchmarks wenden sie jetzt vor
Skalierung und Zeilenerkennung an.

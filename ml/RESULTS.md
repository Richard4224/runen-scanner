# Phoenix-CRNN – Ergebnis

Stand: 24. August 2026. Gemessen auf einem Intel Core i5-12600K, Node 24 und
ONNX Runtime CPU. Alle acht Modelle wurden nur aus den jeweiligen Phoenix-TTFs
synthetisch trainiert; die echten Fotos waren nicht im Training.

## Modell

- Architektur: kleine CNN + bidirektionale GRU + CTC
- Parameter: 268.844
- ONNX-Größe: je 1,03 MB
- Eingabe: binäre Zeile, 48 Pixel hoch, dynamische Breite
- Ausgabe: A-Z und Leerzeichen
- Synthetische Validierungs-CER nach Absatz-Finetuning: 1,79 %

Optisch identische Zeichen werden im Training kanonisiert: Taluz `Q=T`, `V=L`,
Lem-Kai `P=Z` und Nalya `J=N`. Die endgültige Wahl muss später ein Sprachmodell
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

### Alle Schriften

Die Werte nennen jeweils B2/A1 und sind um physisch identische Runen bereinigt:

- Runen: 46,3 % / 96,9 %
- Taluz: 38,8 % / 33,3 %
- Gobsch: 3,2 % / 38,0 %
- Lacrimat: 41,7 % / 65,3 %
- Xersesch: 74,2 % / 70,9 %
- Nalya: 40,9 % / 64,2 %
- Nalya-Shirin: 45,2 % / 26,6 %
- Lem-Kai: 3,3 % / 47,2 %

Über alle 16 Fotos liegt die mittlere bereinigte CER bei rund 46 %. Die
automatische Metrik enthält auch Titel-/Randfragmente und misslungene
Zeilenteilungen. Der praktische Taluz-Test war deshalb deutlich lesbarer, als
seine globale CER vermuten ließ. Gobsch und Lem-Kai erreichen auf B2 bereits
etwa 3 %.

## Urteil

Die Modelle erfüllen Größe und Geschwindigkeit deutlich. Die Genauigkeit
schwankt je nach Schrift und Aufnahme stark; der Modus bleibt deshalb als
experimentell gekennzeichnet und der klassische Decoder als Rückfall erhalten.

Der Generator rendert inzwischen vollständige Absätze, binarisiert sie als
Ganzes und schneidet danach dieselben periodischen Zeilenbänder wie der
Browser aus. Das verbessert besonders A1, schließt den Domain-Gap aber nicht.

Der größte verbliebene Fehler entsteht bei eng gesetztem Taluz: benachbarte
Runen überlappen vertikal, sodass die Projektionssegmentierung Zeilen nur über
den periodischen Grundlinienabstand trennt. Die synthetischen Absatzausschnitte
decken diese realen Ausschnitte trotz Absatz-Finetuning noch nicht genau genug
ab. Ein Wörterbuchlauf senkte B2 in diesem Zustand nicht und war wesentlich
langsamer als die Inferenz.

## Browser- und Cloudflare-Modus

Alle acht Modelle sind über denselben experimentellen Schnellschalter in die
statische Website integriert. ONNX Runtime Web, WASM und Modelle liegen
vollständig in `dist/index.html`; das macht die Datei etwa 31 MB groß und
erhält den Ein-Thread-Offline-Fallback.

Cloudflare Pages liefert zusätzlich COOP/COEP-Header und reale WASM/MJS-Assets.
Damit sind `crossOriginIsolated`, `SharedArrayBuffer` und bis zu vier
WASM-Threads verfügbar. Der End-to-End-Test des Gobsch-B2-Fotos im isolierten
Cloudflare-Modus erkannte 29 Zeilen in 2,2 s einschließlich erstem Laden und
Kompilieren. Auf GitHub Pages bleibt der eingebettete Ein-Thread-Fallback.

Sinnvoller nächster Genauigkeitsschritt ist echtes Domain-Adaptation-Training
mit getrenntem Trainings-/Validierungsfoto oder ein CTC-Beam mit Sprachmodell.

Außerdem wurde ein Benchmarkfehler behoben: `jpeg-js` berücksichtigt die
iPhone-EXIF-Ausrichtung nicht. Alle Realbild-Benchmarks wenden sie jetzt vor
Skalierung und Zeilenerkennung an.

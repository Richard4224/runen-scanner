# Tiny-CRNN-Spike

Das Modell liest eine komplette Runenzeile und gibt per CTC `A-Z` und
Leerzeichen aus. Es trennt die Runen vorher nicht in Einzelzeichen.

## Umgebung

```powershell
python -m venv .venv
.\.venv\Scripts\python -m pip install -r ml\requirements.txt
npm install
```

## Modell trainieren

```powershell
.\.venv\Scripts\python ml\train_crnn.py --font Phoenix-Taluz
```

Das Training nutzt ausschließlich synthetische Zeilen aus dem TTF in `fonts/`
(Phoenix-Schriften liegen nicht im Repo). Perspektive,
Unschärfe, Schatten, Rauschen, Skalierung und JPEG-Artefakte werden zufällig
erzeugt. Der Fotopfad rendert außerdem vollständige, eng gesetzte Absätze,
binarisiert sie als Ganzes und schneidet erst danach die Zielzeile aus. Das
Modell landet in `models/taluz-crnn.onnx`; der beste PyTorch-
Checkpoint unter `ml/checkpoints/` wird nicht committed.

Für die übrigen Schriften werden `--font`, `--output` und `--checkpoint`
entsprechend gesetzt. Die Taluz-Gewichte können mit `--init-checkpoint` als
schneller Startpunkt dienen.

Ein vorhandener Checkpoint kann gezielt weitertrainiert werden:

```powershell
.\.venv\Scripts\python ml\train_crnn.py --font Phoenix-Taluz --resume --clean-epochs 0 --lr 0.0003
```

Taluz (`Q=T`, `V=L`), Lem-Kai (`P=Z`) und Nalya (`J=N`) enthalten optisch
identische Runen. Das CTC-Ziel nutzt je Gruppe ein kanonisches Zeichen; ein
späterer Wörterbuch-Beam muss die sprachlich richtige Variante auswählen.

## Echtes Foto messen

```powershell
node scripts\bench_crnn.mjs img\real\Taluz-15pt-B2.jpg models\taluz-crnn.onnx
```

Ausgegeben werden Modellgröße, Zeilenzahl, Vorbereitung, Inferenz pro Zeile,
exakte CER und eine um physisch identische Taluz-Runen bereinigte CER.
`--dict` misst optional die bestehende Wörterbuchkorrektur; sie ist bewusst
nicht Teil des schnellen Standardlaufs.

Alle acht Modelle parallel messen:

```powershell
node scripts\bench_crnn_set.mjs 4
```

## Cloudflare Pages

```powershell
npm run deploy:cloudflare
```

`src/_headers` aktiviert COOP/COEP. Cloudflare verwendet dadurch bis zu vier
WASM-Threads; die einzelne HTML-Datei behält für GitHub/offline den
eingebetteten Ein-Thread-Fallback.

Die gemessenen Ergebnisse und die Go/No-Go-Bewertung stehen in
[`RESULTS.md`](RESULTS.md).

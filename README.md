# Runenübersetzer

**Live:** [https://runen-uebersetzer.pages.dev/](https://runen-uebersetzer.pages.dev/)

Übersetzt Fotos von Phoenix-Runenbriefen zurück in Klartext (A–Z). Alles läuft lokal im Browser: das Foto wird nicht hochgeladen.

## Nutzung

1. Foto aufnehmen oder aus der Mediathek wählen.
2. Rahmen eng um den Runentext ziehen.
3. Sprache wählen und **Entschlüsseln**.

Standard ist das Schnellmodell (Tiny-CRNN). Optional: **Mehr Details** (höhere Auflösung, langsamer) und ein Wörterbuch, das unsichere Wörter im Hintergrund rät.

Unterstützte Schriften: Runen, Taluz, Gobsch, Lacrimat, Xersesch, Nalya, Nalya-Shirin, Lem-Kai.

Einige Runen sind optisch gleich: Taluz `Q=T` und `V=L`, Lem-Kai `P=Z`, Nalya `J=N`.

## Lokal bauen

Node.js 22+ (getestet mit 24).

```powershell
npm install
npm test
npm run build
```

- `dist/index.html` — eine Offline-Datei (Safari / AirDrop)
- `dist-cloudflare/` — schlanker Build für Cloudflare Pages

```powershell
npm run deploy:cloudflare
```

## Training

Die Phoenix-TTFs liegen nicht in diesem Repo. Zum Nachtrainieren nach `fonts/` legen, siehe [`ml/README.md`](ml/README.md). Die fertigen ONNX-Modelle stehen unter `models/`.

## Rechtliches

[Impressum](https://runen-uebersetzer.pages.dev/impressum.html) · [Datenschutz](https://runen-uebersetzer.pages.dev/datenschutz.html)

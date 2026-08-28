"""Erzeugt Testbriefe mit bekanntem Klartext.

Rendert Text in den Runenschriften und verhunzt ihn anschliessend gezielt so,
wie es ein Handyfoto auf einem LARP tut: schief, unscharf, verrauscht,
ungleichmaessig beleuchtet, perspektivisch verzogen.

Ausgabe: test/data/*.raw (Graustufen, ein Byte je Pixel) + index.json
"""
import json
import math
import os
import random

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

from gen_atlas import charmap

FONT_DIR = os.path.join(os.path.dirname(__file__), "..", "fonts")
OUT_DIR = os.path.join(os.path.dirname(__file__), "..", "test", "data")

SAETZE = [
    ["DER BOTE BRINGT NACHRICHT", "AUS DEM NORDEN"],
    ["TREFFEN BEI SONNENUNTERGANG", "AM ALTEN TURM"],
    ["HUETE DICH VOR DEM", "MANN MIT DER MASKE"],
    ["DIE QUELLE VERSIEGT", "WENN DER MOND STEIGT"],
    ["BRINGE ZWOELF KRUEGE METH", "ZUM LAGER DER WACHE"],
]


def render(font_path, lines, size, offset, encoding):
    font = ImageFont.truetype(font_path, size, encoding=encoding)
    # Leerzeichen MUSS denselben Offset wie die Buchstaben bekommen.
    # Bei Symbol-Fonts (encoding="symb") ist ASCII-Space U+0020 nicht in der
    # Charmap -- PIL rendert dann .notdef-Kaestchen statt Luecken. Der echte
    # Zwischenraum liegt auf U+F020 (= offset + ord(" ")).
    enc = lambda s: "".join(chr(offset + ord(c)) for c in s)
    widths = [font.getlength(enc(l)) for l in lines]
    lh = int(size * 1.9)
    pad = int(size * 0.9)
    w = int(max(widths)) + 2 * pad
    h = lh * len(lines) + 2 * pad
    img = Image.new("L", (w, h), 255)
    d = ImageDraw.Draw(img)
    for i, line in enumerate(lines):
        d.text((pad, pad + lh * i + int(size * 1.1)), enc(line),
               font=font, fill=0, anchor="ls")
    return img


def perspective(img, strength, rng):
    """Leichte Verkippung, wie beim schraeg gehaltenen Handy."""
    w, h = img.size
    dx = w * strength
    dy = h * strength
    src = [(0, 0), (w, 0), (w, h), (0, h)]
    dst = [
        (rng.uniform(0, dx), rng.uniform(0, dy)),
        (w - rng.uniform(0, dx), rng.uniform(0, dy)),
        (w - rng.uniform(0, dx), h - rng.uniform(0, dy)),
        (rng.uniform(0, dx), h - rng.uniform(0, dy)),
    ]
    # Koeffizienten fuer PIL.Image.PERSPECTIVE loesen
    A, B = [], []
    for (sx, sy), (dxp, dyp) in zip(src, dst):
        A.append([dxp, dyp, 1, 0, 0, 0, -sx * dxp, -sx * dyp])
        A.append([0, 0, 0, dxp, dyp, 1, -sy * dxp, -sy * dyp])
        B += [sx, sy]
    coeffs = np.linalg.solve(np.array(A, dtype=float), np.array(B, dtype=float))
    return img.transform((w, h), Image.PERSPECTIVE, coeffs,
                         Image.BICUBIC, fillcolor=255)


def lighting(img, rng):
    """Schattenverlauf ueber die Seite -- der klassische Handyfoto-Fehler."""
    a = np.asarray(img, dtype=np.float32)
    h, w = a.shape
    yy, xx = np.mgrid[0:h, 0:w]
    ang = rng.uniform(0, 2 * math.pi)
    ramp = (math.cos(ang) * xx / w + math.sin(ang) * yy / h)
    ramp = (ramp - ramp.min()) / (np.ptp(ramp) + 1e-9)
    gain = 0.45 + 0.75 * ramp          # 45 % bis 120 % Helligkeit
    return Image.fromarray(np.clip(a * gain, 0, 255).astype(np.uint8))


def degrade(img, level, rng):
    if level == "sauber":
        return img
    if level == "leicht":
        img = img.rotate(rng.uniform(-2, 2), Image.BICUBIC, fillcolor=255)
        img = img.filter(ImageFilter.GaussianBlur(0.6))
        noise = 4
    elif level == "handyfoto":
        img = perspective(img, 0.02, rng)
        img = img.rotate(rng.uniform(-5, 5), Image.BICUBIC, fillcolor=255)
        img = lighting(img, rng)
        img = img.filter(ImageFilter.GaussianBlur(1.1))
        noise = 9
    elif level == "schlecht":
        img = perspective(img, 0.045, rng)
        img = img.rotate(rng.uniform(-9, 9), Image.BICUBIC, fillcolor=255)
        img = lighting(img, rng)
        w, h = img.size
        img = img.resize((w // 2, h // 2), Image.BILINEAR).resize((w, h), Image.BILINEAR)
        img = img.filter(ImageFilter.GaussianBlur(1.5))
        noise = 15
    a = np.asarray(img, dtype=np.float32)
    a += np.random.default_rng(rng.randrange(1 << 30)).normal(0, noise, a.shape)
    return Image.fromarray(np.clip(a, 0, 255).astype(np.uint8))


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    for f in os.listdir(OUT_DIR):
        os.remove(os.path.join(OUT_DIR, f))

    rng = random.Random(7)
    index = []
    fonts = ["Phoenix-Runen", "Phoenix-Taluz", "Phoenix-Gobsch",
             "Phoenix-Lacrimat", "Phoenix-Xersesch", "Phoenix-Nalya",
             "Phoenix-Nalya-Shirin", "Phoenix-Lem-Kai"]
    levels = ["sauber", "leicht", "handyfoto", "schlecht"]

    n = 0
    for fname in fonts:
        path = os.path.join(FONT_DIR, fname + ".ttf")
        offset, encoding = charmap(path)
        for si, lines in enumerate(SAETZE):
            for level in levels:
                size = rng.choice([44, 56, 72])
                img = render(path, lines, size, offset, encoding)
                img = degrade(img, level, rng)
                name = f"{n:04d}.raw"
                with open(os.path.join(OUT_DIR, name), "wb") as fh:
                    fh.write(img.tobytes())
                index.append({
                    "file": name, "w": img.width, "h": img.height,
                    "font": fname, "level": level, "size": size,
                    "text": "\n".join(lines),
                })
                n += 1

    with open(os.path.join(OUT_DIR, "index.json"), "w", encoding="utf-8") as fh:
        json.dump(index, fh, ensure_ascii=False, indent=1)
    print(f"{n} Testbriefe -> {OUT_DIR}")
    print(f"  {len(fonts)} Sprachen x {len(SAETZE)} Texte x {len(levels)} Qualitaetsstufen")


if __name__ == "__main__":
    main()

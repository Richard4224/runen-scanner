"""Baut den Runen-Atlas: src/atlas.json

Anders als eine reine Zeichenerkennung braucht der Schiebefenster-Ansatz die
Glyphen *relativ zum Schreibpunkt* auf der Grundlinie, nicht auf ihre eigene
Boundingbox normiert. Nur so laesst sich eine Rune probeweise an einer
bestimmten Textposition einsetzen und bewerten.

Pro Rune:
  adv     Vorschub in em -- wie weit der Schreibpunkt weiterrueckt
  x0, y0  linke Oberkante des Bildausschnitts, relativ zum Schreibpunkt,
          in em (y0 negativ = oberhalb der Grundlinie)
  w, h    Groesse des Ausschnitts in Pixeln bei EM_PX
  bitmap  Graustufen, base64

Dieselbe Datei bedient den Node-Testlauf und die Web-App, damit beide
garantiert mit identischen Referenzdaten arbeiten.
"""
import base64
import glob
import json
import os

from fontTools.ttLib import TTFont
from PIL import Image, ImageDraw, ImageFont

FONT_DIR = os.path.join(os.path.dirname(__file__), "..", "fonts")
OUT = os.path.join(os.path.dirname(__file__), "..", "src", "atlas.json")

ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
EM_PX = 64        # Rendergroesse des Atlas; zur Laufzeit wird skaliert
SUPER = 4         # Ueberabtastung, danach heruntergerechnet -> weiche Kanten


def charmap(font_path):
    """Symbol-Fonts legen 'A' auf 0xF041 statt 0x41.

    Der Offset allein genuegt nicht -- ohne encoding="symb" bleibt FreeType
    auf der Standard-Charmap und rendert fuer jeden Buchstaben .notdef.
    """
    f = TTFont(font_path, fontNumber=0)
    tables = f["cmap"].tables
    symbol = any(
        st.platformID == 3 and st.platEncID == 0
        and any(0xF000 <= c <= 0xF0FF for c in st.cmap) for st in tables
    )
    uni = any((st.platformID, st.platEncID) in ((3, 1), (0, 0))
              and ord("A") in st.cmap for st in tables)
    return (0xF000, "symb") if (symbol and not uni) else (0, "")


def glyph_patch(font_path, ch, offset, encoding):
    """Rendert eine Rune und liefert Ausschnitt + Lage zum Schreibpunkt.

    Alle Laengen beziehen sich auf die Schriftgroesse (das Geviert), also auf
    genau den Wert, der an truetype() uebergeben wird. Wichtig: getmetrics()
    liefert ascent+descent, und das ist NICHT die Schriftgroesse -- bei diesen
    Fonts 287 statt 256. Rechnet man damit, geraten Vorschubbreiten und
    Bitmapgroessen in verschiedene Masseinheiten und die Runen werden rund
    11 % zu eng gesetzt; der Versatz summiert sich ueber die Zeile auf.
    """
    px = EM_PX * SUPER
    font = ImageFont.truetype(font_path, px, encoding=encoding)
    s = chr(offset + ord(ch))
    pen = (px * 2, px * 2)   # Schreibpunkt auf der Grundlinie
    canvas = Image.new("L", (px * 4, px * 4), 0)
    ImageDraw.Draw(canvas).text(pen, s, font=font, fill=255, anchor="ls")

    bbox = canvas.getbbox()
    adv = font.getlength(s) / px
    if bbox is None:
        return {"adv": adv, "x0": 0, "y0": 0, "w": 0, "h": 0, "bitmap": ""}

    x0, y0, x1, y1 = bbox
    patch = canvas.crop(bbox).resize(
        (max(1, (x1 - x0) // SUPER), max(1, (y1 - y0) // SUPER)), Image.LANCZOS)
    return {
        "adv": round(adv, 5),
        "x0": round((x0 - pen[0]) / px, 5),
        "y0": round((y0 - pen[1]) / px, 5),
        "w": patch.width,
        "h": patch.height,
        "bitmap": base64.b64encode(patch.tobytes()).decode("ascii"),
    }


def main():
    fonts = {}
    for path in sorted(glob.glob(os.path.join(FONT_DIR, "*.ttf"))):
        key = os.path.splitext(os.path.basename(path))[0]
        offset, encoding = charmap(path)
        letters = {ch: glyph_patch(path, ch, offset, encoding) for ch in ALPHABET}

        # Runen, die in dieser Sprache echt identisch sind, zusammenfassen
        groups = {}
        for ch, g in letters.items():
            groups.setdefault(g["bitmap"], []).append(ch)
        ambiguous = sorted("".join(g) for g in groups.values() if len(g) > 1)
        if len(groups) < len(letters) * 0.75:
            raise SystemExit(
                f"{key}: nur {len(groups)} verschiedene Runen von {len(letters)} "
                f"-- vermutlich .notdef statt echter Glyphen")

        fonts[key] = {"letters": letters, "ambiguous": ambiguous}
        hs = [g["h"] for g in letters.values()]
        advs = [g["adv"] for g in letters.values()]
        print(f"{key:22s} adv {min(advs):.2f}-{max(advs):.2f} em   "
              f"Hoehe {min(hs)}-{max(hs)} px"
              + (f"   gleich: {', '.join(ambiguous)}" if ambiguous else ""))

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump({"emPx": EM_PX, "alphabet": ALPHABET, "fonts": fonts}, f)
    print(f"\n-> {OUT}  ({os.path.getsize(OUT) / 1024:.0f} KB)")


if __name__ == "__main__":
    main()

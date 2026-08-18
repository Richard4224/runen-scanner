"""Rendert aus jedem Phoenix-Font die 26 Runen A-Z zu normalisierten Vorlagen.

Ausgabe: src/templates.json  -- wird sowohl vom Node-Testlauf als auch von der
Web-App gelesen, damit beide exakt dieselben Referenzdaten benutzen.

Pro Rune wird gespeichert:
  bitmap  Graustufen 32x32, auf die Glyphen-Boundingbox zugeschnitten und
          seitenverhaeltnis-erhaltend eingepasst (das eigentliche Matching)
  aspect  Breite/Hoehe der Boundingbox (starkes Unterscheidungsmerkmal)
  top     Oberkante der Glyphe relativ zur Grundlinie, in em
  bottom  Unterkante relativ zur Grundlinie, in em (negativ = Unterlaenge)
  adv     Vorschubbreite in em (fuer die Segmentierung)
"""
import base64
import glob
import json
import os

from fontTools.ttLib import TTFont
from PIL import Image, ImageDraw, ImageFont

FONT_DIR = os.path.join(os.path.dirname(__file__), "..")
OUT = os.path.join(os.path.dirname(__file__), "..", "src", "templates.json")

ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
CELL = 32          # Kantenlaenge der Vorlagen-Bitmap
RENDER_PX = 256    # Rendergroesse, danach heruntergerechnet -> weiche Kanten


def codepoint_map(font_path):
    """Ermittelt, unter welchem Codepoint eine Rune tatsaechlich liegt.

    Sechs der acht Phoenix-Fonts sind Symbol-Fonts: sie haben eine (3,0)
    Subtabelle, in der 'A' nicht auf 0x41 sondern auf 0xF041 liegt. Rendert
    man dort schlicht "A", bekommt man fuer jeden Buchstaben dasselbe
    .notdef-Kaestchen -- alle 26 Vorlagen waeren identisch.

    Der Offset allein genuegt nicht: FreeType bleibt sonst auf der Standard-
    Charmap und liefert weiter .notdef. Es braucht zusaetzlich encoding="symb".
    """
    f = TTFont(font_path, fontNumber=0)
    symbol = any(
        st.platformID == 3 and st.platEncID == 0
        and any(0xF000 <= c <= 0xF0FF for c in st.cmap)
        for st in f["cmap"].tables
    )
    unicode_ascii = any(
        (st.platformID, st.platEncID) in ((3, 1), (0, 0)) and ord("A") in st.cmap
        for st in f["cmap"].tables
    )
    if symbol and not unicode_ascii:
        return 0xF000, "symb"
    return 0, ""


def render_glyph(font_path, ch, offset, encoding):
    """Rendert ein Zeichen gross und liefert (Bild, Metriken)."""
    ch = chr(offset + ord(ch))
    font = ImageFont.truetype(font_path, RENDER_PX, encoding=encoding)
    ascent, descent = font.getmetrics()
    em = ascent + descent

    # grosszuegige Leinwand, Grundlinie fest bei y = RENDER_PX
    pad = RENDER_PX
    canvas = Image.new("L", (RENDER_PX * 3, RENDER_PX * 3), 0)
    d = ImageDraw.Draw(canvas)
    d.text((pad, pad), ch, font=font, fill=255, anchor="ls")
    baseline_y = pad

    bbox = canvas.getbbox()
    if bbox is None:
        return None, None

    x0, y0, x1, y1 = bbox
    metrics = {
        "aspect": (x1 - x0) / (y1 - y0),
        "top": (baseline_y - y0) / em,
        "bottom": (baseline_y - y1) / em,
        "adv": font.getlength(ch) / em,
    }
    return canvas.crop(bbox), metrics


def fit_into_cell(img):
    """Seitenverhaeltnis-erhaltend in ein CELLxCELL Feld zentrieren."""
    w, h = img.size
    scale = (CELL - 2) / max(w, h)
    nw, nh = max(1, round(w * scale)), max(1, round(h * scale))
    small = img.resize((nw, nh), Image.LANCZOS)
    cell = Image.new("L", (CELL, CELL), 0)
    cell.paste(small, ((CELL - nw) // 2, (CELL - nh) // 2))
    return cell


def main():
    fonts = {}
    problems = []
    ambiguity = {}
    for path in sorted(glob.glob(os.path.join(FONT_DIR, "*.ttf"))):
        key = os.path.splitext(os.path.basename(path))[0]
        offset, encoding = codepoint_map(path)
        glyphs = {}
        raw = {}
        skipped = []
        for ch in ALPHABET:
            img, metrics = render_glyph(path, ch, offset, encoding)
            if img is None:
                skipped.append(ch)
                continue
            cell = fit_into_cell(img)
            raw[ch] = cell.tobytes()
            metrics["bitmap"] = base64.b64encode(raw[ch]).decode("ascii")
            glyphs[ch] = metrics
        fonts[key] = glyphs

        # Selbsttest gegen den .notdef-Fehler: rendert man Symbol-Fonts falsch,
        # kommt fuer jeden Buchstaben dasselbe Ersatzkaestchen heraus. Einzelne
        # Doppel sind dagegen echt -- manche Sprachen benutzen fuer zwei
        # Buchstaben bewusst dieselbe Rune.
        groups = {}
        for ch, bits in raw.items():
            groups.setdefault(bits, []).append(ch)
        ambiguous = sorted("".join(g) for g in groups.values() if len(g) > 1)
        distinct = len(groups)
        if distinct < len(raw) * 0.75:
            problems.append(
                f"{key}: nur {distinct} verschiedene von {len(raw)} Runen "
                f"-- - vermutlich .notdef statt echter Glyphen"
            )
        ambiguity[key] = ambiguous

        enc = "symbol 0xF0xx" if offset else "unicode"
        note = f"  (leer: {''.join(skipped)})" if skipped else ""
        flag = f"  gleich: {', '.join(ambiguous)}" if ambiguous else ""
        widths = [g["adv"] for g in glyphs.values()]
        spread = max(widths) - min(widths)
        kind = "monospace" if spread < 0.01 else f"proportional {min(widths):.2f}-{max(widths):.2f}"
        print(f"{key:24s} {len(glyphs):2d} Runen  {enc:14s} {kind}{note}{flag}")

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump({"cell": CELL, "alphabet": ALPHABET, "fonts": fonts,
                   "ambiguous": ambiguity}, f)
    print(f"\n-> {OUT}  ({os.path.getsize(OUT) / 1024:.0f} KB)")
    if problems:
        print("\nFEHLER:")
        for p in problems:
            print("  " + p)
        raise SystemExit(1)


if __name__ == "__main__":
    main()

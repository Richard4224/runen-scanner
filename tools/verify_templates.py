"""Rendert eine Kontrolluebersicht aus src/templates.json.

Bewusst aus der JSON und nicht erneut aus den TTFs: so wird genau das
geprueft, was die App spaeter tatsaechlich zum Vergleichen benutzt.
"""
import base64
import json
import os

from PIL import Image, ImageDraw, ImageFont

SRC = os.path.join(os.path.dirname(__file__), "..", "src", "templates.json")
OUT = os.path.join(os.path.dirname(__file__), "..", "src", "templates_check.png")

data = json.load(open(SRC, encoding="utf-8"))
CELL = data["cell"]
ALPHABET = data["alphabet"]
SCALE = 2
S = CELL * SCALE
GAP, LEFT, HEAD = 4, 190, 26

label = ImageFont.load_default(13)
names = sorted(data["fonts"])
W = LEFT + len(ALPHABET) * (S + GAP)
H = len(names) * (S + HEAD + GAP) + 20

img = Image.new("RGB", (W, H), "white")
d = ImageDraw.Draw(img)

y = 10
for name in names:
    glyphs = data["fonts"][name]
    amb = data["ambiguous"].get(name, [])
    caption = name + (f"   [gleich: {', '.join(amb)}]" if amb else "")
    d.text((6, y + S // 2), caption, font=label, fill="black", anchor="lm")
    for i, ch in enumerate(ALPHABET):
        x = LEFT + i * (S + GAP)
        d.rectangle([x, y, x + S, y + S], outline="#ccc")
        raw = base64.b64decode(glyphs[ch]["bitmap"])
        tile = Image.frombytes("L", (CELL, CELL), raw).resize((S, S), Image.NEAREST)
        # invertieren: schwarze Rune auf weiss
        img.paste(Image.eval(tile, lambda v: 255 - v).convert("RGB"), (x, y))
        colour = "#c00" if any(ch in g for g in amb) else "black"
        d.text((x + S // 2, y + S + 3), ch, font=label, fill=colour, anchor="ma")
    y += S + HEAD + GAP

img.save(OUT)
print(f"-> {OUT}  {img.size}")

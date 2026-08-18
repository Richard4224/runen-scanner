"""Referenz-Glyphen und Testseiten aus den Schriften rendern.

Weil die Schriften bekannt sind, brauchen wir keine gesammelten Trainingsdaten:
zu jedem Buchstaben laesst sich die perfekte Form erzeugen. Das ist die
Grundlage der Erkennung -- gerendert wird einmal, verglichen wird danach.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont

from .fonts import ALPHABET, RuneFont

#: Groesse, in der Referenz-Glyphen gerendert werden. Gross genug, dass die
#: kleinen Sternchen und Punkte sauber aufloesen.
TEMPLATE_EM = 256

#: Rand um eine gerenderte Glyphe, damit Ueberhaenge nicht abgeschnitten werden.
PAD = 64


@dataclass
class Template:
    """Eine gerenderte Referenzglyphe."""

    char: str
    mask: np.ndarray   # float32, 0..1, 1 = Tinte
    advance: float     # in em
    #: Versatz der Zeichnung gegenueber dem Textursprung, in em
    offset_x: float
    offset_y: float

    @property
    def aspect(self) -> float:
        h, w = self.mask.shape
        return w / h if h else 0.0


def _pil_font(font: RuneFont, px: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(str(font.path), px)


def render_char(font: RuneFont, char: str, em: int = TEMPLATE_EM) -> Template | None:
    """Eine einzelne Glyphe auf transparentem Grund rendern und zuschneiden."""
    glyph = font.glyph(char)
    if glyph is None or glyph.empty:
        return None

    pil = _pil_font(font, em)
    text = font.encode(char)

    canvas = Image.new("L", (em + 2 * PAD, em + 2 * PAD), 0)
    draw = ImageDraw.Draw(canvas)
    draw.text((PAD, PAD), text, fill=255, font=pil)

    arr = np.asarray(canvas, dtype=np.float32) / 255.0
    ys, xs = np.nonzero(arr > 0.05)
    if len(xs) == 0:
        return None

    x0, x1 = int(xs.min()), int(xs.max()) + 1
    y0, y1 = int(ys.min()), int(ys.max()) + 1
    mask = arr[y0:y1, x0:x1]

    return Template(
        char=char,
        mask=mask,
        advance=glyph.advance,
        offset_x=(x0 - PAD) / em,
        offset_y=(y0 - PAD) / em,
    )


def render_alphabet(font: RuneFont, em: int = TEMPLATE_EM) -> dict[str, Template]:
    """Referenzglyphen fuer alle sichtbaren Buchstaben der Schrift."""
    out: dict[str, Template] = {}
    for c in ALPHABET:
        t = render_char(font, c, em=em)
        if t is not None:
            out[c] = t
    return out


def render_text(
    font: RuneFont,
    text: str,
    em: int = 96,
    margin: int = 40,
    line_spacing: float = 1.6,
) -> Image.Image:
    """Klartext als Runenzeile(n) setzen -- sauberes Schwarz auf Weiss."""
    pil = _pil_font(font, em)
    lines = text.splitlines() or [""]
    encoded = [font.encode(line) for line in lines]

    widths = []
    for line in encoded:
        box = pil.getbbox(line) if line else (0, 0, 0, 0)
        widths.append(box[2] - box[0])
    step = int(em * line_spacing)

    width = max(widths, default=0) + 2 * margin
    height = step * len(lines) + 2 * margin

    img = Image.new("L", (max(width, 1), max(height, 1)), 255)
    draw = ImageDraw.Draw(img)
    for i, line in enumerate(encoded):
        draw.text((margin, margin + i * step), line, fill=0, font=pil)
    return img


def contact_sheet(font: RuneFont, cell: int = 160, cols: int = 7) -> Image.Image:
    """Uebersichtsblatt aller Runen mit lateinischer Beschriftung.

    Dient dem Abgleich mit der Runen-Karte aus dem PDF: was hier steht, muss
    dort im selben Kaestchen stehen.
    """
    templates = render_alphabet(font, em=cell - 40)
    chars = list(templates)
    rows = (len(chars) + cols - 1) // cols
    label_h = 28

    sheet = Image.new("L", (cols * cell, rows * (cell + label_h)), 255)
    draw = ImageDraw.Draw(sheet)
    try:
        label_font = ImageFont.truetype("arial.ttf", 20)
    except OSError:
        label_font = ImageFont.load_default()

    for i, ch in enumerate(chars):
        r, c = divmod(i, cols)
        ox, oy = c * cell, r * (cell + label_h)
        draw.rectangle([ox + 4, oy + 4, ox + cell - 4, oy + cell - 4], outline=180)

        t = templates[ch]
        h, w = t.mask.shape
        scale = min((cell - 24) / w, (cell - 24) / h, 1.0)
        gw, gh = max(int(w * scale), 1), max(int(h * scale), 1)
        glyph_img = Image.fromarray((255 - t.mask * 255).astype(np.uint8)).resize(
            (gw, gh), Image.LANCZOS
        )
        sheet.paste(glyph_img, (ox + (cell - gw) // 2, oy + (cell - gh) // 2))

        label = ch.upper()
        tw = draw.textlength(label, font=label_font)
        draw.text((ox + (cell - tw) / 2, oy + cell - 2), label, fill=0, font=label_font)

    return sheet

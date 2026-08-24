"""Trainiert ein kleines CRNN+CTC-Modell fuer eine Phoenix-Schrift.

Die Trainingszeilen werden direkt aus dem TTF erzeugt und wie Handyfotos
verzerrt. Echte Fotos bleiben damit ein unabhaengiger Test.

Beispiel:
  .venv/Scripts/python ml/train_crnn.py --font Phoenix-Taluz
"""

from __future__ import annotations

import argparse
import io
import json
import math
import os
import random
import re
import sys
from pathlib import Path

import numpy as np
import onnx
import onnxruntime as ort
import torch
from PIL import Image, ImageDraw, ImageFilter, ImageFont, ImageOps
from torch import nn
from torch.utils.data import DataLoader, Dataset

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
from gen_atlas import charmap  # noqa: E402

CHARS = " ABCDEFGHIJKLMNOPQRSTUVWXYZ"
LABEL_OF = {ch: i + 1 for i, ch in enumerate(CHARS)}
BLANK = 0
HEIGHT = 48
AMBIGUOUS = {
    "Phoenix-Taluz": str.maketrans({"Q": "T", "V": "L"}),
    "Phoenix-Lem-Kai": str.maketrans({"Z": "P"}),
    "Phoenix-Nalya": str.maketrans({"N": "J"}),
}


def normalize_text(text: str) -> str:
    text = (
        text.upper()
        .replace("Ä", "AE")
        .replace("Ö", "OE")
        .replace("Ü", "UE")
        .replace("ß", "SS")
    )
    return re.sub(r"[^A-Z ]+", "", text)


def canonical(text: str, font_name: str) -> str:
    return text.translate(AMBIGUOUS.get(font_name, {}))


def load_words() -> list[str]:
    path = ROOT / "node_modules" / "an-array-of-german-words" / "words.json"
    words = json.loads(path.read_text(encoding="utf-8"))
    out: list[str] = []
    seen: set[str] = set()
    for raw in words:
        word = normalize_text(raw)
        if 2 <= len(word) <= 13 and word not in seen:
            seen.add(word)
            out.append(word)
    if len(out) < 1000:
        raise RuntimeError(f"Wortliste unerwartet klein: {len(out)}")
    return out


def perspective_coeffs(width: int, height: int, strength: float, rng: random.Random):
    dx, dy = width * strength, height * strength
    src = [(0, 0), (width, 0), (width, height), (0, height)]
    dst = [
        (rng.uniform(0, dx), rng.uniform(0, dy)),
        (width - rng.uniform(0, dx), rng.uniform(0, dy)),
        (width - rng.uniform(0, dx), height - rng.uniform(0, dy)),
        (rng.uniform(0, dx), height - rng.uniform(0, dy)),
    ]
    a, b = [], []
    for (sx, sy), (tx, ty) in zip(src, dst):
        a.append([tx, ty, 1, 0, 0, 0, -sx * tx, -sx * ty])
        a.append([0, 0, 0, tx, ty, 1, -sy * tx, -sy * ty])
        b.extend([sx, sy])
    return np.linalg.solve(np.asarray(a, dtype=np.float64), np.asarray(b, dtype=np.float64))


def sauvola_ink(gray: np.ndarray, k: float = 0.25) -> np.ndarray:
    """Vektorisierte Variante der Browser-Binarisierung; Ergebnis Tinte=1."""
    h, w = gray.shape
    radius = max(4, round(max(w, h) / 48))
    arr = gray.astype(np.float64)
    integral = np.pad(arr, ((1, 0), (1, 0))).cumsum(0).cumsum(1)
    integral2 = np.pad(arr * arr, ((1, 0), (1, 0))).cumsum(0).cumsum(1)
    ys = np.arange(h)
    xs = np.arange(w)
    y0 = np.maximum(0, ys - radius)
    y1 = np.minimum(h, ys + radius + 1)
    x0 = np.maximum(0, xs - radius)
    x1 = np.minimum(w, xs + radius + 1)
    count = (y1 - y0)[:, None] * (x1 - x0)[None, :]
    total = (
        integral[y1[:, None], x1[None, :]]
        - integral[y0[:, None], x1[None, :]]
        - integral[y1[:, None], x0[None, :]]
        + integral[y0[:, None], x0[None, :]]
    )
    total2 = (
        integral2[y1[:, None], x1[None, :]]
        - integral2[y0[:, None], x1[None, :]]
        - integral2[y1[:, None], x0[None, :]]
        + integral2[y0[:, None], x0[None, :]]
    )
    mean = total / count
    variance = np.maximum(0, total2 / count - mean * mean)
    threshold = mean * (1 + k * (np.sqrt(variance) / 128 - 1))
    return (arr < threshold).astype(np.float32)


class SyntheticLines(Dataset):
    def __init__(
        self,
        font_name: str,
        words: list[str],
        count: int,
        seed: int,
        augment: bool,
    ):
        self.font_name = font_name
        self.font_path = ROOT / f"{font_name}.ttf"
        self.words = words
        self.count = count
        self.seed = seed
        self.augment = augment
        self.offset, self.encoding = charmap(str(self.font_path))
        self.font_cache: dict[int, ImageFont.FreeTypeFont] = {}

    def __len__(self):
        return self.count

    def font(self, size: int):
        if size not in self.font_cache:
            self.font_cache[size] = ImageFont.truetype(
                str(self.font_path), size, encoding=self.encoding
            )
        return self.font_cache[size]

    def make_text(self, rng: random.Random) -> str:
        max_chars = rng.randint(18, 42)
        selected: list[str] = []
        while len(" ".join(selected)) < max_chars:
            word = rng.choice(self.words)
            candidate = " ".join([*selected, word])
            if len(candidate) > max_chars:
                if selected:
                    break
                word = word[:max_chars]
            selected.append(word)
        return " ".join(selected)

    def render(self, plain: str, rng: random.Random) -> Image.Image:
        size = rng.randint(26, 58)
        font = self.font(size)
        encoded = "".join(chr(self.offset + ord(ch)) for ch in plain)
        pad = max(10, size)
        width = max(8, math.ceil(font.getlength(encoded)) + 2 * pad)

        # Enge Druckzeilen wie im echten ODT: Ober-/Unterlaengen der
        # Nachbarzeilen ragen in den Ausschnitt. Der Zeilendetektor schneidet
        # am halben Grundlinienabstand, nicht an komplett weissen Baendern.
        if self.augment and rng.random() < 0.65:
            pitch = size * rng.uniform(1.0, 1.28)
            cell_h = max(12, round(pitch))
            canvas_h = max(cell_h * 3, round(size * 3.5))
            baseline = canvas_h / 2 + size * 0.28
            img = Image.new("L", (width, canvas_h), 255)
            draw = ImageDraw.Draw(img)
            draw.text((pad, baseline), encoded, font=font, fill=0, anchor="ls")
            for delta in (-pitch, pitch):
                neighbor = self.make_text(rng)
                encoded_neighbor = "".join(
                    chr(self.offset + ord(ch)) for ch in neighbor
                )
                draw.text(
                    (pad, baseline + delta),
                    encoded_neighbor,
                    font=font,
                    fill=0,
                    anchor="ls",
                )
            y0 = max(0, round(baseline - pitch / 2))
            y1 = min(canvas_h, y0 + cell_h)
            return img.crop((0, y0, width, y1))

        height = math.ceil(size * 2.7)
        baseline = math.ceil(size * 1.65)
        img = Image.new("L", (width, height), 255)
        ImageDraw.Draw(img).text(
            (pad, baseline), encoded, font=font, fill=0, anchor="ls"
        )

        bbox = ImageOps.invert(img).getbbox()
        if bbox:
            x0, y0, x1, y1 = bbox
            margin = rng.randint(3, 10)
            img = img.crop(
                (
                    max(0, x0 - margin),
                    max(0, y0 - margin),
                    min(img.width, x1 + margin),
                    min(img.height, y1 + margin),
                )
            )
        return img

    def degrade(self, img: Image.Image, rng: random.Random) -> Image.Image:
        if not self.augment:
            return img

        strength = rng.uniform(0.0, 0.035)
        if strength > 0.004:
            coeffs = perspective_coeffs(img.width, img.height, strength, rng)
            img = img.transform(
                img.size,
                Image.Transform.PERSPECTIVE,
                coeffs,
                Image.Resampling.BICUBIC,
                fillcolor=255,
            )
        img = img.rotate(
            rng.uniform(-3.0, 3.0),
            Image.Resampling.BICUBIC,
            expand=True,
            fillcolor=255,
        )
        if rng.random() < 0.85:
            img = img.filter(ImageFilter.GaussianBlur(rng.uniform(0.0, 1.15)))
        if rng.random() < 0.35:
            factor = rng.uniform(0.55, 0.85)
            small = img.resize(
                (max(2, int(img.width * factor)), max(2, int(img.height * factor))),
                Image.Resampling.BILINEAR,
            )
            img = small.resize(img.size, Image.Resampling.BILINEAR)

        arr = np.asarray(img, dtype=np.float32)
        h, w = arr.shape
        yy, xx = np.mgrid[0:h, 0:w]
        angle = rng.uniform(0, 2 * math.pi)
        ramp = math.cos(angle) * xx / max(w, 1) + math.sin(angle) * yy / max(h, 1)
        ramp = (ramp - ramp.min()) / max(float(np.ptp(ramp)), 1e-6)
        low = rng.uniform(0.62, 0.9)
        gain = low + (rng.uniform(0.98, 1.18) - low) * ramp
        arr = arr * gain
        noise = rng.uniform(0.0, 8.0)
        if noise:
            np_rng = np.random.default_rng(rng.randrange(1 << 30))
            arr += np_rng.normal(0, noise, arr.shape)
        img = Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8))

        if rng.random() < 0.45:
            buf = io.BytesIO()
            img.save(buf, "JPEG", quality=rng.randint(45, 92))
            img = Image.open(io.BytesIO(buf.getvalue())).convert("L")
        return img

    def __getitem__(self, index: int):
        rng = random.Random(self.seed + index * 104729)
        plain = self.make_text(rng)
        label = canonical(plain, self.font_name)
        img = self.degrade(self.render(plain, rng), rng)

        scale = HEIGHT / max(img.height, 1)
        width = max(8, round(img.width * scale))
        img = img.resize((width, HEIGHT), Image.Resampling.BILINEAR)
        # Der Browser gibt dem Decoder ebenfalls ein binaeres Zeilenbild.
        # Auf Graustufen zu trainieren und Binaerbilder zu inferieren erzeugt
        # sonst einen massiven synthetisch→Foto Domain-Gap.
        arr = sauvola_ink(np.asarray(img, dtype=np.float32))
        tensor = torch.from_numpy(arr).unsqueeze(0)
        target = torch.tensor([LABEL_OF[ch] for ch in label], dtype=torch.long)
        return tensor, target, label


def collate(batch):
    images, targets, texts = zip(*batch)
    widths = [img.shape[-1] for img in images]
    max_width = max(8, math.ceil(max(widths) / 4) * 4)
    packed = torch.zeros((len(images), 1, HEIGHT, max_width), dtype=torch.float32)
    for i, img in enumerate(images):
        packed[i, :, :, : img.shape[-1]] = img
    flat_targets = torch.cat(targets)
    target_lengths = torch.tensor([len(t) for t in targets], dtype=torch.long)
    input_lengths = torch.tensor([max(1, w // 8) for w in widths], dtype=torch.long)
    return packed, flat_targets, input_lengths, target_lengths, texts


class TinyCRNN(nn.Module):
    def __init__(self, classes: int = len(CHARS) + 1):
        super().__init__()
        self.features = nn.Sequential(
            nn.Conv2d(1, 24, 3, padding=1),
            nn.BatchNorm2d(24),
            nn.ReLU(inplace=True),
            nn.MaxPool2d(2, 2),
            nn.Conv2d(24, 48, 3, padding=1),
            nn.BatchNorm2d(48),
            nn.ReLU(inplace=True),
            nn.MaxPool2d(2, 2),
            nn.Conv2d(48, 96, 3, padding=1),
            nn.BatchNorm2d(96),
            nn.ReLU(inplace=True),
            nn.MaxPool2d((2, 2)),
            nn.Conv2d(96, 128, 3, padding=1),
            nn.BatchNorm2d(128),
            nn.ReLU(inplace=True),
            nn.MaxPool2d((2, 1)),
        )
        self.sequence = nn.GRU(
            input_size=128,
            hidden_size=80,
            num_layers=1,
            bidirectional=True,
        )
        self.classifier = nn.Linear(160, classes)
        # CTC startet sonst bei langen Zeilen gern in einer stabilen
        # "alles Blank"-Loesung. Leichter Gegenbias laesst frueh Zeichen zu.
        nn.init.constant_(self.classifier.bias, 0)
        with torch.no_grad():
            self.classifier.bias[BLANK] = -1.5

    def forward(self, x):
        x = self.features(x)
        x = x.mean(dim=2).permute(2, 0, 1)
        x, _ = self.sequence(x)
        return self.classifier(x).permute(1, 0, 2)


def decode_greedy(logits: torch.Tensor) -> list[str]:
    paths = logits.argmax(dim=-1).detach().cpu().tolist()
    out = []
    for path in paths:
        chars: list[str] = []
        prev = -1
        for token in path:
            if token != BLANK and token != prev:
                chars.append(CHARS[token - 1])
            prev = token
        out.append(re.sub(r"\s+", " ", "".join(chars)).strip())
    return out


def edit_distance(a: str, b: str) -> int:
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(
                min(cur[-1] + 1, prev[j] + 1, prev[j - 1] + (ca != cb))
            )
        prev = cur
    return prev[-1]


@torch.inference_mode()
def validate(model, loader, device):
    model.eval()
    total_edits = 0
    total_chars = 0
    examples = []
    for images, _, _, _, texts in loader:
        logits = model(images.to(device))
        guesses = decode_greedy(logits)
        for want, got in zip(texts, guesses):
            total_edits += edit_distance(got, want)
            total_chars += len(want)
            if len(examples) < 3:
                examples.append((want, got))
    return total_edits / max(total_chars, 1), examples


def export_onnx(model, output: Path):
    output.parent.mkdir(parents=True, exist_ok=True)
    model = model.cpu().eval()
    dummy = torch.zeros((1, 1, HEIGHT, 320), dtype=torch.float32)
    torch.onnx.export(
        model,
        dummy,
        str(output),
        input_names=["image"],
        output_names=["logits"],
        dynamic_axes={
            "image": {0: "batch", 3: "width"},
            "logits": {0: "batch", 1: "time"},
        },
        opset_version=17,
        dynamo=False,
    )
    onnx.checker.check_model(onnx.load(str(output)))
    session = ort.InferenceSession(str(output), providers=["CPUExecutionProvider"])
    result = session.run(None, {"image": np.zeros((1, 1, HEIGHT, 320), np.float32)})
    print(
        f"ONNX: {output}  {output.stat().st_size / 1024 / 1024:.2f} MB  "
        f"Ausgabe {result[0].shape}"
    )


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--font", default="Phoenix-Taluz")
    p.add_argument("--samples", type=int, default=6000)
    p.add_argument("--val-samples", type=int, default=600)
    p.add_argument("--epochs", type=int, default=8)
    p.add_argument("--batch-size", type=int, default=16)
    p.add_argument("--lr", type=float, default=1e-3)
    p.add_argument("--seed", type=int, default=17)
    p.add_argument("--threads", type=int, default=min(12, os.cpu_count() or 4))
    p.add_argument("--output", type=Path, default=ROOT / "models" / "taluz-crnn.onnx")
    p.add_argument(
        "--checkpoint",
        type=Path,
        default=ROOT / "ml" / "checkpoints" / "taluz-crnn.pt",
    )
    return p.parse_args()


def main():
    args = parse_args()
    torch.manual_seed(args.seed)
    np.random.seed(args.seed)
    torch.set_num_threads(args.threads)
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    words = load_words()
    print(
        f"{args.font}: {len(words)} Woerter, {args.samples} Training, "
        f"{args.val_samples} Validierung, {device}, {args.threads} Threads"
    )

    clean_set = SyntheticLines(args.font, words, args.samples, args.seed, False)
    train_set = SyntheticLines(args.font, words, args.samples, args.seed, True)
    val_set = SyntheticLines(
        args.font, words, args.val_samples, args.seed + 100_000_000, True
    )
    train_loader = DataLoader(
        train_set,
        batch_size=args.batch_size,
        shuffle=True,
        collate_fn=collate,
        num_workers=0,
    )
    clean_loader = DataLoader(
        clean_set,
        batch_size=args.batch_size,
        shuffle=True,
        collate_fn=collate,
        num_workers=0,
    )
    val_loader = DataLoader(
        val_set,
        batch_size=args.batch_size,
        shuffle=False,
        collate_fn=collate,
        num_workers=0,
    )

    model = TinyCRNN().to(device)
    optimizer = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=1e-4)
    scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(
        optimizer, T_max=args.epochs
    )
    loss_fn = nn.CTCLoss(blank=BLANK, zero_infinity=True)
    best_cer = float("inf")
    args.checkpoint.parent.mkdir(parents=True, exist_ok=True)

    for epoch in range(1, args.epochs + 1):
        model.train()
        running = 0.0
        batches = 0
        # Kurzes Curriculum: erst Glyphen/CTC lernen, dann Fotostoerungen.
        loader = clean_loader if epoch <= min(2, args.epochs // 3) else train_loader
        for images, targets, input_lengths, target_lengths, _ in loader:
            images = images.to(device)
            targets = targets.to(device)
            logits = model(images)
            log_probs = logits.log_softmax(dim=-1).permute(1, 0, 2)
            loss = loss_fn(
                log_probs,
                targets,
                input_lengths.to(device),
                target_lengths.to(device),
            )
            optimizer.zero_grad(set_to_none=True)
            loss.backward()
            nn.utils.clip_grad_norm_(model.parameters(), 5.0)
            optimizer.step()
            running += float(loss.detach())
            batches += 1

        scheduler.step()
        cer, examples = validate(model, val_loader, device)
        print(
            f"Epoche {epoch:02d}/{args.epochs}  "
            f"Loss {running / max(batches, 1):.3f}  CER {cer * 100:.2f}%"
        )
        if epoch == 1 or epoch == args.epochs or cer < best_cer:
            for want, got in examples[:2]:
                print(f"  soll: {want[:90]}\n  ist : {got[:90]}")
        if cer < best_cer:
            best_cer = cer
            torch.save(model.state_dict(), args.checkpoint)

    model.load_state_dict(torch.load(args.checkpoint, map_location=device))
    export_onnx(model, args.output)
    print(f"Beste synthetische CER: {best_cer * 100:.2f}%")


if __name__ == "__main__":
    main()

// JPEG laden und die EXIF-Ausrichtung anwenden.
// Browser tun das beim HTMLImageElement automatisch; jpeg-js allein nicht.

import fs from "node:fs";
import jpeg from "jpeg-js";
import exifr from "exifr";

export async function decodeJpegOriented(file) {
  const buffer = fs.readFileSync(file);
  const raw = jpeg.decode(buffer, { useTArray: true });
  const orientation = (await exifr.orientation(buffer).catch(() => 1)) || 1;
  return orientRgba(raw, orientation);
}

function orientRgba(raw, orientation) {
  if (orientation === 1) return raw;
  const { width: w, height: h, data } = raw;
  const swap = orientation >= 5 && orientation <= 8;
  const width = swap ? h : w;
  const height = swap ? w : h;
  const out = new Uint8Array(width * height * 4);

  for (let sy = 0; sy < h; sy++) {
    for (let sx = 0; sx < w; sx++) {
      let dx, dy;
      switch (orientation) {
        case 2: dx = w - 1 - sx; dy = sy; break;
        case 3: dx = w - 1 - sx; dy = h - 1 - sy; break;
        case 4: dx = sx; dy = h - 1 - sy; break;
        case 5: dx = sy; dy = sx; break;
        case 6: dx = h - 1 - sy; dy = sx; break;
        case 7: dx = h - 1 - sy; dy = w - 1 - sx; break;
        case 8: dx = sy; dy = w - 1 - sx; break;
        default: dx = sx; dy = sy;
      }
      const si = (sy * w + sx) * 4;
      const di = (dy * width + dx) * 4;
      out[di] = data[si];
      out[di + 1] = data[si + 1];
      out[di + 2] = data[si + 2];
      out[di + 3] = data[si + 3];
    }
  }
  return { width, height, data: out, orientation };
}

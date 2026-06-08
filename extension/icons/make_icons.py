"""
Generate extension icon PNGs. Requires Pillow: pip install Pillow
Run from the icons/ directory: python make_icons.py
"""

from PIL import Image, ImageDraw, ImageFont
import os

SIZES = [16, 48, 128]
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))


def draw_icon(size, greyed=False):
    bg = (30, 41, 59) if not greyed else (50, 50, 50)
    accent = (59, 130, 246) if not greyed else (100, 100, 100)

    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # Rounded rectangle background
    pad = max(1, size // 16)
    draw.rounded_rectangle([pad, pad, size - pad - 1, size - pad - 1],
                            radius=max(2, size // 8), fill=bg)

    # Simple "✈" glyph using a filled triangle for small sizes
    cx, cy = size // 2, size // 2
    r = size // 4

    # Plane body: horizontal bar
    draw.rectangle([cx - r, cy - max(1, r // 4), cx + r, cy + max(1, r // 4)], fill=accent)
    # Nose
    draw.polygon([(cx + r, cy), (cx + r + max(2, r // 2), cy)], fill=accent)
    # Wing
    draw.polygon([(cx - r // 2, cy), (cx, cy - r), (cx + r // 3, cy)], fill=accent)
    # Tail
    draw.polygon([(cx - r, cy), (cx - r // 2, cy - r // 2), (cx - r // 4, cy)], fill=accent)

    return img


for size in SIZES:
    for greyed in [False, True]:
        img = draw_icon(size, greyed)
        suffix = '-grey' if greyed else ''
        path = os.path.join(SCRIPT_DIR, f'icon{size}{suffix.replace("-", "_")}.png')
        img.save(path)
        print(f'Wrote {path}')

print('Done.')

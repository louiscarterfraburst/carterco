#!/usr/bin/env python3
from pathlib import Path
from typing import Optional

from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageFont


ROOT = Path("/Users/louiscarter/carterco")
SRC_DIR = Path("/Users/louiscarter/Downloads/ad images")
OUT_DIR = ROOT / "clients/carterco/assets/fb-ads"

TEXT = ["Har I B2B-leads?", "Lad mig finde én proces", "AI kan forbedre på 20 min."]
FONT = "/System/Library/Fonts/Avenir Next.ttc"


VARIANTS = [
    {
        "src": "IMG_2533.JPG",
        "name": "coffee-close-left-text",
        "crop": (210, 0, 1535, 1656),
        "text_xy": (92, 118),
        "brand_xy": (92, 1540),
    },
    {
        "src": "IMG_2532.JPG",
        "name": "coffee-medium-left-text",
        "crop": (140, 0, 1465, 1656),
        "text_xy": (88, 112),
        "brand_xy": (88, 1540),
    },
    {
        "src": "IMG_2536.JPG",
        "name": "coffee-wide-top-text",
        "crop": (550, 0, 1875, 1656),
        "text_xy": (86, 96),
        "brand_xy": (86, 1540),
    },
]

TEXT_STYLE_VARIANTS = [
    {
        "name": "01-clean-large",
        "crop": (210, 0, 1535, 1656),
        "text_xy": (84, 104),
        "brand_xy": (84, 1540),
        "sizes": [82, 63, 63],
        "style": "clean",
    },
    {
        "name": "02-editorial-serif",
        "crop": (210, 0, 1535, 1656),
        "text_xy": (78, 96),
        "brand_xy": (78, 1540),
        "sizes": [76, 60, 60],
        "style": "serif",
    },
    {
        "name": "03-label-card",
        "crop": (210, 0, 1535, 1656),
        "text_xy": (70, 84),
        "brand_xy": (78, 1540),
        "sizes": [62, 53, 53],
        "style": "card",
    },
    {
        "name": "04-handwritten-note",
        "crop": (210, 0, 1535, 1656),
        "text_xy": (80, 92),
        "brand_xy": (82, 1540),
        "sizes": [70, 56, 56],
        "style": "note",
    },
    {
        "name": "05-bottom-caption",
        "crop": (210, 0, 1535, 1656),
        "text_xy": (82, 1018),
        "brand_xy": (82, 92),
        "sizes": [74, 58, 58],
        "style": "bottom",
    },
    {
        "name": "06-highlight-ai",
        "crop": (210, 0, 1535, 1656),
        "text_xy": (76, 96),
        "brand_xy": (76, 1540),
        "sizes": [78, 59, 59],
        "style": "highlight",
    },
]


def font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont:
    # Avenir Next.ttc index 1 is a heavier face on macOS. If the index changes
    # on another machine, Pillow falls back to index 0.
    try:
        return ImageFont.truetype(FONT, size=size, index=1 if bold else 0)
    except TypeError:
        return ImageFont.truetype(FONT, size=size)


def serif_font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont:
    path = "/System/Library/Fonts/Supplemental/Georgia Bold.ttf" if bold else "/System/Library/Fonts/Supplemental/Georgia.ttf"
    return ImageFont.truetype(path, size=size)


def add_gradient(img: Image.Image, top: bool = True, strength: int = 150) -> Image.Image:
    w, h = img.size
    overlay = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    height = int(h * 0.48)
    for y in range(height):
        alpha = int(strength * (1 - y / height) ** 1.25)
        draw.line([(0, y), (w, y)], fill=(0, 0, 0, alpha))
    if not top:
        overlay = overlay.transpose(Image.Transpose.FLIP_TOP_BOTTOM)
    return Image.alpha_composite(img.convert("RGBA"), overlay)


def draw_text(img: Image.Image, xy: tuple[int, int], sizes: Optional[list[int]] = None) -> None:
    draw = ImageDraw.Draw(img)
    x, y = xy
    sizes = sizes or [78, 64, 64]
    line_gap = 20
    for i, line in enumerate(TEXT):
        f = font(sizes[i], bold=i == 0)
        # Soft shadow, enough for mobile readability without making it poster-y.
        for dx, dy, alpha in [(0, 3, 92), (0, 8, 42)]:
            draw.text((x + dx, y + dy), line, font=f, fill=(0, 0, 0, alpha))
        draw.text((x, y), line, font=f, fill=(255, 255, 248, 246))
        bbox = draw.textbbox((x, y), line, font=f)
        y = bbox[3] + line_gap


def draw_serif_text(img: Image.Image, xy: tuple[int, int], sizes: list[int]) -> None:
    draw = ImageDraw.Draw(img)
    x, y = xy
    for i, line in enumerate(TEXT):
        f = serif_font(sizes[i], bold=i == 0)
        draw.text((x, y + 5), line, font=f, fill=(0, 0, 0, 88))
        draw.text((x, y), line, font=f, fill=(255, 249, 235, 246))
        bbox = draw.textbbox((x, y), line, font=f)
        y = bbox[3] + 18


def rounded_rectangle(draw: ImageDraw.ImageDraw, box: tuple[int, int, int, int], radius: int, fill: tuple[int, int, int, int]) -> None:
    draw.rounded_rectangle(box, radius=radius, fill=fill)


def draw_card_text(img: Image.Image, xy: tuple[int, int], sizes: list[int]) -> None:
    draw = ImageDraw.Draw(img)
    x, y = xy
    line_fonts = [font(sizes[0], True), font(sizes[1]), font(sizes[2])]
    boxes = [draw.textbbox((0, 0), line, font=line_fonts[i]) for i, line in enumerate(TEXT)]
    width = max(b[2] - b[0] for b in boxes) + 64
    height = sum(b[3] - b[1] for b in boxes) + 94
    rounded_rectangle(draw, (x, y, x + width, y + height), 34, (252, 247, 238, 232))
    cy = y + 38
    for i, line in enumerate(TEXT):
        f = line_fonts[i]
        fill = (35, 31, 26, 246) if i == 0 else (50, 45, 38, 238)
        draw.text((x + 32, cy), line, font=f, fill=fill)
        bbox = draw.textbbox((x + 32, cy), line, font=f)
        cy = bbox[3] + 16


def draw_note_text(img: Image.Image, xy: tuple[int, int], sizes: list[int]) -> None:
    draw = ImageDraw.Draw(img)
    x, y = xy
    draw.line((x, y + 88, x + 700, y + 88), fill=(255, 245, 210, 138), width=5)
    for i, line in enumerate(TEXT):
        f = font(sizes[i], bold=i == 0)
        draw.text((x + 2, y + 4), line, font=f, fill=(0, 0, 0, 80))
        draw.text((x, y), line, font=f, fill=(255, 250, 238, 248))
        bbox = draw.textbbox((x, y), line, font=f)
        y = bbox[3] + 19


def draw_highlight_text(img: Image.Image, xy: tuple[int, int], sizes: list[int]) -> None:
    draw = ImageDraw.Draw(img)
    x, y = xy
    for i, line in enumerate(TEXT):
        f = font(sizes[i], bold=i == 0)
        if "AI" in line:
            bbox = draw.textbbox((x, y), line, font=f)
            rounded_rectangle(draw, (x - 14, y + 2, bbox[2] + 16, bbox[3] + 8), 16, (206, 105, 52, 218))
        draw.text((x, y + 4), line, font=f, fill=(0, 0, 0, 75))
        draw.text((x, y), line, font=f, fill=(255, 255, 248, 248))
        bbox = draw.textbbox((x, y), line, font=f)
        y = bbox[3] + 18


def draw_brand(img: Image.Image, xy: tuple[int, int]) -> None:
    draw = ImageDraw.Draw(img)
    f = font(32)
    draw.text(xy, "Carter & Co", font=f, fill=(255, 255, 248, 205))


def make_variant(v: dict) -> None:
    src = Image.open(SRC_DIR / v["src"]).convert("RGB")
    crop = src.crop(v["crop"])
    crop = crop.resize((1080, 1350), Image.Resampling.LANCZOS)
    crop = ImageEnhance.Color(crop).enhance(0.94)
    crop = ImageEnhance.Contrast(crop).enhance(1.04)
    crop = ImageEnhance.Sharpness(crop).enhance(1.08)
    img = add_gradient(crop, top=True)
    draw_text(img, v["text_xy"])
    draw_brand(img, v["brand_xy"])

    png_path = OUT_DIR / f"carterco-fb-ad-{v['name']}.png"
    jpg_path = OUT_DIR / f"carterco-fb-ad-{v['name']}.jpg"
    img.convert("RGB").save(png_path, quality=95)
    img.convert("RGB").save(jpg_path, quality=92, optimize=True)
    print(png_path)
    print(jpg_path)


def make_text_style_variant(v: dict) -> None:
    src = Image.open(SRC_DIR / "IMG_2533.JPG").convert("RGB")
    crop = src.crop(v["crop"])
    crop = crop.resize((1080, 1350), Image.Resampling.LANCZOS)
    crop = ImageEnhance.Color(crop).enhance(0.94)
    crop = ImageEnhance.Contrast(crop).enhance(1.04)
    crop = ImageEnhance.Sharpness(crop).enhance(1.08)
    top = v["style"] != "bottom"
    img = add_gradient(crop, top=top, strength=138 if v["style"] in ["card", "note"] else 158)
    style = v["style"]
    if style == "serif":
        draw_serif_text(img, v["text_xy"], v["sizes"])
    elif style == "card":
        draw_card_text(img, v["text_xy"], v["sizes"])
    elif style == "note":
        draw_note_text(img, v["text_xy"], v["sizes"])
    elif style == "highlight":
        draw_highlight_text(img, v["text_xy"], v["sizes"])
    else:
        draw_text(img, v["text_xy"], v["sizes"])
    draw_brand(img, v["brand_xy"])

    png_path = OUT_DIR / f"carterco-fb-ad-img2533-{v['name']}.png"
    jpg_path = OUT_DIR / f"carterco-fb-ad-img2533-{v['name']}.jpg"
    img.convert("RGB").save(png_path, quality=95)
    img.convert("RGB").save(jpg_path, quality=92, optimize=True)
    print(png_path)
    print(jpg_path)


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for variant in VARIANTS:
        make_variant(variant)
    for variant in TEXT_STYLE_VARIANTS:
        make_text_style_variant(variant)


if __name__ == "__main__":
    main()

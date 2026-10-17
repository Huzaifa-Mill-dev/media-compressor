#!/usr/bin/env python3
"""Convert a font between ttf / otf / woff / woff2 with fontTools (+ brotli for woff2).

Usage: font_convert.py <input> <output> <ttf|otf|woff|woff2>

Spawned with an argument array only (never a shell). Prints one JSON object on stdout on success.
Exit codes: 0 ok, 2 bad usage, 3 unreadable / unsupported font, 4 conversion failed.
"""
import json
import sys

try:
    from fontTools.ttLib import TTFont, newTable
except Exception as exc:  # pragma: no cover
    print(f"fontTools unavailable: {exc}", file=sys.stderr)
    sys.exit(2)

MAX_GLYPHS = 65535


def fail(code, msg):
    print(msg, file=sys.stderr)
    sys.exit(code)


def is_cff(font):
    return "CFF " in font or "CFF2" in font


def otf_to_ttf(font, max_err=1.0):
    """CFF (cubic) outlines -> glyf (quadratic) outlines, after fontTools' otf2ttf snippet."""
    from fontTools.pens.cu2quPen import Cu2QuPen
    from fontTools.pens.ttGlyphPen import TTGlyphPen

    if "CFF2" in font:
        raise ValueError("CFF2 (variable) fonts are not supported")
    order = font.getGlyphOrder()
    gs = font.getGlyphSet()
    glyphs = {}
    for name in order:
        pen = TTGlyphPen(gs)
        gs[name].draw(Cu2QuPen(pen, max_err, reverse_direction=True))
        glyphs[name] = pen.glyph()
    font["loca"] = newTable("loca")
    font["glyf"] = glyf = newTable("glyf")
    glyf.glyphOrder = order
    glyf.glyphs = glyphs
    del font["CFF "]
    if "VORG" in font:
        del font["VORG"]
    glyf.compile(font)
    # hmtx: recompute lsb from the new glyph bounds
    hmtx = font["hmtx"]
    for name in order:
        adv, _ = hmtx[name]
        g = glyf[name]
        g.recalcBounds(glyf)
        hmtx[name] = (adv, getattr(g, "xMin", 0))
    maxp = font["maxp"]
    maxp.tableVersion = 0x00010000
    maxp.maxZones = 1
    maxp.maxTwilightPoints = 0
    maxp.maxStorage = 0
    maxp.maxFunctionDefs = 0
    maxp.maxInstructionDefs = 0
    maxp.maxStackElements = 0
    maxp.maxSizeOfInstructions = 0
    maxp.maxComponentElements = max((len(g.components) if hasattr(g, "components") else 0) for g in glyf.glyphs.values())
    post = font["post"]
    post.formatType = 2.0
    post.extraNames = []
    post.mapping = {}
    post.glyphOrder = order
    font["head"].glyphDataFormat = 0
    font.sfntVersion = "\000\001\000\000"


def ttf_to_otf(font):
    """glyf (quadratic) outlines -> CFF (cubic, exact) outlines."""
    from fontTools.fontBuilder import FontBuilder
    from fontTools.pens.t2CharStringPen import T2CharStringPen

    if "glyf" not in font:
        raise ValueError("font has no TrueType outlines")
    order = font.getGlyphOrder()
    gs = font.getGlyphSet()
    charstrings = {}
    for name in order:
        pen = T2CharStringPen(gs[name].width, gs)
        gs[name].draw(pen)
        charstrings[name] = pen.getCharString()
    names = font["name"]
    ps_name = (names.getDebugName(6) or "ConvertedFont").replace(" ", "")
    info = {
        "version": str(names.getDebugName(5) or "1.000"),
        "FullName": names.getDebugName(4) or ps_name,
        "FamilyName": names.getDebugName(1) or ps_name,
        "Weight": "Regular",
    }
    for t in ("glyf", "loca", "cvt ", "fpgm", "prep", "gasp", "hdmx", "LTSH", "VDMX", "PCLT", "EBDT", "EBLC", "EBSC"):
        if t in font:
            del font[t]
    fb = FontBuilder(font=font, isTTF=False)
    fb.isTTF = False
    font.sfntVersion = "OTTO"
    fb.setupCFF(ps_name, info, charstrings, {})
    font["maxp"] = newMaxp = newTable("maxp")
    newMaxp.tableVersion = 0x00005000
    newMaxp.numGlyphs = len(order)
    post = font["post"]
    post.formatType = 3.0
    font["head"].glyphDataFormat = 0
    if "head" in font:
        font["head"].indexToLocFormat = 0


def main():
    if len(sys.argv) != 4:
        fail(2, "usage: font_convert.py <input> <output> <ttf|otf|woff|woff2>")
    src, dst, target = sys.argv[1:4]
    if target not in ("ttf", "otf", "woff", "woff2"):
        fail(2, "unsupported target format")
    try:
        font = TTFont(src, lazy=False, recalcBBoxes=True)
    except Exception as exc:
        fail(3, f"Not a readable font file: {exc}")
    if "glyf" not in font and not is_cff(font):
        fail(3, "Font has neither TrueType nor CFF outlines (bitmap / SVG-only fonts are not supported)")
    if font.sfntVersion not in ("OTTO", "\000\001\000\000", "true"):
        fail(3, "Unsupported sfnt container")
    if len(font.getGlyphOrder()) > MAX_GLYPHS:
        fail(3, "Font has too many glyphs")
    src_flavor = font.flavor
    try:
        if target in ("ttf", "otf"):
            font.flavor = None
            have_cff = is_cff(font)
            if target == "ttf" and have_cff:
                otf_to_ttf(font)
            elif target == "otf" and not have_cff:
                ttf_to_otf(font)
        else:
            font.flavor = target
        font.save(dst)
    except Exception as exc:
        fail(4, f"Conversion failed: {exc}")
    names = font["name"] if "name" in font else None
    print(
        json.dumps(
            {
                "family": (names.getDebugName(1) if names else None),
                "glyphs": len(font.getGlyphOrder()),
                "outlines": "cff" if is_cff(font) else "truetype",
                "sourceFlavor": src_flavor,
            }
        )
    )


if __name__ == "__main__":
    main()

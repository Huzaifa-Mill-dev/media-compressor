#!/usr/bin/env python3
"""Convert a PDF into an editable Word document with pdf2docx (PyMuPDF + python-docx).

Usage: pdf_to_docx.py <input.pdf> <output.docx> <max_pages>

Spawned with an argument array only (never a shell), single process (no multiprocessing).
Progress lines "P <percent>" go to stdout; the last stdout line is one JSON object on success.
Exit codes: 0 ok, 2 bad usage / missing library, 3 unreadable PDF, 4 password-protected,
5 too many pages, 6 conversion failed.
"""
import json
import logging
import re
import sys
import warnings

warnings.filterwarnings("ignore")  # PyMuPDF's `fitz` deprecation notice etc. must not pollute stderr

try:
    import pymupdf
    from pdf2docx import Converter
except Exception as exc:  # pragma: no cover
    print(f"pdf2docx unavailable: {exc}", file=sys.stderr)
    sys.exit(2)


def fail(code, msg):
    print(msg, file=sys.stderr)
    sys.exit(code)


def emit(percent):
    print(f"P {int(percent)}", flush=True)


class ProgressHandler(logging.Handler):
    """pdf2docx logs "[3/4] Parsing pages..." then "(i/N) Page i" per page; map that onto 10–95%."""

    PHASES = {3: (10, 60), 4: (60, 95)}

    def __init__(self):
        super().__init__(logging.INFO)
        self.phase = 0

    def emit(self, record):
        msg = record.getMessage()
        m = re.search(r"\[(\d)/4\]", msg)  # phase lines are wrapped in ANSI colour codes
        if m:
            self.phase = int(m.group(1))
            return
        m = re.match(r"\((\d+)/(\d+)\)", msg)
        if m and self.phase in self.PHASES:
            lo, hi = self.PHASES[self.phase]
            emit(lo + (hi - lo) * int(m.group(1)) / max(1, int(m.group(2))))


def main():
    if len(sys.argv) != 4:
        fail(2, "usage: pdf_to_docx.py <input.pdf> <output.docx> <max_pages>")
    src, dst, max_pages = sys.argv[1], sys.argv[2], int(sys.argv[3])

    try:
        doc = pymupdf.open(src, filetype="pdf")
    except Exception:
        fail(3, "unreadable PDF")
    with doc:
        if doc.needs_pass:
            fail(4, "password-protected")
        pages = doc.page_count
        if pages < 1:
            fail(3, "no pages")
        if pages > max_pages:
            fail(5, f"more than {max_pages} pages")
        # No extractable text on any of the first pages → most likely a scan; pdf2docx then yields images only.
        sample = range(min(pages, 5))
        scanned = all(not doc[i].get_text("text").strip() for i in sample)

    log = logging.getLogger()
    log.handlers[:] = [ProgressHandler()]
    log.setLevel(logging.INFO)

    emit(5)
    try:
        cv = Converter(src)
        try:
            cv.convert(dst, multi_processing=False)
        finally:
            cv.close()
    except Exception as exc:
        fail(6, f"conversion failed: {type(exc).__name__}")
    print(json.dumps({"pages": pages, "scanned": scanned}), flush=True)


if __name__ == "__main__":
    main()

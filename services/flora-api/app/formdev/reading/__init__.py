"""Reading documents into forms (formdev/docs/FORM-STUDIO-V2.md §5), the way IDP systems do it: tools find the
evidence, the AI (when asked) only interprets it, and every answer is checked against the evidence.

A page goes through deterministic steps first, each cheap and each reporting what it found with page coordinates, so
the work can be watched on the page as it happens:

    pdf.py         the PDF's own text layer and form fields, the resolution of a scan (no OCR when the text is good)
    preprocess.py  a scan straightened (by its ruled lines or its rows of text) and its lighting evened out
    ocr.py         Thai and English OCR on page images (RapidOCR, PP-OCRv5 Thai, on CPU; models in the image)
    thai.py        Thai text clean-up: Unicode NFC, shifted glyphs of old fonts, tone marks a dictionary can restore
    layout.py      the evidence, with ids: text lines (L), ruled cells (C), grids of charts (G), blanks to write on
                   (B: free underlines, dotted leaders), checkboxes (K)
    understand.py  the form the evidence asks for, by rules: title, records over time, tables, labelled blanks with
                   their units, choices, labels with room; a plan whose every item points at its evidence
    assemble.py    the AI's edits to the plan (when asked), each checked against the evidence; coverage of the text
    draft.py       the plan → a Form Studio definition on the 24-column grid, named by app/formdev/ids.py
    jobs.py        a reading job: runs the steps in the background and records each event for the screen

Geometry is in page fractions (0-1, origin top left) so the browser can draw it over its own page rendering.
"""

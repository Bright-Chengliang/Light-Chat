#!/usr/bin/env python3
"""Extract PDF text in human reading order, including two-column papers."""

from __future__ import annotations

import argparse
import statistics
import sys
from pathlib import Path

import pdfplumber


LINE_TOLERANCE = 2.6
MIN_GUTTER_POINTS = 16.0
MAX_PAGES = 500
MAX_OUTPUT_CHARS = 16 * 1024 * 1024


def group_lines(words: list[dict]) -> list[list[dict]]:
    lines: list[list[dict]] = []
    for word in sorted(words, key=lambda item: (float(item["top"]), float(item["x0"]))):
        top = float(word["top"])
        target = None
        for line in reversed(lines[-4:]):
            line_top = statistics.median(float(item["top"]) for item in line)
            if abs(top - line_top) <= LINE_TOLERANCE:
                target = line
                break
            if top - line_top > LINE_TOLERANCE:
                break
        if target is None:
            target = []
            lines.append(target)
        target.append(word)
    for line in lines:
        line.sort(key=lambda item: float(item["x0"]))
    return lines


def detect_column_split(lines: list[list[dict]], width: float) -> float | None:
    candidates: list[float] = []
    minimum_gap = max(MIN_GUTTER_POINTS, width * 0.025)
    for line in lines:
        for left, right in zip(line, line[1:]):
            gap = float(right["x0"]) - float(left["x1"])
            midpoint = (float(left["x1"]) + float(right["x0"])) / 2
            if gap >= minimum_gap and width * 0.40 <= midpoint <= width * 0.60:
                candidates.append(midpoint)
    if len(candidates) < max(6, round(len(lines) * 0.05)):
        return None
    radius = width * 0.025
    clusters = [[candidate for candidate in candidates if abs(candidate - pivot) <= radius] for pivot in candidates]
    clustered = max(
        clusters,
        key=lambda values: len(values) / (1 + abs(statistics.median(values) - width / 2) / (width * 0.035)),
    )
    if len(clustered) < max(2, round(len(lines) * 0.015)):
        return None
    return statistics.median(clustered)


def line_text(words: list[dict]) -> str:
    if not words:
        return ""
    return " ".join(str(word["text"]).strip() for word in words if str(word["text"]).strip()).strip()


def fragment_line(line: list[dict], split: float, width: float) -> tuple[str, list[dict]]:
    left = [word for word in line if (float(word["x0"]) + float(word["x1"])) / 2 < split]
    right = [word for word in line if word not in left]
    if left and right:
        gap = float(right[0]["x0"]) - float(left[-1]["x1"])
        # True full-width prose crosses the midpoint with ordinary word spacing.
        # Two independent columns can occasionally leave a relatively narrow
        # gutter, so keep this threshold deliberately stricter than detection.
        if gap < max(7.0, width * 0.012):
            return "full", line
        return "split", [left, right]
    if left:
        return "left", left
    if right:
        return "right", right
    return "full", line


def extract_page(page) -> str:
    words = page.extract_words(
        x_tolerance=1.5,
        y_tolerance=2.5,
        keep_blank_chars=False,
        use_text_flow=False,
        expand_ligatures=True,
    )
    if not words:
        return ""
    lines = group_lines(words)
    split = detect_column_split(lines, float(page.width))
    if split is None:
        return "\n".join(filter(None, (line_text(line) for line in lines)))

    output: list[str] = []
    left_buffer: list[str] = []
    right_buffer: list[str] = []

    def flush_columns() -> None:
        if left_buffer:
            output.extend(left_buffer)
        if right_buffer:
            if left_buffer and output and output[-1] != "":
                output.append("")
            output.extend(right_buffer)
        left_buffer.clear()
        right_buffer.clear()

    for line in lines:
        kind, fragments = fragment_line(line, split, float(page.width))
        if kind == "full":
            flush_columns()
            text = line_text(fragments)
            if text:
                output.append(text)
            continue
        if kind == "split":
            left_text = line_text(fragments[0])
            right_text = line_text(fragments[1])
            if left_text:
                left_buffer.append(left_text)
            if right_text:
                right_buffer.append(right_text)
            continue
        text = line_text(fragments)
        if text:
            (left_buffer if kind == "left" else right_buffer).append(text)
    flush_columns()
    return "\n".join(output)


def extract_pdf(input_path: Path) -> str:
    pages: list[str] = []
    with pdfplumber.open(input_path) as pdf:
        if len(pdf.pages) > MAX_PAGES:
            raise ValueError(f"PDF page count exceeds {MAX_PAGES}")
        total = 0
        for index, page in enumerate(pdf.pages, start=1):
            text = extract_page(page).strip()
            if not text:
                continue
            section = f"[Page {index}]\n{text}"
            total += len(section)
            if total > MAX_OUTPUT_CHARS:
                raise ValueError("extracted PDF text is too large")
            pages.append(section)
    result = "\n\n".join(pages).strip()
    if len(result) < 20:
        raise ValueError("PDF contains no extractable text; it may require OCR")
    return result + "\n"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("input_pdf", type=Path)
    parser.add_argument("output_txt", type=Path)
    args = parser.parse_args()
    if not args.input_pdf.is_file():
        raise ValueError("input PDF does not exist")
    text = extract_pdf(args.input_pdf)
    args.output_txt.parent.mkdir(parents=True, exist_ok=True)
    args.output_txt.write_text(text, encoding="utf-8", newline="\n")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:  # Keep server logs concise and path-free.
        print(f"PDF extraction failed: {error}", file=sys.stderr)
        raise SystemExit(1)

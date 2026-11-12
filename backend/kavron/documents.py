from __future__ import annotations

import csv
import io
from pathlib import Path

TEXT_EXTENSIONS = {
    ".txt", ".md", ".markdown", ".json", ".csv", ".py", ".ts", ".tsx", ".js", ".jsx",
    ".html", ".css", ".yaml", ".yml", ".toml", ".sql", ".go", ".rs", ".java", ".sh",
    ".xml", ".ini", ".log",
}
SUPPORTED_EXTENSIONS = TEXT_EXTENSIONS | {".pdf", ".docx"}
MAX_EXTRACTED_CHARS = 200_000


class DocumentError(ValueError):
    pass


def extract_text(path: Path, extension: str) -> str:
    ext = extension.lower()
    if ext not in SUPPORTED_EXTENSIONS:
        raise DocumentError("Unsupported document type. Supported types: text, Markdown, JSON, CSV, source code, PDF, DOCX.")
    if ext in TEXT_EXTENSIONS:
        try:
            raw = path.read_text(encoding="utf-8-sig")
        except UnicodeDecodeError as exc:
            raise DocumentError("Text file is not valid UTF-8.") from exc
        if ext == ".json":
            import json
            try:
                raw = json.dumps(json.loads(raw), ensure_ascii=False, indent=2)
            except json.JSONDecodeError as exc:
                raise DocumentError("Invalid JSON document.") from exc
        elif ext == ".csv":
            try:
                rows = list(csv.reader(io.StringIO(raw)))
                raw = "\n".join(" | ".join(cell for cell in row) for row in rows)
            except csv.Error as exc:
                raise DocumentError("Invalid CSV document.") from exc
    elif ext == ".pdf":
        try:
            from pypdf import PdfReader
            reader = PdfReader(str(path), strict=True)
            raw = "\n\n".join(page.extract_text() or "" for page in reader.pages)
        except ImportError as exc:
            raise DocumentError("PDF parsing is unavailable: install the optional pypdf dependency.") from exc
        except Exception as exc:
            raise DocumentError("Could not parse this PDF file.") from exc
    else:
        try:
            from docx import Document
            document = Document(str(path))
            paragraphs = [paragraph.text for paragraph in document.paragraphs if paragraph.text.strip()]
            for table in document.tables:
                paragraphs.extend(" | ".join(cell.text for cell in row.cells) for row in table.rows)
            raw = "\n".join(paragraphs)
        except ImportError as exc:
            raise DocumentError("DOCX parsing is unavailable: install the optional python-docx dependency.") from exc
        except Exception as exc:
            raise DocumentError("Could not parse this DOCX file.") from exc
    cleaned = raw.replace("\x00", "").strip()
    if not cleaned:
        raise DocumentError("No extractable text was found in the document.")
    if len(cleaned) > MAX_EXTRACTED_CHARS:
        cleaned = cleaned[:MAX_EXTRACTED_CHARS] + "\n[Text truncated at the configured extraction limit.]"
    return cleaned

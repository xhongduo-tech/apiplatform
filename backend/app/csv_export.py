"""CSV 导出共享：admin / 用户侧日志导出共用的下载响应包装。"""
from __future__ import annotations

import csv
import io
from collections.abc import Iterable
from typing import Any

from fastapi.responses import StreamingResponse


_FORMULA_PREFIXES = ("=", "+", "-", "@")


def safe_csv_cell(value: Any) -> Any:
    """Neutralize spreadsheet formulas while preserving ordinary CSV values.

    Excel and similar applications can execute cells beginning with formula
    sigils.  User-controlled project, department and error text is therefore
    prefixed with an apostrophe before it reaches an exported workbook.
    """
    if not isinstance(value, str):
        return value
    probe = value.lstrip(" \t\r\n")
    if probe.startswith(_FORMULA_PREFIXES):
        return "'" + value
    return value


def csv_download(headers: list, rows: Iterable[list], filename: str) -> StreamingResponse:
    """表头 + 数据行 → CSV 下载响应（带 BOM，Excel 打开 UTF-8 不乱码）。"""
    def stream():
        buf = io.StringIO()
        writer = csv.writer(buf)
        writer.writerow([safe_csv_cell(v) for v in headers])
        yield ("\ufeff" + buf.getvalue()).encode("utf-8")
        for row in rows:
            buf.seek(0)
            buf.truncate(0)
            writer.writerow([safe_csv_cell(v) for v in row])
            yield buf.getvalue().encode("utf-8")

    return StreamingResponse(
        stream(),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f"attachment; filename={filename}"},
    )

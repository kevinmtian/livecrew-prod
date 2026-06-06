from __future__ import annotations

from typing import Any

try:
    from ..commerce import build_report
    from ..ledger import append_event
except ImportError:  # pragma: no cover - supports `uvicorn main:app` from backend/
    from commerce import build_report
    from ledger import append_event


def generate_report() -> dict[str, Any]:
    report = build_report()
    append_event("report_generated", {"total_units_sold": report["total_units_sold"]})
    return report

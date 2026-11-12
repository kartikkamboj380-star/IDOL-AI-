from __future__ import annotations

import json
import logging
from typing import Any


def log_event(logger: logging.Logger, level: int, event: str, **fields: Any) -> None:
    """Emit single-line JSON events; callers must pass identifiers, never secrets or content."""
    logger.log(level, json.dumps({"event": event, **fields}, ensure_ascii=True, separators=(",", ":"), default=str))

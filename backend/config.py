import os
from functools import lru_cache
from pathlib import Path
from typing import Dict, Optional


PROJECT_ROOT = Path(__file__).resolve().parents[1]
ENV_FILES = [PROJECT_ROOT / ".env.local", PROJECT_ROOT / ".env"]


@lru_cache(maxsize=1)
def load_env_files() -> Dict[str, str]:
    loaded: Dict[str, str] = {}
    for env_file in ENV_FILES:
        if not env_file.exists():
            continue
        for line in env_file.read_text(encoding="utf-8").splitlines():
            parsed = _parse_env_line(line)
            if not parsed:
                continue
            key, value = parsed
            loaded[key] = value
            os.environ.setdefault(key, value)
    return loaded


def get_env(name: str, default: Optional[str] = None) -> Optional[str]:
    load_env_files()
    return os.getenv(name, default)


def get_openai_api_key() -> Optional[str]:
    return get_env("OPENAI_API_KEY")


def get_openai_concierge_model() -> str:
    return get_env("OPENAI_CONCIERGE_MODEL", "gpt-4o-mini") or "gpt-4o-mini"


def get_openai_base_url(default: str) -> str:
    return get_env("OPENAI_BASE_URL", default) or default


def openai_concierge_enabled() -> bool:
    return bool(get_openai_api_key()) and get_env("LIVECREW_DISABLE_OPENAI_CONCIERGE") != "1"


def _parse_env_line(line: str) -> Optional[tuple[str, str]]:
    stripped = line.strip()
    if not stripped or stripped.startswith("#") or "=" not in stripped:
        return None

    key, value = stripped.split("=", 1)
    key = key.strip()
    value = value.strip()

    if not key:
        return None

    if value and value[0] in {"'", '"'} and value[-1:] == value[0]:
        value = value[1:-1]

    return key, value

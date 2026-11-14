"""Конфігурація застосунку: все читається зі змінних оточення (або файлу .env)."""

from __future__ import annotations

import os
import secrets
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
INSTANCE_DIR = BASE_DIR / "instance"


def env_bool(name: str, default: bool) -> bool:
    value = os.environ.get(name)
    if value is None or value.strip() == "":
        return default
    return value.strip().lower() in {"1", "true", "yes", "on", "так"}


def normalize_database_url(url: str) -> str:
    """Render та Heroku віддають postgres:// або postgresql:// — переводимо на драйвер psycopg 3."""
    url = url.strip()
    for prefix in ("postgres://", "postgresql://"):
        if url.startswith(prefix):
            return "postgresql+psycopg://" + url[len(prefix):]
    return url


def _database_url() -> str:
    url = os.environ.get("DATABASE_URL", "").strip()
    if url:
        return normalize_database_url(url)
    INSTANCE_DIR.mkdir(parents=True, exist_ok=True)
    return f"sqlite:///{INSTANCE_DIR / 'workshop.db'}"


def _secret_key() -> str:
    key = os.environ.get("SECRET_KEY", "").strip()
    if key:
        return key
    # Локально: генеруємо один раз і зберігаємо, щоб сесії учасників переживали перезапуск.
    INSTANCE_DIR.mkdir(parents=True, exist_ok=True)
    key_file = INSTANCE_DIR / "secret_key"
    if key_file.exists():
        return key_file.read_text(encoding="utf-8").strip()
    key = secrets.token_hex(32)
    key_file.write_text(key, encoding="utf-8")
    return key


def load_config() -> dict:
    on_render = bool(os.environ.get("RENDER"))
    database_url = _database_url()
    engine_options: dict = {"pool_pre_ping": True}
    if database_url.startswith("postgresql"):
        engine_options.update(pool_size=5, max_overflow=5, pool_recycle=300)

    return {
        "SECRET_KEY": _secret_key(),
        "SQLALCHEMY_DATABASE_URI": database_url,
        "SQLALCHEMY_ENGINE_OPTIONS": engine_options,
        "SQLALCHEMY_TRACK_MODIFICATIONS": False,
        "ADMIN_PASSWORD": os.environ.get("ADMIN_PASSWORD", "").strip() or "admin",
        "ADMIN_PASSWORD_IS_DEFAULT": not os.environ.get("ADMIN_PASSWORD", "").strip(),
        "PUBLIC_URL": os.environ.get("PUBLIC_URL", "").strip().rstrip("/"),
        "SEED_DEMO": env_bool("SEED_DEMO", True),
        "SESSION_COOKIE_SAMESITE": "Lax",
        "SESSION_COOKIE_HTTPONLY": True,
        "SESSION_COOKIE_SECURE": env_bool("SESSION_COOKIE_SECURE", on_render),
        "SESSION_COOKIE_NAME": "workshop_session",
        # Учасник залишається «залогіненим» на телефоні впродовж воркшопу та після нього.
        "PERMANENT_SESSION_LIFETIME": 60 * 60 * 24 * 30,
        "MAX_CONTENT_LENGTH": 256 * 1024,
    }

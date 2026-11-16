"""Workshop Voting — голосування за ідеї на воркшопі в реальному часі."""

from __future__ import annotations

import hashlib
import logging
from pathlib import Path

from dotenv import load_dotenv
from flask import Flask, jsonify, request
from sqlalchemy import event
from sqlalchemy.engine import Engine
from werkzeug.exceptions import HTTPException
from werkzeug.middleware.proxy_fix import ProxyFix

from .config import load_config
from .extensions import db
from .services import ServiceError

log = logging.getLogger(__name__)


@event.listens_for(Engine, "connect")
def _sqlite_pragmas(dbapi_connection, _record):  # pragma: no cover - залежить від драйвера
    module = type(dbapi_connection).__module__
    if module.startswith("sqlite3"):
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.execute("PRAGMA journal_mode=WAL")
        cursor.execute("PRAGMA busy_timeout=5000")
        cursor.close()


def _asset_version(static_dir: Path) -> str:
    """Хеш статичних файлів для скидання кешу браузера після оновлення."""
    digest = hashlib.sha1()
    for path in sorted(static_dir.rglob("*")):
        if path.is_file():
            digest.update(path.read_bytes())
    return digest.hexdigest()[:10]


def create_app(overrides: dict | None = None) -> Flask:
    load_dotenv()
    app = Flask(__name__)
    app.json.sort_keys = False  # зберігаємо порядок полів у JSON-відповідях
    app.config.update(load_config())
    if overrides:
        app.config.update(overrides)

    # Render (і будь-який реверс-проксі) передає реальну схему/хост у X-Forwarded-*.
    app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)  # type: ignore[method-assign]

    db.init_app(app)

    from . import cli, routes_admin, routes_public

    app.register_blueprint(routes_public.bp)
    app.register_blueprint(routes_admin.bp)
    cli.register(app)

    asset_v = _asset_version(Path(app.static_folder))

    @app.context_processor
    def _template_globals():
        return {
            "asset_v": asset_v,
            "brand_name": app.config["BRAND_NAME"],
            "brand_tagline": app.config["BRAND_TAGLINE"],
        }

    from datetime import datetime, timezone
    from zoneinfo import ZoneInfo

    local_tz = ZoneInfo(app.config.get("TIMEZONE", "Europe/Kyiv"))

    @app.template_filter("local_dt")
    def _local_dt(value, fmt="%d.%m.%Y %H:%M"):
        if not value:
            return ""
        if isinstance(value, str):
            value = datetime.fromisoformat(value)
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return value.astimezone(local_tz).strftime(fmt)

    @app.template_filter("phone")
    def _phone(value):
        """+380671234567 → +380 67 123 45 67 (інші формати — як є)."""
        if not value:
            return ""
        if value.startswith("+380") and len(value) == 13:
            d = value[4:]
            return f"+380 {d[:2]} {d[2:5]} {d[5:7]} {d[7:]}"
        if value.startswith("0") and len(value) == 10:
            return f"{value[:3]} {value[3:6]} {value[6:8]} {value[8:]}"
        return value

    @app.errorhandler(ServiceError)
    def _service_error(err: ServiceError):
        db.session.rollback()
        return jsonify(error=err.message), err.status

    @app.errorhandler(HTTPException)
    def _http_error(err: HTTPException):
        if request.path.startswith("/api/"):
            return jsonify(error=err.description or err.name), err.code
        return err

    @app.before_request
    def _csrf_guard():
        # Змінюючі API-запити мають нести заголовок, який сторонній сайт не може додати без CORS-дозволу.
        # Разом із SameSite=Lax cookie це закриває CSRF без токенів у формах.
        if request.path.startswith("/api/") and request.method not in ("GET", "HEAD", "OPTIONS"):
            if request.headers.get("X-Requested-With") != "fetch":
                return jsonify(error="Запит відхилено (відсутній заголовок X-Requested-With)"), 403
        return None

    @app.after_request
    def _no_cache_api(response):
        if request.path.startswith("/api/"):
            response.headers["Cache-Control"] = "no-store"
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("Referrer-Policy", "same-origin")
        return response

    return app

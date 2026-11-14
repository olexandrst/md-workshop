"""Конфігурація gunicorn для Render і Docker."""

import os

bind = f"0.0.0.0:{os.environ.get('PORT', '8000')}"
# Опитування (polling) — це короткі запити, тому потоки ефективніші за процеси.
worker_class = "gthread"
workers = int(os.environ.get("WEB_CONCURRENCY", "2"))
threads = int(os.environ.get("GUNICORN_THREADS", "8"))
timeout = 60
graceful_timeout = 20
keepalive = 5
# Журнал доступу вимкнено: десятки клієнтів опитують сервер щосекунди і засмічують логи.
accesslog = os.environ.get("GUNICORN_ACCESS_LOG") or None
errorlog = "-"
loglevel = os.environ.get("LOG_LEVEL", "info")


def on_starting(server):
    """Один раз у майстер-процесі до запуску воркерів: створюємо таблиці та стартові дані."""
    from app import create_app
    from app.cli import init_db
    from app.extensions import db

    app = create_app()
    with app.app_context():
        created = init_db()
        server.log.info("Database %s", "created" if created else "is ready")
        db.engine.dispose()

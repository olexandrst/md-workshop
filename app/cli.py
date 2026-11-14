"""Ініціалізація бази та службові команди: flask --app wsgi <команда>."""

from __future__ import annotations

import click
from flask import Flask, current_app
from sqlalchemy import text

from .extensions import db
from .models import WORKSHOP_ID, Workshop
from .seed import seed_demo_ideas
from .services import DEFAULT_DESCRIPTION, DEFAULT_TITLE, bump_version, reset_votes

_INIT_LOCK_ID = 7_274_031  # довільне число для pg_advisory_lock


def _init_schema(seed_demo: bool) -> bool:
    db.create_all()
    created = False
    if db.session.get(Workshop, WORKSHOP_ID) is None:
        db.session.add(Workshop(id=WORKSHOP_ID, title=DEFAULT_TITLE, description=DEFAULT_DESCRIPTION))
        created = True
        if seed_demo:
            seed_demo_ideas()
    db.session.commit()
    return created


def init_db(seed_demo: bool | None = None) -> bool:
    """Створює таблиці та запис воркшопу. Ідемпотентна; демо-ідеї додаються лише в нову базу.

    Повертає True, якщо базу щойно створено.
    """
    if seed_demo is None:
        seed_demo = current_app.config.get("SEED_DEMO", True)
    engine = db.engine
    if engine.dialect.name != "postgresql":
        return _init_schema(seed_demo)
    # Кілька процесів можуть стартувати одночасно — серіалізуємо ініціалізацію.
    with engine.connect() as lock_conn:
        lock_conn.execute(text("SELECT pg_advisory_lock(:id)"), {"id": _INIT_LOCK_ID})
        try:
            return _init_schema(seed_demo)
        finally:
            lock_conn.execute(text("SELECT pg_advisory_unlock(:id)"), {"id": _INIT_LOCK_ID})
            lock_conn.commit()


def register(app: Flask) -> None:
    @app.cli.command("init-db")
    @click.option("--no-demo", is_flag=True, help="Не додавати демо-ідеї в нову базу")
    def init_db_command(no_demo: bool) -> None:
        """Створити таблиці (безпечно запускати повторно)."""
        created = init_db(seed_demo=False if no_demo else None)
        click.echo("База створена." if created else "База вже ініціалізована.")

    @app.cli.command("seed-demo")
    def seed_demo_command() -> None:
        """Додати демо-ідеї для меблевого бізнесу (до вже наявних)."""
        init_db(seed_demo=False)
        count = seed_demo_ideas()
        bump_version()
        db.session.commit()
        click.echo(f"Додано демо-ідей: {count}")

    @app.cli.command("reset-votes")
    @click.confirmation_option(prompt="Видалити всі голоси?")
    def reset_votes_command() -> None:
        """Видалити всі голоси (учасники та ідеї залишаються)."""
        reset_votes()
        click.echo("Голоси видалено.")

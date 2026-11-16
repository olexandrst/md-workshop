import os

import pytest
from sqlalchemy import MetaData

from app import create_app
from app.cli import init_db
from app.extensions import db


@pytest.fixture()
def app(tmp_path, monkeypatch):
    # Postgres: TEST_DATABASE_URL=postgresql://user:pass@localhost/workshop_test pytest
    database_url = os.environ.get("TEST_DATABASE_URL") or f"sqlite:///{tmp_path / 'test.db'}"
    monkeypatch.setenv("DATABASE_URL", database_url)
    monkeypatch.setenv("SECRET_KEY", "test-secret")
    monkeypatch.setenv("ADMIN_USERNAME", "mid")
    monkeypatch.setenv("ADMIN_PASSWORD", "s3cret")
    monkeypatch.delenv("PUBLIC_URL", raising=False)
    app = create_app({"TESTING": True, "SEED_DEMO": False})
    with app.app_context():
        _drop_everything()
        init_db()
    yield app
    with app.app_context():
        db.session.remove()
        _drop_everything()
        db.engine.dispose()


def _drop_everything():
    meta = MetaData()
    meta.reflect(bind=db.engine)
    meta.drop_all(bind=db.engine)


def api_client(app):
    c = app.test_client()
    c.environ_base["HTTP_X_REQUESTED_WITH"] = "fetch"
    return c


@pytest.fixture()
def client(app):
    return api_client(app)


@pytest.fixture()
def admin(app):
    c = api_client(app)
    response = c.post("/admin/login", data={"username": "mid", "password": "s3cret"})
    assert response.status_code == 302
    return c


@pytest.fixture()
def make_idea(admin):
    def _make(title="Ідея", effects=("Ефект",), description=""):
        response = admin.post(
            "/api/admin/ideas", json={"title": title, "description": description, "effects": list(effects)}
        )
        assert response.status_code == 201, response.get_json()
        return next(i for i in response.get_json()["ideas"] if i["title"] == title)

    return _make


@pytest.fixture()
def make_participant(app):
    def _make(name="Олена", company="Меблі Плюс", phone="+380 67 123 45 67"):
        c = api_client(app)
        response = c.post("/api/join", json={"name": name, "company": company, "phone": phone})
        assert response.status_code == 200, response.get_json()
        return c

    return _make

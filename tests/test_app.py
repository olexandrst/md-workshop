import io

from openpyxl import load_workbook

from app.cli import init_db
from app.config import normalize_database_url
from app.extensions import db
from app.models import Idea, Participant


def idea_by_id(state, idea_id):
    return next(i for i in state["ideas"] if i["id"] == idea_id)


# --------------------------------------------------------------------------- база і службове


def test_normalize_database_url():
    assert normalize_database_url("postgres://u:p@h/db") == "postgresql+psycopg://u:p@h/db"
    assert normalize_database_url("postgresql://u:p@h/db") == "postgresql+psycopg://u:p@h/db"
    assert normalize_database_url("sqlite:///x.db") == "sqlite:///x.db"


def test_init_db_is_idempotent_and_seeds_demo_once(app):
    with app.app_context():
        assert init_db(seed_demo=True) is False  # запис воркшопу вже існує — демо не додаємо
        assert db.session.query(Idea).count() == 0


def test_seed_demo_on_fresh_database(app):
    from tests.conftest import _drop_everything

    with app.app_context():
        _drop_everything()
        assert init_db(seed_demo=True) is True
        count = db.session.query(Idea).count()
        assert count >= 6
        assert init_db(seed_demo=True) is False
        assert db.session.query(Idea).count() == count


def test_health_and_qr(client):
    assert client.get("/healthz").get_json() == {"status": "ok"}
    response = client.get("/qr.svg")
    assert response.status_code == 200
    assert response.mimetype == "image/svg+xml"
    assert b"<svg" in response.data


def test_qr_uses_public_url(app, client):
    app.config["PUBLIC_URL"] = "https://vote.example.com"
    from app.utils import participant_url

    with app.test_request_context("/"):
        assert participant_url() == "https://vote.example.com/"


def test_participant_page_renders(client):
    response = client.get("/")
    assert response.status_code == 200
    assert "Почати голосування" in response.get_data(as_text=True)


# --------------------------------------------------------------------------- учасники


def test_join_and_rejoin_same_identity(app, client):
    response = client.post("/api/join", json={"name": "  Олена ", "company": "Меблі  Плюс"})
    state = response.get_json()
    assert response.status_code == 200
    assert state["me"]["name"] == "Олена"
    assert state["me"]["company"] == "Меблі Плюс"
    first_id = state["me"]["id"]

    from tests.conftest import api_client

    other_device = api_client(app)
    state2 = other_device.post("/api/join", json={"name": "олена", "company": "МЕБЛІ ПЛЮС"}).get_json()
    assert state2["me"]["id"] == first_id
    assert state2["participants_count"] == 1


def test_join_validation(client):
    response = client.post("/api/join", json={"name": "", "company": "X"})
    assert response.status_code == 400
    assert "Ім'я" in response.get_json()["error"]
    response = client.post("/api/join", json={"name": "A" * 81, "company": "X"})
    assert response.status_code == 400
    response = client.post("/api/join", data="not json", content_type="text/plain")
    assert response.status_code == 400


def test_update_me_and_conflict(make_participant):
    alice = make_participant("Аліна", "Дерево")
    make_participant("Богдан", "Дерево")
    state = alice.put("/api/me", json={"name": "Аліна К.", "company": "Дерево"}).get_json()
    assert state["me"]["name"] == "Аліна К."
    response = alice.put("/api/me", json={"name": "богдан", "company": "дерево"})
    assert response.status_code == 409


def test_leave(make_participant):
    c = make_participant()
    state = c.post("/api/leave").get_json()
    assert "me" not in state
    assert c.post("/api/vote", json={"idea_id": 1, "score": 1}).status_code == 401


# --------------------------------------------------------------------------- голосування


def test_vote_change_and_remove(make_idea, make_participant):
    idea = make_idea("3D-конфігуратор")
    c = make_participant()

    state = c.post("/api/vote", json={"idea_id": idea["id"], "score": 3}).get_json()
    assert state["me"]["votes"][str(idea["id"])] == 3
    r = idea_by_id(state, idea["id"])["results"]
    assert r["total"] == 3 and r["votes"] == 1 and r["dist"]["3"] == 1

    state = c.post("/api/vote", json={"idea_id": idea["id"], "score": 5}).get_json()
    r = idea_by_id(state, idea["id"])["results"]
    assert r["total"] == 5 and r["votes"] == 1 and r["dist"]["3"] == 0 and r["dist"]["5"] == 1

    state = c.post("/api/vote", json={"idea_id": idea["id"], "score": None}).get_json()
    assert str(idea["id"]) not in state["me"]["votes"]
    assert idea_by_id(state, idea["id"])["results"]["votes"] == 0


def test_vote_validation(make_idea, make_participant, client):
    idea = make_idea()
    c = make_participant()
    assert c.post("/api/vote", json={"idea_id": idea["id"], "score": 4}).status_code == 400
    assert c.post("/api/vote", json={"idea_id": idea["id"], "score": "abc"}).status_code == 400
    assert c.post("/api/vote", json={"idea_id": 99999, "score": 1}).status_code == 404
    assert client.post("/api/vote", json={"idea_id": idea["id"], "score": 1}).status_code == 401


def test_voting_closed(admin, make_idea, make_participant):
    idea = make_idea()
    c = make_participant()
    admin.put("/api/admin/workshop", json={"voting_open": False})
    response = c.post("/api/vote", json={"idea_id": idea["id"], "score": 2})
    assert response.status_code == 403
    admin.put("/api/admin/workshop", json={"voting_open": True})
    assert c.post("/api/vote", json={"idea_id": idea["id"], "score": 2}).status_code == 200


def test_state_versioning(make_idea, make_participant):
    idea = make_idea()
    c = make_participant()
    state = c.get("/api/state").get_json()
    version = state["version"]
    assert c.get(f"/api/state?v={version}").get_json() == {"changed": False, "version": version}
    c.post("/api/vote", json={"idea_id": idea["id"], "score": 1})
    fresh = c.get(f"/api/state?v={version}").get_json()
    assert fresh["changed"] is True and fresh["version"] > version


def test_aggregation_and_ranking(admin, make_idea, make_participant):
    a = make_idea("A")
    b = make_idea("B")
    voters = [make_participant(f"U{i}", f"Co{i}") for i in range(3)]
    for client, (sa, sb) in zip(voters, [(5, 1), (3, 2), (0, 2)]):
        client.post("/api/vote", json={"idea_id": a["id"], "score": sa})
        client.post("/api/vote", json={"idea_id": b["id"], "score": sb})

    state = admin.get("/api/admin/state").get_json()
    ra = idea_by_id(state, a["id"])["results"]
    rb = idea_by_id(state, b["id"])["results"]
    assert ra["total"] == 8 and ra["votes"] == 3 and ra["avg"] == 2.67
    assert ra["dist"] == {"0": 1, "1": 0, "2": 0, "3": 1, "5": 1}
    assert rb["total"] == 5 and rb["avg"] == 1.67
    assert ra["rank"] == 1 and rb["rank"] == 2
    assert ra["voters"]["5"] == [{"name": "U0", "company": "Co0"}]


def test_participant_state_has_no_names_and_respects_show_results(admin, make_idea, make_participant):
    idea = make_idea()
    c = make_participant()
    c.post("/api/vote", json={"idea_id": idea["id"], "score": 5})
    results = idea_by_id(c.get("/api/state").get_json(), idea["id"])["results"]
    assert "voters" not in results and results["total"] == 5

    admin.put("/api/admin/workshop", json={"show_results": False})
    state = c.get("/api/state").get_json()
    assert idea_by_id(state, idea["id"])["results"] is None
    assert state["me"]["votes"][str(idea["id"])] == 5


# --------------------------------------------------------------------------- адмінка


def test_admin_requires_login(client):
    assert client.get("/api/admin/state").status_code == 401
    response = client.get("/admin")
    assert response.status_code == 302 and "/admin/login" in response.headers["Location"]
    response = client.post("/admin/login", data={"username": "mid", "password": "wrong"})
    assert response.status_code == 200 and "Невірний логін або пароль" in response.get_data(as_text=True)
    response = client.post("/admin/login", data={"username": "admin", "password": "s3cret"})
    assert response.status_code == 200 and "Невірний логін або пароль" in response.get_data(as_text=True)
    assert client.post("/api/admin/ideas", json={"title": "x"}).status_code == 401


def test_admin_login_redirect_is_safe(client):
    response = client.post("/admin/login", data={"username": "mid", "password": "s3cret", "next": "https://evil.example/"})
    assert response.headers["Location"].endswith("/admin")


def test_admin_session_invalidated_when_password_changes(app, admin):
    assert admin.get("/api/admin/state").status_code == 200
    app.config["ADMIN_PASSWORD"] = "new-password"
    assert admin.get("/api/admin/state").status_code == 401


def test_presenter_page(admin):
    response = admin.get("/admin")
    assert response.status_code == 200
    assert "Режим презентації" in response.get_data(as_text=True)


def test_idea_crud_with_effects(admin, make_participant):
    created = admin.post(
        "/api/admin/ideas",
        json={"title": "  Трекінг  замовлень ", "description": "Рядок 1\r\nРядок 2", "effects": ["Менше дзвінків", " ", {"text": "NPS"}]},
    )
    assert created.status_code == 201
    idea = created.get_json()["ideas"][0]
    assert idea["title"] == "Трекінг замовлень"
    assert idea["description"] == "Рядок 1\nРядок 2"
    assert [e["text"] for e in idea["effects"]] == ["Менше дзвінків", "NPS"]

    updated = admin.put(f"/api/admin/ideas/{idea['id']}", json={"title": "Трекінг", "effects": ["Новий ефект"]})
    idea = updated.get_json()["ideas"][0]
    assert idea["title"] == "Трекінг" and [e["text"] for e in idea["effects"]] == ["Новий ефект"]

    c = make_participant()
    c.post("/api/vote", json={"idea_id": idea["id"], "score": 2})
    state = admin.delete(f"/api/admin/ideas/{idea['id']}").get_json()
    assert state["ideas"] == []
    assert state["participants"][0]["votes_count"] == 0
    assert admin.put(f"/api/admin/ideas/{idea['id']}", json={"title": "x"}).status_code == 404
    assert admin.post("/api/admin/ideas", json={"title": ""}).status_code == 400


def test_reorder(admin, make_idea):
    a, b, c = make_idea("A"), make_idea("B"), make_idea("C")
    state = admin.post("/api/admin/ideas/reorder", json={"ids": [c["id"], a["id"], b["id"]]}).get_json()
    assert [i["title"] for i in state["ideas"]] == ["C", "A", "B"]
    assert admin.post("/api/admin/ideas/reorder", json={"ids": [a["id"]]}).status_code == 409


def test_workshop_update(admin, client):
    state = admin.put(
        "/api/admin/workshop", json={"title": "Новий воркшоп", "description": "Опис", "show_names": False}
    ).get_json()
    assert state["workshop"]["title"] == "Новий воркшоп"
    assert state["workshop"]["show_names"] is False
    assert client.get("/api/state").get_json()["workshop"]["title"] == "Новий воркшоп"
    assert admin.put("/api/admin/workshop", json={"title": ""}).status_code == 400
    assert admin.put("/api/admin/workshop", json={"voting_open": "yes"}).status_code == 400


def test_delete_participant_and_resets(app, admin, make_idea, make_participant):
    idea = make_idea()
    c1 = make_participant("A", "X")
    c2 = make_participant("B", "Y")
    c1.post("/api/vote", json={"idea_id": idea["id"], "score": 5})
    c2.post("/api/vote", json={"idea_id": idea["id"], "score": 3})

    state = admin.get("/api/admin/state").get_json()
    pid = next(p["id"] for p in state["participants"] if p["name"] == "A")
    state = admin.delete(f"/api/admin/participants/{pid}").get_json()
    assert idea_by_id(state, idea["id"])["results"]["total"] == 3
    # Видалений учасник бачить форму входу знову
    assert "me" not in c1.get("/api/state").get_json()

    state = admin.post("/api/admin/reset-votes").get_json()
    assert idea_by_id(state, idea["id"])["results"]["votes"] == 0
    assert state["participants_count"] == 1

    state = admin.post("/api/admin/delete-participants").get_json()
    assert state["participants_count"] == 0
    with app.app_context():
        assert db.session.query(Participant).count() == 0


def test_export_xlsx(admin, make_idea, make_participant):
    idea = make_idea("Розкрій ДСП", effects=["Менше відходів"])
    c = make_participant("Ігор", "Фабрика")
    c.post("/api/vote", json={"idea_id": idea["id"], "score": 5})
    response = admin.get("/admin/export.xlsx")
    assert response.status_code == 200
    wb = load_workbook(io.BytesIO(response.data))
    assert wb.sheetnames == ["Підсумок", "Голоси", "Учасники", "Воркшоп"]
    summary = wb["Підсумок"]
    assert summary["B2"].value == "Розкрій ДСП"
    assert summary["D2"].value == 5
    assert "Фабрика (Ігор)" in summary.cell(row=2, column=12).value
    assert wb["Голоси"]["A2"].value == "Фабрика"


def test_mutating_api_requires_fetch_header(app, make_idea):
    idea = make_idea()
    bare = app.test_client()
    response = bare.post("/api/join", json={"name": "A", "company": "B"})
    assert response.status_code == 403
    assert bare.get("/api/state").status_code == 200
    admin = app.test_client()
    admin.post("/admin/login", data={"username": "mid", "password": "s3cret"})
    assert admin.post("/api/admin/reset-votes").status_code == 403
    assert admin.delete(f"/api/admin/ideas/{idea['id']}").status_code == 403


def test_default_admin_credentials(monkeypatch):
    monkeypatch.delenv("ADMIN_USERNAME", raising=False)
    monkeypatch.delenv("ADMIN_PASSWORD", raising=False)
    monkeypatch.setenv("SECRET_KEY", "x")
    from app.config import load_config

    config = load_config()
    assert (config["ADMIN_USERNAME"], config["ADMIN_PASSWORD"]) == ("mid", "digital")

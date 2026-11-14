"""Адмінка ведучого: екран для проєктора, керування ідеями, налаштування, експорт."""

from __future__ import annotations

import hashlib
import hmac
from datetime import datetime
from functools import wraps
from urllib.parse import urlsplit

from flask import (
    Blueprint,
    Response,
    current_app,
    flash,
    jsonify,
    redirect,
    render_template,
    request,
    session,
    url_for,
)

from .export import build_workbook
from .services import (
    build_state,
    create_idea,
    current_version,
    delete_all_participants,
    delete_idea,
    delete_participant,
    get_workshop,
    reorder_ideas,
    reset_votes,
    scale_payload,
    update_idea,
    update_workshop,
)
from .utils import json_body, participant_url

bp = Blueprint("admin", __name__)


def _password_fingerprint() -> str:
    """Відбиток пароля в сесії: зміна ADMIN_PASSWORD автоматично розлогінює всі адмін-сесії."""
    secret = current_app.config["SECRET_KEY"].encode()
    return hmac.new(secret, current_app.config["ADMIN_PASSWORD"].encode(), hashlib.sha256).hexdigest()[:24]


def is_admin() -> bool:
    return session.get("admin") == _password_fingerprint()


def admin_required(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        if not is_admin():
            if request.path.startswith("/api/"):
                return jsonify(error="Сесія ведучого завершилась — увійдіть знову"), 401
            return redirect(url_for("admin.login", next=request.path))
        return view(*args, **kwargs)

    return wrapped


def _safe_next(target: str | None) -> str:
    if target and target.startswith("/") and not target.startswith("//") and not urlsplit(target).netloc:
        return target
    return url_for("admin.presenter")


# --------------------------------------------------------------------------- сторінки


@bp.route("/admin/login", methods=["GET", "POST"])
def login():
    if request.method == "POST":
        password = request.form.get("password", "")
        if hmac.compare_digest(password.encode(), current_app.config["ADMIN_PASSWORD"].encode()):
            session.permanent = True
            session["admin"] = _password_fingerprint()
            return redirect(_safe_next(request.form.get("next")))
        flash("Невірний пароль")
    return render_template(
        "login.html",
        workshop=get_workshop(),
        next=request.args.get("next", ""),
        default_password=current_app.config.get("ADMIN_PASSWORD_IS_DEFAULT"),
    )


@bp.post("/admin/logout")
def logout():
    session.pop("admin", None)
    return redirect(url_for("admin.login"))


@bp.get("/admin")
@admin_required
def presenter():
    return render_template(
        "presenter.html",
        workshop=get_workshop(),
        boot={"scale": scale_payload(), "participantUrl": participant_url()},
    )


@bp.get("/admin/export.xlsx")
@admin_required
def export_xlsx():
    payload = build_workbook(build_state(admin=True))
    filename = f"workshop-results-{datetime.now():%Y%m%d-%H%M}.xlsx"
    return Response(
        payload,
        mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


# --------------------------------------------------------------------------- API


def _admin_state():
    state = build_state(admin=True)
    state["changed"] = True
    state["participant_url"] = participant_url()
    return jsonify(state)


@bp.get("/api/admin/state")
@admin_required
def api_state():
    known = request.args.get("v", type=int)
    if known is not None and known == current_version():
        return jsonify(changed=False, version=known)
    return _admin_state()


@bp.put("/api/admin/workshop")
@admin_required
def api_update_workshop():
    update_workshop(json_body())
    return _admin_state()


@bp.post("/api/admin/ideas")
@admin_required
def api_create_idea():
    create_idea(json_body())
    return _admin_state(), 201


@bp.put("/api/admin/ideas/<int:idea_id>")
@admin_required
def api_update_idea(idea_id: int):
    update_idea(idea_id, json_body())
    return _admin_state()


@bp.delete("/api/admin/ideas/<int:idea_id>")
@admin_required
def api_delete_idea(idea_id: int):
    delete_idea(idea_id)
    return _admin_state()


@bp.post("/api/admin/ideas/reorder")
@admin_required
def api_reorder_ideas():
    reorder_ideas(json_body().get("ids"))
    return _admin_state()


@bp.delete("/api/admin/participants/<int:participant_id>")
@admin_required
def api_delete_participant(participant_id: int):
    delete_participant(participant_id)
    return _admin_state()


@bp.post("/api/admin/reset-votes")
@admin_required
def api_reset_votes():
    reset_votes()
    return _admin_state()


@bp.post("/api/admin/delete-participants")
@admin_required
def api_delete_participants():
    delete_all_participants()
    return _admin_state()

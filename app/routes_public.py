"""Сторінка учасника та публічне API голосування."""

from __future__ import annotations

from flask import Blueprint, Response, jsonify, render_template, request, session
from sqlalchemy import text

from .extensions import db
from .models import Participant
from .services import (
    ServiceError,
    build_state,
    cast_vote,
    current_version,
    get_workshop,
    join_participant,
    effect_catalog_payload,
    scale_payload,
    update_participant,
)
from .utils import json_body, participant_url, qr_svg

bp = Blueprint("public", __name__)


def current_participant() -> Participant | None:
    participant_id = session.get("participant_id")
    if participant_id is None:
        return None
    participant = db.session.get(Participant, participant_id)
    if participant is None:
        # Ведучий видалив учасника — сесію скидаємо, людина зареєструється знову.
        session.pop("participant_id", None)
    return participant


def require_participant() -> Participant:
    participant = current_participant()
    if participant is None:
        raise ServiceError("Спершу вкажіть ім'я та компанію", 401)
    return participant


def _state_response(participant: Participant | None):
    state = build_state(participant=participant)
    state["changed"] = True
    return jsonify(state)


@bp.get("/")
def index():
    workshop = get_workshop()
    return render_template(
        "participant.html",
        workshop=workshop,
        boot={"scale": scale_payload(), "effects": effect_catalog_payload()},
    )


@bp.get("/healthz")
def healthz():
    db.session.execute(text("SELECT 1"))
    return jsonify(status="ok")


@bp.get("/qr.svg")
def qr_code():
    response = Response(qr_svg(participant_url()), mimetype="image/svg+xml")
    response.headers["Cache-Control"] = "no-cache"
    return response


@bp.get("/api/state")
def api_state():
    participant = current_participant()
    known = request.args.get("v", type=int)
    if known is not None and known == current_version():
        return jsonify(changed=False, version=known)
    return _state_response(participant)


@bp.post("/api/join")
def api_join():
    participant = join_participant(json_body())
    session.permanent = True
    session["participant_id"] = participant.id
    return _state_response(participant)


@bp.put("/api/me")
def api_update_me():
    participant = update_participant(require_participant(), json_body())
    return _state_response(participant)


@bp.post("/api/leave")
def api_leave():
    session.pop("participant_id", None)
    return _state_response(None)


@bp.post("/api/vote")
def api_vote():
    participant = require_participant()
    cast_vote(participant, json_body())
    return _state_response(participant)

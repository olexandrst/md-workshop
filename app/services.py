"""Бізнес-логіка: валідація, голосування, агрегація результатів, побудова стану для клієнтів."""

from __future__ import annotations

import re
from collections import defaultdict
from datetime import datetime, timezone

from sqlalchemy import delete, func, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import selectinload

from .extensions import db
from .models import (
    ALLOWED_SCORES,
    COMPANY_MAX,
    DESCRIPTION_MAX,
    EFFECT_MAX,
    EFFECT_CATALOG,
    EFFECT_LABELS,
    EFFECTS_PER_IDEA_MAX,
    NAME_MAX,
    SCALE,
    TITLE_MAX,
    WORKSHOP_ID,
    BusinessEffect,
    Idea,
    Participant,
    Vote,
    Workshop,
)

DEFAULT_TITLE = "Воркшоп: ІТ-рішення для меблевого бізнесу"
DEFAULT_DESCRIPTION = (
    "Оцініть ідеї ІТ-рішень, які ми напрацьовуватимемо разом. "
    "Ваші оцінки допоможуть обрати, що пропрацьовувати в концепцію і що пілотувати першим."
)


class ServiceError(Exception):
    """Помилка, яку можна показати користувачеві."""

    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.message = message
        self.status = status


# --------------------------------------------------------------------------- валідація

_SPACES = re.compile(r"[ \t ]+")
_ANY_WS = re.compile(r"\s+")
_MANY_NEWLINES = re.compile(r"\n{3,}")


def clean_line(value, field: str, max_len: int, required: bool = True) -> str:
    if value is None:
        value = ""
    if not isinstance(value, str):
        raise ServiceError(f"Поле «{field}» має бути текстом")
    value = _ANY_WS.sub(" ", value).strip()
    if required and not value:
        raise ServiceError(f"Заповніть поле «{field}»")
    if len(value) > max_len:
        raise ServiceError(f"Поле «{field}» задовге (максимум {max_len} символів)")
    return value


def clean_text(value, field: str, max_len: int) -> str:
    """Багаторядковий текст: зберігаємо абзаци, прибираємо зайві пробіли."""
    if value is None:
        value = ""
    if not isinstance(value, str):
        raise ServiceError(f"Поле «{field}» має бути текстом")
    value = value.replace("\r\n", "\n").replace("\r", "\n")
    lines = [_SPACES.sub(" ", line).strip() for line in value.split("\n")]
    value = _MANY_NEWLINES.sub("\n\n", "\n".join(lines)).strip()
    if len(value) > max_len:
        raise ServiceError(f"Поле «{field}» задовге (максимум {max_len} символів)")
    return value


def identity_key(value: str) -> str:
    return value.casefold()


def parse_bool(value, field: str) -> bool:
    if isinstance(value, bool):
        return value
    raise ServiceError(f"Поле «{field}» має бути true або false")


def parse_int(value, field: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        if isinstance(value, str) and value.strip().lstrip("-").isdigit():
            return int(value)
        raise ServiceError(f"Поле «{field}» має бути числом")
    return value


# --------------------------------------------------------------------------- воркшоп і версія


def get_workshop() -> Workshop:
    workshop = db.session.get(Workshop, WORKSHOP_ID)
    if workshop is None:
        workshop = Workshop(id=WORKSHOP_ID, title=DEFAULT_TITLE, description=DEFAULT_DESCRIPTION)
        db.session.add(workshop)
        db.session.flush()
    return workshop


def current_version() -> int:
    version = db.session.scalar(select(Workshop.version).where(Workshop.id == WORKSHOP_ID))
    return int(version or 0)


def bump_version() -> None:
    """Збільшує версію стану. Блокує рядок воркшопу до кінця транзакції — це серіалізує записи."""
    db.session.execute(
        update(Workshop).where(Workshop.id == WORKSHOP_ID).values(version=Workshop.version + 1)
    )


def update_workshop(data: dict) -> None:
    workshop = get_workshop()
    if "title" in data:
        workshop.title = clean_line(data["title"], "Назва воркшопу", TITLE_MAX)
    if "description" in data:
        workshop.description = clean_text(data["description"], "Пояснення", DESCRIPTION_MAX)
    for key, field in (
        ("voting_open", "Голосування відкрите"),
        ("show_results", "Результати для учасників"),
        ("show_names", "Імена на екрані"),
    ):
        if key in data:
            setattr(workshop, key, parse_bool(data[key], field))
    db.session.flush()
    bump_version()
    db.session.commit()


# --------------------------------------------------------------------------- учасники


def _parse_identity(data: dict) -> tuple[str, str]:
    name = clean_line(data.get("name"), "Ім'я", NAME_MAX)
    company = clean_line(data.get("company"), "Компанія", COMPANY_MAX)
    return name, company


def _find_participant(name: str, company: str) -> Participant | None:
    return db.session.scalar(
        select(Participant).where(
            Participant.name_key == identity_key(name),
            Participant.company_key == identity_key(company),
        )
    )


def join_participant(data: dict) -> Participant:
    """Реєструє учасника або повертає існуючого з тим самим ім'ям і компанією."""
    name, company = _parse_identity(data)
    existing = _find_participant(name, company)
    if existing:
        return existing
    participant = Participant(
        name=name,
        company=company,
        name_key=identity_key(name),
        company_key=identity_key(company),
    )
    db.session.add(participant)
    try:
        db.session.flush()
        bump_version()
        db.session.commit()
    except IntegrityError:
        # Одночасна реєстрація з тими самими даними з двох пристроїв.
        db.session.rollback()
        existing = _find_participant(name, company)
        if existing is None:
            raise
        return existing
    return participant


def update_participant(participant: Participant, data: dict) -> Participant:
    name, company = _parse_identity(data)
    other = _find_participant(name, company)
    if other is not None and other.id != participant.id:
        raise ServiceError("Учасник з таким ім'ям і компанією вже існує", 409)
    participant.name = name
    participant.company = company
    participant.name_key = identity_key(name)
    participant.company_key = identity_key(company)
    db.session.flush()
    bump_version()
    db.session.commit()
    return participant


def delete_participant(participant_id: int) -> None:
    participant = db.session.get(Participant, participant_id)
    if participant is None:
        raise ServiceError("Учасника не знайдено", 404)
    bump_version()
    db.session.execute(delete(Vote).where(Vote.participant_id == participant_id))
    db.session.execute(delete(Participant).where(Participant.id == participant_id))
    db.session.commit()


def reset_votes() -> None:
    bump_version()
    db.session.execute(delete(Vote))
    db.session.commit()


def delete_all_participants() -> None:
    bump_version()
    db.session.execute(delete(Vote))
    db.session.execute(delete(Participant))
    db.session.commit()


# --------------------------------------------------------------------------- голосування


def cast_vote(participant: Participant, data: dict) -> int | None:
    """Ставить, змінює або (score = null) знімає оцінку учасника за ідею."""
    idea_id = parse_int(data.get("idea_id"), "idea_id")
    score = data.get("score")
    if score is not None:
        score = parse_int(score, "score")
        if score not in ALLOWED_SCORES:
            raise ServiceError("Недопустима оцінка")

    workshop = get_workshop()
    if not workshop.voting_open:
        raise ServiceError("Голосування закрите ведучим", 403)
    if db.session.get(Idea, idea_id) is None:
        raise ServiceError("Ідею не знайдено (можливо, її щойно видалили)", 404)

    for attempt in range(2):
        try:
            # Спершу блокуємо рядок воркшопу: паралельні голоси одного учасника виконуються послідовно.
            bump_version()
            vote = db.session.scalar(
                select(Vote).where(Vote.participant_id == participant.id, Vote.idea_id == idea_id)
            )
            if score is None:
                if vote is not None:
                    db.session.delete(vote)
            elif vote is None:
                db.session.add(Vote(participant_id=participant.id, idea_id=idea_id, score=score))
            else:
                vote.score = score
            db.session.commit()
            return score
        except IntegrityError:
            db.session.rollback()
            if attempt == 1:
                raise
    return score


# --------------------------------------------------------------------------- ідеї


def parse_effects(raw_effects) -> list[tuple[str | None, str]]:
    """Ефекти: [{"kind": "cost", "text": "уточнення"}, {"kind": null, "text": "власний"}, "власний"].

    Типовий ефект (kind з каталогу) може бути без уточнення; власний — лише з текстом.
    Порожні власні ефекти відкидаються, повтори типових — теж.
    """
    if raw_effects is None:
        return []
    if not isinstance(raw_effects, list):
        raise ServiceError("Бізнес-ефекти мають бути списком")
    effects: list[tuple[str | None, str]] = []
    seen_kinds: set[str] = set()
    for item in raw_effects:
        if isinstance(item, dict):
            kind, text = item.get("kind") or None, item.get("text")
        else:
            kind, text = None, item
        if kind is not None and kind not in EFFECT_LABELS:
            raise ServiceError("Невідомий тип бізнес-ефекту")
        text = clean_line(text, "Бізнес-ефект", EFFECT_MAX, required=False)
        if kind is None and not text:
            continue
        if kind is not None:
            if kind in seen_kinds:
                continue
            seen_kinds.add(kind)
        effects.append((kind, text))
    if len(effects) > EFFECTS_PER_IDEA_MAX:
        raise ServiceError(f"Не більше {EFFECTS_PER_IDEA_MAX} бізнес-ефектів на ідею")
    return effects


def _parse_idea(data: dict) -> tuple[str, str, list[tuple[str | None, str]]]:
    title = clean_line(data.get("title"), "Назва ідеї", TITLE_MAX)
    description = clean_text(data.get("description"), "Опис", DESCRIPTION_MAX)
    return title, description, parse_effects(data.get("effects"))


def _set_effects(idea: Idea, effects: list[tuple[str | None, str]]) -> None:
    idea.effects.clear()
    db.session.flush()
    for position, (kind, text) in enumerate(effects):
        idea.effects.append(BusinessEffect(kind=kind, text=text, position=position))


def create_idea(data: dict) -> Idea:
    title, description, effects = _parse_idea(data)
    # Нові ідеї з'являються зверху списку (і в учасників, і на екрані ведучого).
    min_position = db.session.scalar(select(func.min(Idea.position)))
    position = 1 if min_position is None else min_position - 1
    idea = Idea(title=title, description=description, position=position)
    db.session.add(idea)
    _set_effects(idea, effects)
    db.session.flush()
    bump_version()
    db.session.commit()
    return idea


def update_idea(idea_id: int, data: dict) -> Idea:
    idea = db.session.get(Idea, idea_id)
    if idea is None:
        raise ServiceError("Ідею не знайдено", 404)
    title, description, effects = _parse_idea(data)
    idea.title = title
    idea.description = description
    _set_effects(idea, effects)
    db.session.flush()
    bump_version()
    db.session.commit()
    return idea


def delete_idea(idea_id: int) -> None:
    if db.session.get(Idea, idea_id) is None:
        raise ServiceError("Ідею не знайдено", 404)
    bump_version()
    db.session.execute(delete(Vote).where(Vote.idea_id == idea_id))
    db.session.execute(delete(BusinessEffect).where(BusinessEffect.idea_id == idea_id))
    db.session.execute(delete(Idea).where(Idea.id == idea_id))
    db.session.commit()


def reorder_ideas(ids) -> None:
    if not isinstance(ids, list):
        raise ServiceError("Очікується список ідентифікаторів")
    ids = [parse_int(i, "id") for i in ids]
    existing = set(db.session.scalars(select(Idea.id)).all())
    if len(ids) != len(set(ids)) or set(ids) != existing:
        raise ServiceError("Список ідей застарів — оновіть сторінку", 409)
    bump_version()
    for position, idea_id in enumerate(ids, start=1):
        db.session.execute(update(Idea).where(Idea.id == idea_id).values(position=position))
    db.session.commit()


# --------------------------------------------------------------------------- агрегація та стан


def _empty_dist() -> dict[int, int]:
    return {score: 0 for score in ALLOWED_SCORES}


def compute_results(ideas: list[Idea], with_voters: bool) -> dict[int, dict]:
    """Сума балів, середнє, розподіл голосів (і, для ведучого, хто як голосував) по кожній ідеї."""
    dist: dict[int, dict[int, int]] = defaultdict(_empty_dist)
    voters: dict[int, dict[int, list[dict]]] = defaultdict(lambda: {s: [] for s in ALLOWED_SCORES})

    if with_voters:
        rows = db.session.execute(
            select(Vote.idea_id, Vote.score, Participant.name, Participant.company)
            .join(Participant, Participant.id == Vote.participant_id)
            .order_by(Participant.company_key, Participant.name_key)
        ).all()
        for idea_id, score, name, company in rows:
            dist[idea_id][score] += 1
            voters[idea_id][score].append({"name": name, "company": company})
    else:
        rows = db.session.execute(
            select(Vote.idea_id, Vote.score, func.count(Vote.id)).group_by(Vote.idea_id, Vote.score)
        ).all()
        for idea_id, score, count in rows:
            dist[idea_id][score] = int(count)

    results: dict[int, dict] = {}
    for idea in ideas:
        d = dist[idea.id]
        votes = sum(d.values())
        total = sum(score * count for score, count in d.items())
        result = {
            "total": total,
            "votes": votes,
            "avg": round(total / votes, 2) if votes else 0,
            "dist": {str(score): d[score] for score in ALLOWED_SCORES},
        }
        if with_voters:
            result["voters"] = {str(score): voters[idea.id][score] for score in ALLOWED_SCORES}
        results[idea.id] = result

    ranked = sorted(
        ideas,
        key=lambda i: (
            -results[i.id]["total"],
            -results[i.id]["avg"],
            -int(results[i.id]["dist"]["5"]),
            -int(results[i.id]["dist"]["3"]),
            i.position,
            i.id,
        ),
    )
    for rank, idea in enumerate(ranked, start=1):
        results[idea.id]["rank"] = rank
    return results


def list_ideas() -> list[Idea]:
    return list(
        db.session.scalars(
            select(Idea).options(selectinload(Idea.effects)).order_by(Idea.position, Idea.id.desc())
        ).all()
    )


def _iso(value: datetime | None) -> str | None:
    if value is None:
        return None
    if value.tzinfo is None:  # SQLite повертає naive datetime (у UTC)
        value = value.replace(tzinfo=timezone.utc)
    return value.isoformat()


def idea_to_dict(idea: Idea) -> dict:
    return {
        "id": idea.id,
        "title": idea.title,
        "description": idea.description,
        "position": idea.position,
        "created_at": _iso(idea.created_at),
        "effects": [
            {"id": e.id, "kind": e.kind, "label": e.label, "text": e.text, "display": e.display}
            for e in idea.effects
        ],
    }


def build_state(participant: Participant | None = None, admin: bool = False) -> dict:
    # Версію читаємо першою: дані, прочитані далі, не можуть бути старішими за неї.
    workshop = get_workshop()
    version = workshop.version
    ideas = list_ideas()
    participants_count = db.session.scalar(select(func.count(Participant.id))) or 0

    include_results = admin or workshop.show_results
    results = compute_results(ideas, with_voters=admin) if include_results else {}

    state: dict = {
        "version": version,
        "server_time": _iso(datetime.now(timezone.utc)),
        "workshop": {
            "title": workshop.title,
            "description": workshop.description,
            "voting_open": workshop.voting_open,
            "show_results": workshop.show_results,
            "show_names": workshop.show_names,
        },
        "participants_count": int(participants_count),
        "ideas": [],
    }
    for idea in ideas:
        item = idea_to_dict(idea)
        item["results"] = results.get(idea.id) if include_results else None
        state["ideas"].append(item)

    if participant is not None:
        my_votes = db.session.execute(
            select(Vote.idea_id, Vote.score).where(Vote.participant_id == participant.id)
        ).all()
        state["me"] = {
            "id": participant.id,
            "name": participant.name,
            "company": participant.company,
            "votes": {str(idea_id): score for idea_id, score in my_votes},
        }

    if admin:
        counts = dict(
            db.session.execute(
                select(Vote.participant_id, func.count(Vote.id)).group_by(Vote.participant_id)
            ).all()
        )
        participants = db.session.scalars(
            select(Participant).order_by(Participant.company_key, Participant.name_key)
        ).all()
        state["participants"] = [
            {
                "id": p.id,
                "name": p.name,
                "company": p.company,
                "votes_count": int(counts.get(p.id, 0)),
                "created_at": _iso(p.created_at),
            }
            for p in participants
        ]
    return state


def scale_payload() -> list[dict]:
    return [dict(item) for item in SCALE]


def effect_catalog_payload() -> list[dict]:
    return [dict(item) for item in EFFECT_CATALOG]

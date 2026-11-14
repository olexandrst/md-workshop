"""Модель даних воркшопу."""

from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Integer,
    SmallInteger,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .extensions import db

# Шкала оцінювання. Порядок важливий: від найменшої до найбільшої зацікавленості.
SCALE: tuple[dict, ...] = (
    {"score": 0, "label": "Не релевантно", "short": "Не релевантно"},
    {"score": 1, "label": "Потенційно цікаво", "short": "Цікаво"},
    {"score": 2, "label": "Актуально і потрібно", "short": "Актуально"},
    {"score": 3, "label": "Готові пропрацьовувати концепцію", "short": "Концепція"},
    {"score": 5, "label": "Готові пілотувати", "short": "Пілот"},
)
ALLOWED_SCORES: tuple[int, ...] = tuple(item["score"] for item in SCALE)
SCORE_LABELS: dict[int, str] = {item["score"]: item["label"] for item in SCALE}

WORKSHOP_ID = 1

TITLE_MAX = 200
DESCRIPTION_MAX = 5000
EFFECT_MAX = 300
EFFECTS_PER_IDEA_MAX = 15
NAME_MAX = 80
COMPANY_MAX = 120


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Workshop(db.Model):
    """Один рядок (id=1): налаштування воркшопу та лічильник версії стану."""

    __tablename__ = "workshop"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    title: Mapped[str] = mapped_column(String(TITLE_MAX), nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=False, default="")
    voting_open: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    show_results: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    show_names: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    # Зростає при кожній зміні — клієнти опитують сервер і перезавантажують дані лише при зміні версії.
    version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow, onupdate=utcnow
    )


class Idea(db.Model):
    __tablename__ = "idea"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    title: Mapped[str] = mapped_column(String(TITLE_MAX), nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=False, default="")
    position: Mapped[int] = mapped_column(Integer, nullable=False, default=0, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow, onupdate=utcnow
    )

    effects: Mapped[list["BusinessEffect"]] = relationship(
        back_populates="idea",
        order_by="BusinessEffect.position",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )
    votes: Mapped[list["Vote"]] = relationship(
        back_populates="idea", cascade="all, delete-orphan", passive_deletes=True
    )


class BusinessEffect(db.Model):
    __tablename__ = "business_effect"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    idea_id: Mapped[int] = mapped_column(
        ForeignKey("idea.id", ondelete="CASCADE"), nullable=False, index=True
    )
    text: Mapped[str] = mapped_column(String(EFFECT_MAX), nullable=False)
    position: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    idea: Mapped[Idea] = relationship(back_populates="effects")


class Participant(db.Model):
    __tablename__ = "participant"
    __table_args__ = (UniqueConstraint("name_key", "company_key", name="uq_participant_identity"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(NAME_MAX), nullable=False)
    company: Mapped[str] = mapped_column(String(COMPANY_MAX), nullable=False)
    # Нормалізовані ключі: той самий учасник з іншого пристрою «повертається» до своїх голосів.
    name_key: Mapped[str] = mapped_column(String(NAME_MAX), nullable=False)
    company_key: Mapped[str] = mapped_column(String(COMPANY_MAX), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utcnow)

    votes: Mapped[list["Vote"]] = relationship(
        back_populates="participant", cascade="all, delete-orphan", passive_deletes=True
    )

    @property
    def display(self) -> str:
        return f"{self.company} ({self.name})"


class Vote(db.Model):
    __tablename__ = "vote"
    __table_args__ = (
        UniqueConstraint("participant_id", "idea_id", name="uq_vote_participant_idea"),
        CheckConstraint(
            "score IN (" + ",".join(str(s) for s in ALLOWED_SCORES) + ")", name="ck_vote_score"
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    participant_id: Mapped[int] = mapped_column(
        ForeignKey("participant.id", ondelete="CASCADE"), nullable=False
    )
    idea_id: Mapped[int] = mapped_column(
        ForeignKey("idea.id", ondelete="CASCADE"), nullable=False, index=True
    )
    score: Mapped[int] = mapped_column(SmallInteger, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow, onupdate=utcnow
    )

    participant: Mapped[Participant] = relationship(back_populates="votes")
    idea: Mapped[Idea] = relationship(back_populates="votes")

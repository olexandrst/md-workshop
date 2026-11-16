"""Модель даних воркшопу."""

from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import (
    JSON,
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

# Каталог типових економічних ефектів. kind — стабільний код (іконка на фронтенді), label — назва,
# hint — що саме вимірюємо (підказка ведучому). До типового ефекту можна дописати уточнення.
EFFECT_CATALOG: tuple[dict, ...] = (
    {"kind": "speed", "label": "Прискорення процесів", "hint": "Коротший цикл операцій і виконання замовлення"},
    {"kind": "cost", "label": "Зниження витрат", "hint": "Менші операційні витрати на одиницю продукції"},
    {"kind": "revenue", "label": "Зростання продажів", "hint": "Конверсія, середній чек, нові канали збуту"},
    {"kind": "defects", "label": "Зменшення браку", "hint": "Менше браку, переробок, рекламацій і повернень"},
    {"kind": "quality", "label": "Підвищення якості", "hint": "Стабільна якість продукції та сервісу"},
    {"kind": "productivity", "label": "Підвищення продуктивності", "hint": "Більше результату з тих самих потужностей і людей"},
    {"kind": "people", "label": "Вивільнення людського ресурсу", "hint": "Автоматизація рутини, менше ручної праці (FTE)"},
    {"kind": "materials", "label": "Економія сировини", "hint": "Менше відходів ДСП/МДФ, тканин, фурнітури, енергії"},
    {"kind": "inventory", "label": "Оптимізація запасів", "hint": "Нижчі залишки на складі, вивільнені обігові кошти"},
    {"kind": "customer", "label": "Лояльність клієнтів", "hint": "Задоволеність, NPS, повторні покупки"},
    {"kind": "control", "label": "Прозорість і керованість", "hint": "Рішення на даних, точні прогнози, контроль у реальному часі"},
)
EFFECT_LABELS: dict[str, str] = {item["kind"]: item["label"] for item in EFFECT_CATALOG}
EFFECT_KIND_MAX = 32

WORKSHOP_ID = 1

TITLE_MAX = 200
DESCRIPTION_MAX = 5000
EFFECT_MAX = 300
EFFECTS_PER_IDEA_MAX = 15
NAME_MAX = 80
COMPANY_MAX = 120
PHONE_MAX = 32


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
    # Код типового ефекту з EFFECT_CATALOG або NULL для власного ефекту.
    kind: Mapped[str | None] = mapped_column(String(EFFECT_KIND_MAX), nullable=True)
    # Для власного ефекту — його текст; для типового — необов'язкове уточнення.
    text: Mapped[str] = mapped_column(String(EFFECT_MAX), nullable=False, default="")
    position: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    idea: Mapped[Idea] = relationship(back_populates="effects")

    @property
    def label(self) -> str | None:
        return EFFECT_LABELS.get(self.kind) if self.kind else None

    @property
    def display(self) -> str:
        if self.label and self.text:
            return f"{self.label}: {self.text}"
        return self.label or self.text


class Participant(db.Model):
    __tablename__ = "participant"
    __table_args__ = (UniqueConstraint("name_key", "company_key", name="uq_participant_identity"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(NAME_MAX), nullable=False)
    company: Mapped[str] = mapped_column(String(COMPANY_MAX), nullable=False)
    # Нормалізовані ключі: той самий учасник з іншого пристрою «повертається» до своїх голосів.
    name_key: Mapped[str] = mapped_column(String(NAME_MAX), nullable=False)
    company_key: Mapped[str] = mapped_column(String(COMPANY_MAX), nullable=False)
    # Контактний телефон (бачить лише ведучий). Нормалізований: «+» і цифри.
    phone: Mapped[str] = mapped_column(String(PHONE_MAX), nullable=False, default="")
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


class ResultSnapshot(db.Model):
    """Знімок результатів завершеного голосування: ідеї, бали, хто як голосував, контакти учасників."""

    __tablename__ = "result_snapshot"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    title: Mapped[str] = mapped_column(String(TITLE_MAX), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utcnow, index=True)
    participants_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    votes_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    ideas_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    # Повний стан у форматі build_state(admin=True)
    data: Mapped[dict] = mapped_column(JSON, nullable=False)

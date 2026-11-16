"""Експорт результатів у Excel: підсумок, детальні голоси, учасники."""

from __future__ import annotations

import io
from datetime import datetime

from openpyxl import Workbook
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter

from .models import ALLOWED_SCORES, SCORE_LABELS

HEADER_FILL = PatternFill("solid", fgColor="1C5CAB")
HEADER_FONT = Font(bold=True, color="FFFFFF")
WRAP = Alignment(wrap_text=True, vertical="top")


def _style_sheet(ws, widths: list[int]) -> None:
    for cell in ws[1]:
        cell.fill = HEADER_FILL
        cell.font = HEADER_FONT
        cell.alignment = Alignment(wrap_text=True, vertical="center")
    for index, width in enumerate(widths, start=1):
        ws.column_dimensions[get_column_letter(index)].width = width
    for row in ws.iter_rows(min_row=2):
        for cell in row:
            cell.alignment = WRAP
    ws.freeze_panes = "A2"
    ws.auto_filter.ref = ws.dimensions


def _who(voters: list[dict]) -> str:
    return ", ".join(
        f"{v['company']} ({v['name']}{', ' + v['phone'] if v.get('phone') else ''})" for v in voters
    )


def build_workbook(state: dict) -> bytes:
    wb = Workbook()

    # --- Підсумок
    ws = wb.active
    ws.title = "Підсумок"
    header = ["Місце", "Ідея", "Бізнес-ефекти", "Сума балів", "Середній бал", "Голосів"]
    header += [f"{s} — {SCORE_LABELS[s]}" for s in ALLOWED_SCORES]
    header += ["Готові пілотувати (5)", "Готові пропрацьовувати концепцію (3)"]
    ws.append(header)
    ideas = sorted(state["ideas"], key=lambda i: i["results"]["rank"])
    for idea in ideas:
        r = idea["results"]
        ws.append(
            [
                r["rank"],
                idea["title"],
                "\n".join(e["display"] for e in idea["effects"]),
                r["total"],
                r["avg"],
                r["votes"],
                *[r["dist"][str(s)] for s in ALLOWED_SCORES],
                _who(r["voters"]["5"]),
                _who(r["voters"]["3"]),
            ]
        )
    _style_sheet(ws, [8, 40, 45, 11, 11, 9] + [14] * len(ALLOWED_SCORES) + [40, 40])

    # --- Голоси
    ws = wb.create_sheet("Голоси")
    ws.append(["Компанія", "Ім'я та прізвище", "Телефон", "Ідея", "Бал", "Оцінка"])
    rows = []
    for idea in state["ideas"]:
        for score in ALLOWED_SCORES:
            for voter in idea["results"]["voters"][str(score)]:
                rows.append(
                    [voter["company"], voter["name"], voter.get("phone", ""), idea["title"], score, SCORE_LABELS[score]]
                )
    rows.sort(key=lambda row: (row[0].casefold(), row[1].casefold(), row[3].casefold()))
    for row in rows:
        ws.append(row)
    _style_sheet(ws, [30, 28, 18, 45, 8, 32])

    # --- Учасники
    ws = wb.create_sheet("Учасники")
    ws.append(["Компанія", "Ім'я та прізвище", "Телефон", "Оцінено ідей", "Приєднався"])
    for p in state["participants"]:
        joined = p["created_at"]
        if joined:
            joined = datetime.fromisoformat(joined).strftime("%Y-%m-%d %H:%M")
        ws.append([p["company"], p["name"], p.get("phone", ""), p["votes_count"], joined])
    _style_sheet(ws, [30, 28, 18, 14, 18])

    # --- Про воркшоп
    ws = wb.create_sheet("Воркшоп")
    ws.append(["Параметр", "Значення"])
    ws.append(["Назва", state["workshop"]["title"]])
    ws.append(["Пояснення", state["workshop"]["description"]])
    ws.append(["Учасників", state["participants_count"]])
    ws.append(["Експортовано", datetime.now().strftime("%Y-%m-%d %H:%M")])
    _style_sheet(ws, [18, 90])

    buffer = io.BytesIO()
    wb.save(buffer)
    return buffer.getvalue()

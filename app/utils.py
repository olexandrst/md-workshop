from __future__ import annotations

import io
import os
import socket
from functools import lru_cache
from urllib.parse import urlsplit, urlunsplit

import segno
from flask import current_app, request, url_for

from .services import ServiceError

_LOCAL_HOSTS = {"localhost", "127.0.0.1", "::1", "0.0.0.0"}


def json_body() -> dict:
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        raise ServiceError("Очікується JSON-об'єкт у тілі запиту")
    return data


@lru_cache(maxsize=1)
def lan_ip() -> str | None:
    """IP комп'ютера в локальній мережі (пакети не надсилаються)."""
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.connect(("10.255.255.255", 1))
        ip = sock.getsockname()[0]
        return None if ip.startswith("127.") else ip
    except OSError:
        return None
    finally:
        sock.close()


def participant_url() -> str:
    """Адреса сторінки учасника для QR-коду.

    Якщо ведучий відкрив застосунок як localhost, телефони в залі за такою адресою нікуди не потраплять,
    тож підставляємо IP комп'ютера в локальній мережі.
    """
    public_url = current_app.config.get("PUBLIC_URL")
    if public_url:
        return public_url + "/"
    url = url_for("public.index", _external=True)
    parts = urlsplit(url)
    # У Docker-контейнері «локальна» IP — це адреса контейнера, а не ПК, тож не підставляємо її.
    if parts.hostname in _LOCAL_HOSTS and not os.path.exists("/.dockerenv"):
        ip = lan_ip()
        if ip:
            netloc = ip + (f":{parts.port}" if parts.port else "")
            url = urlunsplit((parts.scheme, netloc, parts.path, "", ""))
    return url


def qr_svg(data: str) -> bytes:
    qr = segno.make(data, error="m")
    buffer = io.BytesIO()
    qr.save(
        buffer,
        kind="svg",
        scale=10,
        border=2,
        dark="#0b0b0b",
        light="#ffffff",
        xmldecl=False,
        title="QR-код для голосування",
    )
    return buffer.getvalue()

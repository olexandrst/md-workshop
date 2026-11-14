"""Локальний запуск на ПК (Windows / macOS / Linux): python run.py

Сервер слухає всі мережеві інтерфейси, тож телефони учасників у тій самій Wi-Fi мережі
можуть відкрити сторінку за QR-кодом з екрана ведучого.
"""

import os

from app import create_app
from app.cli import init_db
from app.utils import lan_ip


def main() -> None:
    app = create_app()
    with app.app_context():
        init_db()

    host = os.environ.get("HOST", "0.0.0.0")
    port = int(os.environ.get("PORT", "5000"))
    ip = lan_ip() or "localhost"

    print("\n  Голосування на воркшопі запущено")
    print(f"  Екран ведучого:   http://localhost:{port}/admin")
    print(f"  Для учасників:    http://{ip}:{port}/")
    if app.config.get("ADMIN_PASSWORD_IS_DEFAULT"):
        print("  Пароль ведучого:  admin  (задайте ADMIN_PASSWORD у файлі .env)")
    print(f"  База даних:       {app.config['SQLALCHEMY_DATABASE_URI'].split('@')[-1]}")
    print("  Зупинити: Ctrl+C\n")

    try:
        from waitress import serve
    except ImportError:  # pragma: no cover
        app.run(host=host, port=port, threaded=True)
    else:
        serve(app, host=host, port=port, threads=16, ident="workshop")


if __name__ == "__main__":
    main()

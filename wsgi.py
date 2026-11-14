"""Точка входу WSGI для gunicorn (Render, Docker): gunicorn -c gunicorn.conf.py wsgi:app"""

from app import create_app

app = create_app()

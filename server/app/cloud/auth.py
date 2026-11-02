"""署名付き HttpOnly セッション。開始前の認証は10分、大会中は開催期限まで。"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time
from typing import Any

from fastapi import HTTPException, Request, WebSocket

from .service import Settings

COOKIE = "quiz_host"


def issue(settings: Settings, event_id: str, expires_at: float) -> str:
    payload = base64.urlsafe_b64encode(json.dumps({"event": event_id, "exp": expires_at}).encode()).decode()
    signature = hmac.new(settings.session_secret.encode(), payload.encode(), hashlib.sha256).hexdigest()
    return f"{payload}.{signature}"


def session(connection: Request | WebSocket, settings: Settings, now: float | None = None) -> dict[str, Any]:
    token = connection.cookies.get(COOKIE, "")
    try:
        payload, signature = token.split(".")
        expected = hmac.new(settings.session_secret.encode(), payload.encode(), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(signature, expected):
            raise ValueError
        value = json.loads(base64.urlsafe_b64decode(payload))
        if value["exp"] <= (time.time() if now is None else now):
            raise ValueError
        return value
    except (ValueError, KeyError, TypeError):
        raise HTTPException(401, "主催者認証が必要です。") from None


def check_origin(connection: Request | WebSocket, settings: Settings) -> None:
    if connection.headers.get("origin") != settings.public_url.rstrip("/"):
        raise HTTPException(403, "許可されない接続元です。")

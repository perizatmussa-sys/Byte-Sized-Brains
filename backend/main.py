"""Этап 1 CQA: безопасно загрузить DEV из API и показать диалоги в браузере.

Запуск из корня репозитория:
    python -m uvicorn backend.main:app --reload

В этом этапе AI-оценка ещё НЕ реализована.
"""

import json
import os
from pathlib import Path
from typing import Any

import requests
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

ROOT = Path(__file__).resolve().parent.parent
FRONTEND = ROOT / "frontend"
DATA_FILE = ROOT / "data" / "dev_records.json"
load_dotenv(ROOT / ".env")

app = FastAPI(title="Byte-Sized-Brains CQA", version="0.1.0")
app.mount("/static", StaticFiles(directory=str(FRONTEND)), name="static")


def read_saved_records() -> list[dict[str, Any]]:
    """Возвращает ранее загруженные диалоги или пустой список."""
    if not DATA_FILE.exists():
        return []

    try:
        with DATA_FILE.open("r", encoding="utf-8") as file:
            records = json.load(file)
    except (OSError, json.JSONDecodeError) as error:
        raise HTTPException(
            status_code=500,
            detail="Локальный файл данных повреждён. Повторите импорт DEV.",
        ) from error

    if not isinstance(records, list):
        raise HTTPException(status_code=500, detail="Неверный формат локального файла данных.")
    return records


def validate_response(payload: Any) -> list[dict[str, Any]]:
    """Проверяет основные поля ответа по спецификации организаторов."""
    if not isinstance(payload, dict) or payload.get("isSuccess") is not True:
        raise HTTPException(status_code=502, detail="API не подтвердил успешную загрузку (isSuccess).")

    data = payload.get("data")
    if not isinstance(data, dict) or not isinstance(data.get("records"), list):
        raise HTTPException(status_code=502, detail="API вернул неожиданный формат data.records.")

    records = data["records"]
    for index, record in enumerate(records):
        if not isinstance(record, dict):
            raise HTTPException(status_code=502, detail=f"Диалог #{index + 1} имеет неверный формат.")
        if not isinstance(record.get("conversation_id"), str):
            raise HTTPException(status_code=502, detail=f"У диалога #{index + 1} отсутствует ID.")
        if not isinstance(record.get("transcript"), list):
            raise HTTPException(status_code=502, detail=f"У диалога #{index + 1} нет списка transcript.")

    return records


@app.get("/")
def index():
    return FileResponse(FRONTEND / "index.html")


@app.get("/api/status")
def get_status():
    records = read_saved_records()
    return {
        "api_configured": bool(os.getenv("CQA_API_URL", "").strip()),
        "data_loaded": DATA_FILE.exists(),
        "record_count": len(records),
    }


@app.post("/api/import")
def import_dev():
    api_url = os.getenv("CQA_API_URL", "").strip()
    if not api_url:
        raise HTTPException(status_code=400, detail="Добавьте CQA_API_URL в файл .env и перезапустите сервер.")
    if not api_url.startswith("https://"):
        raise HTTPException(status_code=400, detail="CQA_API_URL должен начинаться с https://")

    try:
        response = requests.get(api_url, headers={"Accept": "application/json"}, timeout=60)
        response.raise_for_status()
        payload = response.json()
    except requests.exceptions.Timeout as error:
        raise HTTPException(status_code=504, detail="API не ответил за 60 секунд.") from error
    except requests.exceptions.RequestException as error:
        # Не показываем сырую ошибку: она может содержать секретный параметр sig из URL.
        raise HTTPException(
            status_code=502,
            detail="Не удалось подключиться к API. Проверьте ссылку, интернет и доступ к ресурсу.",
        ) from error
    except ValueError as error:
        raise HTTPException(status_code=502, detail="API вернул не JSON.") from error

    records = validate_response(payload)
    DATA_FILE.parent.mkdir(parents=True, exist_ok=True)
    with DATA_FILE.open("w", encoding="utf-8") as file:
        json.dump(records, file, ensure_ascii=False, indent=2)

    languages: dict[str, int] = {}
    channels: dict[str, int] = {}
    for record in records:
        language = str(record.get("language", "unknown"))
        channel = str(record.get("channel", "unknown"))
        languages[language] = languages.get(language, 0) + 1
        channels[channel] = channels.get(channel, 0) + 1

    return {"success": True, "count": len(records), "languages": languages, "channels": channels}


@app.get("/api/conversations")
def list_conversations():
    return [
        {
            "conversation_id": record.get("conversation_id"),
            "language": record.get("language"),
            "channel": record.get("channel"),
            "message_count": len(record.get("transcript", [])),
            "has_audio": bool(record.get("audio_url")),
        }
        for record in read_saved_records()
    ]


@app.get("/api/conversations/{conversation_id}")
def get_conversation(conversation_id: str):
    for record in read_saved_records():
        if record.get("conversation_id") == conversation_id:
            return record
    raise HTTPException(status_code=404, detail="Диалог не найден.")

# --------------------------------------------------
# Этап 2: редактируемый чек-лист и проверенная математика.
# Оценки на этом этапе вводит человек; AI подключим отдельно.
# --------------------------------------------------
from .quality import (checklist, validate_checklist, save_json, CONFIG_FILE,
                      evaluate, saved_evaluations, save_evaluation)


@app.get("/api/checklist")
def get_checklist():
    return checklist()


@app.put("/api/checklist")
def save_checklist(payload: dict[str, Any]):
    config = validate_checklist(payload)
    save_json(CONFIG_FILE, config)
    return config


@app.get("/api/evaluations/{conversation_id}")
def get_evaluation(conversation_id: str):
    result = saved_evaluations().get(conversation_id)
    if not result:
        raise HTTPException(status_code=404, detail="Этот диалог ещё не оценён.")
    return result


@app.post("/api/evaluations/{conversation_id}")
def submit_manual_evaluation(conversation_id: str, payload: dict[str, Any]):
    conversation = next((c for c in read_saved_records()
                         if c.get("conversation_id") == conversation_id), None)
    if conversation is None:
        raise HTTPException(status_code=404, detail="Диалог не найден.")
    result = evaluate(conversation, checklist(), payload.get("answers"))
    result["mode"] = "manual"  # Нельзя выдавать ручную оценку за оценку AI.
    save_evaluation(result)
    return result

"""CQA: загрузка DEV, ручные оценки и AI-оценки.

Запуск из корня репозитория:
    python -m uvicorn backend.main:app --reload

Бесплатная AI-оценка через GroqCloud подключается с GROQ_API_KEY в .env.
"""

import json
import os
from pathlib import Path
from typing import Any

import requests
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, Response
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


def conversation_kind(record: dict[str, Any]) -> str:
    """«call» для звонков, «chat» для переписки — для фильтра на сайте."""
    channel = str(record.get("channel", "")).lower()
    if record.get("audio_url") or any(word in channel for word in ("call", "voice", "phone")):
        return "call"
    return "chat"


def transcript_as_text(record: dict[str, Any]) -> str:
    kind = "Звонок" if conversation_kind(record) == "call" else "Переписка"
    lines = [
        f"Диалог: {record.get('conversation_id', '')}",
        f"Тип: {kind} ({record.get('channel') or '?'}) · Язык: {record.get('language') or '?'}",
        f"Реплик: {len(record.get('transcript', []))}",
        "",
    ]
    for index, message in enumerate(record.get("transcript", []), start=1):
        stamp = f" [{message.get('timestamp')}]" if message.get("timestamp") else ""
        lines.append(f"#{index}{stamp} {message.get('speaker', 'unknown')}: {message.get('text', '')}")
    return "\n".join(lines) + "\n"


def download_response(content: str, filename: str, media_type: str) -> Response:
    return Response(content=content.encode("utf-8"), media_type=f"{media_type}; charset=utf-8",
                    headers={"Content-Disposition": f'attachment; filename="{filename}"'})


@app.get("/api/export")
def export_conversations(kind: str = "all", format: str = "json"):
    """Скачать все скрипты (или только звонки / только переписки) одним файлом."""
    if kind not in ("all", "call", "chat"):
        raise HTTPException(status_code=400, detail="kind должен быть all, call или chat.")
    if format not in ("json", "txt"):
        raise HTTPException(status_code=400, detail="format должен быть json или txt.")
    records = [r for r in read_saved_records() if kind == "all" or conversation_kind(r) == kind]
    name = f"cqa-scripts-{kind}"
    if format == "txt":
        separator = "\n" + "=" * 60 + "\n\n"
        return download_response(separator.join(transcript_as_text(r) for r in records), f"{name}.txt", "text/plain")
    return download_response(json.dumps(records, ensure_ascii=False, indent=2), f"{name}.json", "application/json")


@app.get("/api/conversations/{conversation_id}/download")
def download_conversation(conversation_id: str, format: str = "txt"):
    if format not in ("json", "txt"):
        raise HTTPException(status_code=400, detail="format должен быть json или txt.")
    record = get_conversation(conversation_id)
    safe_id = "".join(ch if ch.isalnum() or ch in "-_" else "_" for ch in conversation_id) or "dialog"
    if format == "txt":
        return download_response(transcript_as_text(record), f"{safe_id}.txt", "text/plain")
    return download_response(json.dumps(record, ensure_ascii=False, indent=2), f"{safe_id}.json", "application/json")


@app.get("/api/conversations")
def list_conversations():
    return [
        {
            "conversation_id": record.get("conversation_id"),
            "language": record.get("language"),
            "channel": record.get("channel"),
            "kind": conversation_kind(record),
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


# --------------------------------------------------
# Этап 4: два AI-провайдера, сравнение и резерв.
# --------------------------------------------------
from fastapi import Query
from .ai import provider_status, saved_for_conversation, assess_one, compare_models


def find_conversation_or_404(conversation_id: str) -> dict[str, Any]:
    item = next((c for c in read_saved_records() if c.get("conversation_id") == conversation_id), None)
    if item is None:
        raise HTTPException(404, "Диалог не найден.")
    return item


@app.get("/api/ai/status")
def ai_status():
    return provider_status()


@app.get("/api/ai/evaluations/{conversation_id}")
def get_ai_evaluation(conversation_id: str):
    result = saved_for_conversation(conversation_id)
    if not result:
        raise HTTPException(404, "Этот диалог ещё не оценён AI.")
    return result  # словарь {groq: оценка, gemini: оценка}


@app.post("/api/ai/evaluations/{conversation_id}")
def submit_ai_evaluation(conversation_id: str, provider: str = Query("auto"), force: bool = Query(False)):
    conversation = find_conversation_or_404(conversation_id)
    return assess_one(conversation, checklist(), provider=provider, force=force)


@app.post("/api/ai/compare/{conversation_id}")
def compare_ai_evaluations(conversation_id: str, force: bool = Query(False)):
    conversation = find_conversation_or_404(conversation_id)
    return compare_models(conversation, checklist(), force=force)


# --------------------------------------------------
# Этап 5: апелляции и окончательный пересмотр человеком.
# Оригинальные ручные / AI-оценки не перезаписываются.
# --------------------------------------------------
from .appeals import create_appeal, list_appeals, decide_appeal


@app.get("/api/appeals")
def get_appeals(conversation_id: str = Query(..., min_length=1)):
    find_conversation_or_404(conversation_id)
    return list_appeals(conversation_id)


@app.post("/api/appeals")
def new_appeal(payload: dict[str, Any]):
    conversation_id = str(payload.get("conversation_id", "")).strip()
    find_conversation_or_404(conversation_id)
    return create_appeal(payload)


@app.post("/api/appeals/{appeal_id}/decision")
def submit_appeal_decision(appeal_id: str, payload: dict[str, Any]):
    return decide_appeal(appeal_id, payload, find_conversation_or_404)

"""CQA: загрузка DEV, ручные оценки и AI-оценки.

Запуск из корня репозитория:
    python -m uvicorn backend.main:app --reload

Бесплатная AI-оценка через GroqCloud подключается с GROQ_API_KEY в .env.
"""

import json
import os
from pathlib import Path
from typing import Any, Optional

import requests
from dotenv import load_dotenv
from fastapi import Body, FastAPI, HTTPException
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles

ROOT = Path(__file__).resolve().parent.parent
FRONTEND = ROOT / "frontend"
DATA_FILE = ROOT / "data" / "dev_records.json"
CUSTOM_FILE = ROOT / "data" / "custom_records.json"  # свои диалоги и контрольные наборы
# Windows-блокнот часто сохраняет «.env» как «.env.txt» — принимаем оба варианта.
ENV_FILE = next((p for p in (ROOT / ".env", ROOT / ".env.txt") if p.is_file()), ROOT / ".env")
load_dotenv(ENV_FILE)


def env_problem() -> str:
    """Понятное объяснение, почему не найдена ссылка CQA_API_URL."""
    if not ENV_FILE.is_file():
        hint = " Сейчас ссылка есть только в .env.example — этот файл сервер не читает." if (ROOT / ".env.example").is_file() else ""
        return (f"Нет файла .env в папке проекта: {ROOT}.{hint} Создайте файл .env рядом с папкой backend, "
                "вставьте строку CQA_API_URL=… и перезапустите сервер.")
    return (f"В файле {ENV_FILE} нет строки CQA_API_URL=… (или она пустая). "
            "Вставьте ссылку из PDF и перезапустите сервер.")

app = FastAPI(title="Byte-Sized-Brains CQA", version="0.1.0")
app.mount("/static", StaticFiles(directory=str(FRONTEND)), name="static")


def read_saved_records() -> list[dict[str, Any]]:
    """Все диалоги: DEV из API + добавленные пользователем / контрольные наборы."""
    custom = read_custom_records()
    custom_ids = {r.get("conversation_id") for r in custom}
    dev = [r for r in read_records_file(DATA_FILE) if r.get("conversation_id") not in custom_ids]
    return dev + custom


def read_custom_records() -> list[dict[str, Any]]:
    return read_records_file(CUSTOM_FILE)


def read_records_file(path: Path) -> list[dict[str, Any]]:
    """Возвращает ранее сохранённые диалоги или пустой список."""
    if not path.exists():
        return []

    try:
        with path.open("r", encoding="utf-8") as file:
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
        "env_file": str(ENV_FILE),
        "env_file_found": ENV_FILE.is_file(),
        "api_problem": None if os.getenv("CQA_API_URL", "").strip() else env_problem(),
        "data_loaded": DATA_FILE.exists(),
        "record_count": len(records),
    }


def url_with_group(api_url: str, group_id: str) -> str:
    from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit
    parts = urlsplit(api_url)
    query = [(k, v) for k, v in parse_qsl(parts.query, keep_blank_values=True) if k != "group_id"]
    query.append(("group_id", group_id))
    return urlunsplit(parts._replace(query=urlencode(query)))


@app.post("/api/import")
def import_dev(group_id: str = ""):
    """Без group_id (или DEV) — загрузка набора DEV. Иначе — контрольный набор
    организаторов: он добавляется к диалогам, DEV при этом не удаляется."""
    group_id = group_id.strip()
    api_url = os.getenv("CQA_API_URL", "").strip()
    if not api_url:
        raise HTTPException(status_code=400, detail=env_problem())
    if not api_url.startswith("https://"):
        raise HTTPException(status_code=400, detail="CQA_API_URL должен начинаться с https://")

    is_dev = not group_id or group_id.upper() == "DEV"
    if not is_dev:
        if not all(ch.isalnum() or ch in "-_" for ch in group_id) or len(group_id) > 64:
            raise HTTPException(status_code=422, detail="group_id: только буквы, цифры, - и _.")
        api_url = url_with_group(api_url, group_id)
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
    if is_dev:
        DATA_FILE.parent.mkdir(parents=True, exist_ok=True)
        with DATA_FILE.open("w", encoding="utf-8") as file:
            json.dump(records, file, ensure_ascii=False, indent=2)
    else:
        if not records:
            raise HTTPException(status_code=404, detail=f"В наборе {group_id} нет диалогов.")
        for record in records:
            record["origin"] = group_id
        save_custom_records(records)

    languages: dict[str, int] = {}
    channels: dict[str, int] = {}
    for record in records:
        language = str(record.get("language", "unknown"))
        channel = str(record.get("channel", "unknown"))
        languages[language] = languages.get(language, 0) + 1
        channels[channel] = channels.get(channel, 0) + 1

    return {"success": True, "count": len(records), "languages": languages, "channels": channels,
            "group_id": "DEV" if is_dev else group_id}


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
            "origin": record.get("origin", "DEV"),
            "message_count": len(record.get("transcript", [])),
            "has_audio": bool(record.get("audio_url")),
            "search_text": " ".join(str(m.get("text", "")) for m in record.get("transcript", [])).lower(),
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
    """Сохранить активный чек-лист (и обновить его копию в библиотеке чек-листов)."""
    return checklists.save_active(payload)


# Несколько чек-листов: список, создание, выбор, переименование, удаление.
from . import checklists


@app.get("/api/checklists")
def get_checklists():
    return checklists.list_checklists()


@app.post("/api/checklists")
def new_checklist(payload: dict[str, Any]):
    return checklists.create(payload)


@app.post("/api/checklists/{checklist_id}/activate")
def activate_checklist(checklist_id: str):
    return checklists.activate(checklist_id)


@app.patch("/api/checklists/{checklist_id}")
def rename_checklist(checklist_id: str, payload: dict[str, Any]):
    return checklists.rename(checklist_id, payload)


@app.delete("/api/checklists/{checklist_id}")
def delete_checklist(checklist_id: str):
    return checklists.delete(checklist_id)


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
from .appeals import create_appeal, list_appeals, decide_appeal, get_appeal, appeal_items


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


# --------------------------------------------------
# Рабочее пространство: баллы для списка, сводка апелляций, аналитика.
# Только чтение сохранённых данных — AI не вызывается.
# --------------------------------------------------
from .appeals import _load as load_all_appeals


def criterion_percent(row: dict[str, Any]) -> Optional[float]:
    """Процент выполнения критерия; None для N/A и флагов без баллов."""
    points, weight = row.get("points_before_redistribution"), row.get("weight") or 0
    if row.get("value") == "na" or points is None or weight <= 0:
        return None
    return round(points / weight * 100, 1)


def result_summary(result: dict[str, Any]) -> dict[str, Any]:
    return {
        "score": result.get("score"),
        "gross_violation": bool(result.get("gross_violation")),
        "created_at": result.get("created_at"),
        "checklist_version": result.get("checklist_version"),
        "criteria": [{"id": r.get("id"), "name": r.get("name"), "type": r.get("type"),
                      "value": r.get("value"), "percent": criterion_percent(r),
                      "reason": r.get("reason"), "evidence_index": r.get("evidence_index")}
                     for r in result.get("criteria", [])],
    }


@app.get("/api/scores")
def get_scores():
    """Для каждого диалога: доступные оценки и «основная» (после апелляции > Groq > Gemini > ручная)."""
    manual = saved_evaluations()
    finals: dict[str, dict[str, Any]] = {}
    for appeal in load_all_appeals():
        if appeal.get("status") == "resolved" and appeal.get("final_result"):
            current = finals.get(appeal["conversation_id"])
            if current is None or str(appeal.get("decided_at", "")) >= str(current.get("decided_at", "")):
                finals[appeal["conversation_id"]] = appeal
    out = {}
    for record in read_saved_records():
        cid = record.get("conversation_id")
        sources: dict[str, Any] = {}
        if cid in finals:
            sources["final"] = result_summary(finals[cid]["final_result"])
        for provider, result in saved_for_conversation(cid).items():
            sources[provider] = result_summary(result)
        if cid in manual:
            sources["manual"] = result_summary(manual[cid])
        primary = next((k for k in ("final", "groq", "gemini", "manual") if k in sources), None)
        out[cid] = {"primary": primary, "score": sources[primary]["score"] if primary else None,
                    "kind": conversation_kind(record),
            "origin": record.get("origin", "DEV"), "language": record.get("language"), "sources": sources}
    return out


@app.get("/api/appeals/all")
def get_all_appeals():
    """Краткий список всех апелляций для разделов «Апелляции» и «Ревью»."""
    keys = ("id", "conversation_id", "source", "criterion_id", "criterion_name", "comment", "status",
            "created_at", "decided_at", "original_score", "final_score", "decision")
    return [{**{k: a.get(k) for k in keys}, "items": appeal_items(a)} for a in load_all_appeals()][::-1]


# --------------------------------------------------
# Свои диалоги: вставка текста, загрузка файла, удаление.
# Хранятся отдельно от DEV в data/custom_records.json.
# --------------------------------------------------
import re
import threading
from datetime import datetime, timezone

_CUSTOM_LOCK = threading.Lock()
SPEAKER_WORDS = {
    "operator": "operator", "оператор": "operator", "agent": "operator", "агент": "operator",
    "менеджер": "operator", "маман": "operator", "консультант": "operator",
    "client": "client", "клиент": "client", "customer": "client", "user": "client",
    "пользователь": "client", "клиентка": "client", "тұтынушы": "client",
    "bot": "bot", "бот": "bot", "aim": "bot",
    "system": "system", "система": "system", "жүйе": "system",
}
LINE_RE = re.compile(
    r"^\s*(?:#?\d+[.)]?\s+)?(?:\[?(?P<time>\d{1,2}:\d{2}(?::\d{2})?|\d{4}-\d{2}-\d{2}T[^\]\s]+)\]?\s*[-–—]?\s*)?"
    r"(?P<speaker>[A-Za-zА-Яа-яЁёӘәҒғҚқҢңӨөҰұҮүҺһІі]+)\s*(?:\[(?P<time2>[^\]]+)\])?\s*[:：]\s*(?P<text>.*)$")


def parse_transcript_text(text: str) -> list[dict[str, Any]]:
    """Разбирает текст вида «Оператор: ...» / «[00:12] Client: ...» в список реплик."""
    transcript: list[dict[str, Any]] = []
    for line in str(text or "").splitlines():
        if not line.strip():
            continue
        match = LINE_RE.match(line)
        speaker = SPEAKER_WORDS.get(match.group("speaker").lower()) if match else None
        if speaker:
            entry = {"speaker": speaker, "text": match.group("text").strip()}
            stamp = match.group("time") or match.group("time2")
            if stamp:
                entry["timestamp"] = stamp.strip()
            transcript.append(entry)
        elif transcript:
            transcript[-1]["text"] = (transcript[-1]["text"] + "\n" + line.strip()).strip()
        else:
            raise HTTPException(422, "Каждая реплика должна начинаться с роли: «Оператор:», «Клиент:», "
                                     "«Бот:» или «Система:» (или operator / client / bot / system).")
    transcript = [m for m in transcript if m["text"]]
    if not transcript:
        raise HTTPException(422, "В тексте не найдено ни одной реплики.")
    return transcript


def _clean_transcript(raw: Any) -> list[dict[str, Any]]:
    if not isinstance(raw, list) or not raw:
        raise HTTPException(422, "transcript должен быть непустым списком реплик.")
    out = []
    for index, message in enumerate(raw, start=1):
        if not isinstance(message, dict) or not str(message.get("text", "")).strip():
            raise HTTPException(422, f"Реплика #{index}: нужны поля speaker и text.")
        speaker = str(message.get("speaker", "")).strip().lower()
        entry = {"speaker": SPEAKER_WORDS.get(speaker, speaker or "client"), "text": str(message["text"]).strip()}
        if message.get("timestamp"):
            entry["timestamp"] = str(message["timestamp"])
        out.append(entry)
    return out


def _new_record(body: dict[str, Any], existing: set) -> dict[str, Any]:
    if body.get("transcript") is not None:
        transcript = _clean_transcript(body.get("transcript"))
    else:
        transcript = parse_transcript_text(body.get("text", ""))
    channel = str(body.get("channel") or "agent chat").strip().lower()
    if channel in ("call", "звонок"):
        channel = "voice call"
    if channel in ("chat", "переписка"):
        channel = "agent chat"
    language = str(body.get("language") or "RU").strip().upper()[:5]
    cid = str(body.get("conversation_id") or "").strip()
    if not cid:
        prefix = f"my-{language.lower()}-"
        number = 1
        while f"{prefix}{number:03d}" in existing:
            number += 1
        cid = f"{prefix}{number:03d}"
    if not re.fullmatch(r"[\w.-]{1,80}", cid):
        raise HTTPException(422, "ID диалога: только буквы, цифры, точка, - и _ (до 80 символов).")
    if cid in existing:
        raise HTTPException(409, f"Диалог с ID {cid} уже есть. Укажите другой ID.")
    audio = body.get("audio_url")
    record = {"conversation_id": cid, "channel": channel, "language": language, "transcript": transcript,
              "audio_url": audio if isinstance(audio, str) and audio.startswith(("http://", "https://")) else None,
              "origin": str(body.get("origin") or "custom"),
              "added_at": datetime.now(timezone.utc).isoformat()}
    return record


def save_custom_records(new_records: list[dict[str, Any]]) -> None:
    with _CUSTOM_LOCK:
        ids = {r["conversation_id"] for r in new_records}
        kept = [r for r in read_custom_records() if r.get("conversation_id") not in ids]
        CUSTOM_FILE.parent.mkdir(parents=True, exist_ok=True)
        with CUSTOM_FILE.open("w", encoding="utf-8") as file:
            json.dump(kept + new_records, file, ensure_ascii=False, indent=2)


@app.post("/api/conversations")
def add_conversations(payload: Any = Body(...)):
    """Добавить свои диалоги.

    * {"text": "Оператор: ...\nКлиент: ...", "channel", "language", "conversation_id"?}
    * {"transcript": [...], ...} — одна запись в формате API;
    * {"records": [...]}, список записей или полный ответ API {"data": {"records": [...]}}.
    """
    if isinstance(payload, dict) and isinstance(payload.get("data"), dict):
        payload = payload["data"].get("records")
    elif isinstance(payload, dict) and isinstance(payload.get("records"), list):
        payload = payload["records"]
    bodies = payload if isinstance(payload, list) else [payload]
    if not bodies or not all(isinstance(b, dict) for b in bodies):
        raise HTTPException(422, "Ожидается объект диалога или список диалогов.")
    if len(bodies) > 500:
        raise HTTPException(422, "За один раз можно добавить до 500 диалогов.")
    existing = {r.get("conversation_id") for r in read_saved_records()}
    records = []
    for number, body in enumerate(bodies, start=1):
        try:
            record = _new_record(body, existing)
        except HTTPException as error:
            prefix = f"Диалог #{number}: " if len(bodies) > 1 else ""
            raise HTTPException(error.status_code, prefix + str(error.detail)) from error
        existing.add(record["conversation_id"])
        records.append(record)
    save_custom_records(records)
    return {"added": [r["conversation_id"] for r in records], "count": len(records)}


@app.delete("/api/conversations/{conversation_id}")
def delete_conversation(conversation_id: str):
    with _CUSTOM_LOCK:
        custom = read_custom_records()
        if not any(r.get("conversation_id") == conversation_id for r in custom):
            if any(r.get("conversation_id") == conversation_id for r in read_saved_records()):
                raise HTTPException(403, "Диалоги DEV удалить нельзя — только добавленные вами.")
            raise HTTPException(404, "Диалог не найден.")
        kept = [r for r in custom if r.get("conversation_id") != conversation_id]
        with CUSTOM_FILE.open("w", encoding="utf-8") as file:
            json.dump(kept, file, ensure_ascii=False, indent=2)
    return {"deleted": conversation_id}


@app.get("/api/appeals/{appeal_id}")
def get_one_appeal(appeal_id: str):
    return get_appeal(appeal_id)

"""CQA Hackathon: export actual AI evaluations as official schema_version 1.0.

Run from repository root:
  python -m scripts.cqa_results_export dev --provider auto
  python -m scripts.cqa_results_export prod --group-id YOUR_GROUP_ID --provider auto

No fabricated scores; errors are preserved explicitly. Does not modify the UI.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import sys
import time
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
RESULTS = ROOT / "results"
TEAM = "Byte-Sized-Brains"

# The Python application uses a few different identifiers from the Appendix.
ID_MAP = {
    "contact": "contact",
    "needs": "discovery", "discovery": "discovery",
    "identity": "identification", "identification": "identification",
    "consultation": "consultation",
    "empathy": "empathy",
    "clarity": "dialogue", "dialogue": "dialogue",
    "closing": "closure", "closure": "closure",
    "critical": "critical",
}
OFFICIAL_ORDER = (
    "contact", "discovery", "identification", "consultation", "empathy",
    "dialogue", "closure", "critical",
)
OFFICIAL_RULES = {
    "contact": ("yes_no", 10, False, None),
    "discovery": ("yes_no", 15, True, None),
    "identification": ("yes_no", 20, True, None),
    "consultation": ("scale", 20, True, (0, 5, 10, 15, 20)),
    "empathy": ("yes_no", 15, False, None),
    "dialogue": ("scale", 15, False, (0, 4, 7, 10)),
    "closure": ("yes_no", 5, True, None),
    "critical": ("flag", 0, False, None),
}


class ExportError(Exception):
    """Error message safe for console output (does not contain secrets or transcripts)."""


def read_json(path: Path) -> Any:
    if not path.is_file():
        raise ExportError(f"Не найден файл {path.relative_to(ROOT)}")
    try:
        return json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise ExportError(f"Невозможно прочитать JSON {path.name}") from exc


def write_json_atomic(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(path.name + ".tmp")
    temp.write_text(json.dumps(data, ensure_ascii=False, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    temp.replace(path)


def source_records(kind: str, group_id: str | None = None) -> list[dict[str, Any]]:
    if kind == "dev":
        records = read_json(DATA / "dev_records.json")
        expected = 65
    else:
        if not group_id or group_id.upper() == "DEV":
            raise ExportError("Для PROD нужен --group-id, выданный организаторами.")
        all_custom = read_json(DATA / "custom_records.json")
        if not isinstance(all_custom, list):
            raise ExportError("custom_records.json должен содержать массив диалогов")
        records = [r for r in all_custom if isinstance(r, dict) and r.get("origin") == group_id]
        expected = 10
    if not isinstance(records, list) or len(records) != expected:
        raise ExportError(f"{kind.upper()}: найдено {len(records) if isinstance(records, list) else '?'} диалогов, требуется {expected}. Сначала импортируйте правильный набор.")
    ids = [r.get("conversation_id") for r in records if isinstance(r, dict)]
    if (len(ids) != expected or any(not isinstance(x, str) or not x for x in ids)
            or len(set(ids)) != expected):
        raise ExportError("Есть пустые или повторяющиеся conversation_id в исходном наборе.")
    if any(not isinstance(r.get("transcript"), list) for r in records):
        raise ExportError("У одного из диалогов отсутствует массив transcript.")
    return records


def check_official_checklist(configuration: dict[str, Any]) -> None:
    """Do not silently submit a ninth test criterion or incorrect weights/scales."""
    criteria = configuration.get("criteria")
    if not isinstance(criteria, list) or len(criteria) != 8:
        raise ExportError("Для сдачи нужен чек-лист ровно из 8 критериев. Выберите исходный чек-лист в интерфейсе.")
    normalized = []
    for item in criteria:
        if not isinstance(item, dict):
            raise ExportError("Неверный формат критерия в чек-листе")
        canonical = ID_MAP.get(item.get("id"))
        if canonical is None:
            raise ExportError(f"Неподдерживаемый критерий: {str(item.get('id'))[:40]}")
        normalized.append(canonical)
        typ, weight, allow_na, scale = OFFICIAL_RULES[canonical]
        if (item.get("type") != typ or item.get("weight") != weight
                or item.get("allow_na") is not allow_na
                or (scale is not None and tuple(item.get("scale") or ()) != scale)):
            raise ExportError(f"Критерий {canonical}: тип, вес, N/A или шкала не соответствуют Appendix 1.0.")
    if set(normalized) != set(OFFICIAL_ORDER) or len(set(normalized)) != 8:
        raise ExportError("В чек-листе есть пропуск или дублирование обязательного критерия.")


def official_score(criteria: list[dict[str, Any]]) -> tuple[float | None, bool]:
    total = 0.0
    possible = 0
    critical = False
    for item in criteria:
        ident, value = item["criterion_id"], item["value"]
        typ, weight, _, scale = OFFICIAL_RULES[ident]
        if ident == "critical":
            critical = value
            continue
        if value is None:
            continue
        possible += weight
        if typ == "yes_no":
            total += weight if value else 0
        else:
            total += weight * value / scale[-1]
    return (round(total * 100 / possible + 1e-10, 2) if possible else None), critical


def convert_evaluation(result: dict[str, Any], record: dict[str, Any]) -> dict[str, Any]:
    cid = record["conversation_id"]
    if not isinstance(result, dict) or result.get("conversation_id") != cid:
        raise ExportError("ID сохранённой оценки не совпадает с диалогом")
    rows = result.get("criteria")
    if not isinstance(rows, list) or len(rows) != 8:
        raise ExportError("Оценка не содержит ровно 8 критериев")
    transformed = {}
    for row in rows:
        if not isinstance(row, dict):
            raise ExportError("Неверный формат строки оценки")
        ident = ID_MAP.get(row.get("id"))
        if ident is None or ident in transformed:
            raise ExportError("Неизвестный или повторный критерий в оценке")
        value = row.get("value")
        typ, _, allow_na, scale = OFFICIAL_RULES[ident]
        if value == "na":
            if not allow_na:
                raise ExportError(f"Недопустимое N/A для {ident}")
            official_value = None
        elif typ in ("yes_no", "flag"):
            if value not in ("yes", "no"):
                raise ExportError(f"Недопустимое Да/Нет для {ident}")
            official_value = value == "yes"
        else:
            if type(value) is not int or value not in scale:
                raise ExportError(f"Недопустимая числовая оценка для {ident}")
            official_value = value
        reason = row.get("reason")
        if not isinstance(reason, str) or not reason.strip():
            raise ExportError(f"Нет объяснения для {ident}")
        evidence = row.get("evidence_index")
        if type(evidence) is not int or evidence < 0 or evidence >= len(record["transcript"]):
            raise ExportError(f"Неверная реплика-доказательство для {ident}")
        transformed[ident] = {
            "criterion_id": ident,
            "value": official_value,
            "rationale": reason.strip(),
            "evidence_turns": [evidence + 1],  # Internal index starts at 0; appendix uses 1.
        }
    if set(transformed) != set(OFFICIAL_ORDER):
        raise ExportError("В результате не хватает обязательных критериев")
    ordered = [transformed[c] for c in OFFICIAL_ORDER]
    score, critical = official_score(ordered)
    saved_score = result.get("score")
    if score is None or type(saved_score) not in (int, float) or not math.isfinite(saved_score):
        raise ExportError("Не удалось вычислить числовой итог (проверьте применимость критериев)")
    if abs(score - saved_score) > 0.011:
        raise ExportError("Итоговый балл не совпадает с расчётом по официальным весам")
    if result.get("gross_violation") is not critical:
        raise ExportError("Флаг грубого нарушения не соответствует критерию critical")
    return {"conversation_id": cid, "status": "ok", "criteria": ordered,
            "score": {"final_score": score, "critical_flag": critical}}


def make_error(cid: str, explanation: str) -> dict[str, Any]:
    return {"conversation_id": cid, "status": "error", "criteria": [], "score": None,
            "error": explanation[:250]}


def verify_submission(document: dict[str, Any], records: list[dict[str, Any]]) -> tuple[int, int]:
    if (set(document) != {"schema_version", "team_name", "model", "results"}
            or document["schema_version"] != "1.0" or document["team_name"] != TEAM):
        raise ExportError("Неверный заголовок JSON")
    model = document["model"]
    if (not isinstance(model, dict) or set(model) != {"mode", "name"}
            or model["mode"] not in ("external_api", "local", "hybrid")
            or not isinstance(model["name"], str) or not model["name"]):
        raise ExportError("Неверное поле model")
    results = document["results"]
    ids = [r["conversation_id"] for r in records]
    if not isinstance(results, list) or len(results) != len(ids):
        raise ExportError("Неверное количество результатов")
    if [r.get("conversation_id") for r in results] != ids:
        raise ExportError("Пропущены, повторены или изменены ID диалогов")
    ok_count = err_count = 0
    for result, conversation in zip(results, records):
        if result.get("status") == "ok":
            if set(result) != {"conversation_id", "status", "criteria", "score"}:
                raise ExportError("В успешной записи есть лишние/недостающие поля")
            criteria = result["criteria"]
            if not isinstance(criteria, list) or len(criteria) != 8:
                raise ExportError("В успешной записи нужно 8 критериев")
            if [c.get("criterion_id") for c in criteria] != list(OFFICIAL_ORDER):
                raise ExportError("Неправильный порядок/ID критериев")
            for c in criteria:
                if set(c) != {"criterion_id", "value", "rationale", "evidence_turns"}:
                    raise ExportError("Неверные поля критерия")
                ident, value = c["criterion_id"], c["value"]
                typ, _, allow_na, scale = OFFICIAL_RULES[ident]
                if value is None and not allow_na:
                    raise ExportError("N/A недопустимо")
                if value is not None and ((typ in ("yes_no", "flag") and type(value) is not bool)
                                          or (typ == "scale" and (type(value) is not int or value not in scale))):
                    raise ExportError("Недопустимое значение критерия")
                if not isinstance(c["rationale"], str) or not c["rationale"].strip():
                    raise ExportError("Пустое объяснение")
                if (not isinstance(c["evidence_turns"], list)
                        or not c["evidence_turns"]
                        or any(type(x) is not int or x < 1 or x > len(conversation["transcript"])
                               for x in c["evidence_turns"])):
                    raise ExportError("Неверные номера реплик")
            computed, flagged = official_score(criteria)
            score = result["score"]
            if (not isinstance(score, dict) or set(score) != {"final_score", "critical_flag"}
                    or type(score["final_score"]) not in (int, float)
                    or not math.isfinite(score["final_score"])
                    or not 0 <= score["final_score"] <= 100
                    or abs(computed - score["final_score"]) > 0.011
                    or score["critical_flag"] is not flagged):
                raise ExportError("Итоговые баллы и флаг не прошли проверку")
            ok_count += 1
        elif result.get("status") == "error":
            if (set(result) != {"conversation_id", "status", "criteria", "score", "error"}
                    or result["criteria"] != [] or result["score"] is not None
                    or not isinstance(result["error"], str) or not result["error"].strip()):
                raise ExportError("Неверный формат записи с ошибкой")
            err_count += 1
        else:
            raise ExportError("Неизвестный статус результата")
    return ok_count, err_count


def safe_reason(exc: Exception) -> str:
    # Prevent leaking credentials, full URLs, raw transcript or model payloads.
    if isinstance(exc, ExportError):
        return str(exc)[:200]
    status = getattr(exc, "status_code", None)
    return f"Сбой оценки ({type(exc).__name__}" + (f", HTTP {status}" if status else "") + ")."


def export(kind: str, *, group_id: str | None = None, provider: str = "auto",
           delay: float = 3.0, retry_errors: bool = False, force: bool = False,
           only_validate: bool = False, max_new: int | None = None) -> dict[str, Any]:
    if provider not in ("auto", "groq", "gemini"):
        raise ExportError("Провайдер должен быть auto, groq или gemini")
    if max_new is not None and max_new < 1:
        raise ExportError("--max-new должен быть больше нуля")
    records = source_records(kind, group_id)
    record_digest = hashlib.sha256(json.dumps(records, ensure_ascii=False, sort_keys=True).encode("utf-8")).hexdigest()
    path = RESULTS / kind / "results.json"
    if only_validate:
        doc = read_json(path)
        ok, errors = verify_submission(doc, records)
        print(f"VALID: {path} | ok={ok}, error={errors}")
        return doc

    # Import only now, so 'validate' needs no AI setup or network.
    if str(ROOT) not in sys.path:
        sys.path.insert(0, str(ROOT))
    from dotenv import load_dotenv
    env_path = next((p for p in (ROOT / ".env", ROOT / ".env.txt") if p.exists()), None)
    if env_path:
        load_dotenv(env_path)
    from backend.quality import checklist
    from backend.ai import assess_one

    configuration = checklist()
    check_official_checklist(configuration)
    if kind == "dev" and any(str(r.get("channel", "")).strip().lower() == "voice call" for r in records):
        if os.getenv("CQA_ALLOW_REAL_CALLS", "false").strip().lower() != "true":
            raise ExportError("Для 5 реальных звонков требуется разрешение и CQA_ALLOW_REAL_CALLS=true в .env")
    # Never re-use a result from another dataset or another checklist revision.
    progress_path = DATA / f"cqa_export_{kind}_progress.json"
    checkpoint = {}
    if progress_path.exists():
        old = read_json(progress_path)
        if (isinstance(old, dict) and old.get("group_id") == (group_id or "DEV")
                and old.get("provider") == provider
                and old.get("checklist") == configuration
                and old.get("ids") == [r["conversation_id"] for r in records]
                and old.get("record_digest") == record_digest
                and isinstance(old.get("items"), dict)):
            checkpoint = old["items"]
    model_names: set[str] = set()
    output: list[dict[str, Any]] = []
    processed_new = 0
    for i, record in enumerate(records, 1):
        cid = record["conversation_id"]
        item = checkpoint.get(cid)
        reuse = (not force and isinstance(item, dict)
                 and (item.get("status") == "ok" or (item.get("status") == "error" and not retry_errors)))
        if reuse:
            row = item
            print(f"[{i}/{len(records)}] {cid}: сохранённый результат ({row['status']})")
        else:
            if max_new is not None and processed_new >= max_new:
                print(f"\nПробный запуск окончен. Новых оценок: {processed_new}. "
                      f"Прогресс сохранён в data/. Финальный results/{kind}/results.json "
                      "ещё не создавался/обновлялся.")
                return {"partial": True, "evaluated_new": processed_new}
            try:
                ai_result = assess_one(record, configuration, provider=provider, force=force)
                row = convert_evaluation(ai_result, record)
                model_name = str(ai_result.get("model", "")).strip()
                if model_name:
                    model_names.add(model_name)
                print(f"[{i}/{len(records)}] {cid}: OK, {row['score']['final_score']:.2f}/100")
            except Exception as exc:
                row = make_error(cid, safe_reason(exc))
                print(f"[{i}/{len(records)}] {cid}: ERROR ({row['error']})")
            checkpoint[cid] = row
            processed_new += 1
            write_json_atomic(progress_path, {
                "group_id": group_id or "DEV", "provider": provider,
                "checklist": configuration, "ids": [r["conversation_id"] for r in records],
                "record_digest": record_digest,
                "items": checkpoint,
            })
            if delay > 0 and i < len(records):
                time.sleep(delay)
        output.append(row)
    # Also include actual model names from local saved AI data, so caching is accurately represented.
    from backend.ai import saved_for_conversation
    for record, row in zip(records, output):
        if row["status"] != "ok":
            continue
        cached = saved_for_conversation(record["conversation_id"])
        for p in ("groq", "gemini"):
            result = cached.get(p)
            if isinstance(result, dict):
                try:
                    if convert_evaluation(result, record) == row:
                        name = result.get("model")
                        if isinstance(name, str) and name.strip():
                            model_names.add(name.strip())
                except ExportError:
                    pass
    if not model_names:
        # A file with only errors still must have model metadata.
        from backend.ai import get_model
        model_names = {get_model("groq") if provider == "auto" else get_model(provider)}
    document = {
        "schema_version": "1.0",
        "team_name": TEAM,
        "model": {"mode": "external_api", "name": ", ".join(sorted(model_names))},
        "results": output,
    }
    ok, errors = verify_submission(document, records)
    write_json_atomic(path, document)
    print(f"\nГотово: {path.relative_to(ROOT)} | записей={len(output)}, ok={ok}, error={errors}")
    if errors:
        print("Есть ошибки оценки. Для повтора только ошибок: --retry-errors")
    return document


def main() -> int:
    parser = argparse.ArgumentParser(description="Экспорт реальных оценок CQA в JSON Appendix 1.0")
    parser.add_argument("dataset", choices=("dev", "prod"))
    parser.add_argument("--group-id", help="Точный group_id организаторов, обязателен для prod")
    parser.add_argument("--provider", choices=("auto", "groq", "gemini"), default="auto")
    parser.add_argument("--delay", type=float, default=3.0, help="Пауза между AI-запросами, секунды")
    parser.add_argument("--retry-errors", action="store_true", help="Повторить только неудачные записи")
    parser.add_argument("--force", action="store_true", help="Переоценить всё заново (расход токенов)")
    parser.add_argument("--validate", action="store_true", help="Проверить готовый JSON без AI-запросов")
    parser.add_argument("--max-new", type=int, help="Пробно оценить только N новых диалогов, без финального JSON")
    args = parser.parse_args()
    try:
        export(args.dataset, group_id=args.group_id, provider=args.provider,
               delay=args.delay, retry_errors=args.retry_errors,
               force=args.force, only_validate=args.validate, max_new=args.max_new)
        return 0
    except ExportError as exc:
        print("ОШИБКА:", exc, file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

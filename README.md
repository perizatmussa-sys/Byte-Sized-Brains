# Byte-Sized-Brains — CQA Hackathon

Прототип Conversation Quality Analytics для Freedom Broker.

## Статус

**Этап 1:** загрузка DEV-диалогов из API и просмотр транскриптов на RU/KZ/EN.  
**Следующие этапы:** редактируемый чек-лист, AI-оценка, баллы/N/A/доказательства, апелляции и пересмотр.

> ВАЖНО: текущий этап не включает AI-оценку. Не выдавайте просмотр диалогов за готовое решение хакатона.

## Запуск на Windows (PowerShell)

Откройте терминал в папке репозитория:

```powershell
py -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
Copy-Item .env.example .env
```

Откройте `.env` в VS Code и вставьте **полную** GET-ссылку организаторов после `CQA_API_URL=`. 
Не делайте её публичной и не коммитьте файл `.env`.

Запустите приложение:

```powershell
python -m uvicorn backend.main:app --reload
```

Откройте http://127.0.0.1:8000/ и нажмите **Загрузить DEV из API**.

Ожидается 65 диалогов (35 RU / 15 KZ / 15 EN); 60 чатов и 5 звонков.

Проверка API: http://127.0.0.1:8000/docs

## Что хранится в GitHub

Исходный код и `.env.example` без секретов. Файлы `.env` и `data/dev_records.json`
в `.gitignore`, чтобы не раскрывать подписанный URL и содержимое диалогов.

## Проблемы

- `py` не найден: попробуйте `python -m venv .venv` или установите Python.
- Не удаётся активировать среду: откройте PowerShell и выполните
  `Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass`, затем повторите активацию.
- API выдаёт 401/403: возможно, ссылка просрочена или недействительна. Запросите её у организаторов.
- `CQA_API_URL` не настроен: проверьте `.env` и перезапустите сервер.
- Если вы видите ошибку HTTP 502, проверьте адрес API, интернет и формат ответа.

## Технологии

Python, FastAPI, Requests, HTML, CSS, JavaScript.

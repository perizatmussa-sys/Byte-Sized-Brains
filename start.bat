@echo off
rem Запуск CQA одним двойным щелчком (Windows).
rem Сам переходит в папку проекта, создаёт .venv, ставит пакеты и запускает сервер.
chcp 65001 >nul
cd /d "%~dp0"

if not exist "backend\main.py" (
  echo [!] Этот файл должен лежать в папке проекта рядом с папкой backend.
  goto :error
)

if not exist ".venv\Scripts\python.exe" (
  echo Создаём виртуальное окружение .venv ...
  python -m venv .venv || goto :error
)

echo Устанавливаем пакеты ...
".venv\Scripts\python.exe" -m pip install -q --disable-pip-version-check -r requirements.txt || goto :error

echo.
echo Откройте в браузере: http://127.0.0.1:8001
echo Чтобы остановить сервер, нажмите Ctrl+C.
echo.
".venv\Scripts\python.exe" -m uvicorn backend.main:app --reload --port 8001
goto :end

:error
echo.
echo [!] Что-то пошло не так. Сделайте скриншот текста выше.
:end
pause

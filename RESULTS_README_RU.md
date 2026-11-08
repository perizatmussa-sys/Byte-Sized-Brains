# Byte-Sized-Brains — официальный экспорт результатов CQA 1.0

Это независимый скрипт. Он **не заменяет** файлы сайта, AI-оценки и транскрипты.

## 1. Что будет создано

- `results/dev/results.json`: 65 исходных DEV-разговоров (60 чатов + 5 звонков).
- `results/prod/results.json`: 10 контрольных чатов выбранного `group_id`.

Один файл содержит **все** записи, включая ошибки AI, если они были. Не подменяем ошибки нулевой оценкой.

Внутренние ID текущего Python проекта автоматически переводятся в ID приложения:
`needs → discovery`, `identity → identification`, `clarity → dialogue`, `closing → closure`.
Внутренний `evidence_index` начинается с 0; для официального `evidence_turns` прибавляется 1.

## 2. Перед запуском

Из корня проекта:

```powershell
cd D:\Byte-Sized-Brains
.\.venv\Scripts\Activate.ps1
python -m unittest discover -s tests -v
```

Убедитесь, что `data/dev_records.json` содержит 65 записей. Файл `.env` содержит API-ключ(и) (не отправляйте их в Git).
Для пяти реальных звонков организаторы должны разрешить отправку во внешние AI-сервисы; тогда `CQA_ALLOW_REAL_CALLS=true`.

В **активном чек-листе** должны быть ровно восемь исходных критериев с весами и шкалами из Appendix.
Если вы создавали тестовый девятый критерий, выберите исходный чек-лист на сайте. Скрипт откажется экспортировать нестандартные критерии, а не подменит их.

## 3. DEV — сначала только 3 новых оценки

```powershell
python -m scripts.cqa_results_export dev --provider auto --max-new 3
```

Пробный запуск расходует токены только на новые оценки; у скрипта есть проверка существующих AI-кэшей. Прогресс сохраняется в `data/cqa_export_dev_progress.json`, он игнорируется Git.

Далее весь DEV:

```powershell
python -m scripts.cqa_results_export dev --provider auto
```

Скрипт последовательно оценивает оставшиеся диалоги (или использует подходящий AI-кэш), формирует официальный файл и проверяет его. Ошибки провайдеров записываются в формате `status=error`.

Повторить только ошибки:

```powershell
python -m scripts.cqa_results_export dev --provider auto --retry-errors
```

Проверить итог без токенов:

```powershell
python -m scripts.cqa_results_export dev --validate
```

Если не хотите автоматического переключения между моделями, выбирайте `--provider groq` или `--provider gemini`.

`--force` запускает **переоценку**, расходует токены и не нужен для обычной сдачи.

## 4. PROD — только после выдачи контрольного набора

1. Получите от организаторов точный `group_id` (пока его нет, не надо создавать PROD из DEV).
2. Импортируйте контрольный набор на сайте в разделе добавления своих диалогов: загрузка по `group_id`.
   В текущем backend это также `POST /api/import?group_id=...`.
3. Убедитесь, что импортированы **ровно 10** контрольных чатов. Скрипт использует только записи с `origin`, совпадающим с вашим `group_id`, и не возьмёт пользовательские тестовые диалоги.
4. Запустите:

```powershell
python -m scripts.cqa_results_export prod --group-id ТОЧНЫЙ_GROUP_ID --provider auto
python -m scripts.cqa_results_export prod --group-id ТОЧНЫЙ_GROUP_ID --validate
```

## 5. Git (обязательно до стоп-кода)

Выполнить из чистой, актуальной Git-ветки с правом записи:

```powershell
git status
git add scripts/cqa_results_export.py scripts/__init__.py tests/test_cqa_results_export.py RESULTS_README_RU.md
git commit -m "Add official CQA JSON results exporter"
git push origin HEAD
```

**Загрузите скрипт заранее**, до выдачи PROD. Финальные JSON с оценками добавляйте отдельно:

```powershell
git add results/dev/results.json results/prod/results.json
git commit -m "Submit DEV and PROD evaluations"
git push origin main
```

Если вы работаете в feature-ветке, слейте её в `main` *до стоп-кода*. Сдача считается готовой, только когда файлы есть в **открытом репозитории** по путям `results/dev/results.json` и `results/prod/results.json`.

## 6. Безопасность

Не коммитьте `.env`, `data/*.json`, сырые разговоры, запись звонков или ключи провайдеров. Только запрошенные организаторами результаты и код. Помните, что `rationale` выводится в публичном репозитории; не копируйте в него конфиденциальные личные данные.

## 7. Ограничения

Скрипт проверен на имитации текущего backend и 65 диалогов. Реальные API-вызовы с вашими ключами здесь не выполнялись. Проверяйте результаты AI вручную на выборке. Формат рассчитан на Appendix Results 1.0: при дальнейших изменениях спецификации нужно обновить проверку.

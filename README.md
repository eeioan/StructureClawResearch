# StructureClaw Research — сценарный бенчмарк LLM-агента в инженерном ПО

Тестовое задание T10: проверка LLM-агента [StructureClaw](https://github.com/structureclaw/structureclaw) (расчёт конструкций в OpenSees) на ферме 2.1 из вузовской методички, с поэтапной оценкой (9 шагов, контрольные точки CP0–CP2) и сравнением с фермами-близнецами из корпуса бенчмарка.

**Итоговый отчёт:** [ОтветТ10Чумаков_v2.md](ОтветТ10Чумаков_v2.md)

## Что где лежит

| Путь | Содержимое |
|---|---|
| `ОтветТ10Чумаков_v2.md` | финальный отчёт |
| `T10_тестовое.md` | формулировка задания |
| `Zadachi/` | исходные задачи (PDF), из которых отобрана ферма 2.1 |
| `custom_tasks/` | эталон (`build_truth.py`, `truth.json`), сценарии, поэтапный оценщик `staged_eval.py`, патч StructureClaw |
| `custom_bench/` | копия корпуса StructureClaw-Bench с раннером для своих сценариев |
| `run_bench.sh` | запуск одного сценария на локальной модели через Ollama |
| `ollama/` | прокси, отключающий thinking, и Modelfile |
| `tries/` | отчёты по каждому прогону, сводка `ALL_RUNS.md`, разбор `REVIEW.md` |
| `bench_runs/` | сырые логи и JSON прогонов; дамп обменов с моделью — `proxy_dump/exchanges.jsonl.gz` |
| `session_export/` | экспорт сессии работы с Claude Code |

## Воспроизведение

1. Склонировать `structureclaw` рядом с этой папкой и применить `custom_tasks/patches/structureclaw-truss-loads.patch`.
2. Построить эталон Python-окружением StructureClaw (`~/.structureclaw/.venv/Scripts/python.exe -I -X utf8 custom_tasks/build_truth.py`), затем `python -I -X utf8 custom_tasks/install.py`.
3. Сгенерировать самоподписанный сертификат для HTTPS-порта прокси (`ollama/localhost-cert.pem`, `ollama/localhost-key.pem`, в репозиторий не входят), запустить `python ollama/nothink_proxy.py`.
4. `./run_bench.sh ru-truss-7e97 gemma4:31b-cloud`

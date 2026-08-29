# Runbook: диагностика запуска и health endpoints

Статус: accepted  
Дата: 2026-08-30

## Быстрая проверка

```bash
curl -i http://localhost:5000/health/live
curl -i http://localhost:5000/health/ready
```

Ожидаемый результат для рабочего приложения — `200` на обоих endpoints. В каждом ответе должен присутствовать `x-correlation-id`; его можно передать явно для поиска записи в логах:

```bash
curl -i -H 'x-correlation-id: startup-check' http://localhost:5000/health/ready
```

## Интерпретация отказов

- `health/live` возвращает `503` или не отвечает: процесс не запущен, завис или недоступен порт. Проверить `docker compose logs backend` и состояние контейнера.
- `health/live` отвечает `200`, а `health/ready` возвращает `503`: процесс жив, но критичная зависимость не прошла `check()`. Найти failed check по безопасному имени в response и логах, затем проверить доступность зависимости и credentials через secret storage.
- приложение завершается до открытия порта: проверить `NODE_ENV`, `PORT` и `SERVICE_NAME`. Ошибка валидации конфигурации является ожидаемым fail-fast поведением.

## Безопасность

Не добавлять в response или logs значения env, connection strings, токены и тексты исключений зависимостей. При расследовании сохранять correlation ID, timestamp и имя failed check. После исправления зависимости повторить readiness-запрос и убедиться, что liveness не использует инфраструктурные вызовы.

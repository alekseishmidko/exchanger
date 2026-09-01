# ADR 0004: Price-time priority в matching engine

Статус: accepted  
Дата: 2026-09-02

## Контекст

Лимитный стакан должен быть справедливым, воспроизводимым при replay и независимым от сетевых/DB задержек. Произвольный порядок заявок приводит к недетерминированному исполнению и невозможности проверить golden fixtures.

## Решение

Используется price-time priority: лучшая цена имеет приоритет, а заявки на одном price level обслуживаются FIFO по monotonic sequence. Сделка исполняется по passive maker price. Все события получают sequence текущей команды и возвращаются в стабильном порядке.

## Последствия

Правило прозрачно и детерминировано, но текущая reference implementation сортирует active opposite orders (`O(n log n)`). Перед production load profile ordered tree может снизить стоимость выбора уровня без изменения контракта и replay semantics.

## Проверка

Покрыты multi-level, same-price FIFO, exact/partial/full fill, market, IOC/FOK, cancel, self-trade, property-based replay и local benchmark scenarios.

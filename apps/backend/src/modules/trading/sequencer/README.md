# Trading sequencer

Sequencer владеет routing команд по `instrumentId` и проверяет, что команду отправляет единственный partition owner. Каждая instrument partition имеет независимый monotonic sequence.

Команда с gap, неверным owner или отсутствующей partition отклоняется до state transition. Повторный `commandId` возвращает сохранённый результат без повторного вызова transition.

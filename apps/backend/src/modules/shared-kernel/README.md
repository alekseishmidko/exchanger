# Shared kernel

Typed IDs, `Decimal` и `Money` остаются чистыми deterministic value objects без
DI, I/O и operational logging. Success/failure фиксирует вызывающая application
boundary (`ledger`, `matching`, `settlement`), поскольку логирование внутри
арифметической операции создало бы hot-path overhead и могло раскрыть финансовые
значения. Поэтому собственных log events у shared-kernel намеренно нет.

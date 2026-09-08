import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Instrument, InstrumentRules, InstrumentStatus } from './instrument';

/** Публичный immutable snapshot инструмента, безопасный для transport mapping. */
export type InstrumentSnapshot = Readonly<{
  id: string;
  baseAssetId: string;
  quoteAssetId: string;
  status: InstrumentStatus;
  rules: readonly InstrumentRules[];
}>;

/**
 * Application port каталога торговых инструментов.
 *
 * Контроллеры получают только snapshots, а административный сервис передаёт
 * сюда уже проверенные domain-команды. Благодаря этому transport-слой не может
 * вызвать `activate`, `pause` или `addRules` в обход authorization, dual control
 * и audit boundary.
 */
export interface InstrumentCatalogPort {
  /** Регистрирует новый инструмент с неизменяемой начальной версией правил. */
  register(instrument: Instrument): void;
  /** Добавляет следующую версию правил существующего инструмента. */
  addRules(instrumentId: string, rules: InstrumentRules): void;
  /** Изменяет lifecycle после применения авторизованной admin-команды. */
  setStatus(instrumentId: string, status: InstrumentStatus): void;
  /** Возвращает один публичный snapshot или безопасную ошибку 404. */
  get(instrumentId: string): InstrumentSnapshot;
  /** Возвращает детерминированно отсортированный каталог snapshots. */
  list(): readonly InstrumentSnapshot[];
}

/**
 * In-memory adapter каталога для development и автоматических тестов.
 *
 * Map содержит domain aggregates только внутри application boundary. Каждый
 * read создаёт новый объект и новый массив правил, поэтому HTTP-клиент не может
 * мутировать сохранённый `Instrument` через ссылку из ответа.
 */
@Injectable()
export class InstrumentCatalogService implements InstrumentCatalogPort {
  private readonly instruments = new Map<string, Instrument>();

  /** Регистрирует инструмент и запрещает неявную перезапись существующего ID. */
  register(instrument: Instrument): void {
    if (this.instruments.has(instrument.id)) {
      throw new ConflictException({
        code: 'INSTRUMENT_ALREADY_EXISTS',
        message: 'Instrument already exists',
      });
    }
    this.instruments.set(instrument.id, instrument);
  }

  /** Делегирует проверку версии и effectiveAt самому domain aggregate. */
  addRules(instrumentId: string, rules: InstrumentRules): void {
    this.requireInstrument(instrumentId).addRules(rules);
  }

  /** Применяет только два допустимых lifecycle-перехода. */
  setStatus(instrumentId: string, status: InstrumentStatus): void {
    const instrument = this.requireInstrument(instrumentId);
    if (status === 'ACTIVE') instrument.activate();
    else instrument.pause();
  }

  /** Возвращает сериализуемый snapshot без методов domain aggregate. */
  get(instrumentId: string): InstrumentSnapshot {
    return this.snapshot(this.requireInstrument(instrumentId));
  }

  /** Сортирует по ID, чтобы одинаковое состояние давало одинаковый HTTP-ответ. */
  list(): readonly InstrumentSnapshot[] {
    return [...this.instruments.values()]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((instrument) => this.snapshot(instrument));
  }

  /** Находит aggregate внутри boundary и не раскрывает внутреннюю структуру Map. */
  private requireInstrument(instrumentId: string): Instrument {
    const instrument = this.instruments.get(instrumentId);
    if (!instrument) {
      throw new NotFoundException({
        code: 'INSTRUMENT_NOT_FOUND',
        message: 'Instrument was not found',
      });
    }
    return instrument;
  }

  /** Преобразует domain aggregate в detached application snapshot. */
  private snapshot(instrument: Instrument): InstrumentSnapshot {
    return {
      id: instrument.id,
      baseAssetId: instrument.baseAssetId,
      quoteAssetId: instrument.quoteAssetId,
      status: instrument.getStatus(),
      rules: [...instrument.getRulesHistory()],
    };
  }
}

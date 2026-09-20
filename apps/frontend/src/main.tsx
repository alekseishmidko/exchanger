import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

/**
 * Точка входа React-приложения ручного тестирования.
 *
 * StrictMode оставлен включённым, чтобы в dev-режиме быстрее замечать
 * небезопасные side effects в компонентах панели. Все реальные HTTP-команды
 * выполняются только из обработчиков кнопок, поэтому двойной render не создаёт
 * повторных биржевых эффектов.
 */
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

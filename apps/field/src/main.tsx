import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
// i18next first: the first render already speaks the resolved language (D9).
import './i18n/i18n';
import { App } from './App';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

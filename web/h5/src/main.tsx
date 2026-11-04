import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { copy } from './lib/copy';
import './styles/tokens.css';
import './styles/app.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error(copy.debug.rootMountError);
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

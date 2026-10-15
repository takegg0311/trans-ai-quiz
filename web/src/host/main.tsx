import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { CloudGate } from './CloudGate';
import '../styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <CloudGate />
  </StrictMode>,
);

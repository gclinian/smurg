// FIRST import, on purpose: moves an invite fragment out of the address bar before any other module runs
// (ARCHITECTURE §4.1). Do not put anything above it.
import './boot/capture-invite.ts';
// SECOND import: the language of this browser, before the string catalogue and any component is evaluated.
import './boot/locale.ts';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './strings/index.ts';
import './ui/tokens.css';
import './ui/base.css';
import './ui/components.css';
import './app/app.css';
import { App } from './app/App.tsx';
import { createBrowserServices } from './app/services.tsx';

const container = document.getElementById('root');
if (!container) throw new Error('#root element missing from index.html');

const services = createBrowserServices();
createRoot(container).render(
  <StrictMode>
    <App services={services} />
  </StrictMode>,
);

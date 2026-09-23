import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import brand from '@brand/brand.json';
import App from './App';
import './styles.css';

// Brand tokens from zehnora/brand/brand.json become CSS variables (light + dark).
const root = document.documentElement;
const toVars = (colors: Record<string, string>) =>
  Object.entries(colors).map(([k, v]) => `--${k.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())}: ${v};`).join('');
const style = document.createElement('style');
style.textContent = `:root{${toVars(brand.colors)}} @media (prefers-color-scheme: dark){:root{${toVars(brand.darkColors)}}}`;
document.head.appendChild(style);
root.lang = 'en';
document.title = `${brand.productName} Console`;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);

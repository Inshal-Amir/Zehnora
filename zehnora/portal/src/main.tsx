import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import brand from '@brand/brand.json';
import App from './App';
import '@fontsource-variable/inter';
import './styles.css';

document.documentElement.lang = 'en';
document.title = `${brand.productName} Console`;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);

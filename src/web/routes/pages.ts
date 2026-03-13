import { Hono } from 'hono';
import { readFileSync } from 'fs';
import { join } from 'path';

const pages = new Hono();

const viewsDir = join(import.meta.dirname, '..', 'views');

function loadLayout(): string {
  return readFileSync(join(viewsDir, 'layout.html'), 'utf-8');
}

function renderPage(pageName: string): string {
  const layout = loadLayout();
  const content = readFileSync(join(viewsDir, `${pageName}.html`), 'utf-8');
  return layout.replace('{{content}}', content).replaceAll('{{page}}', pageName);
}

pages.get('/', (c) => {
  return c.html(renderPage('dashboard'));
});

pages.get('/data', (c) => {
  return c.html(renderPage('data'));
});

pages.get('/history', (c) => {
  return c.html(renderPage('history'));
});

pages.get('/settings', (c) => {
  return c.html(renderPage('settings'));
});

export { pages };

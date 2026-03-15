import { Hono } from 'hono';
import { readFileSync } from 'fs';
import { join } from 'path';

const pages = new Hono();

const viewsDir = join(import.meta.dirname, '..', 'views');

function loadLayout(): string {
  return readFileSync(join(viewsDir, 'layout.html'), 'utf-8');
}

function renderPage(pageName: string, userEmail: string = ''): string {
  const layout = loadLayout();
  const content = readFileSync(join(viewsDir, `${pageName}.html`), 'utf-8');
  return layout
    .replace('{{content}}', content)
    .replaceAll('{{page}}', pageName)
    .replaceAll('{{userEmail}}', userEmail);
}

pages.get('/', (c) => {
  const user = c.get('user' as any) as any;
  return c.html(renderPage('dashboard', user?.email || ''));
});

pages.get('/data', (c) => {
  const user = c.get('user' as any) as any;
  return c.html(renderPage('data', user?.email || ''));
});

pages.get('/history', (c) => {
  const user = c.get('user' as any) as any;
  return c.html(renderPage('history', user?.email || ''));
});

pages.get('/settings', (c) => {
  const user = c.get('user' as any) as any;
  return c.html(renderPage('settings', user?.email || ''));
});

export { pages };

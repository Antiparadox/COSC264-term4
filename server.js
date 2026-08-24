import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');

const app = express();
app.disable('x-powered-by');

// Only public/ is ever served. Course source material (PDFs, PPTX) lives
// outside it and is therefore unreachable, not merely unlinked.
app.use(express.static(PUBLIC, {
  extensions: ['html'],
  setHeaders(res, filePath) {
    // Decks are large but change often while they're being written, so let
    // the browser cache them and revalidate via ETag rather than refetch.
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
  },
}));

app.get('/healthz', (_req, res) => res.type('text/plain').send('ok'));

app.use((_req, res) => {
  res.status(404).type('html').send(
    '<!doctype html><meta charset="utf-8">' +
    '<title>Not found · COSC264</title>' +
    '<style>body{font:17px/1.6 system-ui,sans-serif;max-width:32rem;margin:18vh auto;padding:0 1.5rem;' +
    'background:#eef1f4;color:#15242f}a{color:#0f8f83}' +
    '@media(prefers-color-scheme:dark){body{background:#0d151b;color:#e6edf2}a{color:#3fb8aa}}</style>' +
    '<h1>Page not found</h1><p><a href="/">Back to the lecture slides</a></p>'
  );
});

app.listen(PORT, () => console.log(`COSC264 site listening on :${PORT}`));

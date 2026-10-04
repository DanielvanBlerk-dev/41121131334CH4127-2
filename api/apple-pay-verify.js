// Serves the Apple Pay domain-verification file as an exact-length, uncompressed download.
// The file lives at data/apple-domain-association.txt (bundled via vercel.json "includeFiles").
import fs from 'fs';
import path from 'path';

export default function handler(req, res) {
  try {
    const file = path.join(process.cwd(), 'data', 'apple-domain-association.txt');
    const body = Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'utf8');
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', 'attachment; filename="apple-developer-merchantid-domain-association"');
    res.setHeader('Content-Length', String(body.length));
    res.setHeader('Content-Encoding', 'identity');
    res.setHeader('Cache-Control', 'public, max-age=300, no-transform');
    res.status(200).end(body);
  } catch (e) {
    res.status(404).end('Not found');
  }
}

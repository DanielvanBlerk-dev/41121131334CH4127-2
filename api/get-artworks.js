import { Redis } from '@upstash/redis';

const redis = new Redis({
  url:   process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const DEFAULT_ARTWORKS = [
  {
    id: 1, category: 'figurative', title: 'Still Life with Lemons', medium: 'Oil on linen · 50 × 60 cm', price: 1800, sold: false,
    shipping: { weight: 3.0, length: 65, width: 55, height: 8 },
    svg: '<svg viewBox="0 0 300 400" xmlns="http://www.w3.org/2000/svg"><rect width="300" height="400" fill="#f0ebe0"/><rect x="0" y="280" width="300" height="120" fill="#d4c9b0"/><ellipse cx="110" cy="265" rx="48" ry="22" fill="#c8a820" opacity="0.9"/><ellipse cx="190" cy="270" rx="42" ry="19" fill="#d4b422"/><ellipse cx="150" cy="258" rx="36" ry="16" fill="#e8c830"/><rect x="80" y="100" width="140" height="165" rx="2" fill="#9b8870" opacity="0.3"/><path d="M120 180 Q150 140 180 180" stroke="#7a6050" fill="none" stroke-width="1.5"/><circle cx="90" cy="80" r="8" fill="#8fb050" opacity="0.6"/><circle cx="200" cy="90" r="6" fill="#7a9840" opacity="0.5"/></svg>'
  },
  {
    id: 2, category: 'seascape', title: 'Coastal Morning', medium: 'Oil on board · 30 × 40 cm', price: 950, sold: false,
    shipping: { weight: 2.0, length: 45, width: 35, height: 6 },
    svg: '<svg viewBox="0 0 300 400" xmlns="http://www.w3.org/2000/svg"><rect width="300" height="400" fill="#e8eef5"/><rect y="0" width="300" height="220" fill="#c8d8e8"/><rect y="220" width="300" height="60" fill="#b8c8d8"/><rect y="280" width="300" height="120" fill="#d4c8a8"/><ellipse cx="150" cy="80" rx="60" ry="40" fill="#f5f0e8" opacity="0.7"/><path d="M0 250 Q75 235 150 248 Q225 260 300 245" stroke="#8a9ab0" fill="none" stroke-width="1.5" opacity="0.6"/></svg>'
  },
  {
    id: 3, category: 'figurative', title: 'Interior, Late Afternoon', medium: 'Acrylic on linen · 60 × 80 cm', price: 2400, sold: false,
    shipping: { weight: 4.0, length: 90, width: 70, height: 10 },
    svg: '<svg viewBox="0 0 300 400" xmlns="http://www.w3.org/2000/svg"><rect width="300" height="400" fill="#e8dcc8"/><rect x="160" y="40" width="100" height="250" fill="#f5e8c0" opacity="0.8"/><rect x="0" y="0" width="160" height="300" fill="#c8b898" opacity="0.4"/><rect x="60" y="180" width="80" height="120" rx="2" fill="#6a5840" opacity="0.3"/><rect x="40" y="300" width="220" height="100" fill="#a89878"/><circle cx="80" cy="160" r="30" fill="#d4a840" opacity="0.4"/></svg>'
  },
  {
    id: 4, category: 'figurative', title: 'Portrait Study No. 7', medium: 'Oil on board · 25 × 35 cm', price: 1200, sold: true,
    shipping: { weight: 1.5, length: 40, width: 30, height: 6 },
    svg: '<svg viewBox="0 0 300 400" xmlns="http://www.w3.org/2000/svg"><rect width="300" height="400" fill="#e0d4c8"/><rect x="50" y="50" width="200" height="300" fill="#c8b8a8" opacity="0.4"/><ellipse cx="150" cy="160" rx="55" ry="65" fill="#d4a888" opacity="0.9"/><ellipse cx="150" cy="100" rx="40" ry="45" fill="#c09878"/><path d="M120 165 Q150 180 180 165" stroke="#8a6858" fill="none" stroke-width="1.5"/></svg>'
  },
  {
    id: 5, category: 'seascape', title: 'Garden at Dusk', medium: 'Oil on linen · 70 × 90 cm', price: 3200, sold: false,
    shipping: { weight: 5.0, length: 100, width: 80, height: 12 },
    svg: '<svg viewBox="0 0 300 400" xmlns="http://www.w3.org/2000/svg"><rect width="300" height="400" fill="#2a2040"/><rect y="250" width="300" height="150" fill="#3a3428" opacity="0.9"/><circle cx="200" cy="80" r="35" fill="#d4901c" opacity="0.5"/><ellipse cx="80" cy="240" rx="45" ry="80" fill="#2a4820" opacity="0.8"/><ellipse cx="220" cy="230" rx="35" ry="65" fill="#1e3818" opacity="0.8"/></svg>'
  },
  {
    id: 6, category: 'figurative', title: 'The White Jug', medium: 'Oil on board · 20 × 25 cm', price: 680, sold: false,
    shipping: { weight: 1.0, length: 35, width: 30, height: 6 },
    svg: '<svg viewBox="0 0 300 400" xmlns="http://www.w3.org/2000/svg"><rect width="300" height="400" fill="#e8e4dc"/><rect y="280" width="300" height="120" fill="#d0ccc4"/><path d="M120 280 Q110 200 120 140 Q130 100 150 100 Q170 100 180 140 Q190 200 180 280Z" fill="#f5f3ef"/><path d="M180 160 Q210 155 205 175 Q200 195 180 185" fill="#f5f3ef"/><ellipse cx="150" cy="280" rx="32" ry="8" fill="#c8c4bc"/></svg>'
  },
];

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  try {
    let artworks = await redis.get('artworks');
    if (!artworks || artworks.length === 0) {
      artworks = DEFAULT_ARTWORKS;
      await redis.set('artworks', artworks);
    }

    // Strip imgData (base64) from every artwork before sending to browser.
    // The browser only needs imgUrl (CDN URL) or svg (placeholder).
    // This keeps the response payload tiny — the key performance fix.
    // Legacy artworks that only have imgData will show their SVG placeholder
    // until Michael re-uploads them, at which point they get a Blob URL.
    const artworksClean = artworks.map(a => ({
      ...a,
      imgData: undefined, // never send base64 over the wire
    }));

    // Artist photo — try new Blob URL key first, fall back to legacy base64 key
    const artistPhotoUrl = await redis.get('artist-photo-url') || null;
    const artistPhotoLegacy = !artistPhotoUrl ? (await redis.get('artist-photo') || null) : null;
    const artistPhoto = artistPhotoUrl || artistPhotoLegacy;

    return res.status(200).json({ artworks: artworksClean, artistPhoto });
  } catch (err) {
    console.error('get-artworks error:', err);
    return res.status(200).json({ artworks: DEFAULT_ARTWORKS, artistPhoto: null });
  }
}

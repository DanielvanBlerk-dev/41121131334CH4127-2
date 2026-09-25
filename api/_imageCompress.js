import sharp from 'sharp';

/**
 * Resizes + re-encodes an uploaded image according to the admin's current
 * image settings (see _imageSettings.js). Used by every route that puts a
 * photo into Vercel Blob storage — upload-image.js, update-artist-photo.js,
 * and the Gelato-preview import in paintings.js — so they all produce the
 * same, predictably-sized files. This is the fix for Vercel Blob's "Data
 * Transfer" usage: that quota is billed on the actual bytes served to
 * visitors, so shrinking what gets stored in the first place is what
 * actually moves the number, unlike caching (which doesn't).
 *
 * Deliberately conservative about what it changes:
 *   - Never upscales — an image already smaller than maxDimension is left
 *     at its original resolution, only re-compressed.
 *   - Animated GIFs are passed through completely untouched. Sharp would
 *     otherwise flatten an animated GIF to its first frame, silently
 *     breaking any animated photo — not a trade-off worth making for a
 *     format barely used here anyway.
 *   - A PNG with an alpha channel (transparency) is re-encoded as PNG, not
 *     JPEG, so the transparency survives. A PNG without one — the normal
 *     case for a flattened photo of a painting — is converted to JPEG,
 *     since JPEG is meaningfully smaller than PNG at equivalent visual
 *     quality for photographic content.
 *   - JPEG and WEBP inputs are re-encoded in their own format.
 *   - If a re-encode somehow comes out larger than the original (can
 *     happen with a tiny or already-optimised source), the original is
 *     kept instead — compression that makes a file bigger isn't
 *     compression.
 *
 * @param {string} imgData - base64 data URI. The caller is expected to
 *   have already run this through _imageValidator.js (magic bytes, size
 *   cap, SVG block) — this function does not re-validate, only transforms.
 * @param {{ maxDimension: number, quality: number }} settings
 * @returns {Promise<
 *   { ok: true, buffer: Buffer, mimeType: string, ext: string,
 *     originalBytes: number, finalBytes: number, skipped?: string } |
 *   { ok: false, error: string }
 * >}
 */
export async function compressImage(imgData, settings) {
  try {
    const base64         = imgData.includes(',') ? imgData.split(',')[1] : imgData;
    const input           = Buffer.from(base64, 'base64');
    const originalBytes   = input.length;

    const mimeMatch = imgData.match(/^data:([^;]+);base64,/);
    const mimeType  = mimeMatch ? mimeMatch[1] : 'image/jpeg';

    // Animated GIF — pass through untouched (see doc comment above).
    if (mimeType === 'image/gif') {
      return {
        ok: true, buffer: input, mimeType: 'image/gif', ext: 'gif',
        originalBytes, finalBytes: originalBytes,
        skipped: 'GIF — stored as-is to preserve animation',
      };
    }

    const pipeline = sharp(input, { failOn: 'none' });
    const metadata = await pipeline.metadata();

    const resized = pipeline.resize({
      width:              settings.maxDimension,
      height:             settings.maxDimension,
      fit:                'inside',
      withoutEnlargement: true,
    });

    const hasAlpha = !!metadata.hasAlpha;
    let outBuffer, outMime, outExt;

    if (mimeType === 'image/png' && hasAlpha) {
      outBuffer = await resized.png({ quality: settings.quality, compressionLevel: 9 }).toBuffer();
      outMime = 'image/png'; outExt = 'png';
    } else if (mimeType === 'image/webp') {
      outBuffer = await resized.webp({ quality: settings.quality }).toBuffer();
      outMime = 'image/webp'; outExt = 'webp';
    } else {
      // JPEG, a flattened (non-transparent) PNG, or anything else
      // photographic — JPEG output. flatten() is a no-op when there's no
      // alpha channel to begin with, so this is safe either way.
      outBuffer = await resized
        .flatten({ background: '#ffffff' })
        .jpeg({ quality: settings.quality, mozjpeg: true })
        .toBuffer();
      outMime = 'image/jpeg'; outExt = 'jpg';
    }

    if (outBuffer.length >= originalBytes) {
      return {
        ok: true, buffer: input, mimeType, ext: (mimeType.split('/')[1] || 'jpg'),
        originalBytes, finalBytes: originalBytes,
        skipped: 'already smaller than the recompressed version',
      };
    }

    return { ok: true, buffer: outBuffer, mimeType: outMime, ext: outExt, originalBytes, finalBytes: outBuffer.length };

  } catch (err) {
    console.error('Image compression failed:', err);
    return { ok: false, error: err.message || 'Compression failed.' };
  }
}

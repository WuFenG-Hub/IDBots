/**
 * Avatar file → data-URL pipeline for the mobile edit form (A5).
 *
 * Browser-only (canvas): the pure geometry lives in a2aLimits.fitInside and
 * is unit-tested separately; this module only wires File → <img> → canvas →
 * `data:image/png` URL, capped at 256×256 like the desktop's avatar flow so
 * the metabots.avatar BLOB stays small.
 */
import { fitInside } from './a2aLimits';

export const AVATAR_MAX_EDGE = 256;

export async function fileToAvatarDataUrl(file: File): Promise<string> {
  const objectUrl = URL.createObjectURL(file);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error('avatar decode failed'));
      element.src = objectUrl;
    });
    const { width, height } = fitInside(image.naturalWidth || AVATAR_MAX_EDGE, image.naturalHeight || AVATAR_MAX_EDGE, AVATAR_MAX_EDGE);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('canvas unavailable');
    context.drawImage(image, 0, 0, width, height);
    return canvas.toDataURL('image/png');
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

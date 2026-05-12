export function sanitizeString(str) {
  if (!str || typeof str !== 'string') return '';

  // Remove script/iframe tags entirely
  str = str.replace(/<\s*script.*?>.*?<\s*\/\s*script>/gi, '');
  str = str.replace(/<\s*iframe.*?>.*?<\s*\/\s*iframe>/gi, '');

  // Remove on* event attributes (onload, onclick, etc.)
  str = str.replace(/on\w+="[^"]*"/gi, '');
  str = str.replace(/on\w+='[^']*'/gi, '');

  // Escape & < > " — & must come first to avoid double-escaping
  str = str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  return str.trim();
}

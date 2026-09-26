/**
 * Texto para el sintetizador de la tablet. Las preguntas del servicio están
 * escritas para Slack (mrkdwn, enlaces, emojis, ramas con timestamp); leídas
 * tal cual suenan fatal.
 */

/** Quita el formato de Slack y deja texto plano legible en pantalla. */
export function plain(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/<@[A-Z0-9]+(?:\|([^>]+))?>/g, (_m, name: string | undefined) => name ?? '')
    .replace(/<(https?:[^|>]+)\|([^>]+)>/g, '$2')
    .replace(/<https?:[^>]+>/g, '')
    .replace(/:[a-z0-9_+-]+:/g, '')
    .replace(/(^|[\s(])[*_~]+([^*_~\n]+?)[*_~]+(?=[\s).,:;!?]|$)/g, '$1$2')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Texto para decir en voz alta: plano, claves deletreadas, sin URLs ni ramas con timestamp. */
export function toSpeech(text: string, maxChars = 420): string {
  let s = plain(text)
    .replace(/https?:\/\/\S+/g, '')
    // Ramas del fix: bugfix/AN-1234-20260918-192250 no aporta nada dicho en voz alta.
    .replace(/\b(?:bug)?fix\/[\w.-]+/gi, 'la rama del fix')
    // Claves de Jira letra a letra: "AN-1234" → "A N 1234".
    .replace(/\b([A-Z]{1,6})-(\d+)\b/g, (_m, p: string, n: string) => `${p.split('').join(' ')} ${n}`)
    .replace(/\b([a-z]+)\/([\w.-]+)/g, '$1 $2')
    .replace(/\s*\n+\s*(\d+\.\s*)?/g, '. ')
    .replace(/\.\s*\./g, '.')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (s.length > maxChars) {
    const cut = s.slice(0, maxChars);
    const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '));
    s = `${end > maxChars / 2 ? cut.slice(0, end + 1) : cut}… El resto está en pantalla.`;
  }
  return s;
}

/** "AN-1234" → "A N 1234" (para frases compuestas aquí). */
export function spell(key: string): string {
  return toSpeech(key);
}

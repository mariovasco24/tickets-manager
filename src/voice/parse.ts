/**
 * Interpretación de lo que el reconocedor de voz de la tablet transcribe. Todo
 * es puro (sin E/S) para poder probarlo con frases reales: el reconocedor
 * escribe "AN 1234", "a ene 1.234" o "el ticket an-1234" según el día.
 */

export interface TicketParseOptions {
  /** Proyecto por defecto cuando solo se dice el número. */
  defaultProject: string;
  /** Claves de proyecto conocidas (AN, QA…), para desambiguar letras deletreadas. */
  projects: string[];
}

export interface SpokenTicket {
  key: string;
  /** El proyecto no se entendió y se asumió el de por defecto: hay que decirlo en la respuesta. */
  assumedProject: boolean;
}

export type VoiceIntent =
  | { type: 'fix'; ticket: SpokenTicket; branch?: string; notes?: string }
  | { type: 'status' }
  | { type: 'yes' }
  | { type: 'no' }
  | { type: 'option'; index: number }
  | { type: 'discard'; ticket?: SpokenTicket }
  | { type: 'message'; text: string }
  | { type: 'code_only' }
  | { type: 'retry' }
  | { type: 'repeat' }
  | { type: 'cancel' }
  | { type: 'help' }
  | { type: 'text'; text: string };

/**
 * Minúsculas y sin tildes, conservando la longitud: cada índice del resultado
 * corresponde al mismo carácter del original, así las notas se recortan del
 * texto original con sus tildes.
 */
export function fold(text: string): string {
  let out = '';
  for (const ch of text) {
    const base = ch.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    out += base.length === ch.length ? base : ch.toLowerCase();
  }
  return out;
}

/** Letras deletreadas en español ("a ene" → AN). */
const LETTER_NAMES: Record<string, string> = {
  a: 'A', be: 'B', ce: 'C', de: 'D', e: 'E', efe: 'F', ge: 'G', hache: 'H', i: 'I', jota: 'J',
  ka: 'K', ele: 'L', eme: 'M', ene: 'N', o: 'O', pe: 'P', cu: 'Q', erre: 'R', ere: 'R', ese: 'S',
  te: 'T', u: 'U', uve: 'V', ve: 'V', equis: 'X', ye: 'Y', zeta: 'Z', zeda: 'Z',
};

/** Palabras que pueden ir entre el verbo y la clave y nunca son parte del proyecto. */
const FILLER = new Set([
  'el', 'la', 'los', 'las', 'un', 'una', 'de', 'del', 'al', 'ticket', 'tiquet', 'tique', 'tickets', 'numero', 'num',
  'bug', 'issue', 'jira', 'caso', 'incidencia', 'tarea', 'guion', 'y', 'por', 'favor', 'me', 'nos', 'porfa',
]);

/** Palabras cortas que pueden ir justo antes del número y nunca son un proyecto. */
const NOT_PROJECT = new Set([
  'fix', 'haz', 'hazme', 'mira', 'ver', 've', 'dale', 'oye', 'da', 'bot', 'dame', 'este', 'esta', 'eso', 'para', 'pero',
  'solo', 'que', 'con', 'sin', 'mas', 'ya', 'hay', 'son', 'es', 'no', 'si', 'mi', 'tu', 'su', 'lo', 'le', 'se', 'en',
  'otro', 'otra', 'ahora', 'este', 'nuevo', 'arregla', 'revisa', 'corrige',
]);

const NUMBER_WORDS: Record<string, number> = {
  uno: 1, una: 1, primero: 1, primera: 1, dos: 2, segundo: 2, segunda: 2, tres: 3, tercero: 3, tercera: 3,
  cuatro: 4, cuarto: 4, cuarta: 4, cinco: 5, quinto: 5, quinta: 5, seis: 6, sexto: 6, sexta: 6,
  siete: 7, septimo: 7, septima: 7, ocho: 8, octavo: 8, octava: 8, nueve: 9, noveno: 9, novena: 9, diez: 10,
};

/**
 * Busca una clave de Jira dicha en voz alta. Admite "AN-1234", "an 1234",
 * "a n 1234", "a ene 1.234" y solo "1234" (proyecto por defecto).
 */
export function parseSpokenTicket(text: string, opts: TicketParseOptions): SpokenTicket | undefined {
  // "1.234" / "1,234" son separadores de miles del reconocedor, no parte de la clave.
  const t = numberWordsToDigits(fold(text))
    .replace(/(\d)[.,](?=\d{3}\b)/g, '$1')
    // Google suele pegar la clave: "AN1234" → "an 1234".
    .replace(/([a-z])(\d)/g, '$1 $2')
    // Dígitos dictados sueltos: "1 2 3 4" → "1234".
    .replace(/\d+(?:\s+\d+)+/g, (m) => m.replace(/\s+/g, ''));
  const known = new Set(opts.projects.map((p) => p.toUpperCase()));

  // Forma escrita directa: XYZ-123 / XYZ 123 con un proyecto conocido, o cualquier XYZ-123 con guion.
  for (const m of t.matchAll(/\b([a-z][a-z0-9_]{0,9})\s*-?\s*(\d{1,6})\b/g)) {
    const project = m[1]!.toUpperCase();
    // Con guion vale cualquier proyecto (XYZ-12), salvo una letra suelta: "a n-1234" es AN, no N.
    if (known.has(project) || (m[0].includes('-') && project.length >= 2)) return { key: `${project}-${m[2]}`, assumedProject: false };
  }

  const num = /\b(\d{1,6})\b/.exec(t);
  if (!num) return undefined;

  // Hacia atrás desde el número. Una palabra corta pegada al número es el proyecto tal cual
  // ("rb 29011", "qa 7"); letras sueltas o deletreadas se juntan ("a n" → AN, "erre be" → RB).
  const before = t.slice(0, num.index).split(/[\s,.;:-]+/).filter(Boolean);
  let letters = '';
  for (let i = before.length - 1; i >= 0 && before.length - i <= 4; i--) {
    const tok = before[i]!;
    if (FILLER.has(tok) || NOT_PROJECT.has(tok)) {
      if (letters) break;
      continue;
    }
    const single = LETTER_NAMES[tok] ?? (/^[a-z]$/.test(tok) ? tok.toUpperCase() : undefined);
    if (single) {
      letters = single + letters;
      continue;
    }
    if (!letters && /^[a-z][a-z0-9]{1,5}$/.test(tok)) letters = tok.toUpperCase();
    break;
  }
  if (letters.length >= 2 || known.has(letters)) return { key: `${letters}-${num[1]}`, assumedProject: false };
  // Sin letras (o una sola, que suele ser ruido): proyecto por defecto, y la respuesta lo dice en voz alta.
  return { key: `${opts.defaultProject}-${num[1]}`, assumedProject: true };
}

const UNITS: Record<string, number> = {
  cero: 0, un: 1, uno: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9,
  diez: 10, once: 11, doce: 12, trece: 13, catorce: 14, quince: 15, dieciseis: 16, diecisiete: 17, dieciocho: 18,
  diecinueve: 19, veinte: 20, veintiun: 21, veintiuno: 21, veintidos: 22, veintitres: 23, veinticuatro: 24,
  veinticinco: 25, veintiseis: 26, veintisiete: 27, veintiocho: 28, veintinueve: 29,
};
const TENS: Record<string, number> = { treinta: 30, cuarenta: 40, cincuenta: 50, sesenta: 60, setenta: 70, ochenta: 80, noventa: 90 };
const HUNDREDS: Record<string, number> = {
  cien: 100, ciento: 100, doscientos: 200, doscientas: 200, trescientos: 300, trescientas: 300, cuatrocientos: 400,
  cuatrocientas: 400, quinientos: 500, quinientas: 500, seiscientos: 600, seiscientas: 600, setecientos: 700,
  setecientas: 700, ochocientos: 800, ochocientas: 800, novecientos: 900, novecientas: 900,
};

/**
 * "mil doscientos treinta y cuatro" → "1234". Algunos reconocedores escriben
 * los números en letra; solo se convierten tramos que contengan al menos una
 * decena, centena o "mil", para no tocar "la dos" ni "un momento".
 */
export function numberWordsToDigits(text: string): string {
  const words = text.split(/(\s+)/);
  const out: string[] = [];
  let i = 0;
  while (i < words.length) {
    if (/^\s*$/.test(words[i]!)) {
      out.push(words[i]!);
      i++;
      continue;
    }
    let j = i;
    let total = 0;
    let current = 0;
    let big = false;
    let consumed = 0;
    let lastNumeric = i;
    while (j < words.length) {
      const w = words[j]!;
      if (/^\s+$/.test(w)) {
        j++;
        continue;
      }
      if (w === 'y' && consumed > 0 && j + 2 < words.length && (UNITS[words[j + 2]!] ?? -1) >= 1 && (UNITS[words[j + 2]!] ?? 99) <= 9) {
        j++;
        continue;
      }
      if (w === 'mil') {
        total += (current || 1) * 1000;
        current = 0;
        big = true;
      } else if (HUNDREDS[w] !== undefined) {
        current += HUNDREDS[w];
        big = true;
      } else if (TENS[w] !== undefined) {
        current += TENS[w];
        big = true;
      } else if (UNITS[w] !== undefined) {
        current += UNITS[w];
      } else break;
      consumed++;
      lastNumeric = j;
      j++;
    }
    if (consumed > 0 && big) {
      out.push(String(total + current));
      i = lastNumeric + 1;
    } else {
      out.push(words[i]!);
      i++;
    }
  }
  return out.join('');
}

const FIX_VERB = /\b(haz(me)?|atiende|checa|chequea|encargate de|ocupate de|investiga|analiza|arregla\w*|repara\w*|corrige\w*|revisa\w*|resuelve\w*|soluciona\w*|fix|fixea\w*|trabaja en|ponte con|empieza con|mira el|mira)\b/;
const NOTES_MARKER = /\b(ten en cuenta( que)?|fijate( en)?|ojo( con)?|pista|notas?|el (bug|error|fallo) (esta|debe estar) en)\b\s*:?/;
const BRANCH_MARKER = /\b(desde|sobre|from)\s+(la\s+)?(rama\s+)?/;

/** Interpreta una frase completa ya sin la palabra de activación (si la trae, se ignora). */
export function parseIntent(text: string, opts: TicketParseOptions): VoiceIntent {
  const raw = text.trim();
  const t = fold(raw).replace(/^(oye |hola |eh )?(da ?bot|dabot)[\s,.:]*/, '').trim();
  const offset = fold(raw).length - t.length; // prefijo "oye dabot" quitado, para recortar el original
  const original = raw.slice(offset);

  if (!t) return { type: 'cancel' };
  if (/^(nada|olvidalo|olvida(lo)?|cancela(r)?|calla(te)?|silencio|para|basta|nada nada)\.?$/.test(t)) return { type: 'cancel' };
  if (/^(ayuda|que puedes hacer|que sabes hacer|como funcionas)\b/.test(t)) return { type: 'help' };

  const message = /^(dile a claude( code)?( que)?|a claude|mensaje para claude|dile que|comentale a claude( que)?)[\s,:]+/.exec(t);
  if (message) return { type: 'message', text: original.slice(message[0].length).trim() };

  if (FIX_VERB.test(t)) {
    const ticket = parseSpokenTicket(t, opts);
    if (ticket) return { type: 'fix', ticket, ...fixExtras(t, original) };
  }
  // "el ticket AN 1234" sin verbo reconocible: nombrar un ticket con clave ya es pedirlo.
  if (/\b(ticket|tiquet|tique|bug|issue)\b/.test(t) && /[a-z]\s*-?\s*\d|\d{3,}/.test(t)) {
    const ticket = parseSpokenTicket(t, opts);
    if (ticket) return { type: 'fix', ticket, ...fixExtras(t, original) };
  }

  if (/\b(descarta|descartalo|abandona|olvida el (ticket|job)|cancela el (ticket|job|fix)|mata el job)\b/.test(t)) {
    return { type: 'discard', ticket: /\d/.test(t) ? parseSpokenTicket(t, opts) : undefined };
  }
  if (/\b(repite|repitelo|que dijiste|otra vez|no te (oi|escuche|entendi))\b/.test(t)) return { type: 'repeat' };

  const option = /^(la |el |opcion |numero |rama )?(\d{1,2}|uno|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|primer[oa]|segund[oa]|tercer[oa]|cuart[oa]|quint[oa]|sext[oa]|septim[oa]|octav[oa]|noven[oa])\b\.?$/.exec(t);
  if (option) {
    const w = option[2]!;
    const n = /^\d+$/.test(w) ? Number(w) : (NUMBER_WORDS[w] ?? 0);
    if (n > 0) return { type: 'option', index: n - 1 };
  }

  if (/\b(solo (con )?codigo|sin entorno|sin reproduccion)\b/.test(t)) return { type: 'code_only' };
  if (/^(reintenta|reintentalo|vuelve a intentar(lo)?|prueba otra vez)\b/.test(t)) return { type: 'retry' };

  if (/^(no|nop|nel|negativo|mejor no|ni hablar|para nada|dejalo( asi| igual| como esta)?|deja(lo)? (asi|igual|como esta)|no lo hagas|salta(lo)?|omite(lo)?|paso)\b/.test(t)) return { type: 'no' };
  if (/^(si|sip|claro|dale|adelante|hazlo|confirmo|confirma(do)?|ok|okay|vale|de acuerdo|correcto|afirmativo|venga|perfecto|por supuesto|publica(lo)?|sube(la)?|abre(lo)?|muevelo|cambia(lo)?|acepta(r|lo)?)\b/.test(t)) return { type: 'yes' };

  if (/\b(como va(n)?|que tal va|estado|que hay|en que (estas|andas)|resumen|pendientes|que tienes)\b/.test(t)) return { type: 'status' };

  return { type: 'text', text: original };
}

/** Rama ("desde develop", "desde la rama release barra 9 punto 5") y notas de un pedido de fix. */
function fixExtras(t: string, original: string): { branch?: string; notes?: string } {
  const out: { branch?: string; notes?: string } = {};
  const notes = NOTES_MARKER.exec(t);
  const end = notes ? notes.index : t.length;
  const b = BRANCH_MARKER.exec(t.slice(0, end));
  if (b) {
    const spoken = t
      .slice(b.index + b[0].length, end)
      .replace(/[,;:]+.*$/, '')
      .trim();
    if (spoken) out.branch = spokenBranch(spoken);
  }
  if (notes) {
    const text = original.slice(notes.index + notes[0].length).replace(/^[\s:,.-]+/, '').trim();
    // "el bug está en X" es en sí la nota útil: se conserva entera.
    out.notes = /^el (bug|error|fallo)/.test(notes[0]) ? original.slice(notes.index).trim() : text;
    if (!out.notes) delete out.notes;
  }
  return out;
}

/** "release barra 9 punto 5" → "release/9.5". */
export function spokenBranch(spoken: string): string {
  return fold(spoken)
    .replace(/\s*\bbarra\b\s*/g, '/')
    .replace(/\s*\bpunto\b\s*/g, '.')
    .replace(/\s*\bguion( bajo)?\b\s*/g, (m) => (m.includes('bajo') ? '_' : '-'))
    .trim()
    .replace(/\s+/g, ' ');
}

/** Clave de comparación: solo letras y números ("release/9.5" ≡ "release 9 5" ≡ "Release 9.5"). */
function branchKey(s: string): string {
  return fold(s).replace(/[^a-z0-9]/g, '');
}

/**
 * Empareja una rama dicha en voz alta con las ramas del remoto. Exacta por
 * clave alfanumérica; si no, la única rama cuyo último tramo coincide
 * ("9.5" → release/9.5). Sin coincidencia única devuelve undefined.
 */
export function matchBranch(spoken: string, branches: readonly string[]): string | undefined {
  const k = branchKey(spokenBranch(spoken));
  if (!k) return undefined;
  const exact = branches.find((b) => branchKey(b) === k);
  if (exact) return exact;
  const tail = branches.filter((b) => branchKey(b.split('/').pop() ?? '') === k);
  return tail.length === 1 ? tail[0] : undefined;
}

import { z } from 'zod';

const outcomeSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('needs_clarification'),
    questions: z.array(z.string().trim().min(1)).min(1),
  }),
  /** Resultado del triaje en el repo de conocimiento: en qué repos hay que trabajar. */
  z.object({
    status: z.literal('repos'),
    repos: z
      .array(
        z.object({
          name: z.string().trim().min(1),
          reason: z.string().default(''),
          confidence: z.enum(['high', 'medium', 'low']).default('medium'),
        }),
      )
      .min(1),
    analysis: z.string().default(''),
  }),
  /** A mitad del fix: hace falta otro repositorio. */
  z.object({
    status: z.literal('needs_repos'),
    repos: z.array(z.string().trim().min(1)).min(1),
    reason: z.string().default(''),
  }),
  z.object({
    status: z.literal('fixed'),
    branch: z.string().optional(),
    worktree: z.string().optional(),
    files_changed: z.array(z.string()).default([]),
    tests: z.enum(['passed', 'failed', 'none']).default('none'),
    tests_detail: z.string().optional(),
    /** Plantilla de reporte (en inglés): qué fallaba y por qué / qué se cambió / qué debe revisar QA. */
    issue: z.string().default(''),
    solution: z.string().default(''),
    notes_for_qa: z.string().optional(),
    /** Reproducción en navegador: qué consiguió hacer el agente. Lo verifica el servicio. */
    reproduction: z.enum(['reproduced', 'not_reproduced', 'not_applicable']).optional(),
    /** Spec de regresión del repo (rojo antes / verde después). Lo verifica el servicio con los registros del wrapper. */
    regression_test: z
      .object({
        kind: z.enum(['unit', 'e2e', 'none']).default('none'),
        files: z.array(z.string()).default([]),
        reason: z.string().optional(),
      })
      .optional(),
    /** Compatibilidad: resumen libre; si falta se compone de issue + solution. */
    summary: z.string().default(''),
  }),
  z.object({
    status: z.literal('cannot_fix'),
    reason: z.string().default('sin motivo indicado'),
  }),
]);

export type ClaudeOutcome = z.infer<typeof outcomeSchema>;

export type ParsedOutcome = { kind: 'ok'; outcome: ClaudeOutcome } | { kind: 'no_block' } | { kind: 'invalid'; issues: string[] };

/** Sinónimos que Claude usa en "tests" y "reproduction" fuera del contrato; se normalizan antes de validar. */
const TESTS_SYNONYMS: Record<string, 'passed' | 'failed' | 'none'> = {
  pass: 'passed',
  passing: 'passed',
  ok: 'passed',
  green: 'passed',
  success: 'passed',
  succeeded: 'passed',
  fail: 'failed',
  failing: 'failed',
  error: 'failed',
  red: 'failed',
  skipped: 'none',
  not_run: 'none',
  'not run': 'none',
  'n/a': 'none',
  na: 'none',
  not_applicable: 'none',
};
const REPRO_SYNONYMS: Record<string, 'reproduced' | 'not_reproduced' | 'not_applicable'> = {
  yes: 'reproduced',
  verified: 'reproduced',
  passed: 'reproduced',
  no: 'not_reproduced',
  failed: 'not_reproduced',
  'n/a': 'not_applicable',
  na: 'not_applicable',
  none: 'not_applicable',
  skipped: 'not_applicable',
};

/**
 * Acerca el JSON al contrato sin cambiar su sentido. Caso real: `"tests": "e2e"` (Claude
 * describía CÓMO validó, no el resultado de la suite del repo) tiraba todo el reporte.
 */
function normalize(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const obj = { ...(raw as Record<string, unknown>) };
  if (obj.status !== 'fixed') return obj;
  if (typeof obj.files_changed === 'string') obj.files_changed = [obj.files_changed];
  if (obj.regression_test && typeof obj.regression_test === 'object') {
    const rt = { ...(obj.regression_test as Record<string, unknown>) };
    if (typeof rt.files === 'string') rt.files = [rt.files];
    if (typeof rt.kind === 'string') {
      const k = rt.kind.trim().toLowerCase();
      rt.kind = k === 'e2e' || k === 'cypress' || k === 'playwright' ? 'e2e' : ['none', 'n/a', 'na', 'skipped'].includes(k) ? 'none' : 'unit';
    }
    obj.regression_test = rt;
  }
  if (typeof obj.tests === 'string') {
    const key = obj.tests.trim().toLowerCase();
    if (['passed', 'failed', 'none'].includes(key)) {
      obj.tests = key; // "FAILED" / "Passed": solo mayúsculas
    } else {
      const mapped = TESTS_SYNONYMS[key];
      obj.tests = mapped ?? 'none';
      if (!mapped) {
        const detail = typeof obj.tests_detail === 'string' && obj.tests_detail.trim() ? obj.tests_detail.trim() : undefined;
        obj.tests_detail = [detail, `repo test suite result reported as "${key}"`].filter(Boolean).join(' — ');
      }
    }
  }
  if (typeof obj.reproduction === 'string') {
    const key = obj.reproduction.trim().toLowerCase();
    if (['reproduced', 'not_reproduced', 'not_applicable'].includes(key)) obj.reproduction = key;
    else if (REPRO_SYNONYMS[key]) obj.reproduction = REPRO_SYNONYMS[key];
  }
  return obj;
}

/**
 * Extrae el bloque JSON final del texto de Claude. Acepta un bloque ```json …```
 * (se toma el último) o, como respaldo, el último objeto JSON con "status".
 * Distingue "no hay bloque" de "hay bloque pero no cumple el contrato": en el
 * segundo caso devuelve los problemas exactos para pedírselos a Claude, porque
 * decirle "no trajiste el bloque" cuando sí lo trajo le hacía repetir el mismo JSON.
 */
export function parseOutcomeDetailed(text: string): ParsedOutcome {
  const candidates: string[] = [];

  const fence = /```(?:json)?\s*([\s\S]*?)```/gi;
  for (const m of text.matchAll(fence)) if (m[1]) candidates.push(m[1]);
  candidates.reverse(); // el último bloque primero

  // Respaldo: JSON suelto al final del texto.
  const loose = text.lastIndexOf('{"status"');
  if (loose !== -1) candidates.push(balancedObjectAt(text, loose) ?? '');

  let issues: string[] | undefined;
  for (const raw of candidates) {
    const trimmed = raw.trim();
    if (!trimmed.startsWith('{')) continue;
    let json: unknown;
    try {
      json = JSON.parse(trimmed);
    } catch (err) {
      issues ??= [`el bloque no es JSON válido: ${(err as Error).message}`];
      continue;
    }
    const parsed = outcomeSchema.safeParse(normalize(json));
    if (parsed.success) return { kind: 'ok', outcome: parsed.data };
    issues ??= parsed.error.issues.map((i) => `${i.path.map(String).join('.') || 'raíz'}: ${i.message}`);
  }
  return issues ? { kind: 'invalid', issues } : { kind: 'no_block' };
}

export function parseOutcome(text: string): ClaudeOutcome | undefined {
  const r = parseOutcomeDetailed(text);
  return r.kind === 'ok' ? r.outcome : undefined;
}

/** Devuelve el objeto JSON balanceado que empieza en `start`, o undefined. */
function balancedObjectAt(text: string, start: number): string | undefined {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return undefined;
}

import type { MessageKind } from '../shared/job-types.js';
import type { StreamEvent } from './runner.js';

export interface NewMessage {
  kind: MessageKind;
  toolName: string | null;
  summary: string;
  content: unknown;
}

/** Máximo de caracteres que se guardan por mensaje (los tool_result pueden traer archivos enteros). */
const MAX_CONTENT_CHARS = 20_000;

/**
 * Convierte un evento del stream-json en cero o más mensajes legibles para la
 * transcripción del dashboard. Un evento "assistant" puede traer texto y varias
 * llamadas a herramientas a la vez; cada una se guarda por separado.
 */
export function messagesFromEvent(ev: StreamEvent): NewMessage[] {
  switch (ev.type) {
    case 'system':
      if (ev.subtype !== 'init') return [];
      return [
        {
          kind: 'system',
          toolName: null,
          summary: `Sesión iniciada (${String(ev.model ?? 'modelo por defecto')}, ${Array.isArray(ev.tools) ? ev.tools.length : '?'} herramientas)`,
          content: pick(ev, ['model', 'cwd', 'permissionMode', 'tools', 'mcp_servers']),
        },
      ];

    case 'assistant':
      return blocksOf(ev).flatMap((block): NewMessage[] => {
        if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
          return [{ kind: 'assistant_text', toolName: null, summary: firstLine(block.text), content: truncate(block.text) }];
        }
        if (block.type === 'tool_use') {
          const name = String(block.name ?? 'tool');
          const input = (block.input ?? {}) as Record<string, unknown>;
          return [{ kind: 'tool_use', toolName: name, summary: summarizeToolUse(name, input), content: truncateJson(input) }];
        }
        return [];
      });

    case 'user':
      return blocksOf(ev).flatMap((block): NewMessage[] => {
        if (block.type === 'tool_result') {
          const text = toolResultText(block.content);
          const isError = Boolean(block.is_error);
          return [
            {
              kind: 'tool_result',
              toolName: null,
              summary: isError ? `Error: ${firstLine(text)}` : firstLine(text) || '(sin salida)',
              content: { isError, toolUseId: block.tool_use_id, text: truncate(text) },
            },
          ];
        }
        if (block.type === 'text' && typeof block.text === 'string') {
          return [{ kind: 'user_prompt', toolName: null, summary: firstLine(block.text), content: truncate(block.text) }];
        }
        return [];
      });

    case 'result': {
      const cost = typeof ev.total_cost_usd === 'number' ? ` · $${ev.total_cost_usd.toFixed(4)}` : '';
      const dur = typeof ev.duration_ms === 'number' ? ` · ${Math.round(ev.duration_ms / 1000)}s` : '';
      const turns = typeof ev.num_turns === 'number' ? ` · ${ev.num_turns} turnos` : '';
      return [
        {
          kind: ev.is_error ? 'error' : 'result',
          toolName: null,
          summary: `${ev.is_error ? `Terminó con error (${ev.subtype ?? 'error'})` : 'Sesión completada'}${turns}${dur}${cost}`,
          content: { subtype: ev.subtype, result: truncate(typeof ev.result === 'string' ? ev.result : ''), numTurns: ev.num_turns, durationMs: ev.duration_ms, costUsd: ev.total_cost_usd },
        },
      ];
    }

    default:
      return [];
  }
}

function blocksOf(ev: StreamEvent): Array<Record<string, unknown>> {
  const content = ev.message?.content;
  if (Array.isArray(content)) return content;
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return [];
}

function summarizeToolUse(name: string, input: Record<string, unknown>): string {
  const s = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : undefined);
  switch (name) {
    case 'Read':
      return `Leer ${s('file_path') ?? ''}`.trim();
    case 'Edit':
    case 'MultiEdit':
      return `Editar ${s('file_path') ?? ''}`.trim();
    case 'Write':
      return `Escribir ${s('file_path') ?? ''}`.trim();
    case 'Bash':
      return `$ ${firstLine(s('command') ?? '')}`;
    case 'Grep':
      return `Buscar /${s('pattern') ?? ''}/${s('path') ? ` en ${s('path')}` : ''}`;
    case 'Glob':
      return `Glob ${s('pattern') ?? ''}`;
    case 'LS':
      return `Listar ${s('path') ?? ''}`.trim();
    case 'TodoWrite':
      return 'Actualizar lista de tareas';
    default: {
      const firstStr = Object.values(input).find((v) => typeof v === 'string') as string | undefined;
      return `${name}${firstStr ? ` ${firstLine(firstStr)}` : ''}`;
    }
  }
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (c && typeof c === 'object' && 'text' in c ? String((c as { text: unknown }).text) : ''))
      .filter(Boolean)
      .join('\n');
  }
  return content == null ? '' : JSON.stringify(content);
}

function firstLine(text: string, max = 140): string {
  const line = text.trim().split('\n')[0] ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function truncate(text: string): string {
  return text.length > MAX_CONTENT_CHARS ? `${text.slice(0, MAX_CONTENT_CHARS)}\n… [recortado, ${text.length} caracteres en total]` : text;
}

function truncateJson(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) out[k] = typeof v === 'string' ? truncate(v) : v;
  return out;
}

function pick(ev: StreamEvent, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (k in ev) out[k] = ev[k];
  return out;
}

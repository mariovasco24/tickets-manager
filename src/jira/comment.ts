import type { JobDto } from '../shared/job-types.js';

/**
 * Construye el comentario del fix en Atlassian Document Format, con la misma
 * plantilla que ve el equipo en Slack: Issue / Solution / Notes for QA / Branch /
 * Files / Tests / Reproduction, y los vídeos de antes y después.
 */
export interface CommentVideo {
  phase: 'before' | 'after';
  attachmentId: string;
  filename: string;
  url: string;
}

/** PR abierto desde la rama del job; Jira lo pinta como tarjeta (smart link). */
export interface PullRequestLink {
  repoName: string;
  url: string;
  destination: string;
}

type Node = Record<string, unknown>;

const text = (value: string, marks?: string[]): Node => ({
  type: 'text',
  text: value,
  ...(marks?.length ? { marks: marks.map((m) => ({ type: m })) } : {}),
});
const paragraph = (...content: Node[]): Node => ({ type: 'paragraph', content });
const label = (value: string): Node => paragraph(text(value, ['strong']));

/** Párrafos separados por líneas en blanco, como los escribió el agente. */
function body(value: string): Node[] {
  return value
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => paragraph(text(p)));
}

/**
 * Vídeo incrustado. Si Jira rechaza el nodo de medios (varía por configuración
 * del sitio), `buildFixComment` reintenta con la variante de solo enlace.
 */
function media(video: CommentVideo): Node {
  return {
    type: 'mediaSingle',
    attrs: { layout: 'center' },
    content: [{ type: 'media', attrs: { type: 'file', id: video.attachmentId, collection: '' } }],
  };
}

function link(video: CommentVideo): Node {
  return paragraph(
    video.url
      ? { ...text(video.filename), marks: [{ type: 'link', attrs: { href: video.url } }] }
      : text(`${video.filename} (adjunto en este ticket)`),
  );
}

export function buildFixComment(job: JobDto, videos: CommentVideo[], opts: { embedVideos: boolean; pullRequests?: PullRequestLink[] }): unknown {
  const content: Node[] = [];
  const prs = opts.pullRequests ?? [];

  content.push(label('Issue:'), ...body(job.issue ?? '(not provided)'));
  content.push(label('Solution:'), ...body(job.solution ?? '(not provided)'));
  if (job.notesForQa) content.push(label('Notes for QA:'), ...body(job.notesForQa));

  if (job.branch) content.push(paragraph(text('Branch: ', ['strong']), text(job.branch, ['code'])));
  // Sin lista de archivos: en Jira sobra (está en el PR y en Slack). Decisión del equipo.
  // Tarjeta (inlineCard) en el intento rico; enlace plano en el reintento, por si el sitio la rechaza.
  for (const pr of prs) {
    const labelText = prs.length > 1 ? `Pull request (${pr.repoName} → ${pr.destination}): ` : `Pull request (→ ${pr.destination}): `;
    const card: Node = opts.embedVideos ? { type: 'inlineCard', attrs: { url: pr.url } } : { ...text(pr.url), marks: [{ type: 'link', attrs: { href: pr.url } }] };
    content.push(paragraph(text(labelText, ['strong']), card));
  }
  if (job.testsResult) {
    content.push(paragraph(text('Tests: ', ['strong']), text(`${job.testsResult}${job.testsDetail ? ` — ${job.testsDetail}` : ''}`)));
  }
  if (job.reproduction) content.push(paragraph(text('Reproduction: ', ['strong']), text(job.reproduction)));
  if (job.regressionTest) content.push(paragraph(text('Regression test: ', ['strong']), text(job.regressionTest.label)));

  for (const phase of ['before', 'after'] as const) {
    const video = videos.find((v) => v.phase === phase);
    if (!video) continue;
    content.push(paragraph(text(phase === 'before' ? 'Before (bug):' : 'After (fixed):', ['strong'])));
    content.push(opts.embedVideos ? media(video) : link(video));
  }

  // Sin pie ("nothing is merged…"): el equipo no lo quiere en el ticket; en Slack sí se dice.
  return { type: 'doc', version: 1, content };
}

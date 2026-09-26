import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { SseHub } from '../api/sse.js';
import { openDatabase } from '../db/index.js';
import type { Intake } from '../intake.js';
import { JobRepository } from '../jobs/repository.js';
import { initLogger } from '../logger.js';
import { JobStateError, JobService } from '../jobs/service.js';
import type { IncomingBug } from '../types.js';
import { VoiceService, type VoiceAnnouncement } from './service.js';

initLogger('error', false);

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

/** Intake falso que recorre los mismos estados que el real, sin Jira, Slack ni git. */
function fakeIntake(jobs: JobService, calls: string[]): Intake {
  const branches = ['develop', 'main', 'release/9.5'];
  const fake = {
    async receive(bug: IncomingBug) {
      calls.push(`receive ${bug.key} ${bug.source} ${bug.sourceBranch ?? '-'} ${bug.notes ?? '-'}`);
      const job = jobs.create(bug);
      await tick(5);
      return jobs.ask(job.id, 'awaiting_jira_status', `¿Muevo *${bug.key}* en Jira de "Open" a "In Progress"?`);
    },
    async jiraDecision(id: string, accept: boolean) {
      calls.push(`jira ${accept}`);
      await tick(5);
      jobs.transition(id, 'received', 'ok');
      return jobs.ask(id, 'awaiting_branch', '¿Desde qué rama?');
    },
    async answer(id: string, text: string) {
      calls.push(`answer ${text}`);
      const job = jobs.get(id)!;
      if (job.status === 'awaiting_branch') {
        if (!branches.includes(text)) throw new JobStateError(`La rama "${text}" no existe en el remoto`);
        const { job: updated } = jobs.answer(id, text, 'voice', 'x');
        setTimeout(() => {
          jobs.setTriageResult(id, { repos: [{ name: 'an-datagrid', reason: 'r', confidence: 'high' }], analysis: '' });
          jobs.ask(id, 'awaiting_repos', 'repos?');
        }, 5);
        return updated;
      }
      return jobs.answer(id, text, 'voice', 'x').job;
    },
    async confirmRepos(id: string) {
      calls.push('confirm');
      const { job } = jobs.answer(id, 'repos: an-datagrid', 'voice', 'x');
      setTimeout(() => {
        jobs.transition(id, 'working', 'w');
        setTimeout(() => jobs.transition(id, 'fixed', 'f', { issue: 'Broken sort', solution: 'Fixed comparator', testsResult: 'passed' }), 5);
      }, 5);
      return job;
    },
    async publishJiraComment(id: string, accept: boolean) {
      calls.push(`comment ${accept}`);
      jobs.note(id, accept ? 'jira_comment' : 'jira_comment_skipped', 'c');
      return jobs.get(id)!;
    },
    async discard(id: string) {
      calls.push('discard');
      return jobs.discard(id, 'voz');
    },
    async humanMessage(id: string, text: string) {
      calls.push(`message ${text}`);
      return jobs.get(id)!;
    },
    async listBranches() {
      return branches;
    },
  };
  return fake as unknown as Intake;
}

function setup() {
  const db = openDatabase(path.join(mkdtempSync(path.join(tmpdir(), 'voice-')), 'test.db'));
  const jobs = new JobService(new JobRepository(db));
  const said: VoiceAnnouncement[] = [];
  const hub = { broadcast: (_e: string, a: VoiceAnnouncement) => said.push(a) } as unknown as SseHub;
  const calls: string[] = [];
  const voice = new VoiceService(fakeIntake(jobs, calls), jobs, hub, {
    defaultProject: 'AN',
    projects: ['AN'],
    announce: 'all',
    prEnabled: false,
    jiraMergeStatus: undefined,
    jiraAllowComment: true,
  });
  /** Como el router: los anuncios esperan a que salga la respuesta. */
  const say = async (text: string) => {
    const release = voice.hold();
    const reply = await voice.command(text);
    const before = said.length;
    release();
    return { reply, flushedAfterReply: said.length - before };
  };
  return { voice, said, calls, say, jobs };
}

describe('VoiceService: flujo completo por voz', () => {
  it('de "arregla" al comentario en Jira, con las mismas decisiones que Slack', async () => {
    const { said, calls, say } = setup();

    const r1 = await say('Oye Dabot, arregla el ticket a ene 1234, ten en cuenta el sort panel');
    assert.match(r1.reply.say, /^Vale, voy con A N 1234\./);
    await tick(40);
    assert.equal(calls[0], 'receive AN-1234 voice - el sort panel');
    const q1 = said.at(-1)!;
    assert.equal(q1.decision?.kind, 'jira_status');
    assert.equal(q1.listen, true);
    assert.equal(q1.say, '¿Muevo A N 1234 en Jira de "Open" a "In Progress"? Responde sí o no.');
    assert.doesNotMatch(q1.say, /\*/);

    const r2 = await say('sí');
    assert.equal(r2.reply.say, 'Cambio el estado en Jira.');
    await tick(40);
    const q2 = said.at(-1)!;
    assert.equal(q2.decision?.kind, 'branch');
    assert.deepEqual(q2.decision?.options.map((o) => o.label), ['develop', 'main', 'release/9.5']);

    const bad = await say('feature inventada');
    assert.match(bad.reply.say, /No encuentro la rama feature inventada\. Opciones: 1, develop/);
    assert.equal(bad.reply.listen, true);

    const r3 = await say('release barra 9 punto 5');
    assert.equal(r3.reply.say, 'Rama release 9.5. Busco en qué repositorios está el bug.');
    await tick(60);
    const q3 = said.at(-1)!;
    assert.equal(q3.decision?.kind, 'repos');
    assert.equal(q3.say, 'Terminé el análisis de A N 1234. El bug está en an-datagrid, con confianza alta: r. ¿Confirmo ese repositorio? Responde sí o no.');
    assert.equal(q2.say, 'Selecciona la rama origen para el ticket A N 1234. Dime la rama, o elígela en pantalla.');
    assert.ok(said.some((a) => /Analizando en qué repositorios está A N 1234/.test(a.say)));

    await say('dale');
    await tick(80);
    const q4 = said.at(-1)!;
    assert.equal(q4.decision?.kind, 'jira_comment');
    assert.match(q4.say, /^Ya terminé con A N 1234\. Fixed comparator\. Los tests pasan\. ¿Publico el reporte en A N 1234 como comentario\? Responde sí o no\.$/);
    assert.ok(said.some((a) => a.say === 'Claude Code está trabajando en A N 1234. Te aviso cuando termine o si tiene preguntas.'));

    await say('publícalo');
    await tick(40);
    assert.equal(said.at(-1)!.say, 'Todo listo con A N 1234: reporte publicado. No queda nada pendiente.');
    assert.deepEqual(calls.slice(1), ['jira true', 'answer release/9.5', 'confirm', 'comment true']);
  });

  it('buscador de ramas filtra como Slack', async () => {
    const { voice } = setup();
    assert.deepEqual(await voice.searchBranches(''), { branches: ['develop', 'main', 'release/9.5'] });
    assert.deepEqual(await voice.searchBranches('REL'), { branches: ['release/9.5'] });
  });

  it('los anuncios esperan a que salga la respuesta', async () => {
    const { voice, said } = setup();
    const release = voice.hold();
    await voice.command('arregla el AN 7');
    await tick(40);
    assert.equal(said.length, 0);
    release();
    assert.equal(said.at(-1)?.decision?.kind, 'jira_status');
  });

  it('un error de validación se dice en la misma respuesta', async () => {
    const { voice, say, jobs } = setup();
    await say('arregla el AN 8');
    await tick(30);
    await say('no');
    await tick(30);
    const job = jobs.findActiveByTicket('AN-8')!;
    assert.equal(job.status, 'awaiting_branch');
    const r = await voice.decide(job.id, 'branch:feature/borrada');
    assert.equal(r.say, 'No pude: La rama "feature borrada" no existe en el remoto');
  });

  it('descartar pide confirmación', async () => {
    const { say, calls } = setup();
    await say('arregla el AN 9');
    await tick(30);
    const ask = await say('descarta el ticket');
    assert.match(ask.reply.say, /¿Seguro que descarto A N 9\?/);
    assert.equal(ask.reply.listen, true);
    await say('sí');
    assert.ok(calls.includes('discard'));
  });

  it('sin nada pendiente no manda texto suelto a Claude', async () => {
    const { say, calls } = setup();
    const r = await say('el filtro se aplica dos veces');
    assert.match(r.reply.say, /Oí: el filtro se aplica dos veces. No encontré un ticket/);
    assert.equal(calls.length, 0);
  });

  it('"dile a Claude" sí llega a la sesión', async () => {
    const { say, calls } = setup();
    await say('arregla el AN 10');
    await tick(30);
    const r = await say('dile a Claude que mire también el export');
    assert.match(r.reply.say, /Se lo paso a Claude/);
    assert.ok(calls.includes('message mire también el export'));
  });

  it('pedir un ticket que ya está en marcha no crea otro', async () => {
    const { say, calls } = setup();
    await say('arregla el AN 11');
    await tick(30);
    const r = await say('arregla el AN 11');
    assert.match(r.reply.say, /A N 11 ya está en marcha/);
    assert.equal(calls.filter((c) => c.startsWith('receive')).length, 1);
  });
});

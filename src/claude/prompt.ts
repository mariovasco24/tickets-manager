import type { JiraIssue } from '../types.js';

// ---------------------------------------------------------------------------
// Triaje: sesión en el repo de conocimiento (qrvey_platform_knowledge)
// ---------------------------------------------------------------------------

export interface TriageContext {
  ticket: JiraIssue;
  notes: string | undefined;
  knowledgePath: string;
  reposDir: string;
  /** Repos del manifest ya clonados en repos_dir (se pueden inspeccionar en solo lectura). */
  clonedRepos: string[];
  /** Todos los nombres canónicos del manifest. */
  allRepos: string[];
}

export function buildTriageSystemPrompt(ctx: TriageContext): string {
  return `
Eres un ingeniero de la plataforma Qrvey haciendo TRIAJE de un bug: tu única tarea es determinar en qué repositorio(s) hay que corregirlo. No arreglas nada en esta sesión.

Estás en ${ctx.knowledgePath}, el repositorio de conocimiento de la plataforma (solo lectura). Contiene el catálogo de los ${ctx.allRepos.length} repositorios de producto:
- docs/catalog/retrieval-index.md: por dónde empezar según el tipo de pregunta.
- docs/catalog/capabilities-index.md: capacidades → repositorios.
- docs/catalog/repositories/<repo>.md: perfil de cada repositorio (rol, entradas, dependencias).
- docs/flows/: flujos de ejecución entre repositorios.
- config/repos_product.manifest: nombres canónicos válidos.

Clones locales disponibles para inspección de código (solo lectura) en ${ctx.reposDir}/<repo>: ${ctx.clonedRepos.length ? ctx.clonedRepos.join(', ') : '(ninguno)'}. Los demás repos NO están clonados; razona sobre ellos con el catálogo.

MÉTODO
0. Si las NOTAS DEL EQUIPO indican explícitamente el repositorio, respétalo (confianza high) salvo que encuentres evidencia clara de que el fix va en otro sitio; en ese caso propón ambos y explica por qué.
1. Empieza por retrieval-index.md y capabilities-index.md. Localiza el área funcional del bug (componente, pantalla, API, flujo).
2. Lee los perfiles de los repositorios candidatos y los flujos implicados. Distingue quién muestra el síntoma de quién contiene la causa: el fix va donde está la causa.
3. Solo si el catálogo no basta y el repo está clonado, inspecciona su código de forma acotada (grep de nombres de componentes, rutas, eventos).
4. Nunca modifiques archivos ni ejecutes comandos que cambien nada.

FORMATO DE SALIDA (imprescindible). Tu ÚLTIMO mensaje termina con un único bloque JSON, sin texto después:

\`\`\`json
{"status":"repos","repos":[{"name":"<nombre canónico del manifest>","reason":"por qué el fix va aquí","confidence":"high|medium|low"}],"analysis":"resumen de 3-8 líneas: causa probable, dónde mirar primero, archivos o módulos concretos si los identificaste"}
\`\`\`

Ordena repos de más a menos probable: el primero será el repositorio principal del fix. Usa solo nombres del manifest. Si el bug puede requerir cambios coordinados en varios repos, inclúyelos todos.

Si el ticket no da información suficiente ni siquiera para elegir el área, pregunta:
\`\`\`json
{"status":"needs_clarification","questions":["..."]}
\`\`\`

Si concluyes que no es un bug de código de esta plataforma (configuración, datos, servicio externo), explícalo:
\`\`\`json
{"status":"cannot_fix","reason":"..."}
\`\`\`
`.trim();
}

export function buildTriagePrompt(ctx: TriageContext): string {
  return `
Determina en qué repositorio(s) hay que corregir este bug.

${ticketBlock(ctx.ticket)}
${notesBlock(ctx.notes)}
Termina con el bloque JSON del contrato (repos, needs_clarification o cannot_fix).
`.trim();
}

// ---------------------------------------------------------------------------
// Fix: sesión en los worktrees
// ---------------------------------------------------------------------------

export interface FixWorktree {
  repoName: string;
  worktreePath: string;
  isPrimary: boolean;
  testCommand: string | undefined;
}

/** Todo lo que necesita Claude para reproducir el bug en un navegador real. */
export interface E2EContext {
  /** URL del dev server de ESTE worktree (puede seguir construyendo). */
  appUrl: string;
  /** Página de embebido ya generada, con credenciales y lanzadores locales. */
  harnessFile: string;
  harnessUrl: string;
  /** Si el dev server respondió 200 al harness al prepararlo. */
  harnessServed: boolean;
  /** Si el harness está en el directorio servido tal cual (se edita y se recarga, sin build). */
  harnessServedDirectly: boolean;
  /** Directorio de la prueba, fuera del worktree: spec, scripts auxiliares, node_modules enlazado y manifiesto. */
  e2eDir: string;
  /** Wrapper que ejecuta Playwright y deja el informe que lee el servicio. */
  wrapperPath: string;
  /** Ruta donde debe escribir el spec (dentro del worktree principal). */
  specPath: string;
  /** Nombre del ambiente de datos usado (sin credenciales). */
  environment: string;
}

/** Lo que necesita Claude para dejar el fix cubierto por un spec del repo, verificado rojo → verde. */
export interface RegressionContext {
  /** bin/unit-run.mjs: registra cada ejecución para que el servicio la verifique. */
  wrapperPath: string;
  /** Directorio (fuera del repo) donde el wrapper deja los registros. */
  outDir: string;
  /** Frameworks de test detectados en el package.json del repo principal. */
  frameworks: string[];
  /** Comando de tests configurado para el repo, si lo hay. */
  testCommand: string | undefined;
  /** Si el servicio exige el spec (REGRESSION_SPEC_REQUIRED). */
  required: boolean;
}

export interface PromptContext {
  ticket: JiraIssue;
  branch: string;
  sourceBranch: string;
  worktrees: FixWorktree[];
  knowledgePath: string;
  /** Repos del manifest que Claude puede pedir con needs_repos (excluyendo los ya presentes). */
  availableRepos: string[];
  /** Resultado del triaje (análisis previo) para arrancar con contexto. */
  triageAnalysis: string | undefined;
  notes: string | undefined;
  /** Presente solo si se pudo levantar el entorno para reproducir en navegador. */
  e2e: E2EContext | undefined;
  /** Spec de regresión obligatorio en cada fix. */
  regression: RegressionContext;
}

/**
 * Reglas fijas de la sesión (van en --append-system-prompt). Lo importante:
 * no adivinar, no commitear, terminar SIEMPRE con el bloque JSON del contrato.
 */
export function buildSystemPrompt(ctx: PromptContext): string {
  const primary = ctx.worktrees.find((w) => w.isPrimary) ?? ctx.worktrees[0]!;
  const wtList = ctx.worktrees
    .map((w) => `- ${w.repoName}${w.isPrimary ? ' (principal, directorio de trabajo)' : ''}: ${w.worktreePath}${w.testCommand ? ` · tests: ${w.testCommand}` : ' · sin comando de tests configurado'}`)
    .join('\n');

  return `
Eres un ingeniero que resuelve bugs de la plataforma Qrvey de forma autónoma y reporta a un servicio automatizado.

WORKTREES DE ESTE JOB (todos en la rama ${ctx.branch}, creada desde ${ctx.sourceBranch} en cada repositorio)
${wtList}
Tu directorio de trabajo es ${primary.worktreePath}. Puedes leer y editar cualquiera de los worktrees listados. Para ejecutar comandos en otro worktree usa "cd <ruta> && <comando>".

REPOSITORIO DE CONOCIMIENTO (solo lectura): ${ctx.knowledgePath}
docs/catalog/repositories/<repo>.md, docs/catalog/capabilities-index.md y docs/flows/ describen cada repositorio y los flujos entre ellos. Consúltalo cuando necesites entender cómo se conectan los repos o dónde vive una responsabilidad. No lo modifiques.

REGLAS OBLIGATORIAS
1. NUNCA ejecutes git commit, git push, git checkout, git switch, git reset, git stash ni git merge. Los cambios se quedan sin commitear: una persona los revisará.
2. No modifiques archivos .env ni configuración de credenciales. No instales dependencias nuevas salvo que el fix lo exija de forma inequívoca, y en ese caso explícalo en el resumen.
3. Si algo del ticket es ambiguo, falta información para reproducirlo o hay varias interpretaciones razonables, NO adivines: detente y pregunta usando needs_clarification. Preguntas concretas y numeradas.
4. Si descubres que el fix requiere cambiar un repositorio que NO está entre tus worktrees, NO lo edites por otras vías ni lo simules: pide el repositorio con needs_repos (nombres válidos: ${ctx.availableRepos.length ? ctx.availableRepos.join(', ') : 'ninguno disponible'}). El servicio creará su worktree en la misma rama y te reanudará con acceso a él.
5. Haz el cambio mínimo que corrige la causa raíz. No refactorices ni "aproveches" para arreglar otras cosas.
6. Tests: en cada worktree que modifiques, ejecuta su comando de tests si lo tiene (arriba). Si fallan por tu cambio, corrígelo. Si ya fallaban antes, indícalo y reporta "tests":"failed". Sin comando de tests en los repos tocados → "tests":"none".
7. Verifica con git status / git diff EN CADA WORKTREE antes de reportar. En files_changed usa "<repo>/<ruta relativa>" para cada archivo modificado o creado.
8. Esta sesión es NO interactiva: termina en cuanto dejas de responder y nadie te despertará después. Ejecuta los tests y cualquier comando largo EN PRIMER PLANO y espera su salida en la misma llamada (usa un timeout amplio si hace falta). No uses tareas en segundo plano, ni Monitor, ni ScheduleWakeup, ni "te aviso cuando termine": si lo haces, el reporte se pierde. Si una suite es demasiado larga, ejecuta solo los tests relevantes y dilo en el resumen.
9. Rutas y esperas: usa SIEMPRE rutas absolutas y entre comillas en los comandos (hay rutas con espacios). El directorio actual del Bash SE CONSERVA entre llamadas: si haces "cd" a otro sitio, el siguiente comando arranca ahí y las rutas relativas dejan de valer. O rutas absolutas, o empieza cada comando con cd "<ruta>" &&. Nunca esperes con bucles de shell (until/while con sleep) ni vigiles archivos de build a mano: los comandos que necesitas ya esperan por ti y terminan solos.

${ctx.e2e ? reproductionSection(ctx.e2e) : ''}
${regressionSection(ctx.regression, primary)}
FORMATO DE SALIDA (imprescindible)
Tu ÚLTIMO mensaje debe terminar con un único bloque de código JSON, sin texto después, con exactamente una de estas formas:

\`\`\`json
{"status":"needs_clarification","questions":["pregunta 1","pregunta 2"]}
\`\`\`

\`\`\`json
{"status":"needs_repos","repos":["nombre_canonico"],"reason":"por qué hace falta tocar ese repositorio"}
\`\`\`

\`\`\`json
{"status":"fixed","branch":"${ctx.branch}","files_changed":["${primary.repoName}/ruta/relativa.ts"],"tests":"passed|failed|none","tests_detail":"suite summary: how many pass/fail, which files fail and whether those failures pre-existed your change","issue":"...","solution":"...","notes_for_qa":"...","reproduction":"reproduced|not_reproduced|not_applicable","regression_test":{"kind":"unit|e2e|none","files":["${primary.repoName}/ruta/del.spec.ts"],"reason":"solo si kind es none"}}
\`\`\`

Los campos issue, solution y notes_for_qa forman el reporte que lee el equipo de QA y van EN INGLÉS:
- issue: what was wrong and why (symptom + root cause), 2-5 sentences, plain language.
- solution: what you changed and why it fixes the root cause; mention each repository touched.
- notes_for_qa: OPTIONAL. Only if there is something QA must verify beyond the ticket, a side effect,
  a related ticket to re-check (cite its key), or a pre-existing test failure. Omit the field if nothing applies.

\`\`\`json
{"status":"cannot_fix","reason":"explicación concreta de por qué no es posible o no es prudente arreglarlo aquí"}
\`\`\`

Si el equipo responde a tus preguntas o añade repositorios, la conversación continúa en esta misma sesión: aplica la información y vuelve a terminar con el bloque JSON.
`.trim();
}

/**
 * Protocolo de reproducción: la misma prueba debe FALLAR antes del fix y PASAR
 * después. Es lo que convierte "solucionado" en algo comprobado.
 */
function reproductionSection(e2e: E2EContext): string {
  const harnessState = e2e.harnessServed
    ? 'Comprobado: el servidor ya la sirve (HTTP 200).'
    : 'ATENCIÓN: al prepararla el servidor NO la servía. Averigua desde qué directorio sirve (salida de la build o su configuración) y copia ahí el archivo antes de seguir.';
  const editNote = e2e.harnessServedDirectly
    ? 'Está en el directorio que el servidor sirve tal cual: guardas y recargas, sin copiarla a ningún sitio ni esperar a ninguna build.'
    : 'Sus cambios se ven al recargar la página.';
  return `
REPRODUCCIÓN EN NAVEGADOR (obligatoria antes de tocar código)
Hay un servidor de desarrollo de ESTE worktree en ${e2e.appUrl} (ambiente de datos: ${e2e.environment}), en modo
watch: cada edición del código la reconstruye solo.

Página de embebido ya preparada: "${e2e.harnessFile}"
Se abre en ${e2e.harnessUrl}. ${harnessState}
Ya trae la configuración (api_key, app_id, domain, user_id, qrveyid) y los lanzadores apuntando al servidor
LOCAL. Ajusta el tag del widget y "settings" al caso del ticket. ${editNote}
NUNCA apuntes los lanzadores al dominio publicado: se probaría código que no es el tuyo.
Si en el archivo quedó un TODO de lanzador, lista el directorio de salida de la build y escribe la ruta
correcta con el prefijo ${e2e.appUrl}.

Directorio de la prueba: "${e2e.e2eDir}" (fuera del repositorio). Ahí van el spec y cualquier script
auxiliar. Ya tiene un enlace node_modules con @playwright/test y playwright, así que \`node "<script>.mjs"\`
funciona sin instalar ni enlazar nada, y un bugs-manager.json con la URL de la app y el worktree que el
wrapper lee solo.

El vídeo de la prueba es la evidencia que verá el equipo de QA, así que la reproducción debe hacerse COMO
LA HARÍA UNA PERSONA, por la interfaz del widget embebido en el harness:
- Navega al harness, espera a que el widget se pinte y después haz clic, escribe y navega igual que el
  usuario del ticket. Las aserciones van sobre lo que se ve en pantalla (textos y elementos visibles).
- NO montes el componente suelto en un div ni fuerces el escenario escribiendo el estado interno con
  page.evaluate. Recurre a eso solo si no hay ninguna forma de llegar a la pantalla por la interfaz, y en
  ese caso dilo en "notes_for_qa": la evidencia es más débil.
- Añade una espera corta (await page.waitForTimeout(1500)) justo antes de la aserción que falla, para que
  el vídeo muestre el estado del bug el tiempo suficiente para verlo.

Protocolo:
1. Escribe el spec en "${e2e.specPath}". Debe AFIRMAR el comportamiento correcto (el del ticket ya
   arreglado), de modo que con el bug presente falle. Usa \`import { test, expect } from '@playwright/test'\`.
2. Ejecútalo ANTES de tocar código, con un timeout de 5 minutos:
   node "${e2e.wrapperPath}" --phase before "${e2e.specPath}"
   Debe FALLAR. Si pasa, o no consigues montar la pantalla, NO inventes un arreglo: termina con
   needs_clarification explicando qué intentaste y pregunta si continuar solo con código.
3. Aplica el fix.
4. Inmediatamente después, ejecuta EL MISMO spec sin modificarlo, con un timeout de 5 minutos:
   node "${e2e.wrapperPath}" --phase after "${e2e.specPath}"
   El wrapper espera él solo a que el servidor responda y a que la reconstrucción haya recogido tus
   cambios, y lo va contando por pantalla. NO escribas bucles de espera ni compruebes archivos de build
   a mano: es la forma más frecuente de dejar la sesión colgada durante minutos.
   Debe PASAR. Si no pasa, sigue trabajando o explica por qué en cannot_fix.
5. Reporta "reproduction":"reproduced". El servicio lee los informes de ambas fases y comprueba que
   realmente falló antes y pasó después, así que no sirve de nada afirmarlo sin ejecutarlo.
Dentro del worktree solo debe quedar el fix: el spec, sus artefactos y la página de embebido no cuentan
como cambios ni los recoge el runner de tests del repo.
`;
}

/** Primer mensaje: el ticket completo tal como se leyó en Jira, más el análisis del triaje. */
export function buildInitialPrompt(ctx: PromptContext): string {
  return `
Resuelve el siguiente bug reportado en Jira.

${ticketBlock(ctx.ticket)}
${notesBlock(ctx.notes)}${
    ctx.triageAnalysis
      ? `
ANÁLISIS PREVIO (triaje sobre el catálogo de la plataforma; verifícalo en el código, puede estar equivocado)
${ctx.triageAnalysis}
`
      : ''
  }
PASOS
1. Explora el código relevante en los worktrees y localiza la causa raíz del problema descrito.
2. Si el ticket no da suficiente información, pregunta (needs_clarification). Si hace falta otro repositorio, pídelo (needs_repos).
3. ANTES de tocar el código de producción, escribe el spec de regresión y ejecútalo con el wrapper en fase before (debe fallar).
4. Aplica el fix mínimo y ejecuta el MISMO spec en fase after (debe pasar). Después, los tests relevantes de los worktrees tocados, y revisa el diff.
5. Termina con el bloque JSON del contrato, con regression_test.
`.trim();
}

/** Mensaje de reanudación con la respuesta humana. */
export function buildResumePrompt(answer: string): string {
  return `Respuesta del equipo a tus preguntas:\n\n${answer.trim()}\n\nContinúa aplicando esta información. Si sigue habiendo ambigüedad, vuelve a preguntar. Termina siempre con el bloque JSON del contrato.`;
}

/** Reanudación tras crear los worktrees que Claude pidió con needs_repos. */
export function buildReposAddedPrompt(added: FixWorktree[], rejected: string[]): string {
  const lines = added.map((w) => `- ${w.repoName}: ${w.worktreePath}${w.testCommand ? ` · tests: ${w.testCommand}` : ''}`);
  const rej = rejected.length ? `\n\nEl equipo NO autorizó estos repositorios: ${rejected.join(', ')}. No los pidas de nuevo; si el fix es imposible sin ellos, reporta cannot_fix explicándolo.` : '';
  return `Worktrees adicionales creados en la misma rama, ya accesibles para leer y editar:\n${lines.join('\n')}${rej}\n\nContinúa con el fix coordinando los cambios entre repositorios. Ejecuta los tests de cada worktree tocado y termina con el bloque JSON del contrato (files_changed con prefijo <repo>/).`;
}

/** Cuando el equipo rechaza todos los repos pedidos. */
export function buildReposRejectedPrompt(rejected: string[]): string {
  return `El equipo NO autorizó trabajar en ${rejected.join(', ')}. Continúa solo con los worktrees que ya tienes. Si el fix es imposible sin esos repositorios, reporta cannot_fix explicando exactamente qué habría que cambiar allí. Termina con el bloque JSON del contrato.`;
}

/** Mensajes libres del equipo escritos en el hilo (o el dashboard) fuera de una pregunta explícita. */
export function buildFollowUpPrompt(messages: string[], pendingQuestion?: string): string {
  const list = messages.length === 1 ? messages[0]!.trim() : messages.map((m, i) => `${i + 1}. ${m.trim()}`).join('\n');
  const pending = pendingQuestion
    ? `\n\nTenías estas preguntas pendientes:\n${pendingQuestion}\nSi los mensajes las responden, continúa; si no, vuelve a preguntar lo que falte.`
    : '';
  return `Mensaje(s) adicional(es) del equipo sobre este bug:\n\n${list}${pending}\n\nTenlos en cuenta como instrucciones de quien pidió el fix: revisa si cambian tu análisis o tu implementación y actúa en consecuencia. Recuerda: sin commits, cambios mínimos, y termina siempre con el bloque JSON del contrato reflejando el estado actual de los worktrees.`;
}

/** Comando típico para ejecutar UN archivo de spec con la infraestructura que ya tiene el repo. */
export function suggestedSpecCommand(frameworks: string[]): string {
  if (frameworks.includes('@stencil/core')) return 'npx stencil test --spec -- <spec>';
  if (frameworks.includes('vitest')) return 'npx vitest run <spec>';
  if (frameworks.includes('jest')) return 'npx jest <spec>';
  if (frameworks.includes('mocha')) return 'npx mocha <spec>';
  return 'npm test -- <spec>';
}

/**
 * Spec de regresión obligatorio: la misma disciplina que la reproducción en navegador, pero
 * sobre un test DEL REPOSITORIO, que es lo que protege el arreglo en el futuro.
 */
function regressionSection(reg: RegressionContext, primary: FixWorktree): string {
  const frameworks = reg.frameworks.length ? reg.frameworks.join(', ') : 'ninguno detectado en package.json';
  const configured = reg.testCommand ? ` El comando de tests configurado para el repo es "${reg.testCommand}".` : '';
  return `
SPEC DE REGRESIÓN (${reg.required ? 'OBLIGATORIO en cada fix' : 'esperado en cada fix'})
Todo fix debe quedar cubierto por un spec DEL REPOSITORIO que falle sin el fix y pase con él. La prueba de
Playwright del harness es evidencia para QA y NO cuenta: vive fuera del repo. Usa solo la infraestructura de
tests que el repo ya tiene (detectada: ${frameworks}) y sus convenciones de ubicación y nombre; nunca añadas
dependencias para testear.${configured}
Comando típico para un archivo: ${suggestedSpecCommand(reg.frameworks)}
Protocolo, con el wrapper que registra cada ejecución (el servicio lee esos registros; afirmarlo no basta):
1. Localizada la causa y ANTES de tocar el código de producción, escribe el spec: un archivo nuevo o un caso
   nuevo en un spec existente, que afirme el comportamiento correcto.
2. Ejecútalo en fase before; debe FALLAR:
   node "${reg.wrapperPath}" --phase before --cwd "${primary.worktreePath}" --out "${reg.outDir}" --spec "<ruta relativa del spec>" -- <comando de test para ese archivo>
3. Aplica el fix.
4. Ejecuta EXACTAMENTE el mismo comando con --phase after; debe PASAR. (--cwd es el worktree del repo donde
   vive el spec.) Si ya habías aplicado el fix antes de escribir el spec, revierte tu cambio a mano de forma
   temporal, ejecuta before, vuelve a aplicarlo y ejecuta after. Nunca uses git stash ni git checkout para eso.
5. Reporta "regression_test":{"kind":"unit","files":["${primary.repoName}/<ruta del spec>"]}. Si de verdad es
   imposible cubrirlo (di por qué con precisión), {"kind":"none","reason":"..."}: una persona decidirá si
   acepta el fix sin spec.
`;
}

/** El fix llegó sin spec verificado: se le pide una vez, con el veredicto exacto. */
export function buildRegressionPrompt(label: string, reg: RegressionContext, primary: FixWorktree): string {
  return [
    `El fix no tiene un spec de regresión verificado: ${label}.`,
    'Hace falta un spec DEL REPOSITORIO que falle sin el fix y pase con él, ejecutado en ambas fases con el wrapper, con el MISMO comando y el spec entre los archivos modificados:',
    `  node "${reg.wrapperPath}" --phase before --cwd "${primary.worktreePath}" --out "${reg.outDir}" --spec "<ruta relativa>" -- <comando de test>`,
    '  (con el fix revertido temporalmente a mano si ya está aplicado; después vuelve a aplicarlo y ejecuta --phase after con el mismo comando)',
    `Comando típico: ${suggestedSpecCommand(reg.frameworks)}. Solo infraestructura que el repo ya tenga.`,
    'Si de verdad no es posible cubrirlo, responde con "regression_test":{"kind":"none","reason":"<motivo concreto>"} y una persona decidirá.',
    'Termina con el bloque JSON completo del contrato (status fixed, con regression_test y files_changed actualizados).',
  ].join('\n');
}

/** El bloque llegó pero no cumple el contrato: se le dice exactamente qué corregir. */
export function buildInvalidJsonPrompt(issues: string[]): string {
  return [
    'Tu bloque ```json final NO cumple el contrato:',
    ...issues.map((i) => `- ${i}`),
    '',
    'Valores admitidos: "status" ∈ needs_clarification | needs_repos | fixed | cannot_fix. En fixed: "tests" ∈ passed | failed | none',
    '(es el resultado de la suite de tests del REPO; si solo validaste con la prueba de Playwright, pon "none" y cuéntalo en tests_detail),',
    '"reproduction" ∈ reproduced | not_reproduced | not_applicable, y "files_changed" es una lista de "<repo>/<ruta>".',
    'Responde ÚNICAMENTE con el bloque ```json corregido, sin texto antes ni después.',
  ].join('\n');
}

/** Cuando el último mensaje no trajo el bloque JSON, se le pide una vez más. */
export function buildMissingJsonPrompt(): string {
  return 'Tu último mensaje no terminó con el bloque JSON requerido. Responde ÚNICAMENTE con el bloque ```json del contrato que describa el estado actual del trabajo.';
}

// ---------------------------------------------------------------------------

function ticketBlock(t: JiraIssue): string {
  const comments = t.comments.length
    ? t.comments.map((c, i) => `--- Comentario ${i + 1} (${c.author}, ${c.created}) ---\n${c.body}`).join('\n\n')
    : '(sin comentarios)';
  return `TICKET ${t.key}: ${t.summary}
URL: ${t.url}
Estado en Jira: ${t.status} · Tipo: ${t.issueType} · Reportado por: ${t.reporter}

DESCRIPCIÓN
${t.description || '(sin descripción)'}

COMENTARIOS
${comments}
`;
}

function notesBlock(notes: string | undefined): string {
  return notes
    ? `
NOTAS ADICIONALES DEL EQUIPO (quien pidió el fix; si contradicen al ticket, mandan estas)
${notes}
`
    : '';
}

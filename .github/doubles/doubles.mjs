// Domingas: the doubles' guesses.
// Runs in GitHub Actions every time data.json changes. For every member who doesn't have a guess on a book yet,
// it asks Gemini what that member would give the book, and commits the guesses back to data.json.
// The Gemini key lives in the repository secret GEMINI_API_KEY, so it is never on the web page.
//
// The prompt lives in prompt.js at the root of the repo, shared with the page (which uses it for guests).

import {readFileSync, writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
const {personaPrompt, parseReply} = createRequire(import.meta.url)('../../prompt.js');

const FILE = process.env.DATA_FILE || 'data.json';
const BRANCH = process.env.BRANCH || 'main';
const MODEL = process.env.DOUBLES_MODEL || 'gemini-3.5-flash-lite';
const MAX_PER_RUN = Number(process.env.MAX_PER_RUN || 30); // tope de preguntas por ejecución (controla el gasto)
const PAUSE_MS = Number(process.env.PAUSE_MS ?? 4000);     // pausa entre preguntas, para no pasar el límite por minuto del plan gratuito
const API = process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com';
// Modo (botón "Run workflow" en Actions → Dobles):
//   normal            → solo las notas que faltan (lo que pasa al guardar en la página)
//   rehacer-sin-nota  → además rehace las de libros que el miembro aún no ha puntuado (útil al cambiar el prompt)
//   probar            → enseña qué contestaría ahora para todos, sin guardar nada
const MODE = process.env.MODE || 'normal';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const git = (...args) => execFileSync('git', args, {stdio:['ignore', 'pipe', 'pipe']}).toString().trim();
const read = () => JSON.parse(readFileSync(FILE, 'utf8'));
const rKey = (b, m) => b + '~' + m;
const isNum = v => typeof v === 'number' && isFinite(v);
const scored = x => x && isNum(x.score);

/* ---------- same derived data as index.html ---------- */
function view(d){
  const col = c => (d[c] && typeof d[c] === 'object') ? d[c] : {};
  const S = {members:col('members'), books:col('books'), ratings:col('ratings'), personas:col('personas')};
  const bookKey = b => b.date || (b.month ? b.month + '-01' : '');
  return {
    S,
    members: () => Object.entries(S.members).map(([id, m]) => ({id, ...m})).sort((a, b) => (a.name || '').localeCompare(b.name || '', 'es')),
    books: () => Object.entries(S.books).map(([id, b]) => ({id, ...b})).sort((a, b) => bookKey(b).localeCompare(bookKey(a)) || (b.at || 0) - (a.at || 0)),
    real: (b, m) => S.ratings[rKey(b, m)],
    guess: (b, m) => S.personas[rKey(b, m)],
  };
}
/* ---------- ask Gemini ---------- */
class GeminiError extends Error { constructor(code, msg){ super(msg || code); this.code = code; } }
async function callGemini(prompt){
  const res = await fetch(`${API}/v1beta/models/${encodeURIComponent(MODEL)}:generateContent`, {method:'POST',
    headers:{'content-type':'application/json', 'x-goog-api-key':process.env.GEMINI_API_KEY},
    body:JSON.stringify({contents:[{role:'user', parts:[{text:prompt}]}], generationConfig:{responseMimeType:'application/json', maxOutputTokens:2048}})});
  const j = await res.json().catch(() => ({}));
  if (!res.ok){
    const msg = (j.error && j.error.message) || `HTTP ${res.status}`;
    if (res.status === 429) throw new GeminiError('rate_limited', msg);
    if (res.status === 401 || res.status === 403 || /api key/i.test(msg)) throw new GeminiError('bad_key', msg);
    if (res.status === 404) throw new GeminiError('bad_model', msg);
    throw new GeminiError('error', msg);
  }
  if (j.promptFeedback && j.promptFeedback.blockReason) throw new GeminiError('blocked', 'bloqueado: ' + j.promptFeedback.blockReason);
  const c = (j.candidates || [])[0];
  return ((c && c.content && c.content.parts) || []).map(p => p.text || '').join('');
}
async function ask(prompt){
  let text;
  for (let attempt = 0; ; attempt++){
    try { text = await callGemini(prompt); break; }
    catch (e) { if (e.code !== 'rate_limited' || attempt >= 3) throw e; console.log('Límite por minuto de Gemini; esperando…'); await sleep(30000 * (attempt + 1)); }
  }
  return parseReply(text);
}

async function main(){
  if (!process.env.GEMINI_API_KEY){
    console.log('::warning::Falta el secreto GEMINI_API_KEY (Settings → Secrets and variables → Actions). Los dobles no pueden pensar.');
    return;
  }
  // Partimos de la última versión: si se guardó varias veces seguidas, esta ejecución puede venir de un commit antiguo.
  git('config', 'user.name', 'Domingas (dobles)');
  git('config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com');
  git('fetch', 'origin', BRANCH);
  git('reset', '--hard', `origin/${BRANCH}`);
  const V = view(read());
  const redo = (b, m) => MODE === 'rehacer-sin-nota' && V.guess(b.id, m.id) && !scored(V.real(b.id, m.id));
  const todo = [];
  for (const b of V.books()) for (const m of V.members()) if (MODE === 'probar' || !V.guess(b.id, m.id) || redo(b, m)) todo.push({b, m});
  if (!todo.length){ console.log(MODE === 'rehacer-sin-nota' ? 'No hay notas que rehacer: todas las que hay tienen ya nota real o faltan por pedir.' : 'Todos los dobles tienen ya su nota.'); return; }
  console.log(`Modo ${MODE}: ${todo.length} ${MODE === 'probar' ? 'pruebas' : 'notas de dobles pendientes'}; esta vez se piden hasta ${MAX_PER_RUN}.`);
  if (MODE === 'probar') console.log(`\n----- Prompt de ejemplo (${todo[0].m.name} · "${todo[0].b.title}") -----\n${personaPrompt(V.S, todo[0].m.id, todo[0].b.id)}\n-----\n`);

  const results = {};
  for (const [i, {b, m}] of todo.slice(0, MAX_PER_RUN).entries()){
    if (i) await sleep(PAUSE_MS);
    try {
      const g = await ask(personaPrompt(V.S, m.id, b.id));
      results[rKey(b.id, m.id)] = {bookId:b.id, memberId:m.id, score:g.score, comment:g.comment, at:Date.now()};
      if (MODE === 'probar'){
        const old = V.guess(b.id, m.id), r = V.real(b.id, m.id);
        console.log(`\n${m.name} · "${b.title}"${scored(r) ? ` (nota real: ${r.score})` : ''}`);
        if (old) console.log(`  antes: ${old.score} · ${old.comment}`);
        console.log(`  ahora: ${g.score} · ${g.comment}`);
      } else console.log(`✓ ${m.name} · "${b.title}": ${g.score}${redo(b, m) ? ' (rehecha)' : ''}`);
    } catch (e) {
      if (e.code === 'bad_key'){ console.log('::error::La clave GEMINI_API_KEY no es válida: ' + e.message); break; }
      if (e.code === 'bad_model'){ console.log(`::error::Gemini no reconoce el modelo ${MODEL}: ${e.message}`); break; }
      if (e.code === 'rate_limited'){ console.log('::warning::Se ha agotado el límite de Gemini por ahora; lo que falta se pedirá en la próxima ejecución.'); break; }
      console.log(`✗ ${m.name} · "${b.title}": ${e.message}`); // se reintentará en la próxima ejecución
    }
  }
  if (!Object.keys(results).length){ process.exitCode = 1; return; }
  if (MODE === 'probar'){ console.log('\nModo probar: no se ha guardado nada.'); return; }

  // Guardar: partimos siempre de la última versión, por si alguien ha guardado mientras tanto.
  for (let attempt = 0; attempt < 5; attempt++){
    git('fetch', 'origin', BRANCH);
    git('reset', '--hard', `origin/${BRANCH}`);
    const d = read(), W = view(d);
    let n = 0;
    for (const [k, g] of Object.entries(results)){
      // solo si sigue faltando (o se rehace y aún no hay nota real) y el libro y el miembro siguen existiendo
      const free = !W.S.personas[k] || (MODE === 'rehacer-sin-nota' && !scored(W.S.ratings[k]));
      if (free && W.S.books[g.bookId] && W.S.members[g.memberId]){ W.S.personas[k] = g; n++; }
    }
    if (!n){ console.log('Nada nuevo que guardar.'); return; }
    const doc = {...d, updatedAt:new Date().toISOString(), personas:W.S.personas};
    writeFileSync(FILE, JSON.stringify(doc, null, 2) + '\n');
    git('add', FILE);
    git('commit', '-m', `Domingas: ${n === 1 ? 'nota de un doble' : `notas de ${n} dobles`}${MODE === 'rehacer-sin-nota' ? ' (rehechas)' : ''}`);
    try { git('push', 'origin', `HEAD:${BRANCH}`); console.log(`Guardadas ${n} notas.`); return; }
    catch (e) { console.log('Alguien guardó a la vez; reintentando…'); await new Promise(r => setTimeout(r, 2000 * (attempt + 1))); }
  }
  throw new Error('No se pudo guardar después de varios intentos.');
}

main().catch(e => { console.error(e); process.exit(1); });

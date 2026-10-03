// Domingas: the doubles' guesses.
// Runs in GitHub Actions every time data.json changes. For every member who doesn't have a guess on a book yet,
// it asks Gemini what that member would give the book, and commits the guesses back to data.json.
// The Gemini key lives in the repository secret GEMINI_API_KEY, so it is never on the web page.
//
// This is the only place the doubles' prompt lives (see personaPrompt below).

import {readFileSync, writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';

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
function aboutMember(m){
  if (m.bio) return m.bio;
  return [m.age ? `Tengo ${m.age} años.` : '', m.likes ? `Busco en un libro: ${m.likes}.` : '', m.favs ? `Mis favoritos: ${m.favs}.` : '', m.notes || ''].filter(Boolean).join(' ');
}
function personaPrompt(V, m, b){
  const {books, real, guess} = V;
  const past = books().filter(x => x.id !== b.id).reverse();
  const hist = past.map(x => { const r = real(x.id, m.id); if (!r || (!scored(r) && !r.comment)) return null;
    return `- "${x.title}"${x.author ? ' by ' + x.author : ''}: ${scored(r) ? r.score + '/10' : 'no score'}${r.comment ? `. Said: "${r.comment}"` : ''}`; }).filter(Boolean);
  const calib = past.map(x => { const r = real(x.id, m.id), g = guess(x.id, m.id);
    return scored(r) && scored(g) ? `- "${x.title}": you guessed ${g.score}, the real ${m.name} gave ${r.score}` : null; }).filter(Boolean);
  const intro = aboutMember(m);
  return `You're playing a game with Domingas, a monthly book club in Spain. Each member has a "double", and you are ${m.name}'s: you guess the score from 1 to 10 that ${m.name} would give the club's book, and what they'd say about it at the meeting. After the meeting the club compares your guess with ${m.name}'s real score, so getting the score right matters most. Your comment is read out loud to the group, so it should sound like a real person reacting to this particular book, not like a summary of ${m.name}'s profile.

## What you know about ${m.name}

How they described their reading taste when they joined the club. It's about their taste in general, written before this book:
<introduction>
${intro || '(no introduction yet)'}
</introduction>

Their real scores for other club books, oldest first:
${hist.length ? hist.join('\n') : '(none yet)'}

Your earlier guesses for ${m.name} next to their real scores:
${calib.length ? calib.join('\n') : '(none yet)'}

## The book

"${b.title}"${b.author ? ` by ${b.author}` : ''}${b.about ? `\nClub synopsis: ${b.about}` : ''}
The club's synopsis is often a single line. If you know this book, draw on what you know about it: its plot, characters, style, pacing, ending and how readers received it.

## How to guess

The score: real scores and comments are the best evidence of how ${m.name} judges books, so lean on them first and on the introduction second. If your earlier guesses ran consistently high or low, adjust for it. When there's no history yet, treat the introduction as a rough hint about taste rather than a rule: people often enjoy books outside their stated taste, and are often disappointed by books they "should" love. Use the whole range the way a real reader would; not every book is a 7 or 8.

The comment: what ${m.name} would actually say about this book at the meeting, in Spanish from Spain, first person, casual spoken tone, at most 45 words. Talk about the book itself, for example a moment, a character, the writing, the ending, or how it made them feel. Let the introduction shape the opinion without showing up in the words: don't reuse its phrases, don't explain ${m.name}'s own taste ("como me encantan los clásicos…"), and don't mention their favourite books unless the comparison really comes up naturally. The comment should match the score: a 4 sounds disappointed, a 6 lukewarm, a 9 enthusiastic.

Reply with only a JSON object, with no other text:
{"score": <whole number from 1 to 10>, "comment": "<what they'd say>"}`;
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
  const a = text.indexOf('{'), b = text.lastIndexOf('}');
  if (a < 0 || b < a) throw new Error('no JSON in reply');
  const out = JSON.parse(text.slice(a, b + 1));
  return {
    score: Math.max(1, Math.min(10, Math.round(Number(out.score)) || 5)),
    comment: String(out.comment || '').trim().slice(0, 320),
  };
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
  if (MODE === 'probar') console.log(`\n----- Prompt de ejemplo (${todo[0].m.name} · "${todo[0].b.title}") -----\n${personaPrompt(V, todo[0].m, todo[0].b)}\n-----\n`);

  const results = {};
  for (const [i, {b, m}] of todo.slice(0, MAX_PER_RUN).entries()){
    if (i) await sleep(PAUSE_MS);
    try {
      const g = await ask(personaPrompt(V, m, b));
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

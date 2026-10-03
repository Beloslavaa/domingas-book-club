// Domingas: the doubles' guesses.
// Runs in GitHub Actions every time data.json changes. For every member who doesn't have a guess on a book yet,
// it asks Gemini what that member would give the book, and commits the guesses back to data.json.
// The Gemini key lives in the repository secret GEMINI_API_KEY, so it is never on the web page.
//
// The prompt mirrors personaPrompt() in index.html: if you change one, change the other.

import {readFileSync, writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';

const FILE = process.env.DATA_FILE || 'data.json';
const BRANCH = process.env.BRANCH || 'main';
const MODEL = process.env.DOUBLES_MODEL || 'gemini-3.5-flash-lite';
const MAX_PER_RUN = Number(process.env.MAX_PER_RUN || 30); // tope de preguntas por ejecución (controla el gasto)
const PAUSE_MS = Number(process.env.PAUSE_MS ?? 4000);     // pausa entre preguntas, para no pasar el límite por minuto del plan gratuito
const API = process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com';
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
    return `- "${x.title}"${x.author ? ' by ' + x.author : ''}: gave ${scored(r) ? r.score + '/10' : 'no score'}${r.comment ? `. Said: "${r.comment}"` : ''}`; }).filter(Boolean);
  const calib = past.map(x => { const r = real(x.id, m.id), g = guess(x.id, m.id);
    return scored(r) && scored(g) ? `- "${x.title}": you guessed ${g.score}, the real ${m.name} gave ${r.score}` : null; }).filter(Boolean);
  return `You are the "double" of ${m.name}, a member of Domingas, a monthly book club in Spain. Predict how the real ${m.name} would rate a book the club read.

HOW ${m.name.toUpperCase()} INTRODUCES THEMSELVES
${aboutMember(m) || '(no introduction yet)'}

THEIR REAL RATINGS OF OTHER CLUB BOOKS (oldest first)
${hist.length ? hist.join('\n') : '(none yet)'}

YOUR PAST GUESSES VERSUS REALITY
${calib.length ? calib.join('\n') + '\nLearn from these misses: if you tend to be too generous or too harsh, correct for it. When their real ratings disagree with how they describe themselves, trust the real ratings.' : '(no track record yet)'}

THE BOOK
"${b.title}"${b.author ? ' by ' + b.author : ''}${b.about ? `\nSynopsis: ${b.about}` : ''}

Assume ${m.name} finished it. Give the score they would actually give, using the 1 to 10 range the way they do. Then write what they'd say about it at the meeting, in their own voice, in Spanish from Spain.

Reply with ONLY a JSON object, no prose and no code fences:
{"score":7,"comment":"first person, in Spanish, max 45 words"}`;
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
  const V = view(read());
  const todo = [];
  for (const b of V.books()) for (const m of V.members()) if (!V.guess(b.id, m.id)) todo.push({b, m});
  if (!todo.length){ console.log('Todos los dobles tienen ya su nota.'); return; }
  console.log(`${todo.length} notas de dobles pendientes; esta vez se piden hasta ${MAX_PER_RUN}.`);

  const results = {};
  for (const [i, {b, m}] of todo.slice(0, MAX_PER_RUN).entries()){
    if (i) await sleep(PAUSE_MS);
    try {
      const g = await ask(personaPrompt(V, m, b));
      results[rKey(b.id, m.id)] = {bookId:b.id, memberId:m.id, score:g.score, comment:g.comment, at:Date.now()};
      console.log(`✓ ${m.name} · "${b.title}": ${g.score}`);
    } catch (e) {
      if (e.code === 'bad_key'){ console.log('::error::La clave GEMINI_API_KEY no es válida: ' + e.message); break; }
      if (e.code === 'bad_model'){ console.log(`::error::Gemini no reconoce el modelo ${MODEL}: ${e.message}`); break; }
      if (e.code === 'rate_limited'){ console.log('::warning::Se ha agotado el límite de Gemini por ahora; lo que falta se pedirá en la próxima ejecución.'); break; }
      console.log(`✗ ${m.name} · "${b.title}": ${e.message}`); // se reintentará en la próxima ejecución
    }
  }
  if (!Object.keys(results).length){ process.exitCode = 1; return; }

  // Guardar: partimos siempre de la última versión, por si alguien ha guardado mientras tanto.
  git('config', 'user.name', 'Domingas (dobles)');
  git('config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com');
  for (let attempt = 0; attempt < 5; attempt++){
    git('fetch', 'origin', BRANCH);
    git('reset', '--hard', `origin/${BRANCH}`);
    const d = read(), W = view(d);
    let n = 0;
    for (const [k, g] of Object.entries(results)){
      // solo si sigue faltando y el libro y el miembro siguen existiendo
      if (!W.S.personas[k] && W.S.books[g.bookId] && W.S.members[g.memberId]){ W.S.personas[k] = g; n++; }
    }
    if (!n){ console.log('Nada nuevo que guardar.'); return; }
    const doc = {...d, updatedAt:new Date().toISOString(), personas:W.S.personas};
    writeFileSync(FILE, JSON.stringify(doc, null, 2) + '\n');
    git('add', FILE);
    git('commit', '-m', `Domingas: ${n === 1 ? 'nota de un doble' : `notas de ${n} dobles`}`);
    try { git('push', 'origin', `HEAD:${BRANCH}`); console.log(`Guardadas ${n} notas.`); return; }
    catch (e) { console.log('Alguien guardó a la vez; reintentando…'); await new Promise(r => setTimeout(r, 2000 * (attempt + 1))); }
  }
  throw new Error('No se pudo guardar después de varios intentos.');
}

main().catch(e => { console.error(e); process.exit(1); });

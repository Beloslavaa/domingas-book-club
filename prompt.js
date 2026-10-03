// Domingas: the prompt for the doubles. This is the only copy.
// Used by the GitHub Action (.github/doubles/doubles.mjs) for club members, and by the page (index.html) for guests.
// personaPrompt(data, memberId, bookId) takes the club data ({members, books, ratings, personas}, as in data.json).
(function (root) {
  const rKey = (b, m) => b + '~' + m;
  const scored = x => x && typeof x.score === 'number' && isFinite(x.score);
  const bookKey = b => b.date || (b.month ? b.month + '-01' : '');

  function aboutMember(m) {
    if (m.bio) return m.bio;
    return [m.age ? `Tengo ${m.age} años.` : '', m.likes ? `Busco en un libro: ${m.likes}.` : '', m.favs ? `Mis favoritos: ${m.favs}.` : '', m.notes || ''].filter(Boolean).join(' ');
  }

  function personaPrompt(data, memberId, bookId) {
    const m = data.members[memberId], b = data.books[bookId];
    const real = (bid) => (data.ratings || {})[rKey(bid, memberId)];
    const guess = (bid) => (data.personas || {})[rKey(bid, memberId)];
    // other club books, oldest first
    const past = Object.entries(data.books).map(([id, x]) => ({id, ...x}))
      .sort((x, y) => bookKey(x).localeCompare(bookKey(y)) || (x.at || 0) - (y.at || 0))
      .filter(x => x.id !== bookId);
    const hist = past.map(x => { const r = real(x.id); if (!r || (!scored(r) && !r.comment)) return null;
      return `- "${x.title}"${x.author ? ' by ' + x.author : ''}: ${scored(r) ? r.score + '/10' : 'no score'}${r.comment ? `. Said: "${r.comment}"` : ''}`; }).filter(Boolean);
    const calib = past.map(x => { const r = real(x.id), g = guess(x.id);
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

  // Reads Gemini's reply into {score, comment}, or throws if it isn't the JSON we asked for.
  function parseReply(text) {
    const a = text.indexOf('{'), b = text.lastIndexOf('}');
    if (a < 0 || b < a) throw new Error('no JSON in reply');
    const out = JSON.parse(text.slice(a, b + 1));
    return {
      score: Math.max(1, Math.min(10, Math.round(Number(out.score)) || 5)),
      comment: String(out.comment || '').trim().slice(0, 320),
    };
  }

  const api = {personaPrompt, parseReply};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.DomingasPrompt = api;
})(this);

# Domingas

The Domingas book club app: a Game Boy–style room where everyone rates each month's book from 1 to 10, and an AI "double" of each member guesses what they would have said.

It runs entirely on GitHub, with no other server or account:

- **GitHub Pages** serves the page.
- **`data.json`** in this repository holds the club's data. The page reads it when it opens and writes changes back as small commits.
- **A GitHub Action** has the doubles guess automatically. Whenever a book or a member is added, it asks Google's Gemini for the missing guesses and commits them to `data.json`. The Gemini key is stored as a repository secret, so it's never on the page.

Members join by opening an **invite link** once. After that they can add books and rate from that browser, with nothing to set up.

## Files

| File | What it is |
| --- | --- |
| `index.html` | The whole app (HTML, CSS and JavaScript in one file). |
| `data.json` | The club's data: members, books, ratings and the doubles' guesses. |
| `.nojekyll` | Tells GitHub Pages to serve the files as they are. |
| `favicon.svg`, `favicon-32.png`, `apple-touch-icon.png` | The pixel book icon for browser tabs and phone home screens. |
| `.github/workflows/doubles.yml` | The Action that runs the doubles when `data.json` changes. |
| `.github/doubles/doubles.mjs` | The script it runs. |
| `prompt.js` | The prompt that tells Gemini how to play each double. The Action uses it for members, and the page uses it for guests. |

## Setup (about 15 minutes, done once by whoever runs the club)

1. **Create a repository** on GitHub, for example `domingas`, and upload all the files to the root of the `main` branch, **including the `.github` folder**.
   macOS hides folders whose name starts with a dot. In Finder press **Cmd+Shift+.** to show them before dragging. If the upload still skips it, create the two files by hand with **Add file → Create new file**, typing the full path, for example `.github/workflows/doubles.yml`, and pasting the contents.
2. **Turn on GitHub Pages:** *Settings → Pages → Build and deployment → Deploy from a branch*, pick `main` and `/ (root)`. After a minute the club lives at `https://YOUR-USER.github.io/domingas/`.
3. **Give the doubles a Gemini key:**
   - Create a key at [aistudio.google.com/apikey](https://aistudio.google.com/apikey). The free tier is enough for a book club.
   - In the repository: *Settings → Secrets and variables → Actions → New repository secret*. Name it `GEMINI_API_KEY` and paste the key.
   - Under *Actions → Dobles → Run workflow*, run it once to give the doubles a guess for every book already in the club.
4. **Create the club's GitHub token**, which lets the page save:
   - *GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token*.
   - *Repository access:* **Only select repositories**, then pick your Domingas repo.
   - *Permissions → Repository permissions → Contents:* **Read and write**. Nothing else.
   - *Expiration:* up to a year. When it expires, create a new one, open the club address with `#club=` and the new token on the end, and send everyone the new invite link from Ajustes.
5. **Join and invite the club:** open `https://beloslavaa.github.io/domingas-book-club/#club=` followed by the token, on each of your own devices. Then go to **Menú → Ajustes**, tap **Copiar enlace de invitación** and send that link privately to each member, for example in your WhatsApp group.

## For members

- **Open the invite link once** on each phone or computer you'll use. The page saves access in that browser and removes it from the address bar. From then on, just use the normal club address.
- **Without the invite link** you're a guest. You see the club's books, but not its members or their scores. You can create a member for yourself and rate the books, but that's only for you: it's never saved, and it disappears when you close the tab. Guests can't add books. If the guest doubles are set up (see below), they can also ask their own double what they'd give each book; that isn't saved either.
- **The doubles guess on their own** a minute or two after a book or member is added. Until then, "Jugar a los dobles" says the double is still thinking. The page checks for the guess regularly, so there's no need to reload.
- **Next to each score you can write a short opinion** (optional, up to 280 characters). It appears under the member in the Registro, and the doubles read it to learn how each person thinks about books.
- **Each double guesses once per book.** Once a member's real score is in, their double's guess can't change.

## How saving works

- Every change shows up immediately on screen and is kept in the browser.
- About a second later it is committed to `data.json` ("Domingas: actualización …"). A small pink square on the **Menú** button means there are changes that haven't been uploaded yet.
- If a save fails (no connection, or someone else saving at the same moment), it retries on its own, waiting a little longer each time, and again when you come back to the tab or the connection returns.
- Before each save, the page and the doubles Action both re-read `data.json` and merge, so changes saved at the same time don't overwrite each other.
- Other devices pick up changes when the page is opened, when you come back to the tab, or within a minute or so.
- Opened anywhere other than GitHub Pages (for example a local preview), the page shows the `data.json` next to it and keeps your changes in that browser only.
- **Menú → Ajustes → Descargar JSON** downloads a backup; **Importar JSON** replaces everything with a backup.

## Settings in the code

- **Custom domain:** if you don't use `*.github.io`, open `index.html`, find `const CONFIG` near the top of the script and fill in `owner` and `repo`. The branch and file name are also set there.
- **Model and limits:** the doubles use `gemini-3.5-flash-lite`. Each run asks for at most 30 guesses, 4 seconds apart, to stay under the free tier's per-minute limit. All three can be changed at the top of `.github/doubles/doubles.mjs`. If Gemini says the limit is used up, the run stops, and whatever is missing is asked on the next run.

## Doubles for guests (optional)

Guests aren't saved, so the GitHub Action can't make their doubles. Instead the page asks Gemini directly, with a second key that is **visible to anyone** in the page source. That's only safe if the key can't cost money and only works from this site:

1. In [Google AI Studio](https://aistudio.google.com/apikey), choose **Create API key → in a new project**. Don't add billing to that project, so it stays on the free tier and can never be charged. Keep it separate from the club's key.
2. In [Google Cloud → Credentials](https://console.cloud.google.com/apis/credentials), select that new project and open the key:
   - *Application restrictions:* **Websites**, then add `https://beloslavaa.github.io/*`.
   - *API restrictions:* **Restrict key**, then pick **Generative Language API**.
   - Save.
3. Put the key in `guestKey` inside `const CONFIG` in `index.html`.

If someone copies the key and uses up its free quota, guests see "se ha acabado su cupo de hoy" until the next day. The club's own doubles use the other key and keep working.

## Good to know

- **The invite link is a key.** Anyone who has it can change the club's data, so share it only privately. If it leaks, delete the token on GitHub (*Settings → Developer settings → Fine-grained tokens*), create a new one and send a new link. Browsers using the old link will show "El token de GitHub no es válido" until they open the new one. Every change is a commit, so you can always restore an older `data.json` from the repository history.
- **Privacy:** on a free GitHub account, Pages needs a public repository, so anyone with the link to the repo can read `data.json`, including the members' introductions. Keep the introductions to things you're happy to share, or use a private repo on a paid plan.
- **What Gemini sees:** each request includes the member's introduction, their past scores and comments, and the book. On Gemini's free tier, Google may use what's sent to improve its products, so keep introductions to things you're happy to share. A paid tier doesn't do this.
- **API costs:** the Action makes one short Gemini request per member per book. That usually fits in the free tier. On a paid key it costs a fraction of a cent per request. The workflow's log (*Actions → Dobles*) shows each guess, and any problem such as a wrong key or a used-up limit.

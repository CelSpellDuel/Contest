# SpellDuel

Static site (HTML/CSS/JS) + Supabase. No build step.

## Setup
1. **Supabase → SQL Editor:** paste and run `supabase/schema.sql`.
2. **Authentication → Providers:** enable **Anonymous sign-ins** (students join without accounts).
3. **Authentication → Users → Add user:** create your teacher account (email + password).
   Then turn **off** "Allow new users to sign up" so nobody else can become a teacher.
4. Put your Project URL and anon key in `config.js`.
5. **GitHub:** push the folder, then Settings → Pages → deploy from `main` / root.

**Upgrading an existing project?** Run `migration.sql` once in the SQL Editor *before* deploying the new files. It moves each duel's secret word out of the public `matches` table.

## Using it
- **Teacher:** sign in, create a contest, add words (just type the word; the definition and example fill in automatically), share the code.
- **Students:** Student → enter code and name.
- **Projector:** teacher → **Projector** tab (next to Overview, Contestants, Word bank, Matches, Security). Press **F** or the Fullscreen button, then drag that window to the big screen.
- Start round 1, then press **Start** on each match. Answers are judged automatically; a tie (both right or both wrong) gets a new word.
- Keep the teacher tab open during the contest: it does the judging and advances the bracket.

## AI Master (definitions + example sentences)
**Free option (Google Gemini):**
1. Go to aistudio.google.com/app/apikey, sign in with a Google account, click **Create API key**. No card needed.
2. Supabase → **Edge Functions → Deploy a new function → Via Editor**. Name it `ai-master`, paste `supabase/functions/ai-master/index.ts`, deploy.
3. Supabase → **Edge Functions → Secrets**: add `GEMINI_API_KEY` with your key.
   (If the default model is ever retired, add `GEMINI_MODEL` with a current Flash-Lite model name from AI Studio.)

Paid alternative: add `ANTHROPIC_API_KEY` instead. If both exist, Gemini is used.

On the teacher **Projector** tab, press **Enable AI Master voice** once (browsers need a click). She then reads every new duel aloud. The secret word is never shown on screen, only its letter count.
If AI Master is unavailable, the app falls back to a free dictionary.

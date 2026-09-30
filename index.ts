// AI Master: writes a definition + example sentence for each word.
// Only signed-in teachers can call it. API keys stay in Supabase secrets.
// Free option: set GEMINI_API_KEY (Google AI Studio). Paid option: set ANTHROPIC_API_KEY.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

const SYSTEM = `You are AI Master, a friendly spelling-bee teacher. You receive a JSON array of English words.
Reply with ONLY a JSON array (no markdown), one object per word, in the same order:
{"word": string, "definition": string, "example": string}
- definition: one short, clear sentence for school students, starting with the part of speech in parentheses, e.g. "(noun) ...". It must NOT contain the word itself.
- example: one natural sentence that uses the word exactly as spelled.
- If an item is not a real English word, or you are unsure, return {"word": "...", "error": "not a word"} for it.`;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
  });
  const { data: { user } } = await sb.auth.getUser();
  if (!user || user.is_anonymous) return json({ error: "Teachers only" }, 401);

  const body = await req.json().catch(() => ({}));
  const list = (Array.isArray(body.words) ? body.words : [])
    .map((w: unknown) => String(w).trim())
    .filter((w: string) => /^[\p{L}'’-]{1,40}$/u.test(w))
    .slice(0, 25);
  if (!list.length) return json({ results: [] });

  const parse = (text: string) => {
    try { return json({ results: JSON.parse(text.replace(/```json|```/g, "").trim()) }); }
    catch { return json({ error: "Bad AI reply" }, 502); }
  };

  const gemini = Deno.env.get("GEMINI_API_KEY");
  if (gemini) {
    const model = Deno.env.get("GEMINI_MODEL") ?? "gemini-2.5-flash-lite";
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: "POST",
      headers: { "x-goog-api-key": gemini, "content-type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM }] },
        contents: [{ role: "user", parts: [{ text: JSON.stringify(list) }] }],
        generationConfig: { responseMimeType: "application/json", temperature: 0.4 },
      }),
    });
    if (!r.ok) return json({ error: "AI request failed" }, 502);
    const d = await r.json();
    return parse((d.candidates?.[0]?.content?.parts ?? []).map((x: { text?: string }) => x.text ?? "").join(""));
  }

  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": Deno.env.get("ANTHROPIC_API_KEY") ?? "",
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 2500,
      system: SYSTEM,
      messages: [{ role: "user", content: JSON.stringify(list) }],
    }),
  });
  if (!r.ok) return json({ error: "AI request failed" }, 502);
  const d = await r.json();
  return parse((d.content ?? []).map((c: { text?: string }) => c.text ?? "").join(""));
});

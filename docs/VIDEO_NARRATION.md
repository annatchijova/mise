# Video narration — read this, don't improvise it

A literal, copy-paste script for the ≤3:00 Devpost video (`docs/PLAN.md` §10 sets the 3-minute cap;
`docs/DEMO_SCRIPT.md` has the full beat-by-beat reasoning and is the source this was compressed from —
read that first if a beat here needs more context on *why* it's in). Three kinds of line, and the
language of each is intentional — operator instructions in Spanish, everything you say or type stays
in English because the video is in English:

- **HACÉ:** *(español)* — la acción concreta: en qué hacer click, o qué escribir y dónde.
- **SAY (to Mise):** *(English)* — type or paste this exact text into the simulator's chat input, then
  send it. Also speak it out loud as you type, if you're narrating live instead of dubbing later.
- **NARRATE:** *(English)* — your own voice, over the screen, explaining nothing technical. Say it
  like you're telling a friend what just happened in your kitchen, not presenting a feature.

Timestamps are targets, not a metronome — if a beat runs long, cut from the closing, not the middle.

---

## Antes de grabar — checklist de 3 minutos

1. **Sembrá el pantry para el beat 4.** Verificado en vivo (2026-10-22): el pantry actual no tiene
   tofu ni lechuga por vencer — `zero_waste` sin eso devuelve paté de hongos, no la pareja que este
   beat necesita. Con `pantry_update`, poné tofu cerca de su fecha de vencimiento y lechuga marcada
   como confirmada y cerca del límite de su vida útil. Después corré `zero_waste` sin argumentos y
   confirmá que ahora sí aparece esa pareja, antes de prender la cámara.
2. **Hacé un ensayo completo de la secuencia, una vez, sin grabar.** Dos líneas de este guion nunca se
   probaron exactamente como están escritas (solo se probó el comportamiento subyacente por otro
   camino): la línea "I'm out of broad beans too" del beat 3, y "How many calories is that?" del
   beat 5 (depende de que Gemini resuelva "that" contra el guiso que ya se está cocinando en la
   conversación). Si alguna de las dos no da la respuesta esperada al ensayar, avisame y la
   ajustamos antes de grabar — no lo sueltes así en la toma final sin haberlo visto andar una vez.
3. **Abrí el simulador** (`http://localhost:8095`, o el puerto que hayas usado) **y dejalo en la
   pantalla de inicio**, con el chat vacío, antes de empezar a grabar.

---

## 0:00 – 0:20 — Open on the kitchen, not the code

**HACÉ:** nada todavía en el simulador — esto se graba hablando a cámara o sobre un plano del
logo/presentación, antes de tocar la app.

**NARRATE:**
> I cook. Creative reuse is most of what I do in a kitchen — what's about to turn, what's left in the
> pan, what two things in the fridge have never met but should. And even a chef runs out of ideas some
> nights. This is Mise: a pantry and cooking companion for Alexa+, built so it never once makes
> something up to sound helpful.

## 0:20 – 0:45 — The pantry, and the word "roughly"

**HACÉ:** hacé click en el botón **"What have I got?"** (el primero de los cuatro botones de ejemplo
arriba del chat). No hace falta tipear nada — el botón ya manda el texto exacto.

**SAY:** "What have I got?"

**NARRATE:**
> Notice it doesn't flatten the answer. Spinach is *roughly* four days by its own reckoning. Milk is
> expiring tomorrow because I told it so. The tomato — it just says the amount is unknown. It would be
> so easy to guess a number there. It doesn't.

## 0:45 – 1:25 — The week, and the hash

**HACÉ:** hacé click en el botón **"Plan my week"** (segundo botón). Manda el texto de abajo
automáticamente.

**SAY:** "Plan my dinners through Thursday, forty minutes max."

**NARRATE:**
> Each night comes with its own reason — this one's Thursday because the spinach goes off that day.
> And here's the part I actually care about: run this twice on the same pantry, and it hands back the
> exact same plan, byte for byte. Say the hash out loud if there's room. A model that plans your week
> gives you a different week every time and can't tell you why. This can hand you a receipt.

**HACÉ:** esta vez no hay botón — escribí el texto de abajo en el campo de texto ("Say something to
Mise…") y mandalo con el botón **Send** o Enter.

**SAY:** "We're out on Thursday."

**NARRATE:**
> Move one thing, and the plan explains what shifted and why — in the same terms, not a shrug.

## 1:25 – 2:05 — Cooking, and the two refusals

**HACÉ:** click en el botón **"Cook the stew"** (tercer botón). El texto real que manda este botón es
el de abajo — usalo tal cual, no lo cambies por otra frase, porque es la que ya está probada contra el
servidor real.

**SAY:** "Let's cook the lentil and chocolate stew."

**NARRATE:**
> The card is a checklist a person can actually shop from — *about 330 grams*, not 333.333.

**HACÉ:** click en el botón **"Substitute tahini"** (cuarto botón).

**SAY:** "I'm out of tahini, what can I use instead?"

**NARRATE:**
> It swaps from a table a cook actually wrote — sunflower seed butter, a ratio, a warning about what
> changes in the flavor. Now ask it about something that table doesn't cover.

**HACÉ:** sin botón — escribí esto en el campo de texto y mandalo. (Esta es una de las dos líneas del
punto 2 del checklist — ensayala antes de grabar.)

**SAY:** "I'm out of broad beans too."

**NARRATE:**
> "I have nothing curated for broad bean — tell me what it was doing in the dish, and I can answer."
> That silence is the whole point. It would rather say nothing than invent a substitution that could
> ruin your dinner — or worse.

## 2:05 – 2:25 — Leftovers, with a name

**HACÉ:** sin botón — escribí esto en el campo de texto y mandalo. Requiere que ya hayas sembrado el
pantry (punto 1 del checklist) antes de grabar.

**SAY:** "The tofu expires tomorrow and the lettuce looks rough. What can I do?"

**NARRATE:**
> It doesn't search "a tofu recipe." It looks at what's already in here, ranks by what's about to
> turn, and pairs it with an actual technique — not "cook better," something concrete. This is the
> creative-reuse instinct I started with, just handed back to me when I'm out of ideas myself.

## 2:25 – 2:45 — The floor, not the hedge

**HACÉ:** sin botón — escribí esto en el campo de texto y mandalo. (La segunda línea sin ensayar del
punto 2 del checklist.)

**SAY:** "How many calories is that?"

**NARRATE:**
> "At least 284 a serving — that's five of six ingredients I can account for, and I have no figures
> for the plant milk powder, so I stop there." Every other assistant gives you a confident number.
> This one tells you exactly where its knowledge runs out, and stands behind the part that's real.

## 2:45 – 3:00 — Close

**HACÉ:** nada en la app — volvé a cámara, o a un plano de la página de GitHub Pages / el logo, para
cerrar.

**NARRATE:**
> Alexa+ is the only thing in this system that talks. Everything it says comes from a deterministic
> server that decided first and never guesses — the pantry, the plan, the substitution, the number.
> The technical case for that — how it's enforced, what's tested, what's still open — is all in the
> README. This is Mise.

---

## If the video is still running long

Cut, in this order, before touching the opener or the closer:

1. The "We're out on Thursday" re-plan line inside beat 2 (saves ~15s).
2. The "broad beans too" refusal in beat 3 — keep only the tahini substitution, drop the "nothing
   curated" follow-up (saves ~10s, but this is the second-best beat in the whole script; cut it last).
3. Shorten the pantry beat's narration to one sentence instead of three.

Do not cut the opener or the closer. The opener is the only place the human story lives; the closer is
the only place that points a judge who wants the technical depth at where it actually is.

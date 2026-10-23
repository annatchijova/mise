# Guion para ElevenLabs — bloques listos para copiar y pegar

Esto es el mismo contenido que `docs/VIDEO_NARRATION.md`, pero sin las instrucciones de qué tocar —
acá solo queda lo que se dice en voz alta, en bloques separados, en el orden en que van en el video.
Cada bloque entre ``` ``` es exactamente lo que va en la caja de texto de ElevenLabs — ni una palabra
más. Las notas fuera de los bloques son para vos, no se pegan.

Alcance: esto cubre tu voz — lo que le decís a Mise y tu narración. No incluye lo que Mise/Gemini
responde, porque esa respuesta no es determinística (el texto exacto varía un poco en cada corrida real)
— esa parte queda como texto en pantalla / audio real capturado en vivo, no como TTS pre-escrito.

Si ElevenLabs te deja etiquetar tono por bloque: los bloques "narración" van con un tono cálido,
conversacional, de alguien contándole algo a un amigo — nunca de presentación corporativa. Los bloques
"a Mise" van con el tono natural de pedirle algo a un asistente de voz, un poco más directo.

---

## Bloque 1 — apertura (narración)

```
I cook. Creative reuse is most of what I do in a kitchen — what's about to turn, what's left in the pan, what two things in the fridge have never met but should. And even a chef runs out of ideas some nights. This is Mise: a pantry and cooking companion for Alexa+, built so it never once makes something up to sound helpful.
```

## Bloque 2 — a Mise, pantry

```
What have I got?
```

## Bloque 3 — narración, pantry

```
Notice it doesn't flatten the answer. Spinach is roughly four days by its own reckoning. Milk is expiring tomorrow because I told it so. The tomato — it just says the amount is unknown. It would be so easy to guess a number there. It doesn't.
```

## Bloque 4 — a Mise, plan semanal

```
Plan my dinners through Thursday, forty minutes max.
```

## Bloque 5 — narración, plan y hash

```
Each night comes with its own reason — this one's Thursday because the spinach goes off that day. And here's the part I actually care about: run this twice on the same pantry, and it hands back the exact same plan, byte for byte. A model that plans your week gives you a different week every time and can't tell you why. This can hand you a receipt.
```

## Bloque 6 — a Mise, cambio de plan

```
We're out on Thursday.
```

## Bloque 7 — narración, el re-plan

```
Move one thing, and the plan explains what shifted and why — in the same terms, not a shrug.
```

## Bloque 8 — a Mise, empezar a cocinar

```
Let's cook the lentil and chocolate stew.
```

## Bloque 9 — narración, la tarjeta de cocina

```
The card is a checklist a person can actually shop from — about 330 grams, not 333.333.
```

## Bloque 10 — a Mise, sustitución que sí existe

```
I'm out of tahini, what can I use instead?
```

## Bloque 11 — narración, la sustitución

```
It swaps from a table a cook actually wrote — sunflower seed butter, a ratio, a warning about what changes in the flavor. Now ask it about something that table doesn't cover.
```

## Bloque 12 — a Mise, sustitución que no existe

```
I'm out of broad beans too.
```

## Bloque 13 — narración, el rechazo

```
I have nothing curated for broad bean — tell me what it was doing in the dish, and I can answer. That silence is the whole point. It would rather say nothing than invent a substitution that could ruin your dinner — or worse.
```

## Bloque 14 — a Mise, sobras

```
The tofu expires tomorrow and the lettuce looks rough. What can I do?
```

## Bloque 15 — narración, zero waste

```
It doesn't search for a tofu recipe. It looks at what's already in here, ranks by what's about to turn, and pairs it with an actual technique — not cook better, something concrete. This is the creative-reuse instinct I started with, just handed back to me when I'm out of ideas myself.
```

## Bloque 16 — a Mise, calorías

```
How many calories is that?
```

## Bloque 17 — narración, el piso no la cobertura

```
At least 284 a serving — that's five of six ingredients I can account for, and I have no figures for the plant milk powder, so I stop there. Every other assistant gives you a confident number. This one tells you exactly where its knowledge runs out, and stands behind the part that's real.
```

## Bloque 18 — cierre (narración)

```
Alexa+ is the only thing in this system that talks. Everything it says comes from a deterministic server that decided first and never guesses — the pantry, the plan, the substitution, the number. The technical case for that — how it's enforced, what's tested, what's still open — is all in the README. This is Mise.
```

---

Nota de edición: en el bloque 13 saqué las comillas dobles de adentro del texto citado ("I have
nothing curated for broad bean...") porque son parte de lo que la app realmente respondió, no algo que
vos digas con comillas en la voz — quedó como texto corrido para que ElevenLabs no intente leer las
comillas como pausa rara. Mismo criterio en el bloque 17 con el "at least 284".

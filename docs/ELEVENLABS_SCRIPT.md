# Guion para ElevenLabs — un solo bloque, con pausas y tono

Un único bloque para pegar entero en ElevenLabs, con las marcas de pausa y de tono que soporta el
modelo v3 (el expresivo, con "audio tags" entre corchetes). Si tu cuenta/voz usa otro modelo que no
lee esas etiquetas, las va a leer como texto literal — en ese caso avisame y te lo devuelvo sin
etiquetas. Abajo del bloque en inglés está la traducción al español, solo para que la puedas leer —
esa parte no se pega en ningún lado, el video va en inglés.

Alcance: esto es tu voz — lo que le decís a Mise y tu narración. No incluye lo que Mise/Gemini
responde, porque esa respuesta no es determinística (el texto exacto varía un poco en cada corrida
real) — esa parte queda como texto en pantalla / audio real capturado en vivo, no como TTS
pre-escrito.

Es un bloque largo (casi 3 minutos de habla). Si en una sola generación el tono empieza a desviarse o
perder consistencia hacia el final, cortalo en los puntos marcados `[pause]` — cada uno es un corte
natural entre secciones.

---

## Bloque único (inglés, para pegar en ElevenLabs)

```
[warm] I cook. Creative reuse is most of what I do in a kitchen — what's about to turn, what's left in the pan, what two things in the fridge have never met but should. And even a chef runs out of ideas some nights. [sincere] This is Mise: a pantry and cooking companion for Alexa plus, built so it never once makes something up to sound helpful.

[pause]

[curious] What have I got?

[thoughtful] Notice it doesn't flatten the answer. Spinach is roughly four days by its own reckoning. Milk is expiring tomorrow because I told it so. The tomato — it just says the amount is unknown. It would be so easy to guess a number there. It doesn't.

[pause]

Plan my dinners through Thursday, forty minutes max.

[thoughtful] Each night comes with its own reason — this one's Thursday because the spinach goes off that day. And here's the part I actually care about... run this twice on the same pantry, and it hands back the exact same plan, byte for byte. A model that plans your week gives you a different week every time and can't tell you why. This can hand you a receipt.

We're out on Thursday.

Move one thing, and the plan explains what shifted and why — in the same terms, not a shrug.

[pause]

Let's cook the lentil and chocolate stew.

The card is a checklist a person can actually shop from — about 330 grams, not 333.333.

I'm out of tahini, what can I use instead?

It swaps from a table a cook actually wrote — sunflower seed butter, a ratio, a warning about what changes in the flavor. Now ask it about something that table doesn't cover.

I'm out of broad beans too.

[serious] I have nothing curated for broad bean — tell me what it was doing in the dish, and I can answer. [pause] That silence is the whole point. It would rather say nothing than invent a substitution that could ruin your dinner — or worse.

[pause]

The tofu expires tomorrow and the lettuce looks rough. What can I do?

[warm] It doesn't search for a tofu recipe. It looks at what's already in here, ranks by what's about to turn, and pairs it with an actual technique — not cook better, something concrete. This is the creative-reuse instinct I started with, just handed back to me when I'm out of ideas myself.

[pause]

How many calories is that?

[matter-of-fact] At least 284 a serving — that's five of six ingredients I can account for, and I have no figures for the plant milk powder, so I stop there. [thoughtful] Every other assistant gives you a confident number. This one tells you exactly where its knowledge runs out, and stands behind the part that's real.

[pause]

[sincere] Alexa plus is the only thing in this system that talks. Everything it says comes from a deterministic server that decided first and never guesses — the pantry, the plan, the substitution, the number. The technical case for that — how it's enforced, what's tested, what's still open — is all in the README. [warm] This is Mise.
```

---

## Traducción al español (solo para leer, no se pega)

**[cálido]** Soy cocinera. La reutilización creativa es la mayor parte de lo que hago en una cocina — lo que está por vencerse, lo que sobró en la sartén, dos cosas en la heladera que nunca se cruzaron pero deberían. Y hasta un chef se queda sin ideas algunas noches. **[sincero]** Esto es Mise: un acompañante de despensa y cocina para Alexa+, construido para que nunca, jamás, invente algo solo para sonar útil.

*(pausa)*

**[curiosa]** ¿Qué tengo?

**[pensativa]** Fijate que no aplana la respuesta. La espinaca está *más o menos* a cuatro días, según su propio cálculo. La leche vence mañana porque yo se lo dije. El tomate — directamente dice que la cantidad es desconocida. Sería tan fácil inventar un número ahí. No lo hace.

*(pausa)*

Planeame las cenas hasta el jueves, cuarenta minutos máximo.

**[pensativa]** Cada noche viene con su propia razón — esta es jueves porque la espinaca se vence ese día. Y acá está la parte que de verdad me importa... corré esto dos veces sobre la misma despensa, y te devuelve exactamente el mismo plan, byte por byte. Un modelo que planea tu semana te da una semana distinta cada vez y no puede explicarte por qué pasó. Esto te puede dar un comprobante.

Nos quedamos sin nada para el jueves.

Movés una sola cosa, y el plan explica qué cambió y por qué — en los mismos términos, no con un "no sé".

*(pausa)*

Cocinemos el guiso de lentejas y chocolate.

La tarjeta es una lista de compras que una persona puede realmente usar — *alrededor de 330 gramos*, no 333,333.

Me quedé sin tahini, ¿qué puedo usar en su lugar?

Lo cambia por algo de una tabla que escribió un cocinero de verdad — manteca de semillas de girasol, una proporción, una advertencia sobre qué cambia en el sabor. Ahora preguntale por algo que esa tabla no cubre.

También me quedé sin habas.

**[seria]** No tengo nada curado para habas — contame qué función cumplía en el plato, y puedo responderte. *(pausa)* Ese silencio es todo el punto. Prefiere no decir nada antes que inventar una sustitución que te arruine la cena — o algo peor.

*(pausa)*

El tofu vence mañana y la lechuga está medio fea. ¿Qué puedo hacer?

**[cálida]** No busca "una receta de tofu". Mira lo que ya hay acá, ordena por lo que está por vencerse, y lo empareja con una técnica concreta — no "cociná mejor", algo específico. Este es el mismo instinto de reutilización creativa con el que arranqué, devuelto a mí cuando yo misma me quedo sin ideas.

*(pausa)*

¿Cuántas calorías tiene eso?

**[directa]** Al menos 284 por porción — esos son cinco de los seis ingredientes que puedo contabilizar, y no tengo los datos de la leche en polvo vegetal, así que ahí me detengo. **[pensativa]** Cualquier otro asistente te da un número con total confianza. Este te dice exactamente dónde termina lo que sabe, y respalda la parte que sí es real.

*(pausa)*

**[sincera]** Alexa+ es lo único en este sistema que habla. Todo lo que dice viene de un servidor determinístico que ya decidió antes y nunca inventa — la despensa, el plan, la sustitución, el número. El caso técnico de eso — cómo se hace cumplir, qué está probado, qué sigue abierto — está todo en el README. **[cálida]** Esto es Mise.

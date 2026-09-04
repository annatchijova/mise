# Mise — plan de integraciones IoT y portales de recetas

> Extiende `docs/PLAN.es.md` (bloques A–H) con un bloque **I · Integraciones**. Responde a la propuesta del equipo (3 sep 2026): heladeras inteligentes que rastrean y compran productos (Samsung Family Hub + Instacart, GE Profile Kitchen Assistant), sus plataformas (Samsung Food, Taste of Home) y portales de recetas (Cookpad, Allrecipes, ChefSteps), con KitchenPal, NoWaste, Pantry Check y FridgeBuddy como referencias de producto.
>
> Estado de cada afirmación sobre APIs externas: **[verificado]** = leído en documentación oficial o en resultados de búsqueda de documentación oficial; **[no verificado]** = conocimiento previo, hay que confirmarlo antes de apostar tiempo; **[bloqueado]** = la documentación no se pudo abrir desde el entorno donde se escribió este plan.

## 0 · Resumen en cinco líneas

1. Las integraciones **no cambian la arquitectura**: son *fuentes de eventos de despensa* y *formatos de intercambio de recetas*. El ledger append-only con origen y confianza ya está pensado para esto; solo hay que sumar orígenes (`smartthings`, `barcode`, `receipt`, `import`) y un campo `location` (heladera, freezer, alacena, segunda ubicación).
2. **Nada externo entra en el camino de respuesta de Alexa+** (presupuesto 500 ms). Toda integración corre fuera de banda: webhook de entrada, job de sincronización o acción desde la web de la cuenta. Las tools MCP solo leen lo que ya está en DynamoDB.
3. De todo lo propuesto, lo que tiene API pública usable en un hackathon es: **SmartThings** (heladera Samsung), **Instacart Developer Platform** (compra real), **Open Food Facts** (código de barras) y **schema.org Recipe JSON-LD** (importar/exportar recetas con cualquier portal). GE SmartHQ tiene portal de desarrolladores pero acceso a inventario sin confirmar. Samsung Food, Cookpad, Allrecipes, ChefSteps, Taste of Home **no tienen API pública** para terceros: se integran por JSON-LD, no por API.
4. No tenemos una heladera conectada. La demo usa un **adaptador simulado con el mismo contrato** que el real, y el video lo dice. Una integración fingida como real es exactamente lo que el proyecto se propone no hacer.
5. Orden: primero lo que de-riesga (llaves, shapes de payload, JSON-LD), después el adaptador SmartThings, después Instacart. Lo demás queda documentado como extensible, no construido.

## 1 · Qué pide el equipo y qué se puede hacer de verdad

| Propuesta | Qué hay realmente | Estado | Decisión |
|---|---|---|---|
| Samsung Family Hub (heladera con cámara, lista de alimentos, compra vía Instacart) | La heladera es un device de **SmartThings**. La API pública de SmartThings (REST, token personal u OAuth) expone devices y capabilities; la lista de alimentos/compras del Family Hub es la parte a confirmar: hay hilos de la comunidad preguntando cómo leerla por API. La compra vía Instacart es un acuerdo Samsung–Instacart cerrado, no una API para nosotros. | API SmartThings [verificado que existe]; capability de lista de alimentos [no verificado, bloqueado]. | **Hacer**: adaptador `smartthings` sobre la API pública, con simulador para la demo. Verificar el nombre exacto de la capability (candidata: `samsungce.fridgeFoodList`) con un token real. |
| GE Profile Kitchen Assistant | Existe `developer.smarthq.com` con OAuth 2.0 y "Digital Twin API" para appliances GE. Nada visto que exponga el rastreo de alimentos del Kitchen Assistant a terceros. | Portal [verificado que existe]; inventario [no verificado, bloqueado]. | **No construir**. Dejar el contrato de adaptador listo para que un segundo fabricante entre sin tocar el core. |
| Samsung Food (ex Whisk) | Documentación Whisk existe (`docs.whisk.com`) pero el acceso es para partners y grocers; no hay signup abierto. Samsung Food **importa recetas desde una URL** con JSON-LD, igual que casi todas las apps de recetas. | [verificado: docs de partner]; import por URL [no verificado]. | **Integrar por JSON-LD**: publicar cada receta de Mise como página HTML con `schema.org/Recipe`, importable desde Samsung Food, Paprika, Family Hub y demás. |
| Taste of Home, Cookpad, Allrecipes, ChefSteps | Sin API pública para terceros. Todas publican JSON-LD `Recipe` en sus páginas (Allrecipes con seguridad; el resto se verifica con una URL cada uno). | [verificado para Allrecipes por documentación de terceros]. | **Importar por JSON-LD** a nuestro contrato, con `source.kind: "imported"`, `needs_review: true` y el texto original guardado tal cual. Nunca scraping de HTML libre. |
| Compra desde la heladera | Lo que sí existe es **Instacart Developer Platform**: crea una "shopping list page" o "recipe page" a partir de una lista de ingredientes y devuelve una URL. Signup abierto, entorno de desarrollo. | [verificado en documentación oficial]. | **Hacer**: `cart_from_plan` además de armar el carrito UCP devuelve un `instacart_url` con los faltantes. El checkout de Alexa+ sigue siendo UCP (es lo que pide la plataforma); Instacart es la salida "comprá donde comprás siempre". |
| Código de barras (KitchenPal, Pantry Check) | **Open Food Facts**: `GET /api/v2/product/{barcode}` con `fields=`, sin llave. | [verificado]. | **Hacer**, barato: endpoint de ingesta `barcode` que resuelve el producto y escribe un evento `add` con confianza `confirmed`. |
| Escaneo de tickets y fotos (NoWaste) | Necesita OCR o visión. Rompe la regla "sin LLM propio" si lo hacemos nosotros. | — | **No construir**. Dejarlo como origen `receipt` en el contrato, alimentable por webhook desde cualquier app que ya lo haga. |

## 2 · Principio de diseño

**Una integración es un productor de eventos de despensa o un traductor de recetas. Nunca una tool.**

```
   fuentes                          ingesta (fuera de banda)             lo que Alexa+ ve
   ─────────────────────            ────────────────────────────         ───────────────────
   voz (Alexa+) ──────────────────► tool pantry_update ───────────┐
   SmartThings (poll / webhook) ──► POST /ingest/smartthings ──────┤
   escáner de barras ─────────────► POST /ingest/barcode ──────────┼──► PANTRY_EVT (ledger) ──► fold ──► pantry_list, plan_week
   app de tickets ────────────────► POST /ingest/receipt ──────────┤        origen + confianza + location
   checkout UCP / Instacart ──────► evento add origen=checkout ────┘

   URL de portal (JSON-LD) ──────► importador ──► data/imports/<id>.json (needs_review) ──► validador ──► recipe_search
   receta de Mise ───────────────► GET /recipes/<id> (HTML + JSON-LD) ──► Samsung Food, Paprika, Family Hub, Google
```

Tres reglas que se desprenden:

- **Confianza por origen, no por fuente**. Cada adaptador declara qué confianza puede afirmar: voz y código de barras → `confirmed`; cámara de heladera → `inferred` (la cámara reconoce "hay tomates", no cuántos ni cuándo vencen); ticket → `confirmed` para el ítem, `inferred` para la cantidad si el ticket no la trae. El fold y `pantry_list` ya saben narrar esa reserva.
- **Idempotencia en la ingesta**. Cada evento externo trae `external_id` (id del device + timestamp, o hash del ticket). Mismo `external_id` dos veces → no se duplica. Igual que UCP con `Idempotency-Key`.
- **Nada bloquea a Alexa+**. Si SmartThings tarda 4 s o está caído, la despensa sigue respondiendo con lo último sincronizado y con un `synced_at` que `pantry_list` puede narrar ("the fridge last reported an hour ago").

## 3 · Cambios al modelo de datos

Sobre la tabla única del plan original:

| Entidad | Cambio |
|---|---|
| `PANTRY_EVT` | `origin` amplía su vocabulario: `voice \| recipe_deduction \| checkout \| smartthings \| barcode \| receipt \| import`. Nuevos campos opcionales: `location` (`fridge \| freezer \| pantry \| other:<nombre>`), `external_id`, `source_device`. |
| `USER#id / SOURCE#<kind>#<id>` | Nueva: fuente conectada. `kind`, `label` ("kitchen fridge"), credenciales cifradas o referencia a Secrets Manager, `synced_at`, `last_error`, `enabled`. |
| `RECIPE#id / V#n` | `source.kind`: `book \| imported`. Para `imported`: `source.url`, `source.site`, `source.fetched_at`, `source.jsonld_sha256` (el JSON-LD original guardado tal cual, como hoy `original_text`). |

El campo `location` es la única idea de FridgeBuddy/NoWaste que cambia datos: permite "¿qué hay en el freezer?" y varias ubicaciones (garaje, casa de fin de semana) sin más esfuerzo que un filtro en `pantry_list`.

## 4 · Componentes a construir

### 4.1 Contrato de adaptador (`src/integrations/`)

```ts
interface PantrySource {
  kind: "smartthings" | "barcode" | "receipt" | "simulated";
  /** Lee el estado remoto y lo traduce a eventos. Puro respecto a la red: recibe el payload ya obtenido. */
  toEvents(payload: unknown, ctx: { userId: string; now: string }): PantryEvent[];
  /** Qué confianza puede afirmar este origen. Nunca más que esto. */
  maxConfidence: "confirmed" | "inferred";
}
```

`toEvents` es puro y determinístico: se testea con payloads guardados como fixtures (`test/fixtures/smartthings/*.json`). El acceso a la red vive aparte (`sync.ts`), fuera del servidor MCP.

### 4.2 Ingesta HTTP

- `POST /ingest/:kind` con firma HMAC por fuente (secreto por `SOURCE#`), `Idempotency-Key` obligatorio, respuesta 202. Escribe eventos y actualiza `synced_at`.
- `POST /sources/:kind/sync` (solo desde la web de la cuenta): dispara una sincronización manual. Para la demo alcanza; un cron de App Runner o EventBridge cada N minutos es el paso siguiente.

### 4.3 Adaptador SmartThings

1. Token personal de SmartThings de una cuenta con Family Hub (hace falta alguien del equipo con la heladera, o un contacto que preste un token por una tarde). Sin eso, el adaptador real queda escrito contra la documentación y **no se muestra como funcionando**.
2. `GET /v1/devices` → filtrar por capability de heladera; `GET /v1/devices/{id}/status` → leer la lista de alimentos si la capability existe públicamente.
3. Mapear nombres de alimentos a ids canónicos con `data/ingredient_aliases.json` (ya existe; sumar alias en inglés que devuelva la heladera). Lo que no mapea entra como `unmapped` y `pantry_list` lo narra ("the fridge reported 'kimchi' which I don't know yet").
4. Confianza `inferred`, `location: fridge`, `external_id = deviceId + fecha del ítem`.

### 4.4 Simulador de heladera (para la demo)

- `POST /ingest/simulated` con el **mismo shape de payload** que el adaptador real (copiado de un status real si conseguimos el token; si no, del esquema documentado, y el README lo dice).
- Una página mínima en la web de la cuenta: "Simulated fridge" con tres botones (agregar tofu, sacar tomates, marcar vencimiento). Sirve para el video y para las pruebas del planificador.
- En el video: "The fridge logged the tofu on Monday" aparece con badge `inferred` y origen `fridge`. Es honesto y además muestra el argumento del ledger mejor que la voz sola.

### 4.5 Código de barras (Open Food Facts)

- `POST /ingest/barcode { ean, qty?, unit?, location? }` → `GET https://world.openfoodfacts.org/api/v2/product/{ean}?fields=product_name,brands,quantity,categories_tags` → evento `add` `confirmed`.
- Mapeo `categories_tags` → id canónico con una tabla pequeña (`data/off_categories.json`). Lo que no mapea queda `unmapped`.
- Cache del producto en DynamoDB (`OFF#ean`) para no repetir la llamada.

### 4.6 Recetas: importar y exportar por JSON-LD

- **Exportar**: `GET /recipes/:id` devuelve HTML con `<script type="application/ld+json">` `schema.org/Recipe` generado desde `data/recipes/<id>.json` (`recipeIngredient`, `recipeInstructions` como `HowToStep`, `totalTime`, `recipeYield`, `suitableForDiet: VeganDiet`). Es lo que hace a Mise legible por Samsung Food, Paprika, Family Hub, Google y cualquier portal. Cero riesgo, una tarde.
- **Importar**: `scripts/import_jsonld.py <url>` (stdlib, como los otros scripts) → extrae el bloque `Recipe`, lo guarda tal cual en `source.jsonld`, traduce a nuestro contrato con `qty_source` según lo que el JSON-LD trae (`"2 cups flour"` → parseo conservador; lo que no parsea queda `qty: null, unit: to_taste, note: <texto original>`), `role`, `technique`, `ingredients[].id` y `diet.vegan` en `null`, y `needs_review: true` con sus razones. No pasa por el contrato completo — no podría: los roles son obligatorios ahí. Pasa por `validate_recipes.py --staging`, que verifica el contrato débil de `data/imports/`: que lo que no se puede saber esté explícitamente en `null` en vez de rellenado, que el JSON-LD verbatim esté y coincida con su hash, y que el archivo admita que necesita revisión. La promoción a `data/recipes/` la hace una persona llenando esos nulls; ahí sí aplica el contrato completo. Roles y técnicas son criterio de chef, no se infieren.
- Probar con una URL de cada portal (Allrecipes, Cookpad, ChefSteps, Taste of Home) y registrar en `docs/IMPORT_SOURCES.md` cuál trae JSON-LD completo y cuál no. Eso es el "soporte de portales" que se puede afirmar con evidencia.
- **Vía voz, no**: `recipe_import` como tool MCP requeriría una llamada externa dentro de la respuesta. El import es una acción de la web de la cuenta.

### 4.7 Instacart Developer Platform

- Signup en la plataforma de desarrolladores, llave de entorno de desarrollo.
- `POST .../products/products_link` (shopping list page) con `line_items[{name, quantity, unit}]` armados desde los faltantes del plan → devuelve una URL. [shape verificado a nivel de documentación, campos exactos a confirmar al implementar].
- `cart_from_plan` suma `instacart_url` al `structuredContent`; la vista de carrito MCP App muestra "Open in Instacart" junto al checkout UCP. La llamada a Instacart se hace **al generar el plan** (fuera del turno de voz) o en la vista, nunca dentro de `cart_from_plan` si supera el presupuesto; medir.
- Cierre del círculo: Instacart no notifica compras a terceros. Lo que se compró por Instacart vuelve a la despensa por voz o por código de barras, no automáticamente, y el README lo dice.

### 4.8 Vista de despensa (MCP App), con lo que aportan las referencias

- Badge de confianza (ya previsto) + **semáforo de frescura** (Pantry Check): verde > 3 días, amarillo 1–3, rojo hoy o vencido, gris sin fecha. Todo entero, determinístico, calculado en el servidor.
- Filtro por **ubicación** (FridgeBuddy / NoWaste): heladera, freezer, alacena, otras.
- Línea "fuentes": "Voice · Kitchen fridge (synced 12 min ago) · Barcode". Muestra de dónde sale cada dato sin explicarlo.

## 5 · Bloque I · Integraciones — inventario de trabajo

En el orden que reduce riesgo más rápido. Sin fechas. Todo se puede repartir a una persona que no esté en recetas.

**I.0 · De-riesgo (medio día, antes de escribir código)**
- Conseguir llave de Instacart Developer Platform y hacer una llamada a mano con dos ítems. Guardar request y response como fixture.
- Conseguir un token personal de SmartThings de alguien con Family Hub; `GET /v1/devices` y `GET status` de la heladera. Guardar el JSON como fixture. Si no se consigue, decidir explícitamente: simulador con shape documentado.
- Abrir una URL de cada portal (Allrecipes, Cookpad, ChefSteps, Taste of Home, Samsung Food) y guardar el JSON-LD que traen. Anotar cuál no trae.
- Confirmar que la política de red de App Runner permite salida a esos hosts.

**I.1 · Datos y contrato**
- Vocabulario de `origin` ampliado, `location`, `external_id`, entidad `SOURCE#`.
- `PantrySource` + adaptador `simulated` + tests con fixtures (fold con eventos de varios orígenes; mismo `external_id` dos veces no duplica; confianza nunca supera `maxConfidence`).

**I.2 · Recetas por JSON-LD**
- `GET /recipes/:id` con JSON-LD. Validar con la herramienta de resultados enriquecidos de Google o con el validador de schema.org.
- `scripts/import_jsonld.py` + `docs/IMPORT_SOURCES.md` con evidencia por portal.

**I.3 · Ingesta**
- `POST /ingest/:kind` con HMAC e idempotencia; `POST /sources/:kind/sync`.
- Adaptador `barcode` con Open Food Facts y cache.
- Adaptador `smartthings` (real si hay token; en todo caso con fixtures).

**I.4 · Compra**
- Cliente Instacart, `instacart_url` en `cart_from_plan`, botón en la vista de carrito.

**I.5 · Vista y demo**
- Semáforo, filtro por ubicación, línea de fuentes en la vista de despensa.
- Página "Simulated fridge" en la web de la cuenta.
- Tramo de video: entre 0:00 y 0:30, "The fridge logged the tofu on Monday; you said the lentils this morning" con los dos badges distintos.

**Fuera de alcance, escrito para que no vuelva a la mesa**: GE SmartHQ (sin acceso confirmado a inventario), OCR de tickets y fotos (rompe "sin LLM propio"), API de Samsung Food (partners), scraping de portales sin JSON-LD, notificaciones push de vencimiento (Alexa+ no documenta proactividad para add-ons; queda como pregunta al planificador: "what's expiring?").

## 5.bis · Estado de implementación

Lo que ya está en el repo, con sus pruebas. Todo lo demás del bloque I sigue pendiente.

| Ítem | Estado | Dónde |
|---|---|---|
| Contrato de eventos de despensa (origen, confianza, ubicación, `external_id`, milli-unidades enteras) | hecho | `src/pantry/events.ts` |
| Fold determinístico: idempotencia, degradación honesta, `stale` derivado del reloj | hecho | `src/pantry/fold.ts` |
| Contrato `PantrySource` + `runSource` que recorta la confianza al techo declarado | hecho | `src/integrations/types.ts` |
| Adaptador de heladera simulada con envelope tipo SmartThings | hecho | `src/integrations/simulated_fridge.ts` |
| Resolución de nombres externos a ids canónicos, con `unmapped` como salida de primera clase | hecho | `src/integrations/aliases.ts`, `data/source_aliases.json` |
| Exportar recetas como páginas con JSON-LD (`GET /recipes`, `/recipes/:id`, `/recipes/:id.json`) | hecho | `src/recipe_jsonld.ts`, `src/server.ts` |
| Importar desde JSON-LD a staging, con parseo conservador de cantidades | hecho | `scripts/import_jsonld.py` |
| Contrato de staging y su validador | hecho | `scripts/validate_recipes.py --staging`, `docs/RECIPE_SCHEMA.md` |
| Pruebas: 60, incluida la ida y vuelta exportar → importar | hecho | `test/` (`npm test`) |
| I.0 de-riesgo: llaves de Instacart y token de SmartThings, evidencia por portal | **pendiente, necesita manos humanas** | `docs/IMPORT_SOURCES.md` |
| Ingesta HTTP (`POST /ingest/:kind`), HMAC, sincronización | pendiente | — |
| Adaptador de código de barras (Open Food Facts) | pendiente | — |
| Adaptador SmartThings real | pendiente, bloqueado por I.0 | — |
| Instacart en `cart_from_plan` | pendiente, bloqueado por I.0 | — |
| Vista de despensa (semáforo, ubicaciones, línea de fuentes) | pendiente | — |

Dos cosas que la implementación cambió respecto de lo planeado, ambas hacia más honestidad:

- **Las cantidades de la despensa son enteros en milésimas de unidad**, no decimales. Una despensa se
  suma una y otra vez, y `0.1 + 0.2` no puede derivar. La conversión ocurre una sola vez, en el borde.
- **Las unidades nunca se convierten entre sí.** 2 tazas de harina y 500 g de harina son dos líneas
  honestas, no una suma inventada. Cada línea es (ingrediente, unidad, ubicación).

## 6 · Cómo suma a la rúbrica

| Rúbrica | Dónde vive |
|---|---|
| Workflow agéntico que orquesta servicios | heladera → ledger → planificador → carrito UCP / Instacart → despensa. Un servicio más en la cadena, y Alexa+ no tiene que nombrarlo. |
| Add-on consciente del contexto, estado entre sesiones | la despensa se actualiza sin que la persona hable; `pantry_list` narra de dónde salió cada dato y cuándo. |
| Capacidades de compra | UCP (requisito de la plataforma) más salida a un retailer real por Instacart. |
| Lo "obvio" que hay que evitar | ninguna integración es un wrapper: cada una entra al ledger con origen, confianza e idempotencia, y el planificador es el que decide. |

## 7 · Riesgos y verificaciones pendientes

- **verificar** Capability pública de SmartThings para la lista de alimentos del Family Hub. Sin token real, el adaptador queda contra documentación y la demo usa el simulador. [bloqueado desde este entorno]
- **verificar** Campos exactos y límites de la shopping list page de Instacart, y si el entorno de desarrollo devuelve URLs abribles. [documentación bloqueada desde este entorno; verificar con la llave]
- **verificar** Que Samsung Food importe desde nuestra página con JSON-LD (prueba manual de cinco minutos con la app). El exportador ya sirve las páginas; falta un host público y la prueba.
- **verificar** Qué portales traen JSON-LD completo. Los cuatro que probamos están bloqueados por el proxy de egress de este entorno, así que el parser se desarrolló contra nuestras propias páginas exportadas y contra las formas de texto que estos sitios publican. La tabla de evidencia de `docs/IMPORT_SOURCES.md` está vacía a propósito.
- **verificar** Latencia de la llamada a Instacart; si supera el presupuesto, moverla a la generación del plan.
- **decisión** Sin OCR ni visión propios. Lo que requiera reconocer una foto entra por webhook desde una app que ya lo haga, o no entra.
- **decisión** Cada integración se muestra en el video como lo que es: real con token real, o simulada con el shape real. Nunca la segunda presentada como la primera.

## 8 · Fuentes consultadas

- Instacart Developer Platform: introducción, shopping list page, recipe page, referencia de API (`docs.instacart.com/developer_platform_api`).
- Open Food Facts API v2 (`openfoodfacts.github.io/openfoodfacts-server/api/`).
- SmartThings: soporte de Samsung sobre View Inside, Food List y listas de compras; hilo de la comunidad sobre acceso a listas por API.
- SmartHQ Developer Portal (`developer.smarthq.com`); proyectos abiertos `gekitchen` y `ha_gehome`.
- Samsung Food / Whisk: docs de partner (`docs.whisk.com`), Grocer Integration Overview.
- schema.org `Recipe`; guía de datos estructurados de recetas de Google.
- Referencias de producto citadas por el equipo: KitchenPal, NoWaste, Pantry Check, FridgeBuddy.

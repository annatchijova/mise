# Mise — plan de arquitectura (Amazon Developer Hackathon 2026, track Alexa+)

> Documento de planificación original de la autora (español). Versión en inglés: `docs/PLAN.md`. La fuente de verdad con formato completo es `docs/PLAN.es.html`.
> El código, los tests y la documentación pública del repo están en inglés.

Amazon Developer Hackathon 2026 · track Alexa+ · arquitectura y plan

  Un add-on MCP para Alexa+ que lleva la despensa por voz, arma el plan de la semana con lo que hay y lo que se vence, guía la cocción paso a paso sin perder el hilo entre sesiones, sustituye con criterio de chef y compra lo que falta. Nombre de trabajo: cambialo cuando quieras.
- **Stack:**TypeScript · Node 22
- **Hosting:**AWS (App Runner + DynamoDB)
- **Compra:**UCP checkout, tienda demo propia
- **Prueba:**Web Simulator (sin dispositivo)
- **Locale:**en-US (contenido en inglés)

## 01 · Qué decide la plataforma por vos

Tres cosas que salen de la documentación oficial y que fijan la forma del sistema antes de escribir una línea.

Alexa+ es el LLM. El add-on expone tools por MCP; el razonamiento de Alexa+ decide cuándo llamarlas, extrae las entidades de lo que dijo la persona y narra el resultado. Tu servidor no tiene modelo propio: es datos más lógica determinística. La rúbrica premia "workflows agénticos que orquestan servicios de forma autónoma", y esa orquestación la hace Alexa+ sobre tus tools — vos ponés las piezas correctas y descripciones que mapeen a intenciones distintas.
- **Compra:**r no es comprar en Amazon. El checkout de un add-on sigue UCP (Universal Commerce Protocol): Alexa+ es agente, no comerciante. Tu backend es el merchant of record, la fuente de precios, impuestos, stock y envío, y expone cinco endpoints REST más un perfil en /.well-known/ucp. No hay forma documentada de que un add-on compre productos de Amazon Fresh o Whole Foods. Para el hackathon, "capacidad de compra" significa implementar una tienda propia — acá, un almacén demo con SKUs reales de las recetas.

El estado entre sesiones es tuyo, atado a account linking. Alexa+ mantiene el hilo conversacional del lado de ellos y no documenta un identificador de usuario para tools sin linking. La identidad estable sale del bearer token de OAuth 2.1 (authorization code + PKCE S256, parámetro resource, documento PRM). Sin linking no existe "¿dónde me quedé?". La certificación exige además una experiencia de invitado funcional para lo que no necesite cuenta.

  Latencia, dos cifras en la documentación. El quickstart dice que la respuesta debe llegar en menos de 500 ms; los requisitos funcionales dicen "resultados dentro de 3 segundos" y mostrar un mensaje intermedio si la tool tarda. Diseñá para la cifra dura: todas las tools son lecturas/escrituras en DynamoDB más cómputo puro, sin llamadas externas en el camino de respuesta.

## 02 · Arquitectura

  
  
    
      
        
      
    
    

    
    Alexa+
    NLU · razonamiento · voz
    cliente MCP · registry
    orquestador · UI

    
    AWS APP RUNNER · 1 CONTENEDOR · TLS · MIN 1

    
    Servidor MCP
    POST /mcp · Streamable HTTP · spec 2025-11-25
    tools + resources ui:// · zod en el borde

    
    Almacén demo · UCP
    /checkout-sessions · create/get/update/complete
    /.well-known/ucp · Idempotency-Key 24 h

    
    OAuth 2.1 (account linking)
    /authorize · /token · PKCE S256 · resource
    /.well-known/oauth-authorization-server

    
    DynamoDB
    single table
    USER · PANTRY_EVT
    RECIPE · SUBST
    COOK · PLAN
    SKU · CART · CS

    
    tools/call
    
    UCP REST
    
    bearer

    
    
    
  
  

  Un solo contenedor en App Runner sirve las tres superficies bajo la misma URL TLS (App Runner da HTTPS de fábrica; dominio propio opcional). Min 1 instancia elimina el arranque en frío durante la demo. No hay LLM del lado tuyo.

Por qué App Runner y no Lambda

Streamable HTTP funciona en modo stateless (cada POST devuelve JSON) y eso entra en Lambda, pero el cliente MCP de Alexa+ anuncia capacidades de roots y la documentación no aclara si abre streams GET/SSE que Lambda no sostiene bien. Un contenedor siempre tibio evita el arranque en frío y las dudas de transporte por el precio de un servicio pequeño. Si preferís Lambda, el punto a verificar es exactamente ese: correr el Local Inspector contra el endpoint y ver si pide capacidades de stream.

OAuth: Cognito o servidor propio

Alexa+ exige OAuth 2.1 con PKCE, el parámetro resource (RFC 8707) apuntando a la URI canónica del servidor MCP y un documento PRM; no soporta Dynamic Client Registration ni OIDC. Cognito cubre authorization code + PKCE y suma puntos en el mini-challenge de AWS, pero hay que verificar que acepte resource y que el PRM servido desde tu dominio apunte correctamente a su metadata. La alternativa es un servidor OAuth 2.1 mínimo dentro del mismo contenedor (oidc-provider o hecho a mano): más código, control total, y es tu terreno. Elegí después de una prueba de linking de media hora con Cognito.

## 03 · Modelo de datos

Una tabla en DynamoDB con claves compuestas. Lo importante no es el esquema sino tres decisiones de forma.

La despensa es un ledger, no un inventario. Cada cambio es un evento append-only (add, consume, remove, correct) con origen (voice, recipe_deduction, checkout). El estado actual es un fold sobre los eventos, y cada ítem lleva un nivel de confianza: confirmed cuando la persona lo dijo, inferred cuando lo dedujo una receta cocinada, stale después de N días sin confirmación. La tool nunca presenta una cantidad inferida como certeza; Alexa+ la narra con esa reserva porque el structuredContent se la marca.

La receta es una máquina de estados, no un texto. Pasos ordenados con duración estimada, dependencias y timers paralelos; ingredientes con rol (grasa, ácido, ligante, umami, proteína, aromático) y no solo nombre. El rol es lo que hace posible sustituir con criterio.

Las sustituciones son una tabla curada por vos, versionada. Clave: ingrediente + rol + técnica (¿tiene que emulsionar? ¿dorar? ¿ligar en frío?). Valor: alternativas con proporción y advertencia. Alexa+ no inventa sustituciones; elige entre las que vos escribiste. Ese es el argumento de producto que nadie más en el hackathon puede hacer.

  EntidadPK / SKCampos que importan

  
    UsuarioUSER#id / PROFILErestricciones (vegano fijo; alergias), personas en casa, tiempo típico por comida, unidades (g/ml)

    Evento de despensaUSER#id / PANTRY#ts#ulidtipo, ingrediente_id, cantidad+unidad, origen, vence_el (si lo dijo), confianza

    RecetaRECIPE#id / V#ntítulo, rinde, pasos[{orden, texto, dur_s, timer?, depende_de[]}], ingredientes[{id, rol, cantidad, unidad, técnica}]

    SustituciónSUBST#ingrediente / ROL#técnicaalternativas[{ingrediente, proporción, advertencia}], versión, autora

    Sesión de cocinaUSER#id / COOK#recipe#startedestado, paso_actual, timers activos, desvíos[{paso, qué_cambió}], transiciones log

    Plan semanalUSER#id / PLAN#semanacomidas[{día, receta, por_qué: usa_X_que_vence}], faltantes[], hash del plan

    SKU (almacén)SKU#id / METAtítulo, precio en centavos, stock, mapea_a_ingrediente

    Carrito / checkoutUSER#id / CART · CS#id / STATEline_items, totals, status UCP, expires_at (6 h), idempotency keys (24 h)

## 04 · Tools MCP

Cada tool mapea a una intención distinta (requisito de certificación: descripciones claras, con sinónimos, sin prometer de más). Entradas validadas con zod en el borde; salida siempre en structuredContent, y donde hay UI, _meta.ui.resourceUri. Las que necesitan cuenta lo declaran y devuelven un error MCP bien formado si no hay linking; las de invitado funcionan solas.

  ToolEntradaDevuelveCuenta

  
    pantry_updateitems[{name, qty, unit, expires?}], mode: add|consume|correctestado resultante de esos ítems con confianzasí

    pantry_listfilter: all|expiring_soon|lowítems + confianza + días para vencer · UI: vista de despensasí

    recipe_searchquery? , use_ingredients?[], max_minutes?candidatas con % de ingredientes que ya tenésno

    plan_weekdays, meals_per_day, time_budget_min, avoid?[]plan + rationale por comida + faltantes consolidados · UI: grillasí

    substituteingredient, recipe_id?, step?alternativas curadas con proporción y advertenciano

    cook_startrecipe_id, servings?sesión creada, paso 1, mise en place · UI: tarjeta de pasosí

    cook_nextcompleted_hint?paso siguiente; si el hint no coincide con el paso actual, lo registra como desvío y avisasí

    cook_where_am_i—sesión activa o pausada, paso, timers, tiempo transcurridosí

    cook_notenote (ej. "used chickpeas instead of lentils")desvío registrado; ajusta la deducción de despensa al cerrarsí

    cook_pause / cook_finish—pausa reanudable · al terminar: consume ingredientes (eventos inferred)sí

    cart_from_planplan_id?, days?[]carrito con SKUs del almacén, precio, lo que no se pudo mapear · UI: carritosí

    cart_editadd[] / remove[] / qty changescarrito actualizadosí

  

El checkout no es una tool: Alexa+ lo dispara por la superficie UCP cuando la persona dice que quiere comprar. Tu tool cart_from_plan deja el carrito listo con los ids de SKU que después viajan en line_items.

Ejemplo de definición (SDK oficial TS)

server.registerTool("cook_next", {
  title: "Next cooking step",
  description: "Advance the active cooking session to the next step. Use when the customer says they finished a step, asks what's next, or says 'done', 'ready', 'ok next'.",
  inputSchema: { completed_hint: z.string().optional() },
  _meta: { ui: { resourceUri: "ui://mise/step-card" } }
}, async ({ completed_hint }, extra) => {
  const user = requireLinkedUser(extra);            // del bearer token
  const next = await cook.advance(user, completed_hint); // determinístico, <50 ms
  return { structuredContent: next, content: [{ type: "text", text: next.spoken }] };
});

## 05 · Los tres motores determinísticos

Sesión de cocina

  
  
    
    
      
        
      
    
    idle
    mise en place
    en paso n
    pausada
    terminada

    cook_start
    cook_next
    cook_next (n+1) · cook_note (desvío)
    pause
    where_am_i / next
    último paso
    → eventos consume (inferred)
  
  

  Toda transición se registra con su entrada (qué dijo la persona, qué paso esperaba el sistema). "Ya agregué la cebolla" cuando el paso actual era otro no rompe nada: queda como desvío y la deducción de despensa lo respeta al cerrar.

Planificador semanal

Un scoring entero y determinístico, no un modelo. Para cada slot (día, comida) se puntúan las recetas candidatas: usa ingredientes que vencen pronto (peso alto, decrece con días restantes), minimiza faltantes, respeta el tiempo disponible del slot, penaliza repetir la misma proteína en comidas consecutivas y la misma receta en la semana. Asignación greedy por slot ordenado por urgencia de vencimiento; mismo estado de despensa produce el mismo plan. El plan sale con su rationale por comida ("Thursday: tofu stir-fry because the tofu expires Friday") y un hash del plan — marca de la casa, y le da a Alexa+ algo concreto para narrar en vez de justificar por su cuenta.

Sustituciones

Lookup exacto por (ingrediente, rol, técnica), con fallback a (ingrediente, rol) y por último (rol). Cada entrada la escribís vos: proporción, qué cambia en textura o sabor, y cuándo no sirve ("aquafaba no liga en caliente"). Para la demo alcanzan 30–50 entradas que cubran los ingredientes de las 8–12 recetas. El repo las versiona como datos, no como código.

## 06 · Compra: el almacén demo y UCP

Alexa+ inicia la sesión con los ítems del carrito y el contexto del comprador; tu backend responde siempre HTTP 200 con el estado UCP y usa messages[] para errores comerciales. El método de pago elegido para la demo es com.amazon.payments.stored_payment_method: instrumentos "guardados" en tu almacén (tarjetas ficticias) que devolvés en Create y validás en Complete contra el usuario del token. Evita el onboarding con Amazon Pay que exige el network token.

  EndpointQuién llamaQué hacés

  
    GET /.well-known/ucpdescubrimientoperfil con versión 2026-04-08, capability dev.ucp.shopping.checkout, handler stored_payment_method

    POST /checkout-sessionsAlexa+ (Create)validar SKUs y stock, precios desde tu catálogo (nunca del request), totals en centavos, instrumentos de pago, link a política de reembolso, expires_at +6 h

    GET /checkout-sessions/{id}Alexa+ (recuperación)estado actual, Cache-Control: no-store

    PUT /checkout-sessions/{id}Alexa+ (Update)dirección/selecciones → recalcular envío e impuestos, pasar a ready_for_complete

    POST /checkout-sessions/{id}/completeAlexa+ (Complete)validar que payment_method_id es del usuario y que vos lo devolviste en Create; descontar stock; emitir eventos add a la despensa con origen checkout

    POST /checkout-sessions/{id}/cancelopcionaltransición de estado

  

  - Headers en todas las llamadas: Authorization: Bearer, Idempotency-Key en las que cambian estado (misma clave con body distinto → 409), UCP-Agent, Request-Id.

  - TLS 1.3 mínimo — App Runner lo soporta; confirmá la política TLS del dominio.

  - Mensajes con presentation: "disclosure" para alérgenos: como chef, mostrar "contains sesame" en el checkout es un detalle que un jurado nota.

  - El cierre del círculo es el argumento de producto: completar la compra escribe en la despensa, y el próximo plan_week ya la ve.

  A verificar temprano: si el Web Simulator permite ejercer el flujo de checkout de punta a punta sin certificación. La documentación de testing no lo dice. Si no se puede, el video muestra el checkout con el Local Inspector o con un cliente MCP de referencia contra los endpoints UCP, y se explica.

## 07 · Cuenta, estado y la experiencia de invitado

Con linking: el bearer token identifica al usuario, y todo el estado (despensa, plan, sesión de cocina, carrito) cuelga de ese id. Sin linking: recipe_search y substitute funcionan igual, y el resto responde con un mensaje que invita a vincular la cuenta, sin callejón sin salida. Alexa+ lleva el contexto de la conversación; tu servidor lleva el contexto de la persona. Esa división es lo que hace que "¿dónde me quedé?" funcione un día después, en otro dispositivo, en otra conversación.

## 08 · MCP Apps: las cuatro vistas

Alexa+ soporta la extensión MCP Apps: un recurso ui://… con HTML empaquetado que el cliente renderiza en un iframe aislado y que se comunica por JSON-RPC sobre postMessage usando @modelcontextprotocol/ext-apps. Sin UI declarada, Alexa+ usa el flujo "solo datos" y arma sus propios visuales desde el structuredContent — así que las vistas son pulido, no bloqueo. Orden de valor para la demo:

  - Tarjeta de paso (cook_start, cook_next): paso actual grande, timer, ingredientes de este paso, botón "next" que llama cook_next desde la UI.

  - Grilla semanal (plan_week): días × comidas, cada celda con la razón; faltantes abajo con un botón que llama cart_from_plan.

  - Carrito (cart_from_plan): ítems, precios, lo que no se pudo mapear a un SKU.

  - Despensa (pantry_list): ítems con badge de confianza y días para vencer — el lugar donde se ve que el sistema no finge saber lo que no sabe.

Vos tenés el frontend resuelto; lo único distinto acá es el sandbox: sin red externa desde el iframe, todo inline, y las acciones que disparan tools piden aprobación del usuario por diseño del protocolo.

## 09 · Cómo cubre la rúbrica

  Lo que la rúbrica llama "creativo"Dónde vive en Mise

  
    Workflow agéntico que orquesta servicios de forma autónomadespensa → planificador → carrito → checkout → despensa, con Alexa+ encadenando tools sin que la persona nombre ninguna

    Add-on consciente del contexto que mantiene estado entre sesionessesión de cocina reanudable; ledger de despensa con confianza; plan persistido

    Capacidades de compraUCP completo con método de pago guardado y disclosure de alérgenos

    Soporte de media / MCP Appscuatro vistas MCP Apps; tarjeta de paso con timer

    Agent Skillsel add-on se da de alta por el flujo guiado del toolkit

    Lo que la rúbrica llama "obvio" y hay que evitarninguna tool es un wrapper de una API ajena; ninguna respuesta es un Q&A de un turno

  

Además, con licencia Apache-2.0 y repo público el proyecto entra al mini-challenge Open Source, y hosteado en AWS entra al AWS Builder. Las reglas permiten un premio de track más uno de mini-challenge por proyecto.

## 10 · Inventario de trabajo

Todo lo que hay que hacer, agrupado por área y en el orden que reduce riesgo más rápido. Sin fechas: eso lo organizás vos. Lo primero es cerrar un viaje redondo mínimo con la plataforma; recién después vale la pena construir contenido.

  
    A · Acceso y esqueleto primero, de-riesga la plataforma

    
      - Instalar Alexa AI CLI, alexa-ai configure (Login with Amazon) con la cuenta developer

      - Repo público Apache-2.0, TypeScript, @modelcontextprotocol/sdk, zod, esbuild; Dockerfile

      - Servidor MCP con una sola tool (recipe_search sobre datos en memoria), Streamable HTTP en /mcp

      - Desplegar a App Runner (min 1 instancia) o exponer con cloudflared para la primera prueba

      - alexa-ai new mcp --locale en-US --mcp-server-url …, completar addon.json (íconos en 6 tamaños, privacy/terms URLs provisorias), alexa-ai deploy

      - Viaje redondo en el Web Simulator: preguntar por una receta y ver la respuesta. Hasta acá, nada más

      - Correr el Local Inspector y guardar el reporte de preparación como línea de base

    
  

  
    B · Cuenta y estado

    
      - Prueba de media hora: Cognito con PKCE + resource + PRM. Si no cierra, servidor OAuth 2.1 mínimo en el contenedor

      - Account linking en el add-on; extraer el id de usuario del bearer en un middleware único

      - DynamoDB single-table, acceso por repositorio; ledger de despensa con fold y niveles de confianza

      - Camino de invitado: tools sin cuenta funcionan; las otras devuelven error MCP bien formado

    
  

  
    C · Contenido de chef tu ventaja, empezá en paralelo con A

    
      - Formato de receta como datos (JSON/YAML): pasos con duración, timers, dependencias; ingredientes con rol y técnica

      - 8–12 recetas veganas escritas en ese formato, en inglés, elegidas para que compartan ingredientes y ejerciten sustituciones

      - Tabla de sustituciones: 30–50 entradas con proporción y advertencia, versionada

      - Catálogo del almacén: ~40 SKUs que cubran las recetas, precios en centavos, stock, alérgenos

    
  

  
    D · Tools y motores

    
      - pantry_update, pantry_list sobre el ledger

      - Máquina de estados de cocina: cook_start/next/where_am_i/note/pause/finish; log de transiciones; deducción al cerrar

      - substitute con lookup por (ingrediente, rol, técnica) y fallbacks

      - Planificador: scoring entero, greedy por urgencia, rationale por slot, hash del plan; plan_week

      - cart_from_plan, cart_edit con mapeo ingrediente → SKU y lista de no mapeados

      - Descripciones de tools con sinónimos; corta ≤123 caracteres, completa ≤4000; 3–4 ejemplos de invocación ≤200 caracteres cada uno

    
  

  
    E · Almacén y UCP

    
      - /.well-known/ucp; los cinco endpoints de checkout; idempotencia con 409; no-store; TTL 6 h

      - Handler stored_payment_method con instrumentos ficticios ligados al usuario; validación en Complete

      - Impuesto y envío simples pero calculados del lado del servidor; disclosure de alérgenos en messages[]

      - Complete escribe eventos en la despensa con origen checkout

      - Verificar si el Web Simulator ejercita el checkout; si no, plan B para el video

    
  

  
    F · Vistas MCP Apps

    
      - Setup de @modelcontextprotocol/ext-apps; recursos ui://mise/* empaquetados inline

      - Tarjeta de paso con timer y botón next → luego grilla semanal → carrito → despensa

    
  

  
    G · Pruebas

    
      - Unitarias que pueden fallar: fold del ledger, transiciones válidas e inválidas de la sesión, determinismo del plan (mismo input → mismo hash), idempotencia UCP (misma clave, body distinto → 409)

      - Local Inspector en verde antes de cada deploy; sesiones grabadas en el Web Simulator para las frases del guion

    
  

  
    H · Entrega

    
      - Privacy policy y términos reales en URLs públicas; política de reembolso del almacén demo

      - README con setup, arquitectura y qué es determinístico vs qué hace Alexa+

      - Video ≤3 min (guion abajo) grabado en el Web Simulator con vista de pantalla de dispositivo

      - Formulario de Devpost: track Alexa+, mini-challenges AWS Builder y Open Source

## 11 · Guion del video (3 minutos)

Una sola historia, sin explicar tecnología hasta el final. Cada tramo muestra una capacidad de la rúbrica sin nombrarla.

  - 0:00"I've got two onions, half a kilo of red lentils, and the tofu expires Friday."
Despensa por voz. La vista muestra el tofu con días para vencer y todo marcado como confirmado.

  - 0:30"Plan my dinners through Thursday, forty minutes max."
Grilla semanal. El tofu cae el jueves y la celda dice por qué. Faltantes consolidados abajo.

  - 1:00"Let's cook tonight's lentils." … "Done with the onions." … "I'm out of tahini."
Tarjeta de paso con timer; sustitución con proporción y advertencia de la tabla de chef.

  - 1:40"Pause." — corte — "Where was I?"
Reanuda en el paso 5 con el timer donde quedó. Estado entre sesiones, sin explicarlo.

  - 2:10"Order what's missing for Thursday."
Carrito → checkout con tarjeta guardada → disclosure "contains sesame" → recibo. La despensa ya muestra lo comprado.

  - 2:45Cierre en una placa: qué decide el servidor (todo lo que cuenta) y qué hace Alexa+ (entender y narrar).
Quince segundos de arquitectura, no más.

## 12 · Riesgos y verificaciones pendientes

  - verificar Disponibilidad del Web Simulator desde Argentina con cuenta developer: el toolkit es US-only y la documentación de testing no habla de región. Es lo primero que se prueba en el bloque A.

  - verificar Checkout de punta a punta en el simulador sin certificación.

  - verificar Cognito con resource (RFC 8707) y PRM; si no, OAuth propio.

  - verificar Si el cliente MCP de Alexa+ abre streams GET además de POST (define Lambda vs contenedor).

  - verificar Qué contexto llega en la sesión MCP sin linking (locale, timezone) — la documentación no lo enumera.

  - decisión Todo el contenido en inglés: el add-on se crea con locale en-US y el video lo piden en inglés.

  - decisión Sin LLM propio en el servidor. Si en algún momento tentás meter uno (por ejemplo para parsear ingredientes libres), la respuesta es no: Alexa+ ya extrae entidades, y agregar un modelo rompe la latencia y el argumento.

## 13 · Fuentes

Alexa+ MCP Toolkit Overview ·
MCP QuickStart ·
Client and App Lifecycle ·
Functional Requirements ·
Checkout Integration Reference (UCP) ·
Test Your MCP Add-ons ·
MCP Apps (extensión oficial) ·
Reglas del hackathon

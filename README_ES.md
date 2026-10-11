[English](README.md) · **[Español](README_ES.md)** · [Technical README](README_TECHNICAL.md)

# Mise

Llevar la cuenta de lo que hay en casa, lo que conviene usar pronto y el punto en que quedó una
receta exige atención justo cuando hace falta cocinar. Mise le da a Alexa+ una despensa y un
acompañante de cocina que mantienen separados los hechos informados, las estimaciones y lo que se
desconoce.

Mise ayuda a planificar comidas con lo que ya hay, seguir una receta paso a paso y preparar un carrito
con lo que falta. Sus respuestas salen de datos de cocina curados y de lógica determinista en el
servidor.

## Cómo se usa

Podés preguntar qué hay en la despensa y después qué cocinar durante la semana. Mise explica por qué
eligió cada comida, incluso si conviene usar pronto algún ingrediente. Al empezar a cocinar, la sesión
recuerda el paso, los temporizadores y los cambios que informaste. Si la tabla de sustituciones no
tiene una respuesta, Mise lo dice en vez de inventarla.

El [guion de demostración](docs/DEMO_SCRIPT.md) describe el flujo previsto. Todavía no se verificó el
ciclo completo en el simulador de Alexa+; consultá [lo que está bloqueado](docs/BLOCKED.md).

## De dónde salen las respuestas

| Si preguntás… | Mise responde desde… |
|---|---|
| ¿Qué tengo? | Un historial de eventos que distingue lo confirmado por vos, lo inferido y lo que no se confirmó recientemente. |
| ¿Qué puedo cocinar? | Un planificador fijo que explica cada comida y produce un hash repetible del plan. |
| ¿Con qué reemplazo este ingrediente? | Una tabla curada por una chef, con proporciones y advertencias, o una respuesta clara si no hay datos. |
| ¿Qué nutrición aporta esta receta? | Valores curados por ingrediente; las cantidades y filas faltantes quedan visibles y un resultado parcial se presenta como mínimo. |

Alexa+ mantiene la conversación y elige las herramientas. El servidor controla la despensa, el
planificador, el estado de cocción, las consultas a tablas y los cálculos de la tienda. El modelo no
puede cambiar esas decisiones. La arquitectura, los contratos de datos y los límites de confianza
están en el **[Technical README](README_TECHNICAL.md)**.

## Probarlo en local

Se necesita Node.js 22 o posterior y Python 3 para validar los datos.

```bash
npm install
npm run build
INGEST_SECRET=dev-secret UCP_TOKEN=dev-token npm start
```

Por defecto, el servidor escucha en `http://localhost:8080`. Abrí `/pantry`, `/recipes` o `/data`, o
consultá `/healthz`. La tienda de demostración está disponible si configurás `UCP_TOKEN`. Ejecutá
`npm run check` para las comprobaciones locales completas.

## Estado del proyecto

Mise es una implementación para un hackathon. Las pruebas automatizadas y los validadores cubren el
comportamiento local. Todavía no se verificaron de punta a punta el simulador de Alexa+, los servicios
reales de AWS, las integraciones con una heladera o un lector de códigos de barras ni un cliente UCP
real. [BLOCKED.md](docs/BLOCKED.md) detalla el estado y qué evidencia hace falta para actualizarlo.

## Enlaces

- [Technical README](README_TECHNICAL.md): arquitectura, protocolos, datos, seguridad y evidencia.
- [English README](README.md): resumen para personas en inglés.
- [Agent Skills](skills/README.md): instrucciones para que Alexa+ use las herramientas.
- [Ideas y decisiones de alcance](docs/IDEAS.md).

## Licencia

Apache-2.0. Ver [LICENSE](LICENSE).

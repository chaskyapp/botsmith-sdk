# bot-sdk — SDKs cliente de la Bot API de Chasky

**Estado: especificación. Todavía no hay código en ningún lenguaje.**

Monorepo de los SDKs que un autor de bot instala en su proyecto para hablar con
la Bot API de Chasky, en el lugar que `telegraf` o `python-telegram-bot` ocupan
para Telegram.

Vive **fuera** de `backend-api-go` a propósito: el SDD scopeó el consumidor
externo fuera del repo del servidor, y meterlo adentro contaminaría la API con
decisiones que le corresponden a cada autor de bot.

## Los tres SDKs

| Entrega | Lenguaje | Paquete | Estado |
|---|---|---|---|
| 1 | TypeScript | `@chasky/bot` | [`js/`](js/) — vacío |
| 2 | Go | `github.com/chaskyapp/bot-sdk/go` | [`go/`](go/) — vacío |
| 3 | Python | `chasky-bot` | [`python/`](python/) — vacío |

El orden es TypeScript → Go → Python, y el motivo está en el §5 del contrato:
**la suite de conformidad no prueba nada con un solo consumidor**, y Go es el
segundo puerto más barato porque el equipo ya lo escribe y `pepibot` ya existe.

## Por dónde empezar

- **[docs/00-spec.md](docs/00-spec.md)** — el contrato: propósito, superficie,
  semánticas garantizadas y delegadas, identificadores, errores y redacción,
  decisiones y pedidos al servidor.
- **[docs/01-organizacion.md](docs/01-organizacion.md)** — cómo se sostiene ese
  contrato en tres implementaciones sin que se desincronicen: layout, qué es
  invariante y qué idiomático, suite de conformidad, versionado, orden de trabajo.
- **[conformance/](conformance/)** — la suite que convierte las garantías en
  tests que fallan. Se escribe **antes** que cualquier SDK.

## Lo más importante, en tres líneas

1. **Un solo proceso por bot.** Dos `getUpdates` simultáneos se reparten los
   updates **sin error visible**. El SDK garantiza un solo poll por instancia; lo
   que pasa entre procesos no lo ve nadie hasta que el servidor devuelva `409`
   (pedido S1 — es el hallazgo más grave del análisis).
2. **El offset avanza siempre**, aunque el handler falle. Es un cursor de
   lectura, no un ack de negocio.
3. **El token viaja en la ruta** y se filtra a los logs por el transporte. Todo
   error que sale del SDK viene redactado.

## Antes de escribir código

Quedan **seis decisiones abiertas** en el §12 del contrato. D6 —la ventana de
deduplicación— es bloqueante: cambia la estructura de datos del núcleo en los
tres SDKs, y se resuelve verificando si el PEL de Redis puede reentregar fuera de
orden.

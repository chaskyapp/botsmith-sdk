# SDK cliente de la Bot API de Chasky — Especificación

Estado: **especificación. No hay código todavía y no debe haberlo hasta que las
decisiones abiertas del §12 estén cerradas por el usuario.**

Fecha: 2026-09-08.
Servidor de referencia: `backend-api-go`, rama `cc-jose-nieto/botapi`.
Evidencia de campo: `~/Desktop/pepibot/main.go` (554 líneas, Go, solo stdlib),
un cliente que corre a la vez contra Chasky y contra Telegram para comparar los
dos contratos.

---

## 1. Propósito

Un autor de bot que hoy quiere hablar con Chasky tiene que escribir, a mano y
antes de la primera línea de lógica propia:

- el bucle de long-poll y su reintento,
- la aritmética del `offset`,
- la deduplicación por `update_id`,
- la generación y el reuso de la `Idempotency-Key`,
- la redacción del token en los errores del transporte,
- el clamp de `limit`/`timeout` a los máximos del servidor,
- y el mapeo de un envelope `{ok, result}` a errores tipados.

Eso son las 554 líneas de pepibot **antes** de contestar un solo mensaje. Todo
eso es infraestructura, no producto: cada autor lo va a reescribir igual, y cada
uno se va a equivocar en los mismos cinco lugares.

El SDK existe para que el autor escriba únicamente esto:

> "cuando llegue un mensaje de texto, contestá X."

Es exactamente el trabajo que `telegraf` o `python-telegram-bot` hacen para
Telegram.

### No-propósito

- **No es un cliente de Telegram.** No se promete portabilidad de código escrito
  para Telegram (§4).
- **No vive en `backend-api-go`.** El SDD scopeó el consumidor externo fuera del
  repo del servidor a propósito: meterlo adentro contamina la API con decisiones
  que le corresponden a cada autor de bot.
- **No inventa garantías que el servidor no da.** Todo lo que el servidor no
  promete, el SDK lo delega de forma explícita y documentada (§8).

---

## 2. El servidor tal como está hoy

Lo que sigue es descriptivo, no aspiracional: es el contrato contra el que se
escribe el SDK.

### 2.1 Superficie del token (Bot API)

Base local: `http://localhost:54250/api/v1` — todo el servidor vive bajo
`/api/v1` porque nexus antepone `Settings.PathPrefix`.

```
POST <base>/bot<TOKEN>/getMe
POST <base>/bot<TOKEN>/getUpdates
POST <base>/bot<TOKEN>/sendMessage
POST <base>/bot<TOKEN>/sendChatAction
```

El token viaja **en la ruta** y es la **única** credencial. Estas rutas son
públicas: no piden `x-secret` ni sesión. Formato del token:
`bot:{uuid}:{secreto-hex-64}` — se parte en el **último** `:`, porque el `botID`
ya contiene uno.

Envelope:

```
Éxito:  { "ok": true,  "result": ... }
Error:  { "ok": false, "error_code": N, "description": "..." }
```

El `error_code` replica el status HTTP. `description` es un string estable en
inglés, pensado para logs — **no** es mecanismo de control de flujo.

Códigos observados: `400` `BAD_REQUEST` / `TEXT_REQUIRED` /
`ACTION_NOT_SUPPORTED` / `REPLY_TO_MESSAGE_NOT_FOUND`, `401` `TOKEN_INVALID`,
`403` `BOT_SUSPENDED` / `CHAT_FORBIDDEN`, `404` `CHAT_NOT_FOUND`, `500`
`INTERNAL_ERROR`.

Proyección de mensaje (la única, deliberadamente pobre — el `Message` de dominio
tiene ~40 campos y ninguno más se filtra):

```
BotMessage { message_id, from{id, name}, chat{id, type}, date, text }
```

`date` está en **segundos**, no milisegundos.

`getMe` devuelve `{ id, is_bot: true, username, first_name }`.

Límites y defaults del servidor (configurables, estos son los valores por
defecto): `BOTAPI_UPDATES_MAX_LIMIT=100`, `BOTAPI_UPDATES_MAX_TIMEOUT=30`
segundos, `BOTAPI_STREAM_MAXLEN=10000`. En la request: `offset` ausente o `0` no
confirma nada, `limit` por defecto `100`, `timeout` por defecto `0`. Valores
negativos, tipos incorrectos y `limit:0` explícito son `400`; valores por encima
del máximo se **clampean** en silencio.

### 2.2 Superficie de sesión humana

```
POST <base>/bot/register                  (X-Botapi-Platform-Key, server-to-server)
POST <base>/bots/{botID}/conversation     (sesión humana — el "/start")
GET  <base>/bots/search/{query}           (sesión humana)
```

### 2.3 Superficie de BotSmith (gestión)

```
GET  <base>/bot-management/capability
GET  <base>/bot-management/bots
GET  <base>/bot-management/bots/{id}
GET  <base>/bot-management/dialogue
POST <base>/bot-management/commands
PUT  <base>/bot-management/administrators/{id}
```

Credenciales: **sesión humana (bearer o cookie) + `X-Secret`**. Nada que ver con
el token del bot. Envelope distinto: `{ok, data}` en éxito y
`{ok:false, error:{code}}` en error, con `no-store`.

Códigos: `INVALID_INPUT` 400, `UNAUTHORIZED` 401, `FORBIDDEN` 403, `NOT_FOUND`
404, `STALE_STATE` 409, `QUOTA_EXCEEDED` 422, `TOO_MANY_ATTEMPTS` 429,
`UNAVAILABLE`/`RECOVERY_REQUIRED` 503.

`POST /commands` no es un CRUD: es una **máquina de estados conversacional** con
control de concurrencia optimista. Body:
`{operationID, expectedRevision, command, value?, botID?, expectedCredentialVersion?}`.
Vocabulario de comandos: `/newbot`, `/mybots`, `/help`, `/cancel`, `value`,
`select`, `name`, `description`, `issue`, `rotate`, `revoke`, `archive`,
`unarchive`, `confirm`.

---

## 3. Lo que pepibot descubrió y el SDK tiene que resolver

Cada uno de estos seis puntos es una trampa que un autor pisa una vez, en
producción, y tarda un rato en entender. Están en el orden en que duelen.

### 3.1 Un solo consumidor lógico por bot, y el servidor no avisa

Dos `getUpdates` simultáneos sobre el mismo bot **se reparten** los updates: cada
camino recibe la mitad, **sin error visible**. La invariante está declarada en el
diseño del servidor —consumer group `botapi-updates`, consumer fijo `api-1`,
válida incluso entre réplicas de la API— y el spec dice explícitamente que
detectar o rechazar al segundo consumidor queda fuera de v1.

Telegram, ante lo mismo, devuelve un `409 Conflict: terminated by other
getUpdates request`. **Es una diferencia real a favor de Telegram** y está
levantada como pedido al servidor en §13 (S1).

Mientras tanto el SDK hace lo único que puede hacer desde afuera: garantizar que
**una instancia** nunca tenga dos polls en vuelo, y fallar ruidosamente si se la
arranca dos veces. Lo que pasa entre dos procesos distintos no lo ve, y el
documento tiene que decirlo con todas las letras (§8, L3).

### 3.2 El offset tiene que avanzar SIEMPRE

Incluso para un update ya visto, o uno que el handler no pudo procesar, o uno que
hizo explotar al handler. Si el offset solo avanza al tener éxito, el bot se
atasca reintentando el mismo update para siempre, y —peor— nunca ve los que
vienen atrás.

Esta es la regla que más fácil se rompe cuando el autor la escribe a mano, porque
"solo confirmo lo que procesé bien" suena a lo correcto. No lo es: el `offset` de
Chasky **no** es un ack de negocio, es un cursor de lectura.

### 3.3 La entrega es at-least-once

El mismo `update_id` puede volver: el cliente se murió entre responder y avanzar
el offset, o la entry quedó en el PEL. El `update_id` **no** se reasigna en la
reentrega. Deduplicar es responsabilidad del cliente.

### 3.4 `Idempotency-Key` nueva por mensaje lógico, la misma al reintentar ESE

Es una extensión de Chasky; Telegram no conoce esta cabecera. Solo aplica a
`sendMessage`, y está scopeada **por bot**, nunca por chat.

La trampa: reusar una key entre mensajes distintos hace que el servidor devuelva
el resultado de la primera y **descarte el segundo en silencio**. La llamada
responde `200` con un `BotMessage` válido. Parece que funcionó. No funcionó.

Además, en el reintento la **key gana sobre el body**: si se reintenta la misma K
con otro texto, el servidor devuelve el snapshot original antes de siquiera
validar el contenido nuevo.

### 3.5 El token se filtra a los logs por el transporte

Como viaja en la ruta, el cliente HTTP incrusta la URL completa en sus propios
errores. Un `connection refused` alcanza para dejar la credencial escrita en un
log. No hace falta que nadie loguee mal: alcanza con loguear el error.

El servidor ya redacta `/bot<token>/` en los suyos. **El cliente tiene que hacer
lo mismo del lado de afuera**, y es responsabilidad del SDK, no del autor: el
autor no sabe que el error trae una URL adentro.

### 3.6 Los identificadores son cadenas, y los campos se llaman distinto

`chat.id`, `from.id` y `message_id` son **string** en Chasky y **número** en
Telegram. El remitente es `from.name` en Chasky y `from.first_name` en Telegram.

Consecuencia dura: **un SDK de Telegram no funciona contra Chasky sin
modificarlo.** No alcanza con cambiar la URL base. Es la evidencia que decide la
decisión de fondo del §4.

En pepibot esto se resolvió con un tipo `flexID` que recuerda la forma en que
llegó el identificador y lo reemite igual. **Ese tipo es un artefacto de correr
las dos plataformas en un mismo binario, y NO debe portarse al SDK** (§9).

---

## 4. Decisión de fondo — nativo de Chasky, no compatible con Telegram

**Recomendación: nativo.** Con una precisión que importa: nativo en los **tipos**,
familiar en el **modelo mental**.

### Por qué no compatible

Imitar la API de un SDK de Telegram promete una cosa —"portás tu bot casi sin
tocarlo"— que el contrato no puede sostener. Los identificadores tienen otro
tipo. Un `chat_id` numérico no encuentra nada en Chasky; uno entrecomillado lo
rechaza Telegram. Sostener la fachada obliga a coerción por todos lados, y toda
coerción de identificadores es un **error silencioso**: no tira excepción, apunta
al chat equivocado o a ninguno.

Y la lista de diferencias no se agota en los tipos:

| | Telegram | Chasky |
|---|---|---|
| `chat.id`, `from.id`, `message_id` | número | **string** |
| nombre del remitente | `first_name` | **`name`** |
| poll concurrente | `409` explícito | se reparte, sin error |
| `Idempotency-Key` | no existe | requerida por disciplina |
| `sendChatAction` | vocabulario amplio | **solo `typing`** |
| adjuntos, media, botones | sí | **no en v1** |
| `setWebhook` en la superficie del token | sí | **no, y a propósito** (§10) |

Un autor que trae un bot de Telegram y encuentra una API que se le parece pero
falla distinto está peor que uno que encuentra una API honesta y distinta. La
falsa familiaridad es más cara que la diferencia declarada.

### Qué sí se toma prestado

El **modelo mental**, que es lo que realmente se porta: updates con un
`update_id` monótono, `offset` como cursor, `chat_id` como destino, y
composición por handlers (`bot.on(...)`, middlewares). Un autor de telegraf
reconoce la forma en cinco minutos aunque no reuse una línea.

Eso es el 80% del beneficio de portar, sin nada de la ficción de tipos.

---

## 5. Decisión — lenguaje

**Recomendación: TypeScript/Node primero. Go segundo.**

El razonamiento no es "TS es mejor", es **dónde el SDK vale más**:

1. **El público del SDK no es el equipo del backend.** Son terceros que escriben
   bots. Las referencias que el usuario mismo nombró —`python-telegram-bot`,
   `telegraf`— son Python y JS. No hay un SDK de Go de Telegram que ocupe ese
   lugar en la cabeza de nadie.

2. **El valor marginal del SDK es mayor en JS que en Go, y pepibot lo prueba.**
   Hoy un autor de Go puede hablar con Chasky en 554 líneas de biblioteca
   estándar, sin una sola dependencia, y ya existe el archivo que lo demuestra.
   El autor de JS enfrenta las mismas 554 líneas **más** el trabajo de descubrir
   solo las seis trampas del §3. El hueco a tapar es más grande del lado de JS.

3. **El resto del producto ya es JS.** El frontend es Next.js; el portal
   enterprise también. Un `@chasky/bot` se instala y se despliega en el mismo
   toolchain que el equipo ya opera.

4. **El futuro webhook es Node.** Cuando exista egreso de webhooks (§10), el
   handler HTTP del bot va a vivir mayoritariamente en un runtime serverless, y
   ese terreno es de Node.

**Contraargumento honesto, y por qué no gana:** el servidor es Go, y un SDK en Go
lo mantendría el mismo equipo sin cambiar de contexto, con tests de contrato
contra un servidor local en un solo toolchain. Es un argumento de
**mantenimiento**, real, y pierde contra uno de **adopción**: el SDK existe para
gente que no está en el repo del servidor.

**Rol de pepibot en el plan:** no se descarta y no se promueve a producto. Queda
como **cliente de conformidad** —la implementación de referencia mínima, en
stdlib, que verifica el contrato del servidor de punta a punta— y se mueve a
`reference/pepibot/` de este repo. Un SDK de Go se considera después, con el
contrato ya estabilizado por el de TS.

---

## 6. Decisión — superficie mínima y empaquetado

**Recomendación: dos paquetes, y solo el primero en la primera entrega.**

### `@chasky/bot` — runtime del bot (primera entrega)

Credencial: el token, en la ruta. Superficie: `getMe`, `getUpdates`,
`sendMessage`, `sendChatAction`, más todo el andamiaje del §7.

### `@chasky/botsmith` — gestión (después, y solo si hay demanda)

Credencial: **sesión humana + `X-Secret`**. Superficie: los seis endpoints de
`/bot-management`.

Son dos paquetes y no uno por tres razones, en orden de peso:

1. **Credenciales distintas.** Un paquete solo obliga a un constructor que acepta
   token *o* sesión+secreto, y eso invita al error más caro posible: mandar el
   `X-Secret` de la plataforma desde el proceso del bot, o el token del bot desde
   el navegador. Separar los paquetes hace que ese error ni se pueda escribir.
2. **Audiencias distintas.** El runtime lo instala el autor del bot en su
   servidor. La gestión la usa quien provisiona bots — hoy, una persona en el
   portal.
3. **Formas distintas.** `/bot-management/commands` no es REST: es un diálogo con
   estado, `operationID`, `expectedRevision` y CAS. Modelarlo bien es un trabajo
   propio, y no debería demorar la primera entrega del runtime.

**Por qué BotSmith no es urgente:** casi todos los autores crean el bot **una
vez**, a mano, en el portal. La automatización por código sirve para un caso
concreto —CI que provisiona bots por entorno— y hasta que ese caso exista es
superficie que se mantiene sin usarse.

---

## 7. Superficie de la API del SDK

Boceto de contrato, no implementación: firmas y tipos, sin cuerpos. Sirve para
discutir la forma; los nombres finales se cierran junto con el §12.

### 7.1 Tipos del dominio

```ts
type ChatID    = string;  // "bot:{botID}:{userID}"  — SIEMPRE string
type UserID    = string;  // "bot:{uuid}" o el id del humano
type MessageID = string;
type UpdateID  = number;  // el ÚNICO numérico. Ver §9.

interface BotUser    { id: UserID; name: string }
interface Chat       { id: ChatID; type: string }
interface BotMessage { messageId: MessageID; from: BotUser; chat: Chat; date: Date; text: string }
interface Update     { updateId: UpdateID; message?: BotMessage }
interface BotIdentity { id: UserID; isBot: true; username: string; displayName: string }
```

`date` llega en segundos y se expone como `Date`. `displayName` se mapea desde el
`first_name` del servidor: esa asimetría —`first_name` a la Telegram en `getMe`,
`name` a la Chasky en `from`— es una inconsistencia del servidor y el SDK la
absorbe en vez de propagarla (pedido S2 en §13).

### 7.2 Cliente crudo

Un envoltorio 1:1 de los cuatro métodos, sin bucle. Es lo que usa el runtime por
dentro, y lo que necesita quien quiere control total.

```ts
class ChaskyBotClient {
  constructor(options: { token: string; baseUrl?: string; fetch?: typeof fetch });

  getMe(signal?: AbortSignal): Promise<BotIdentity>;
  getUpdates(params: { offset?: number; limit?: number; timeoutSeconds?: number },
             signal?: AbortSignal): Promise<Update[]>;
  sendMessage(params: { chatId: ChatID; text: string; replyToMessageId?: MessageID },
              signal?: AbortSignal): Promise<BotMessage>;
  sendChatAction(params: { chatId: ChatID; action: "typing" },
                 signal?: AbortSignal): Promise<true>;
}
```

`action` es un literal `"typing"` y no un string: el vocabulario de Telegram es
válido en Telegram y `400 ACTION_NOT_SUPPORTED` acá. Que el compilador lo diga
antes que el servidor es gratis.

### 7.3 Runtime — lo que la mayoría va a usar

```ts
const bot = createBot({
  token: process.env.CHASKY_BOT_TOKEN!,
  baseUrl: process.env.CHASKY_API,          // default: producción
  transport: polling({ limit: 50, timeoutSeconds: 25 }),  // hoy el único (§10)
});

bot.command("start", ctx => ctx.reply("Hola, soy pepi."));
bot.on("text",       ctx => ctx.reply(`Dijiste: ${ctx.message.text}`));

bot.onError(err => logger.error(err));       // ya viene redactado (§10.3 / §9)
bot.onFatal(err => process.exit(1));         // 401/403 terminal: el bot no sigue

await bot.start();
await bot.stop();                            // corta el long-poll en vuelo
```

`ctx` trae el update, el mensaje, el `chatId`, el cliente crudo, y los atajos
`reply` (que es `sendMessage` al chat del update, con `Idempotency-Key`
administrada) y `typing`.

**Un detalle del dominio que el SDK debe reflejar:** un bot **no puede iniciar**
una conversación. Solo puede responder en un chat que ya conoce, porque la
conversación la crea la apertura humana (`POST /bots/{botID}/conversation`). El
`chatId` se aprende de los updates. Un método que sugiera "mandale un mensaje a
este usuario" sería una mentira de API; si el SDK expone un envío fuera de
handler, tiene que pedir un `chatId` que el autor haya guardado él.

---

## 8. Semánticas: lo que el SDK garantiza y lo que delega

Esta es la sección que hace del SDK algo más que un envoltorio de `fetch`, y la
que hay que leer entera antes de escribir un bot.

### 8.1 Garantiza

- **G1 — Un solo poll en vuelo por instancia.** `start()` sobre una instancia ya
  arrancada es un error inmediato y local, no un bot que recibe la mitad de los
  mensajes.
- **G2 — El offset avanza siempre.** Se calcula `max(update_id) + 1` sobre el
  lote **recibido**, y se manda en el poll siguiente pase lo que pase con los
  handlers: excepción, timeout, rechazo, update ya visto. El avance es del
  transporte, no del negocio.
- **G3 — Dedup por `update_id`, con ventana acotada.** pepibot usa un `map` que
  crece para siempre; en un proceso que vive meses eso es una fuga. El SDK usa
  una ventana finita, dimensionada con la garantía del servidor de que los
  `update_id` son monótonos por bot (§12, D6).
- **G4 — `Idempotency-Key` administrada.** Una key nueva por mensaje lógico, la
  **misma** en cada reintento interno de ese envío. El autor nunca la escribe ni
  la ve. Si la fuente de aleatoriedad falla, **no se envía**: mandar sin key es
  peor que no mandar, porque un reintento crearía un duplicado.
- **G5 — Redacción del token en todo error que salga del SDK.** Incluidos los del
  transporte, y recursivamente en `cause`, `stack` y cualquier campo que traiga
  una URL.
- **G6 — Clamp de `limit` y `timeout`.** Un `timeout: 60` razonable no debe
  convertirse en un `400`; se recorta al máximo del servidor y se emite un aviso.
  Los valores que el servidor rechaza de plano —negativos, `limit: 0`— se
  rechazan en el SDK, con el motivo, antes de gastar una request.
- **G7 — Reintento con backoff en lo transitorio, corte en lo terminal.** `401`
  y `403 BOT_SUSPENDED` detienen el bot y disparan `onFatal`: reintentar un token
  revocado es ruido infinito. Red, `5xx` y timeouts reintentan con backoff
  exponencial y jitter.
- **G8 — Cancelación limpia.** `stop()` aborta el long-poll en vuelo; no espera
  hasta 30 segundos a que venza el deadline del servidor.
- **G9 — Los identificadores se reemiten tal cual llegaron.** El SDK nunca
  convierte un id (§9).

### 8.2 Delega — explícitamente, y hay que leerlo

- **L1 — Exactly-once no existe.** El servidor no lo promete y el SDK no lo puede
  inventar. Si un handler tiene efectos hacia afuera —cobrar, mandar un mail,
  crear un ticket— la idempotencia de **ese** efecto es del autor. G3 reduce los
  duplicados; no los elimina.
- **L2 — Persistencia del offset entre reinicios.** Por defecto el offset vive en
  memoria: al reiniciar, el servidor reentrega el PEL y el bot vuelve a ver
  updates ya procesados. Se expone un gancho `OffsetStore` opcional, y **queda
  documentado que el default reprocesa** (§12, D7).
- **L3 — Un solo proceso por bot.** G1 vale **por instancia**. El SDK no puede
  ver otra réplica, y el servidor no la rechaza (§3.1). Correr dos procesos del
  mismo bot rompe la entrega en silencio, y eso es del despliegue. Mientras el
  pedido S1 no exista, esto es la limitación más peligrosa del sistema y el
  README tiene que abrirlo con eso.
- **L4 — La retención del stream.** `BOTAPI_STREAM_MAXLEN=10000` por bot, y el
  `XTRIM` puede llevarse incluso updates no confirmados. Un bot caído más tiempo
  del que cubre esa ventana pierde updates. Es operación, no SDK.
- **L5 — El significado.** Qué contestar, cuándo y con qué texto.

---

## 9. Identificadores

**Regla única: en Chasky todos los identificadores son `string`, y el SDK nunca
los convierte.** Los recibe string, los guarda string, los reemite string.

`chat.id` tiene forma `bot:{botID}:{userID}` y `from.id` tiene forma `bot:{uuid}`
para el bot. **Eso es estructura observable, no contrato**: el SDK no parsea ids
para deducir nada, igual que el servidor —que tiene la regla explícita de no
parsear ids para autorizar. Un id es una etiqueta opaca.

**`flexID` no se porta.** El tipo de pepibot que recuerda si el id llegó como
cadena o como número resuelve un problema que solo existe cuando un mismo binario
habla con Chasky y con Telegram. En un SDK nativo de Chasky ese problema no
existe, y copiarlo sería arrastrar una solución sin su problema: agrega un tipo
propio donde alcanza `string`, y le pide al autor pensar en una ambigüedad que su
plataforma no tiene.

**`update_id` es la única excepción numérica**, y merece su párrafo. Es un `int64`
del lado del servidor (`INCR botapi:seq:{botID}`, uno por bot, empezando en cero).
En JS los enteros son exactos hasta 2^53; un `int64` real no entra. En la
práctica un contador por bot no se acerca ni de lejos a ese techo, así que se
representa como `number`. **Esto queda escrito acá para que nadie lo "arregle" a
`BigInt` sin saber por qué, y para que si algún día el servidor cambia el
generador de secuencia —a un snowflake, a un timestamp— esta decisión se
reabra.** Los gaps en la secuencia son válidos y esperables; el SDK no debe
tratarlos como pérdida.

---

## 10. Errores y redacción

### 10.1 Tipado

```ts
class ChaskyApiError extends Error {
  readonly code: number;         // 400, 401, 403, 404, 500 — control de flujo
  readonly description: string;  // string del servidor — SOLO para logs
  readonly method: string;       // "sendMessage", ...
}
class ChaskyTransportError extends Error { readonly cause: unknown }
```

El control de flujo se hace **por `code`**, nunca por `description`: el servidor
declara la description como legible y estable, pero no como enumerada.

### 10.2 Clasificación

| Clase | Códigos | Qué hace el SDK |
|---|---|---|
| Terminal | `401`, `403 BOT_SUSPENDED` | Detiene el bot, dispara `onFatal`. No reintenta. |
| De negocio | `400`, `403 CHAT_FORBIDDEN`, `404` | Devuelve el error al llamador. No reintenta: reintentar un `text` vacío da un `text` vacío. |
| Transitorio | `500`, `5xx`, red, timeout | Backoff exponencial con jitter, **reusando la misma `Idempotency-Key`**. |

### 10.3 Redacción — obligatoria, no opcional

**Ningún objeto que el SDK exponga puede contener el token.** La regla no es
"tener cuidado al loguear": es que el token viaja en la ruta y el transporte
incrusta la URL en sus propios errores, así que el `Error` ya nace contaminado
antes de que nadie lo toque.

Implementación de la regla:

1. Todo error que cruce el borde del SDK pasa por un redactor que reemplaza el
   token por `<REDACTED>` en `message`, `stack`, y recursivamente en `cause`.
2. Se redacta el **token**, y también el patrón `/bot<algo>/` de la ruta, para
   cubrir el caso de un token distinto del configurado.
3. El SDK **no loguea por su cuenta**. Emite eventos; loguear es del autor. Pero
   todo lo que emite ya viene redactado, de modo que la decisión del autor no
   pueda filtrar la credencial.
4. El token nunca aparece en la representación del cliente: `toString`,
   `inspect`, serialización.

**Y una regla más, que pepibot no cubre:** si el `baseUrl` es `http://` y el host
no es local, el SDK **advierte** —o se niega, según D8— porque un token en la
ruta sobre texto plano queda escrito en cada proxy del camino. En HTTPS el path
va cifrado; en HTTP, no.

---

## 11. Webhook: el lugar reservado, sin comprometer la forma

Hoy Chasky **no tiene** egreso de webhooks. Está especificado y sin construir en
`docs/sdd/botapi/botsmith/12-webhook-delivery.md` del servidor. El SDK deja el
lugar y no promete nada más.

**Lo que sí se compromete:** el transporte es un parámetro, y los handlers del
autor no cambian al cambiarlo.

```ts
createBot({ token, transport: polling({ ... }) })    // hoy
createBot({ token, transport: webhook({ ... }) })    // cuando exista
```

Toda la promesa es esa: `bot.on("text", ...)` sobrevive al cambio.

**Lo que NO se compromete:** la forma del handler HTTP, el nombre de la cabecera
de secreto, el modelo de reintentos del servidor, el formato del cuerpo. Todo eso
está sin construir y comprometerlo hoy sería inventar el contrato del servidor
desde el cliente.

**Dos cosas que el SDK sí debe saber desde ya**, porque están decididas del lado
del servidor:

- **Polling y webhook son excluyentes.** No es estilo copiado de Telegram: los
  dos consumirían del mismo consumer group y competirían, con el mismo síntoma
  invisible del §3.1. Configurar los dos transportes tiene que ser un error de
  construcción del SDK, no algo que se descubra en producción.
- **La URL se registra por BotSmith, no por el token.** No va a haber
  `setWebhook` en la superficie del token, y es a propósito: un token filtrado
  hoy deja mandar mensajes como el bot —malo, acotado, se cierra rotando—; si
  además dejara registrar webhook, el atacante redirige **todo el tráfico
  entrante** a su servidor y lee las conversaciones sin que el dueño lo note.
  Cuando exista, la configuración de webhook vive en `@chasky/botsmith`, no en
  `@chasky/bot`.
- Cuando un bot está en modo webhook, `getUpdates` responde **error explícito**,
  no lista vacía. El SDK tiene que traducir ese error a un mensaje que diga
  "estás preguntando por el canal equivocado", porque una lista vacía se lee como
  "no hay mensajes" y es la peor confusión posible.

---

## 12. Decisiones abiertas

Las cinco primeras son de fondo y están recomendadas arriba; se repiten acá para
que se puedan aprobar o rechazar de una.

| # | Decisión | Recomendación | Fundamento |
|---|---|---|---|
| **D1** | Lenguaje de la primera entrega | **TypeScript/Node** (`@chasky/bot`) | El público son terceros, y el hueco es mayor en JS: en Go pepibot ya prueba que se puede con stdlib. §5 |
| **D2** | ¿Compatible con Telegram o nativo? | **Nativo**, con el modelo mental de Telegram | Los ids son string vs número; toda coerción es error silencioso. §4 |
| **D3** | Superficie | **Dos paquetes**; `@chasky/bot` primero, `@chasky/botsmith` después | Credenciales distintas: un solo paquete invita a mandar el `X-Secret` desde el proceso del bot. §6 |
| **D4** | Webhook | **Seam de transporte, sin comprometer forma** | El servidor no lo construyó todavía. §11 |
| **D5** | Destino de pepibot | **Cliente de conformidad** en `reference/pepibot/`, no producto | Es la prueba viva del contrato; degradarlo a ejemplo pierde esa función |
| **D6** | Tamaño de la ventana de dedup | Ventana de los últimos **N=1000** `update_id`, o solo `> lastSeen` | El `update_id` es monótono por bot, así que un umbral simple podría alcanzar y evitaría la estructura entera. **Preguntar**: ¿alcanza el umbral, o hay reentregas fuera de orden? |
| **D7** | Persistencia del offset | Gancho `OffsetStore` **opcional**, default en memoria | Un default con disco sorprende; uno con memoria reprocesa. Se elige reprocesar y documentarlo |
| **D8** | `http://` no local | **Advertir**, no negarse | Negarse rompe entornos de staging internos legítimos. Abierto: ¿preferís que se niegue y haya que optar explícitamente? |
| **D9** | Nombre y scope del paquete | `@chasky/bot` y `@chasky/botsmith`; repo `bot-sdk` | Sigue la convención de los repos hermanos, que no llevan prefijo `chasky-` |

---

## 13. Lo que le pedimos al servidor

Salen de este análisis y son tickets de `backend-api-go`, no del SDK.

- **S1 — `409` en `getUpdates` concurrente, como Telegram.** *Prioridad alta.* Es
  el hallazgo #1 del §3.1: hoy dos consumidores se reparten los updates sin error
  visible, y ninguna cantidad de disciplina del cliente lo detecta desde afuera.
  Un `409` explícito convierte el peor modo de falla del sistema —silencioso,
  intermitente, imposible de diagnosticar— en un mensaje de error. El spec lo
  dejó fuera de v1 a conciencia; el SDK es la evidencia de que hace falta.
- **S2 — Normalizar `getMe`.** Devuelve `first_name` (nombre de Telegram) cuando
  el resto del contrato usa `name` (nombre de Chasky). Habiendo elegido no ser
  compatible con Telegram, esa asimetría no compra nada y confunde. Agregar
  `display_name` conservando `first_name` por compatibilidad sería suficiente.
- **S3 — Publicar los límites efectivos.** `BOTAPI_UPDATES_MAX_LIMIT` y
  `BOTAPI_UPDATES_MAX_TIMEOUT` son configurables, y hoy el cliente los tiene que
  hardcodear para poder clampear (G6). Exponerlos en `getMe` —o en un
  `getLimits`— hace que el SDK se adapte a la instancia en vez de adivinarla.
- **S4 — Documentar la retención por bot.** El `XTRIM` aproximado puede llevarse
  updates no confirmados. Un autor necesita saber cuánto tiempo puede estar caído
  su bot antes de perder mensajes; hoy ese número no está publicado.
- **S5 — `Retry-After` en el `429` de BotSmith.** Menor. Sin esa cabecera, un
  cliente de `TOO_MANY_ATTEMPTS` solo puede adivinar el backoff.

---

## 14. Lo que NO entra en la primera entrega

Adjuntos y media (el servidor solo hace texto en v1). Botones y callbacks. Teclado
inline. Presencia. Edición y borrado de mensajes. Grupos (el modelo es un bot
atendiendo a muchos usuarios, cada uno con su chat privado). Registro de bots
desde el SDK (`POST /bot/register` usa platform key server-to-server y no debe
salir de la plataforma). Webhook. Reintento automático a nivel de handler.

Nada de esto está descartado; está **fuera del alcance de la primera entrega**, y
la razón en casi todos los casos es la misma: el servidor todavía no lo ofrece.

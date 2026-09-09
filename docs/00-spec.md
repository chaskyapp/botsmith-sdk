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
`403` `BOT_SUSPENDED` / `CHAT_FORBIDDEN`, `404` `CHAT_NOT_FOUND`, `409`
`CONFLICT_POLLING` (§3.1), `500` `INTERNAL_ERROR`.

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

### 3.1 Un solo consumidor por bot — el servidor ahora expulsa

**Esto cambió el 2026-09-08** (commit `d4526381` de `backend-api-go`, spec
`docs/sdd/botapi/botsmith/14-poll-exclusion.md`). El texto viejo de esta sección
describía el peor modo de falla del sistema; hoy describe un contrato.

**Antes**: dos `getUpdates` simultáneos sobre el mismo bot **se repartían** los
updates —cada camino recibía la mitad, sin error ni log—, porque los dos polls
usaban el mismo nombre de consumidor y `XREADGROUP` reparte. Desde afuera se veía
"un bot que a veces no responde", y no había nada en los logs que lo explicara.

**Ahora**: hay un cerrojo por bot (`botapi:poll:<botID>`) y `getUpdates` devuelve
**`409 CONFLICT_POLLING`**. Chasky imita a Telegram, que corta con
`409 Conflict: terminated by other getUpdates request`.

Tres detalles del mecanismo que el SDK necesita saber, y que no se deducen de
"hay un 409":

1. **El que llega DESPLAZA al que estaba.** El cerrojo se toma sin condición
   (`SET` sin `NX`), así que **el `409` le llega al poll VIEJO**, no al nuevo. El
   servidor lo eligió así porque el caso frecuente es un reinicio del bot, y
   hacer esperar al proceso que acaba de arrancar sería un impuesto diario para
   prevenir un accidente de configuración que se arregla una vez.

   Consecuencia directa y nada obvia: **`start()` no es una operación inocente.**
   Arrancar el SDK expulsa a quien esté polleando ese bot. En un despliegue con
   dos réplicas, arrancar la segunda mata a la primera.

2. **Perder el poll NO pierde mensajes.** El poll desplazado devuelve **cero**
   entradas —no las que ya había leído: entregar a medias sería el mismo reparto
   silencioso con menos elementos— y esas entradas quedan **sin ACK**, así que las
   recupera la instancia que lo desplazó. El SDK no tiene que hacer nada. El autor
   lo va a preguntar igual, y por eso está documentado acá.

3. **El cerrojo tiene TTL corto y se renueva por tramo**, no dura el poll entero.
   Un proceso que muere libera el bot en segundos en vez de esperar el timeout
   máximo de 30 s. Para el SDK esto es una buena noticia operativa: reiniciar un
   bot es rápido.

**Lo que el SDK debe hacer con el `409`: detenerse, no reintentar.** Es terminal,
como el `401`. El reflejo natural de un cliente es reintentar cualquier error que
parezca transitorio, y acá ese reflejo es catastrófico: dos instancias que
reintentan entran en una **guerra de expulsiones** —cada una desplaza a la otra,
ninguna llega a procesar nada— y el resultado es peor que el reparto silencioso
que este cambio vino a arreglar. Está anotado como garantía **G7** (§8.1) y como
caso obligatorio de conformidad.

**Y el mensaje importa.** El `409` **no** significa "configuración incorrecta":
en un despliegue rolling es el flujo normal y correcto, y la instancia vieja debe
morir limpia. El SDK dice *"otra instancia tomó el poll de este bot; esta se
detiene"*, no *"error de configuración"*. Distinguir un deploy de un accidente no
se puede hacer en el instante del `409` —son idénticos— y fingir que sí sería
mentirle al autor.

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
| poll concurrente | `409` explícito | **`409` explícito** — ya coincide |
| `Idempotency-Key` | no existe | requerida por disciplina |
| `sendChatAction` | vocabulario amplio | **solo `typing`** |
| adjuntos, media, botones | sí | **no en v1** |
| `setWebhook` en la superficie del token | sí | **no, y a propósito** (§10) |

Un autor que trae un bot de Telegram y encuentra una API que se le parece pero
falla distinto está peor que uno que encuentra una API honesta y distinta. La
falsa familiaridad es más cara que la diferencia declarada.

**Nota del 2026-09-08:** el `409` en poll concurrente pasó de diferencia a
coincidencia (§3.1). Eso **no reabre esta decisión**. La fila que hace que un SDK
de Telegram no funcione contra Chasky es la primera —`string` contra número—, no
esta: una coincidencia más en una tabla de siete no cambia que los identificadores
tengan otro tipo, y la coerción de identificadores sigue siendo un error
silencioso. Lo que sí gana el `409` es que la **clasificación de errores** (§10.2)
se acerca a la de Telegram, y eso abarata portar el manejo de errores. Es un
ahorro real y no es la decisión de fondo.

### Qué sí se toma prestado

El **modelo mental**, que es lo que realmente se porta: updates con un
`update_id` monótono, `offset` como cursor, `chat_id` como destino, y
composición por handlers (`bot.on(...)`, middlewares). Un autor de telegraf
reconoce la forma en cinco minutos aunque no reuse una línea.

Eso es el 80% del beneficio de portar, sin nada de la ficción de tipos.

---

## 5. Decisión — los tres SDKs y su orden

**CERRADA (2026-09-08): se hacen tres — TypeScript, Go y Python — en un monorepo,
y el orden de entrega es TypeScript → Go → Python.**

### 5.1 Por qué TypeScript primero

1. **El público del SDK no es el equipo del backend.** Son terceros que escriben
   bots. Las referencias del rubro —`telegraf`, `python-telegram-bot`— son JS y
   Python.
2. **El valor marginal es mayor en JS, y pepibot lo prueba.** Hoy un autor de Go
   habla con Chasky en 554 líneas de biblioteca estándar, sin una dependencia, y
   el archivo que lo demuestra ya existe. El autor de JS enfrenta esas mismas 554
   líneas **más** el trabajo de descubrir solo las seis trampas del §3.
3. **El resto del producto ya es JS.** Frontend Next.js, portal enterprise. Mismo
   toolchain que el equipo ya opera.
4. **El futuro webhook es Node.** Cuando exista egreso de webhooks (§11), el
   handler HTTP del bot va a vivir mayoritariamente en un runtime serverless.

Y una precisión que no es cosmética: se escribe **en TypeScript**, y los `.d.ts`
publicados son **parte del contrato público**, no documentación. Que
`sendChatAction({ action: "upload_photo" })` falle en el editor y no con un `400
ACTION_NOT_SUPPORTED` en producción es la mitad del valor del SDK, porque la
mitad de las trampas del §3 son de forma.

### 5.2 Por qué Go segundo

El argumento de adopción favorecía a Python —no tiene nada hoy, y los bots con
LLM son casi todos Python—. Gana un argumento más urgente: **la suite de
conformidad (§6) no prueba nada con un solo consumidor.**

Una suite corrida por una sola implementación no valida el contrato: valida esa
implementación contra sí misma. Recién con el **segundo** puerto aparecen los
casos donde la suite era ambigua, donde el "contrato" era en realidad un detalle
de cómo lo hizo el primero, y donde una garantía estaba escrita en prosa que
admitía dos lecturas.

Go llega segundo antes que Python porque **la mitad del trabajo ya está escrita**
en pepibot y porque lo mantiene el mismo equipo que el servidor, sin cambiar de
contexto. Es el segundo puerto más barato, y el segundo puerto es el que
convierte la conformidad en algo real.

### 5.3 Por qué Python tercero

Es el que más adopción trae y el que menos riesgo de contrato corre, porque llega
con el contrato ya sacudido por dos implementaciones. Llegar tercero no lo
degrada: lo hace el más barato de los tres.

### 5.4 Rol de pepibot

**No se promueve a `sdk/go` y no se degrada a ejemplo.** Su función es distinta
de la de un SDK: es el único cliente que corre contra **Chasky y Telegram a la
vez**, y esa comparación es lo que hace visibles las diferencias del §4. Un SDK
nativo de Chasky pierde exactamente esa capacidad.

Queda en `reference/pepibot/` como **cliente de conformidad**: la implementación
mínima en stdlib que verifica el contrato del servidor de punta a punta. El SDK
de Go nace mirándolo, no siendo él (D5, §12).

---

## 6. Decisión — superficie mínima y empaquetado

**CERRADA: dos paquetes por lenguaje, y solo el primero en la primera entrega.**

### Paquete 1 — runtime del bot (primera entrega)

Credencial: el token, en la ruta. Superficie: `getMe`, `getUpdates`,
`sendMessage`, `sendChatAction`, más todo el andamiaje del §7.

### Paquete 2 — gestión (después, y solo si hay demanda)

Credencial: **sesión humana + `X-Secret`**. Superficie: los seis endpoints de
`/bot-management`.

### Por qué son dos y no uno

No son dos partes del mismo SDK: **son dos sistemas distintos que casualmente
hablan del mismo objeto.** El contraste, verificado contra el servidor:

| | Runtime | Gestión |
|---|---|---|
| Credencial | token en la **ruta** | sesión humana **+** `X-Secret` |
| Ruta | `/bot<TOKEN>/sendMessage` | `/bot-management/commands` |
| Auth del servidor | `IsPublic: true, NoRequiresAuthentication: true` | middleware de sesión + secreto de API |
| Envelope éxito | `{ok, result}` | `{ok, data}` |
| Envelope error | `{ok:false, error_code, description}` | `{ok:false, error:{code}}` |
| Tipo del código de error | **número** (`409`) | **string** (`"STALE_STATE"`) |
| Forma | REST con métodos | máquina de estados con CAS |
| Quién lo corre | el proceso del bot, 24/7 | un humano, una vez |

Cuatro razones, en orden de peso:

**1. Los envelopes son incompatibles, y el `409` significa lo contrario en cada
superficie.** Esta razón no es un juicio de diseño: es un hecho del servidor.

Un envelope tiene `result` y el otro `data`. Uno codifica el error como número y
el otro como string dentro de un objeto anidado. Un cliente HTTP no puede parsear
los dos sin ramificar en la primera línea.

Y encima:

| `409` en… | Código | Qué significa | Qué debe hacer el cliente |
|---|---|---|---|
| Runtime | `CONFLICT_POLLING` | otra instancia te desplazó | **detenerse**, jamás reintentar |
| Gestión | `STALE_STATE` | tu `expectedRevision` está viejo | **releer y reintentar** |

**Es el mismo número con la instrucción opuesta.** En un paquete único queda un
`ChaskyError` con `code: 409` cuyo manejo correcto depende de qué endpoint lo
produjo — y el día que alguien escriba un `if (code === 409) retry()` compartido,
rompe el runtime de la peor forma posible: la guerra de expulsiones del §3.1.

**2. Credenciales distintas, y el daño de filtrarlas no es simétrico.** Un
paquete único obliga a un constructor que acepta token *o* sesión+secreto, y eso
hace **escribible** el peor error del sistema: mandar el `X-Secret` de plataforma
desde el proceso del bot, que corre en el servidor de un tercero.

- **Token filtrado**: el atacante manda mensajes como ese bot. Malo, acotado, se
  cierra rotando el token.
- **`X-Secret` filtrado**: es un secreto de **plataforma**, no de un bot. No es el
  mismo incidente.

Es la llave del departamento y la llave maestra del edificio: las dos abren
puertas, y no van en el mismo llavero. Con dos paquetes ese error **no se puede
ni tipear** — el paquete del runtime no tiene un campo donde poner el `X-Secret`.

Y no es criterio importado: **es el mismo razonamiento de radio de impacto que el
servidor ya aplicó** al decidir que `setWebhook` no va en la superficie del token
(`12-webhook-delivery.md`, Req.W1). Esto lo respeta del lado del cliente.

**3. Audiencias distintas.** El runtime lo instala el autor del bot en su
servidor. La gestión la usa quien provisiona bots — que puede ser otra persona:
BotSmith separa explícitamente al dueño (sesión humana) del portador del token.

**4. Formas distintas.** `/bot-management/commands` no es REST: es un diálogo con
estado, `operationID`, `expectedRevision` y CAS optimista. Modelarlo bien es un
trabajo propio, y no debería demorar la primera entrega del runtime.

### El contraargumento, y qué se hace con él

Dos paquetes son dos publicaciones, dos versiones y más ceremonia. Y comparten
código: redacción del token, backoff, cliente HTTP.

Comparten **menos de lo que parece** — el envelope, que es el corazón del parseo,
es distinto en los dos. Lo que sí se repite son unas 50 líneas. Van a un paquete
**interno y no publicado** (`js/core/`, `go/internal/`, `python/_core/`), del que
ninguno de los dos paquetes públicos expone la superficie del otro.

La alternativa —un paquete con dos entrypoints, `@chasky/bot` y
`@chasky/bot/smith`— ahorra esa ceremonia y **pierde la garantía**: el código de
gestión ya está instalado en el proceso del bot, así que el `X-Secret` vuelve a
ser algo que alguien puede pasarle. Es una ceremonia menos a cambio de la razón 2
entera.

**Por qué BotSmith no es urgente:** casi todos los autores crean el bot **una
vez**, a mano, en el portal. La automatización por código sirve para un caso
concreto —CI que provisiona bots por entorno— y hasta que ese caso exista es
superficie que se mantiene sin usarse.

### Nombres por ecosistema

Los dos paquetes existen en los tres lenguajes, con el nombre que cada ecosistema
espera. El nombre cambia; la separación de credenciales no.

El estándar es **la identidad `chasky` + el rol en una palabra** (`bot` para el
runtime, `botsmith` para la gestión), escrito como cada ecosistema lo escribe.
El scope `@chasky/` de npm está **confirmado disponible** (2026-09-08), y es el
que fija el estándar para los otros dos.

| | Runtime | Gestión |
|---|---|---|
| npm | `@chasky/bot` ✅ | `@chasky/botsmith` ✅ |
| Go | `github.com/chaskyapp/bot-sdk/go` (`package chaskybot`) | `.../bot-sdk/go/botsmith` |
| PyPI | `chasky-bot` | `chasky-botsmith` |

---

## 7. Superficie de la API del SDK

Boceto de contrato, no implementación: firmas y tipos, sin cuerpos. Sirve para
discutir la forma; los nombres finales se cierran junto con el §12.

Está escrito en TypeScript porque es la primera entrega (§5). **Go y Python NO lo
transliteran**: portan los invariantes y adoptan la forma de su ecosistema. Qué
es invariante y qué es idiomático está en `01-organizacion.md` §3, y es la regla
que impide que el SDK de Python parezca TypeScript mal traducido.

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
- **G3 — Dedup por `update_id`, con un umbral.** Se descarta todo
  `update_id <= lastSeen`, y `lastSeen` es **un solo entero**: no hace falta
  ninguna estructura de datos. El servidor entrega en orden ascendente estricto y
  no emite identificadores regresivos, así que un `update_id` por debajo del
  umbral es **siempre** un duplicado (D6, §12 — verificado contra el código).
  pepibot usa un `map` que crece para siempre; en un proceso que vive meses eso
  es una fuga, y el umbral la elimina de raíz.

  Ese entero es **el mismo** que alimenta el offset: `offset == lastSeen + 1` en
  todo momento (D7, §12). El SDK guarda un número, no dos.
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
- **G7 — Reintento con backoff en lo transitorio, corte en lo terminal.** `401`,
  `403 BOT_SUSPENDED` y **`409 CONFLICT_POLLING`** detienen el bot y disparan
  `onFatal`: reintentar un token revocado es ruido infinito, y reintentar un
  `409` es una **guerra de expulsiones** en la que dos instancias se desplazan
  mutuamente y ninguna procesa nada (§3.1). Red, `5xx` y timeouts reintentan con
  backoff exponencial y jitter.
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
  updates ya procesados. Se expone un gancho `OffsetStore` opcional —`load()` /
  `save(n)`, invocado una vez por lote— y **queda documentado que el default
  reprocesa** (D7, §12, cerrada).
- **L3 — Un solo proceso por bot.** G1 vale **por instancia**: el SDK no puede
  ver otra réplica. **Desde el 2026-09-08 el servidor sí la rechaza** con un
  `409` (§3.1), así que esto dejó de ser el peor modo de falla del sistema —era
  silencioso, ahora es ruidoso— y pasó a ser una condición operativa normal.

  Lo que queda delegado es **decidir cuántos procesos corren**. El servidor deja
  polleando al último que arrancó; si el despliegue levanta dos réplicas, una va
  a morir con `409` cada vez. El SDK reporta el hecho; que haya una sola es del
  despliegue.
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
| Terminal — desplazado | `409 CONFLICT_POLLING` | Detiene el bot. **Nunca reintenta**: reintentar es una guerra de expulsiones (§3.1). El mensaje dice "otra instancia tomó el poll", no "error de configuración". |
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

## 12. Decisiones

Las cerradas están cerradas: se aplican, no se rediscuten salvo que aparezca
evidencia nueva. Las abiertas necesitan una respuesta antes de la primera línea
de código.

### Cerradas

| # | Decisión | Resolución | Fundamento |
|---|---|---|---|
| **D1** | Lenguajes y orden | **TS → Go → Python**, los tres | El segundo puerto es el que valida la conformidad; Go es el segundo más barato. §5 |
| **D2** | ¿Compatible con Telegram o nativo? | **Nativo**, con el modelo mental de Telegram | Los ids son string vs número; toda coerción es error silencioso. §4 |
| **D3** | Superficie | **Dos paquetes por lenguaje**; runtime primero, gestión después | Envelopes incompatibles y un `409` que significa lo opuesto en cada superficie; y un paquete único hace *escribible* mandar el `X-Secret` desde el proceso del bot. §6 |
| **D4** | Webhook | **Seam de transporte, sin comprometer forma** | El servidor no lo construyó todavía. §11 |
| **D5** | Destino de pepibot | **Cliente de conformidad** en `reference/pepibot/`, no semilla de `sdk/go` | Es el único cliente que corre contra las dos plataformas, y el SDK nativo pierde esa capacidad. El movimiento efectivo es tarea de la entrega 2 (abajo) |
| **D6** | Dedup por `update_id` | **Umbral `> lastSeen`**: un entero, sin estructura de datos | Verificado en el código (abajo). Es más barato **y** más correcto que una ventana finita |
| **D7** | Persistencia del offset | Gancho `OffsetStore` **opcional**, default en memoria | Un default con disco sorprende; uno con memoria reprocesa **y se ve**. Y el estado es **un solo entero** (abajo) |
| **D8** | `http://` no local | **Advertir una vez**, no negarse; opción explícita para silenciar | Negarse rompe staging interno legítimo — TLS terminado en el ingress, túneles, compose |
| **D9** | Layout y nombres | **Monorepo `bot-sdk`**, un directorio por lenguaje en la raíz; scope npm **`@chasky/`** confirmado disponible | Tres puertos del mismo contrato, mismo equipo, al mismo tiempo. Detalle en `01-organizacion.md` |
| **D10** | Formato de la conformidad | **Casos JSON** + un fake HTTP por lenguaje | Idiomático y sin proceso externo. Decisión **reversible** (abajo) |
| **D11** | Versionado | **Independiente por paquete** + versión del contrato declarada aparte | La pregunta que importa no es qué versión tiene el paquete, sino qué garantías implementa |

#### Verificación de D6 (2026-09-08)

Leído en `internal/core/botapi/infrastructure/redis/`, rama `cc-jose-nieto/botapi`:

1. **`producer.go`** — el `XADD` del script Lua usa un **stream ID explícito**
   igual a `<update_id>-0`, así que **el orden del stream es el orden de
   `update_id`**. El script además compara contra el último ID del stream y
   aborta antes que emitir uno regresivo: hay **gaps válidos, nunca IDs hacia
   atrás**.
2. **`updates.go`** — el lector recorre primero el **PEL** (`XREADGROUP` desde
   `"0"`, con el cursor avanzando por `entry.ID`) y recién después las **nuevas**
   (`">"`), que por construcción tienen IDs mayores que cualquier pendiente.

De ahí sale que **cada respuesta llega en orden ascendente estricto**, y que entre
respuestas también lo está mientras el offset avance (G2). La única fuente de
repetición es una re-entrega del PEL, y siempre trae `update_id <= lastSeen`.

**El umbral no filtra de más**: sin identificadores regresivos, un `update_id` por
debajo del umbral es siempre un duplicado.

**Y es más correcto que una ventana finita.** Si el consumer group se recrea
—camino `NOGROUP` del propio lector— el last-delivered-id vuelve a cero y se
re-entrega **el stream entero**. Una ventana de N=1000 reprocesa todo lo anterior
a esas mil entradas; el umbral no se inmuta. Se elige por correctitud; que además
sea un entero en vez de una estructura es el bonus.

*Alcance*: el umbral vale **dentro de la vida del proceso**. Al reiniciar,
`lastSeen` arranca en cero y el PEL se reprocesa — eso es **D7**, no D6, y es el
default documentado en L2.

#### D7 — y el hallazgo de que el estado es un solo entero

`OffsetStore` es una interfaz de dos métodos, `load()` y `save(n)`, invocada
**una vez por lote** y no por update: guardar por update sería correcto y lento.

Y hay una simplificación que cae de D6 y que conviene tener escrita antes de
implementar tres veces: **el offset y el umbral de dedup son el mismo número.**

Con G2 el offset es `max(update_id del lote) + 1`, y con G3 el umbral es
`max(update_id procesado)`. Como el offset avanza pase lo que pase con los
handlers, al cerrar cada lote vale siempre `offset == lastSeen + 1`. **No son dos
piezas de estado: es una.** El `OffsetStore` persiste un entero, y de ahí salen
las dos cosas.

Default en memoria porque un default con disco sorprende —¿dónde escribe, con qué
permisos, qué pasa en un contenedor efímero?— y porque reprocesar al reiniciar no
viola nada: at-least-once ya está delegado en L1. Es visible, es documentado, y
quien no lo quiera implementa la interfaz.

#### D8 — advertir, con precisión

La advertencia se emite **una sola vez, al construir el cliente**, no por request:
una advertencia por poll es ruido que se termina filtrando en un grep.

"Local" es **solo loopback**: `localhost`, `127.0.0.0/8`, `::1`, `*.localhost`.
Deliberadamente NO incluye `*.local`, que en mDNS puede ser una máquina de la red
real y ahí el token viaja en claro por la ruta.

Se silencia con una opción explícita (`allowInsecureTransport: true`). Quien la
escribe, sabe lo que está aceptando; el default no lo decide por él.

#### D10 — casos JSON, y por qué no el binario único

La alternativa era un binario de conformidad que hospeda el fake y contra el que
los tres SDKs pegan por HTTP real. Es **más fiel** —HTTP de verdad, no un mock— y
se paga caro: hay que construirlo y mantenerlo, cada CI tiene que arrancarlo,
esperar el puerto y matarlo, y aparece una familia entera de fallas nuevas que no
son del SDK (puertos ocupados, carreras de arranque).

Los casos JSON con un fake por lenguaje usan el mock HTTP que cada ecosistema ya
tiene, sin proceso externo. **JSON y no YAML** porque los tres lenguajes lo
parsean sin agregar dependencia.

El riesgo real es que tres fakes interpreten un caso distinto. Se acota haciendo
que el caso declare **las requests esperadas de forma exacta** —método, ruta,
cabeceras, cuerpo— y que el fake solo las reproduzca: lo que se verifica es lo
observado contra lo declarado, nunca lógica que viva dentro del fake.

Es una decisión **reversible**, y ese es medio argumento: si los tres fakes
empiezan a divergir, se migra al binario único con los mismos casos.

#### D11 — versión de paquete y versión de contrato

Cada paquete lleva su semver y se publica cuando tiene algo que publicar: un fix
de empaquetado en Python no fuerza releases vacíos en TypeScript y Go.

Aparte, cada paquete declara **contra qué versión del contrato** cumple, y los
casos de conformidad declaran a qué versión pertenecen. Eso responde la única
pregunta que de verdad importa entre tres implementaciones: *¿estos dos SDKs
garantizan lo mismo?* — que la versión del paquete no contesta.

La versión del contrato es `MAJOR.MINOR`: **MINOR** cuando se agrega una garantía,
**MAJOR** cuando cambia una que ya existía.

### Abiertas

| # | Decisión | Recomendación | Qué falta |
|---|---|---|---|
| **D12** | Traducir `docs/` al inglés | **DISPARADA el 2026-09-08**: D5, D7, D8, D10 y D11 cerraron, así que esto es lo único pendiente. Incluye renombrar `01-organizacion.md` → `01-organization.md`, actualizar los enlaces y quitar los avisos *"(in Spanish for now)"* de los READMEs | Ya no espera nada. Queda en esta lista hasta ejecutarse, que es exactamente para lo que estaba: un paso pendiente que no se cuenta es un paso que se olvida |

---

## 13. Lo que le pedimos al servidor

Salen de este análisis y son tickets de `backend-api-go`, no del SDK.

- **S1 — `409` en `getUpdates` concurrente, como Telegram. ✅ RESUELTO
  (2026-09-08, commit `d4526381`).** Era el hallazgo #1: dos consumidores se
  repartían los updates sin error visible, y ninguna disciplina del cliente lo
  detectaba desde afuera. Hoy hay un cerrojo por bot y un `409 CONFLICT_POLLING`
  (§3.1). El peor modo de falla del sistema —silencioso, intermitente, imposible
  de diagnosticar— pasó a ser un mensaje de error.

  **Salvedad para el repo del servidor, no para el SDK:** el `Req.X1` de
  `14-poll-exclusion.md` dice que falla *el que llega*; la implementación hace lo
  contrario y **desplaza al que estaba**, con el motivo explicado en el commit.
  El código manda y el SDK se escribe contra el código; ese spec quedó
  desactualizado.
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

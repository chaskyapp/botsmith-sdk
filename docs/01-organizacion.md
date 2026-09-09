# Organización del monorepo

Complemento de [`00-spec.md`](00-spec.md), que define **el contrato**. Este
documento define **cómo se sostiene ese contrato en tres implementaciones sin
que se desincronicen.**

Decisiones cerradas el 2026-09-08: monorepo, y orden de entrega
**TypeScript → Go → Python**.

---

## 1. El problema que este documento resuelve

Escribir tres SDKs no es difícil. Lo difícil es que sigan siendo **el mismo
SDK** dentro de seis meses.

El modo de falla concreto: alguien arregla el avance del offset en TypeScript
—porque un usuario reportó que su bot se atascaba— y Python y Go se quedan con el
bug. Ahora hay dos comportamientos contra el mismo servidor, ninguno documentado
como distinto, y el próximo que investigue va a perder un día averiguando cuál de
los tres tiene razón.

Ese riesgo no se administra con buena voluntad ni con un checklist en el PR
template. Se administra con **una suite de conformidad ejecutable** (§4) y con una
regla clara sobre qué debe ser idéntico y qué debe ser distinto (§3).

El layout del repo es lo **menos** importante de este documento. Está primero
porque es lo que se ve.

---

## 2. Layout

```
bot-sdk/
├── README.md
├── docs/
│   ├── 00-spec.md              El contrato. Agnóstico de lenguaje.
│   └── 01-organizacion.md      Este documento.
├── conformance/
│   ├── README.md               Cómo se corre y cómo se agrega un caso.
│   └── cases/                  Casos declarativos. Fuente de verdad ejecutable.
├── js/                         @chasky/bot        · primera entrega
├── go/                         .../bot-sdk/go     · segunda entrega
├── python/                     chasky-bot         · tercera entrega
└── reference/
    └── pepibot/                Cliente de conformidad (pendiente D5)
```

**Un directorio por lenguaje en la raíz, no bajo `sdk/`.** El anidamiento extra
no compra nada y encarece los tags de Go: `go/v0.1.0` es legible,
`sdk/go/v0.1.0` es ruido. El precio es una raíz con tres directorios de
implementación a la vista, que es exactamente lo que el repo es.

### El detalle de Go, que es el único incómodo

Go es el ecosistema que peor lleva los monorepos poliglotas, así que conviene
dejarlo escrito antes de que alguien lo descubra solo:

- `go/go.mod` declara `module github.com/chaskyapp/bot-sdk/go`.
- El import queda `github.com/chaskyapp/bot-sdk/go`, y el paquete se llama
  `chaskybot` — en Go el nombre del paquete no tiene que coincidir con el
  directorio, y `package go` no existe.
- Los tags de release llevan el prefijo del subdirectorio: **`go/v0.1.0`**, no
  `v0.1.0`. Es el mecanismo estándar de submódulos de Go, funciona con
  `go get`, y falla de forma confusa si alguien taggea sin el prefijo.
- `go/` tiene su propio `go.sum` y su propio CI. No comparte nada de build con
  los otros dos.

Ninguna de estas tres cosas es un obstáculo. Todas son sorpresas si no se
anticipan.

---

## 3. Qué es invariante y qué es idiomático

**La regla más importante del repo.** El error clásico del SDK multi-lenguaje es
**transliterar**: portar TypeScript a Python cambiando la sintaxis. El resultado
se reconoce a simple vista —`bot.onError(...)` en camelCase, con callbacks, en un
paquete de PyPI— y le dice al usuario que le vendieron un puerto perezoso.

Un SDK de Python tiene que sentirse escrito por alguien que escribe Python.

### Invariante — idéntico en los tres, y la conformidad lo verifica

- Las garantías **G1–G9** y las delegaciones **L1–L5** del §8 del contrato, con
  el mismo **comportamiento observable**: mismas requests, mismo orden, mismos
  reintentos, mismos cortes.
- Los **nombres de los tipos del dominio y de sus campos** (`Update`,
  `BotMessage`, `chat`, `from`, `text`). Ajustados a la convención de cada
  lenguaje, pero reconocibles: quien lee el spec encuentra el campo.
- La **clasificación de errores** —terminal / de negocio / transitorio— y qué se
  reintenta.
- La **política de redacción** del token (§10.3): ningún objeto expuesto contiene
  la credencial, en ninguno de los tres.
- El **wire format exacto**: qué se manda, con qué cabeceras, con qué defaults.

### Idiomático — distinto a propósito, y la conformidad no lo mira

| | TypeScript | Go | Python |
|---|---|---|---|
| Concurrencia | `Promise` + `AbortSignal` | goroutine + `context.Context` | `asyncio` + `CancelledError` |
| Naming | `camelCase` | `PascalCase` exportado | `snake_case` |
| Errores | excepciones (`throw`) | valores de error (`error`) | excepciones (`raise`) |
| Handlers | closures, `bot.on("text", fn)` | funcs / interfaces, `bot.Handle(...)` | decoradores, `@bot.on_text` |
| Config | objeto de opciones | functional options | kwargs / dataclass |
| Cancelar | `bot.stop()` con `AbortController` | cancelar el `context` | cancelar la task |

Cuando invariante e idiomático chocan, **gana el idiomático en la forma y el
invariante en el comportamiento**. Ejemplo concreto: en Go, `sendMessage`
devuelve `(BotMessage, error)` y no lanza nada — eso es idiomático y correcto.
Lo que **no** puede cambiar es cuáles de esos errores el SDK reintenta solo y
cuáles devuelve.

---

## 4. La suite de conformidad

Es el mecanismo que hace que "tres SDKs" no sea "tres productos". Sin esto, el
§3 es una aspiración.

### Qué es

Un conjunto de **casos declarativos** en `conformance/cases/`, versionados junto
al contrato. Cada caso describe un escenario del servidor y las requests que el
SDK **debe** producir. Convierte las garantías G1–G9 de prosa en tests que
fallan.

Los casos que más importan son los que corresponden a las seis trampas del §3,
porque son las que un puerto apurado rompe:

- El servidor devuelve updates 5, 6, 7 y el handler **tira excepción** en el 6 →
  el siguiente poll manda `offset: 8`. **G2.** Es el caso que más fácil se rompe,
  porque "solo confirmo lo que procesé bien" suena a lo correcto.
- El servidor reentrega el update 6 → el handler corre **una sola vez**. **G3.**
- Dos `sendMessage` lógicamente distintos → **dos** `Idempotency-Key` distintas.
  **G4.** Y el reintento del primero → la **misma** key.
- El transporte falla con un error que contiene la URL → el error que sale del
  SDK **no** contiene el token. **G5.**
- `timeout: 60` → la request sale con el máximo del servidor, no con 60. **G6.**
- `401` → el bot se detiene y no reintenta. `500` → reintenta con backoff. **G7.**

### Cómo se ejecuta

Cada SDK trae un runner mínimo que levanta un servidor HTTP falso guiado por el
caso, corre el SDK contra él, y compara las requests observadas con las
esperadas. El runner es de cada lenguaje; **los casos son compartidos**.

Un caso que solo pasa en TypeScript es un caso mal escrito o un bug en los otros
dos. Nunca es "así funciona en ese lenguaje".

### La regla operativa

> **Un cambio de comportamiento se escribe primero como caso de conformidad, y
> recién después se implementa.** Un SDK que no pasa un caso nuevo está
> incompleto, no roto: el caso es el que manda.

Y el corolario incómodo, que conviene aceptar de entrada: cuando llegue el SDK de
Go y falle un caso, **la primera hipótesis es que el caso está mal escrito**, no
que Go está mal. Los casos nacidos de una sola implementación describen esa
implementación. Ese sacudón es exactamente por lo que Go va segundo (§5.2 del
contrato) y no hay que resistirlo: es el trabajo, no un contratiempo.

---

## 5. Versionado y releases

Recomendación —**abierta, D11**—: **versión independiente por paquete**, y la
versión del contrato declarada aparte.

- Los tres paquetes tienen su propio semver. Un fix de empaquetado en Python no
  fuerza un release vacío de TypeScript y Go.
- Cada paquete declara **contra qué versión del contrato** cumple, y ese número
  aparece en la conformidad. Es el dato que responde la pregunta que realmente
  importa: *¿este SDK implementa las mismas garantías que aquel?*
- Tags: `js/v0.1.0`, `go/v0.1.0`, `python/v0.1.0`.

La alternativa —una versión única sincronizada para los tres— es más fácil de
explicar y de comunicar. Se paga con releases vacíos y con una versión que miente
sobre qué cambió en cada paquete. Está en D11 por si preferís esa moneda.

---

## 6. Orden de trabajo

El orden **dentro** de cada entrega importa tanto como el orden entre lenguajes.

### Entrega 1 — TypeScript

1. Cerrar D5–D8 y D10–D11 del contrato. **Sin esto no se escribe código**: D6
   (ventana de dedup) cambia la estructura de datos del núcleo en los tres.
2. Escribir los casos de conformidad **antes** que el SDK. Salen del §8 del
   contrato, no de la implementación.
3. Runner de conformidad en TypeScript.
4. `@chasky/bot`: cliente crudo, luego runtime.
5. Correr contra un servidor local real, con el flujo completo de pepibot.

### Entrega 2 — Go

6. `bot-sdk/go`, mirando pepibot pero sin heredarlo (§5.4 del contrato).
7. Runner de conformidad en Go, contra **los mismos casos**.
8. **Reconciliar.** Acá aparecen los casos ambiguos. Corregir el caso y después
   las dos implementaciones — en ese orden.

### Entrega 3 — Python

9. `chasky-bot`, con el contrato ya sacudido por dos puertos.
10. Runner y conformidad.

### Transversal, en cualquier momento

11. Los pedidos al servidor del §13 del contrato. **S1 (el `409` en `getUpdates`
    concurrente) no depende de ningún SDK y es el hallazgo más grave del
    análisis**: puede arrancar hoy, en paralelo con la entrega 1.

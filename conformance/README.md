# Suite de conformidad

**Vacío: todavía no hay casos.** Es lo primero que se escribe, antes que
cualquier SDK.

Los casos de `cases/` son la **fuente de verdad ejecutable** del contrato:
convierten las garantías G1–G9 del §8 en tests que fallan. Cada SDK trae su
propio runner; **los casos son compartidos**.

## La regla

> Un cambio de comportamiento se escribe primero como caso, y recién después se
> implementa.

Un caso que solo pasa en un lenguaje es un caso mal escrito o un bug en los
otros. Nunca es "así funciona en ese lenguaje".

Detalle y lista de casos prioritarios:
[`../docs/01-organizacion.md`](../docs/01-organizacion.md) §4.

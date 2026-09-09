# bot-sdk — SDK cliente de la Bot API de Chasky

**Estado: especificación. Todavía no hay código.**

Este repo va a contener el SDK que un autor de bot instala en su proyecto para
hablar con la Bot API de Chasky, en el mismo lugar que `telegraf` o
`python-telegram-bot` ocupan para Telegram.

Vive **fuera** de `backend-api-go` a propósito: el SDD scopeó el consumidor
externo fuera del repo del servidor, y meterlo adentro contaminaría la API con
decisiones que le corresponden a cada autor de bot.

## Por dónde empezar

- **[docs/00-spec.md](docs/00-spec.md)** — la especificación completa: propósito,
  superficie, semánticas garantizadas y delegadas, identificadores, errores y
  redacción, decisiones abiertas y pedidos al servidor.

## Lo más importante de la especificación, en tres líneas

1. **Un solo proceso por bot.** Dos `getUpdates` simultáneos se reparten los
   updates **sin error visible**. El SDK garantiza un solo poll por instancia; lo
   que pasa entre procesos no lo ve nadie hasta que el servidor devuelva `409`
   (pedido S1).
2. **El offset avanza siempre**, aunque el handler falle. Es un cursor de
   lectura, no un ack de negocio.
3. **El token viaja en la ruta** y se filtra a los logs por el transporte. Todo
   error que sale del SDK viene redactado.

## Estado de las decisiones

Las decisiones de fondo (lenguaje, compatibilidad con Telegram, empaquetado)
están **recomendadas y sin aprobar** en el §12 de la especificación. No se
escribe código hasta que estén cerradas.

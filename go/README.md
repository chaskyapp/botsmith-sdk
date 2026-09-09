# SDK de Go

**Entrega 2. Vacío: todavía no hay código.**

- Módulo: `github.com/chaskyapp/bot-sdk/go`, `package chaskybot`.
- Tags de release **con prefijo de subdirectorio**: `go/v0.1.0`, no `v0.1.0`.
  Sin el prefijo, `go get` falla de forma confusa.
- Nace mirando `reference/pepibot/`, **sin heredarlo**: pepibot corre contra
  Chasky y Telegram a la vez, y ese es su valor. Ver §5.4 del contrato.
- Contrato: [`../docs/00-spec.md`](../docs/00-spec.md)

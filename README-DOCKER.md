# Entorno local de Configuración de eventos

El Compose levanta PostgreSQL, migraciones, API y worker con simulador. Está configurado exclusivamente para desarrollo local.

## Iniciar

```powershell
Copy-Item .env.example .env
docker compose up --build -d
```

La API queda en `http://localhost:3000/configuration/v1` y Swagger en `http://localhost:3000/configuration/v1/docs`. PostgreSQL se publica en `127.0.0.1:5433`.

## Probar el worker

Usa Swagger para crear un evento y luego publica una release mediante `POST /configuration/v1/events/{id}/releases`, enviando `If-Match`, `Idempotency-Key` y `expected_event_revision`.

```powershell
docker compose logs -f worker
```

El ejemplo configura `SIMULATOR_FAIL_FIRST_N=1`: el simulador falla la primera entrega de cada arranque, programa retry y luego acepta el mensaje. Busca `outbox_retry_scheduled`, seguido por `outbox_delivered` con el mismo `outbox_id`. Para desactivar el fallo, define `SIMULATOR_FAIL_FIRST_N=0` en `.env` y recrea el worker.

El broker simulado no envía mensajes a otros servicios. La identidad es mock de desarrollo; no expongas estos contenedores como despliegue de producción.

# Servicio de configuración de eventos

Este repositorio contiene el servicio del Grupo 2 para crear y administrar eventos, conservar sus revisiones, asignar responsables y publicar versiones inmutables de la configuración. El estado actual permite desarrollo y pruebas locales; todavía utiliza identidad, membresías y entrega de mensajes simuladas.

## Estado actual

- API REST en NestJS/TypeScript con documentación OpenAPI/Swagger.
- PostgreSQL 16 con migraciones SQL versionadas, separación por organización y políticas de seguridad por fila (RLS).
- Operaciones de eventos que incluyen creación/consulta, edición con control de concurrencia (`ETag`/`If-Match`), duplicado, cierre, cancelación, archivo, asignaciones, historial y auditoría.
- Publicación de releases con manifiesto, hash y artefactos de evento, cronograma y formularios. El smoke test usa fixtures de desarrollo para esos artefactos; aún no consulta los servicios reales de cronograma o formularios.
- Registro transaccional `outbox`: la API guarda el evento de integración junto con la operación de negocio. El worker local reclama mensajes por tenant, usa leases, reintenta fallos con backoff y marca entregas o fallos terminales.
- Worker Node.js separado del proceso de la API. Su adaptador actual es `SimulatedBroker`: no entrega mensajes a ningún otro servicio.
- Compose local para PostgreSQL, migraciones, API y worker. La configuración usa `pnpm` y el volumen `postgres_data` conserva la base entre reinicios normales.
- Autenticación mediante actores de desarrollo (`x-dev-actor`) y una tabla en memoria de membresías. No hay validación de JWT/OIDC ni conexión al servicio real de organizaciones/membresías.

## Contrato HTTP del Integrante A

`contracts/configuration/openapi.yaml` documenta el contrato canónico de esta copia. Las operaciones principales usan:

| Acción | Ruta |
|---|---|
| Crear evento | `POST /configuration/v1/events` |
| Listar eventos | `GET /configuration/v1/events` |
| Leer evento | `GET /configuration/v1/events/{id}` |
| Editar evento | `PATCH /configuration/v1/events/{id}` |
| Duplicar | `POST /configuration/v1/events/{id}/duplications` |
| Cerrar inscripciones | `POST /configuration/v1/events/{id}/closures` |
| Cancelar | `POST /configuration/v1/events/{id}/cancellations` |
| Archivar | `POST /configuration/v1/events/{id}/archives` |
| Validar readiness | `POST /configuration/v1/events/{id}/publication-validations` |
| Publicar una release | `POST /configuration/v1/events/{id}/releases` |

Los comandos mutables requieren `Idempotency-Key`; los que dependen de revisión requieren `If-Match`. La publicación también requiere `expected_event_revision` en el body y debe coincidir con `If-Match`. Duplicar requiere `site_id`, `slug`, `starts_at` y `ends_at`; cerrar/cancelar requieren `reason` y `effective_at`. Los errores usan `application/problem+json` con `code`, `request_id` y `errors[]`.

El contrato declara Bearer/JWT como seguridad de integración y conserva `x-dev-actor` como esquema exclusivamente local. **La implementación actual solo resuelve actores mock**; Bearer/JWT no queda operativo hasta conectar el proveedor de identidad. La validación de readiness usa fixtures para agenda y formularios.

El endpoint independiente `/configuration/v1/events/{id}/publish` se retiró del contrato: publicar ocurre mediante la creación de una release. Las rutas anteriores con sufijos `/duplicate`, `/close`, `/cancel`, `/archive` y `/readiness` también se sustituyeron por las rutas canónicas; clientes deben actualizarse.

## Requisitos

- Docker Desktop con Compose V2.
- Node.js 22 o superior y Corepack habilitado para ejecutar los scripts locales.
- `pnpm` del proyecto (`pnpm@11.20.0`), gestionado mediante Corepack.

## Arranque local

Desde esta carpeta, en PowerShell:

```powershell
Copy-Item .env.example .env
# Edita .env y establece contraseñas locales propias.
docker compose up --build -d
docker compose ps
```

URLs locales:

- API: `http://localhost:3000/configuration/v1`
- Swagger: `http://localhost:3000/configuration/v1/docs`
- PostgreSQL: `127.0.0.1:5433`

Para observar los servicios:

```powershell
docker compose logs -f api
docker compose logs -f worker
docker compose logs -f db migrate
```

## Scripts operativos

El único script operativo del repositorio es `scripts/migrate.mjs`. Aplica en orden las migraciones de `db/migrations`, registra sus hashes y prepara el rol restringido de la aplicación. Compose lo ejecuta antes de iniciar la API y el worker. Para ejecutarlo manualmente: `docker compose run --rm migrate`.

No hay scripts de seed, smoke ni carga de datos. Para probar el flujo, crea un evento y una release desde Swagger usando el actor local `org-a-manager`. Los cambios quedan en el volumen de PostgreSQL hasta que se elimine deliberadamente con `docker compose down -v`.

El ejemplo de `.env.example` configura `SIMULATOR_FAIL_FIRST_N=1` para observar el reintento del worker. Después de ejecutar el smoke test, consulta `docker compose logs -f worker`; normalmente verás `outbox_retry_scheduled` seguido de `outbox_delivered` para el mismo `outbox_id`. El fallo es deliberado y lo genera el simulador, no un servicio externo.

## Integración con los servicios reales

La integración debe hacerse por contratos acordados con los equipos responsables de identidad/tenants, cronograma, formularios y mensajería. Antes de conectar, confirmen con ellos los endpoints o topics, esquemas, identificadores, autenticación, versiones y manejo de errores. El flujo recomendado es:

1. **Acordar contratos y ownership.** Usar `contracts/configuration/openapi.yaml` como contrato HTTP del servicio y acordar contratos de eventos con los consumidores. Definir quién es dueño de cada dato (evento, cronograma, formularios, tenant y membresía), compatibilidad de versiones y una estrategia para cambios compatibles.
2. **Conectar identidad y tenants.** Sustituir `MockClaimsProvider` y el encabezado `x-dev-actor` por validación real de JWT/OIDC: firma, emisor, audiencia, expiración y scopes. Mapear claims verificados a `sub` y `organization_id`. Sustituir `MembershipAdapter` por el cliente/adaptador del servicio de membresías. No aceptar tenant o usuario enviados en el body como prueba de identidad. Mantener RLS y probar accesos cruzados.
3. **Conectar cronograma y formularios.** Implementar adaptadores de salida para consultar/validar sus servicios al preparar una publicación. Acordar IDs, estados, errores y disponibilidad. El ensamblador de releases debe conservar snapshots/artefactos y hashes reproducibles; decidir si el servicio propietario entrega una versión o si Configuración de eventos guarda una copia. Evitar que el smoke fixture sea usado como respuesta real.
4. **Definir el contrato de mensajes.** Acordar broker (por ejemplo, Kafka o RabbitMQ, según la plataforma), topics/routing keys, esquema versionado, clave de partición, headers de correlación, identificador único del evento, política de retención y consumidores. Los mensajes deben representar hechos confirmados, como release publicada o evento cancelado, y no incluir datos sensibles innecesarios.
5. **Implementar un adaptador de broker real.** Reemplazar `SimulatedBroker.publish` por un adaptador con cliente oficial del broker elegido, configuración por variables/secretos, TLS y autenticación, timeout, confirmación del broker y clasificación de errores transitorios/permanentes. Mantener la interfaz pequeña (`publish`) y seleccionar simulador o broker real mediante configuración explícita. En Compose de desarrollo se podrá añadir el broker y su healthcheck cuando se conozca la plataforma elegida.
6. **Conservar las garantías de `outbox`.** La API ya registra el mensaje en la misma transacción que el cambio de negocio. El worker solo debe marcarlo `delivered` después de una confirmación válida del broker; ante error transitorio debe reintentar con backoff y ante agotamiento registrar el estado terminal y permitir inspección/reprocesamiento. Como un proceso puede caer después de publicar y antes de marcar la fila, la entrega es al menos una vez: los consumidores deben ser idempotentes usando el ID de evento/outbox. No prometer “exactly once” de extremo a extremo.
7. **Añadir operación y seguridad.** Configurar secretos fuera del repositorio, métricas y alertas para pendientes/antiguos/reintentos/fallos, logs estructurados con `event_id`, `outbox_id`, tenant y correlation ID, health/readiness, límites y apagado ordenado. Restringir permisos de publicación y acceso por tenant.

La selección del broker no está fijada en este repositorio. No se debe asumir Kafka, RabbitMQ ni un formato de mensaje concreto hasta acordarlo con la plataforma y los servicios consumidores.

## Desarrollo fuera de Docker

Para compilar la API: `pnpm build:api`. Para ejecutar sus pruebas unitarias: `pnpm test:api`. El worker se inicia con `pnpm start:worker` y requiere variables PostgreSQL, `WORKER_TENANT_IDS` y una base ya migrada. En la mayoría de los casos, Compose es la opción más sencilla para levantar juntas las dependencias locales.

> **Solo desarrollo local:** `AUTH_MODE=mock`, actores y membresías en memoria, fixtures y broker simulado no son aptos para exponer el servicio ni para producción.

# Integrante A — Eventos y núcleo de publicación

**Rol dentro del Equipo 2:** responsable del ciclo de vida de los eventos y del ensamblado de cada release. Esta guía desarrolla el [acuerdo común](../ACUERDO-DESARROLLO-EQUIPO-2.md); las reglas normativas siguen en el [backlog](../backlogs/TEAM-2-EVENT-CONFIGURATION.md) y los [contratos de API](../contracts/API-CONTRACTS.md).

## Historias asignadas

| Historia | Entrega concreta |
|---|---|
| EC-001 | Crear evento/convocatoria en `draft` con sitio, slug, tipo, zona horaria, fechas y policy inicial; auditar e impedir duplicados por idempotencia. |
| EC-002 | Editar metadatos y reglas con `ETag`/`If-Match`; devolver `412` ante una revisión vieja; conservar releases previas. |
| EC-003 | Duplicar configuración permitida en otro borrador, con IDs y fechas nuevas; excluir publicaciones y registros. |
| EC-004 | Cerrar inscripciones mediante nueva versión de policy y release; mostrar estado sin cancelar confirmados. |
| EC-005 | Cancelar con razón y evento de cancelación; archivar sólo estados terminales y conservar historial. |
| EC-006 | Asignar responsables por evento/sede con membresía activa, scope mínimo y vigencia; propagar revocación. |
| EC-030 | Validar readiness de sitio, fechas, agenda, policy, binding, consentimiento y permisos antes de publicar. |
| EC-031 | Crear `publication_id`, snapshot/hash/manifiesto y outbox de manera atómica e idempotente. |
| EC-040 | Listar y filtrar eventos por sitio, tipo, fecha y estado con cursor y aislamiento por tenant. |
| EC-041 | Historial append-only de cambios y publicaciones con actor, revisión, diff, hash y request ID. |

## Archivos y datos bajo su responsabilidad

- Backend: `apps/configuration-api/src/events/` y núcleo de `apps/configuration-api/src/publishing/`.
- Frontend: `apps/configuration-admin/src/events/`.
- Worker: relay de `apps/configuration-worker/src/` para entregar el outbox; C integra su vista de recuperación mediante una interfaz de aplicación.
- Datos: `events`, `event_revisions`, `assignments`, `releases`, `release_artifacts`, `audit` y `outbox`. Sus migraciones siguen la numeración común y son forward-only.
- Contratos: rutas de eventos, validación/publicación y eventos `configuration.event.release_published.v1` y `configuration.event.cancelled.v1`.

## Acuerdos mínimos ya fijados para su módulo

1. **API y permisos.** A materializa en OpenAPI 3.1 las rutas de eventos, duplicación, cierre, cancelación, archivo, validación y release del [catálogo](../contracts/API-CONTRACTS.md#event-configuration-api). Crear/editar/listar exige `events:write`; validar/publicar/cerrar/cancelar exige `events:publish`. `EventCreate` exige `site_id`, `slug`, `kind`, `timezone`, `starts_at`, `ends_at`; policy inicial es validada por el servidor. `ReleaseCreate` recibe `expected_event_revision`, no un snapshot. Todos los comandos POST exigen `Idempotency-Key`; ediciones y publicación dependientes de revisión exigen `If-Match`. Los errores son `application/problem+json`.
   Las rutas implementadas usan `/duplications`, `/closures`, `/cancellations`, `/archives` y `/publication-validations`; la publicación única es `POST /events/{id}/releases`. Cierre y cancelación reciben `reason` y `effective_at`; duplicación recibe `site_id` y fechas objetivo. La especificación está en `equipo-2/Configuración_de_eventos/contracts/configuration/openapi.yaml`. `x-dev-actor` es solo fixture local; el contrato de integración usa Bearer/JWT cuando se conecte identidad real.
2. **Interfaz interna.** A define `PublicationContext = { organization_id, event_id, expected_event_revision, effective_at, transaction }`. Su `ReleaseAssembler` llama a `readEventSnapshot(context)`, `buildScheduleArtifact(context)` y `buildFormArtifact(context)`. Cada proveedor devuelve `{ kind, version, body, hash, errors, warnings }`. `errors` bloquea la publicación; `warnings` queda en el resultado de validación. B y C implementan los dos últimos proveedores. Las revisiones de cada agregado son independientes; el contexto les da el mismo corte transaccional.
3. **Corte de publicación.** El ensamblado y la lectura de los tres artefactos ocurren dentro de **una transacción PostgreSQL `SERIALIZABLE`**. A compara `expected_event_revision` con la revisión actual, valida datos y reintenta un conflicto de serialización con límite; si una revisión del cliente quedó vieja devuelve `412`. Una edición posterior a ese corte requiere otra release y no modifica la anterior.
4. **Manifiesto y hash.** A asigna UUIDv7 a `publication_id` y una `release_version` creciente por evento. El manifiesto contiene `organization_id`, `business_event_id`, `publication_id`, `release_version`, `effective_at` y artefactos `event`, `schedule`, `forms`, cada uno con `kind`, `version`, `ref` y `sha256`. El JSON de cada artefacto y del manifiesto se canonicaliza con [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785.html) y se calcula SHA-256 de los bytes UTF-8 canónicos. El manifiesto y artefactos se guardan inmutables en `releases`/`release_artifacts`; `manifest_ref` es una referencia opaca que la API de Configuration resuelve. A agrega su ruta de lectura autenticada al OpenAPI antes de consumirla desde otro equipo.
5. **Entrega y propagación.** A guarda release y `configuration.event.release_published.v1` en outbox en el mismo commit; el worker entrega con reintento. “Entregado al bus” no significa “activo en consumidor”. A expone a C una lectura `getPropagation(publication_id)` (`events:read`) y un comando `requeue(publication_id, reason, actor)` (`events:publish`). `release_consumers` registra acuses autenticados de servicios por consumidor/publicación/versión; sólo un acuse explícito marca `active`. Sin acuse, el estado es `pending` o `unknown`. Requeue no modifica manifiesto y deja auditoría. A documenta la ruta de acuse y la resolución de `manifest_ref` en OpenAPI antes de la integración externa.

Puede avanzar con proveedores simulados de agenda y formulario que devuelvan artefactos conforme al contrato. Los datos simulados se sustituyen por los proveedores reales al integrar; no se publican en producción.

## Orden de desarrollo propio

1. **Contrato y base:** OpenAPI de sus rutas, schemas de sus dos eventos, migraciones de eventos/revisiones/auditoría/outbox y fixture de dos organizaciones. Preparar claims de `events:write` y `events:publish`.
2. **Ciclo básico:** EC-001, EC-002 y EC-040. Entregar pantalla de listado, creación y edición. Verificar slug por sitio, fechas, zona, revisión y acceso por tenant.
3. **Estados y acceso:** EC-003, EC-005 y EC-006. Añadir duplicación, cancelación/archivo, asignaciones y sus cambios auditados. Integrar la comprobación de membresía mediante el contrato de identidad; mientras tanto, usar un adaptador local explícito.
4. **Publicación:** EC-030 y EC-031. Ensamblar artefactos de B/C, validar el conjunto, persistir release y outbox en una transacción y devolver identificador/estado. Repetir la misma key debe devolver el mismo resultado.
5. **Cierre y auditoría:** EC-004 y EC-041. Cerrar inscripciones mediante nueva policy/release; exponer historial y asegurar que los releases anteriores permanecen inmutables.

## Reglas que debe respetar siempre

- El evento sigue las transiciones de [STATE-MACHINES.md](../contracts/STATE-MACHINES.md); `archived` sólo desde `closed` o `cancelled`.
- `organization_id` y actor provienen de claims validados. Un evento ajeno no se expone, aunque se conozca su ID.
- Todos los comandos `POST` usan `Idempotency-Key`; `PATCH` y comandos dependientes de revisión usan `If-Match`.
- El cliente envía intención de publicar, nunca un manifiesto que reemplace snapshots leídos en el servidor.
- Release y outbox se escriben juntos. Un mensaje duplicado o reintentado conserva el mismo hecho de dominio y no genera otra publicación efectiva.
- El evento publicado y sus artefactos son inmutables; editar crea nueva revisión y publicar de nuevo crea otra release.
- No decide plazas disponibles, no almacena respuestas de formularios y no modifica datos de participación o asistencia.

## Pruebas y criterios para entregar sus cambios

- Crear con la misma key y payload reproduce la respuesta; misma key con payload diferente devuelve `409`.
- Dos ediciones sobre la misma revisión: una triunfa y la otra devuelve `412`; la release anterior conserva su hash.
- Tenant B no puede consultar, editar, duplicar ni publicar evento de tenant A, incluso reutilizando el mismo pool de PostgreSQL.
- Readiness devuelve errores accionables si faltan agenda, binding/consentimiento o policy; no crea release parcial.
- Un fallo del relay después del commit permite reintentar la entrega sin duplicar la release. Se mide pendiente, reintento y lag.
- Cancelación y archivo cumplen las transiciones; toda operación sensible deja actor y request ID en auditoría.

**Primer PR útil:** contrato `EventCreate`/`Event` + migración de `events`/`event_revisions` + `POST` y `GET /configuration/v1/events` + pantalla mínima de listado/creación + prueba de dos tenants. Después puede trabajar en publicación con proveedores simulados.

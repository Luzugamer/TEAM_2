# Integrante B — Agenda y recursos

**Rol dentro del Equipo 2:** responsable de sedes, ponentes, programas, sesiones y coherencia de agenda. Esta guía desarrolla el [acuerdo común](../ACUERDO-DESARROLLO-EQUIPO-2.md); las reglas normativas siguen en el [backlog](../backlogs/TEAM-2-EVENT-CONFIGURATION.md) y los [contratos de API](../contracts/API-CONTRACTS.md).

## Historias asignadas

| Historia | Entrega concreta |
|---|---|
| EC-010 | Crear/editar sedes y salas con capacidad, ubicación, accesibilidad y exclusividad; impedir solapamientos de recursos exclusivos. |
| EC-011 | Gestionar perfil público de ponentes, media referenciada y consentimiento; tratar exclusividad si aplica. |
| EC-012 | Crear programas/tracks ordenados, con slug por evento, color accesible y revisión. |
| EC-013 | Crear/mover sesiones con programa, sala, ponentes y tiempo UTC más zona de visualización; `409` con recurso/intervalo ante conflicto. |
| EC-014 | Cancelar o completar sesiones mediante estado y razón; los cambios publicados requieren nueva release y preservan asistencia previa. |
| EC-015 | Mostrar agenda paralela por track/sala/recurso y un preview con conflictos bloqueantes y advertencias. |
| EC-032 | Preparar contrato y consumidor simulado que compruebe manifiesto, hashes, replay, gaps y activación completa; los consumidores reales pertenecen a sus equipos. |
| EC-034 | Crear nueva publicación cuando cambia una agenda ya publicada; calcular diff público y emitir `configuration.schedule.changed.v1`. |

## Archivos y datos bajo su responsabilidad

- Backend: `apps/configuration-api/src/schedule/`; sólo aporta al módulo `publishing` mediante el proveedor acordado.
- Frontend: `apps/configuration-admin/src/schedule/`.
- Datos: `venues`, `speakers`, `programs`, `sessions` y `resource_reservations` para salas/ponentes exclusivos, con `organization_id`, revisiones y restricciones de integridad; sus migraciones son forward-only.
- Contratos: CRUD de venues/speakers/programs/sessions, `POST /events/{id}/schedule-validations` y el evento `configuration.schedule.changed.v1`.
- Pruebas de consumidor simulado y casos de replay/gap de EC-032 en el área de contratos/pruebas del Equipo 2.

## Acuerdos mínimos ya fijados para su módulo

1. **API y permisos.** B materializa en OpenAPI 3.1 CRUD de venues, speakers, programs y sessions y `POST /events/{id}/schedule-validations` del [catálogo](../contracts/API-CONTRACTS.md#event-configuration-api). Exige `events:write`, tenant de claims, `Idempotency-Key` para comandos POST y `If-Match` para cambios de revisión. `SessionWrite` exige `program_id`, `title`, `starts_at`, `ends_at`, `venue_id`; el 409 usa `schedule_conflict` e identifica recurso e intervalo sin PII.
2. **Interfaz hacia publicación.** B implementa `buildScheduleArtifact(context)` y `validateSchedule(context)` usando el `PublicationContext` y la **misma transacción** de A. El artefacto contiene `event_id`, `schedule_version`, programas ordenados, sesiones no borradas, sedes y ponentes públicos consentidos; cada sesión conserva estado, `starts_at`/`ends_at` UTC, `venue_id`, `program_id` y referencias de ponentes. B devuelve `{ kind: "schedule", version, body, hash, errors, warnings }`. El hash es SHA-256 del JSON canonicalizado según [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785.html).
3. **Tiempo y conflictos.** `starts_at` y `ends_at` se guardan como `timestamptz` UTC; la zona IANA del evento determina la vista. `starts_at < ends_at` y la sesión debe quedar dentro de la ventana del evento. Intervalos son semiabiertos `[inicio, fin)`: terminar exactamente cuando comienza otra sesión está permitido. `resource_reservations` tiene una fila por sala o ponente exclusivo asignado a una sesión y una restricción de exclusión PostgreSQL sobre tenant, recurso y rango `tstzrange`; el chequeo de preview usa la misma regla. Las sesiones canceladas liberan sus reservas sin borrar la revisión histórica.
4. **Cambios publicados.** Crear, mover, cancelar o completar una sesión visible, o cambiar programa/sala/ponente que afecte la agenda pública, deja el borrador pendiente de **nueva release**. B entrega a A un diff público con `session_id`, tipo de cambio y antes/después de los campos públicos. Tras el commit de la nueva release, A emite outbox y B define el payload de `configuration.schedule.changed.v1` con evento, `publication_id`, `schedule_hash` y sesiones afectadas. El snapshot anterior no cambia.
5. **Estado del evento y consumidor simulado.** B lee estado/ventana de evento mediante `readEventSnapshot(context)` de A; no actualiza `events`. Para EC-032 el simulador conserva `(consumer_name, domain_event_id)` como inbox, materializa `pending`, comprueba referencias/hashes del manifiesto y sólo pasa a `active` cuando todos los artefactos están presentes. Un duplicado es éxito sin efecto; un gap de versión queda `pending` y solicita replay. Es una prueba del contrato, no el consumidor de otro equipo.

Puede construir sedes, programas y sesiones con un `event_id` de fixture validado por un adaptador local. Para probar publicación, usa un ensamblador simulado conforme al manifiesto acordado.

## Orden de desarrollo propio

1. **Contrato y base:** rutas/esquemas de agenda, migraciones de recursos y sesiones, índices/constraints de exclusividad, fixtures con dos tenants y una agenda paralela.
2. **Recursos:** EC-010, EC-011 y EC-012. Entregar CRUD de sedes/salas, ponentes y programas; incluir estados de carga/error/vacío en React.
3. **Sesiones:** EC-013 y EC-014. Crear, mover, cancelar y completar con control de revisión, validación de rangos y conflicto real en base de datos.
4. **Vista previa:** EC-015. Mostrar simultaneidad por track, sala y ponente; distinguir qué impide publicar y qué sólo advierte.
5. **Publicación e integración:** entregar proveedor de artefacto de agenda, EC-034 y EC-032. Probar nueva release/diff y consumidor simulado con duplicados y gaps.

## Reglas que debe respetar siempre

- No acepta horarios inválidos ni solapamientos de recursos exclusivos; la base y la transacción protegen la regla también bajo concurrencia.
- Una sesión sigue `draft → scheduled → cancelled/completed`; un cambio horario crea revisión y no reescribe snapshots publicados.
- El conflicto `409` incluye identificador de recurso e intervalo, sin datos personales. `If-Match` detecta ediciones sobre revisión vieja.
- El nombre, bio o imagen pública de un ponente requieren la referencia/consentimiento previsto; no se confunde ponente con usuario de login.
- Los artefactos de agenda contienen sólo datos públicos necesarios y hash reproducible; nunca respuestas de formularios ni asistentes.
- Cambiar la agenda publicada genera otra `publication_id` mediante el mecanismo de A; B no escribe `releases` ni `outbox` fuera de la interfaz acordada.
- Las rutas exigen `events:write` o `events:publish` según el [contrato de API](../contracts/API-CONTRACTS.md#event-configuration-api) y aíslan organizaciones.

## Pruebas y criterios para entregar sus cambios

- Dos sesiones en la misma sala exclusiva y horario superpuesto: sólo una se guarda; la otra devuelve `409` con intervalo. Dos sesiones en tracks diferentes y salas compatibles coexisten.
- Una edición con ETag viejo devuelve `412`; un tenant ajeno no puede ver ni modificar sedes, ponentes o sesiones.
- Preview y validación server-side muestran los mismos conflictos bloqueantes antes de publicar.
- Un cambio posterior a una publicación produce nueva versión, diff y mensaje versionado; el snapshot anterior conserva su hash.
- El consumidor simulado activa `pending → active` sólo con manifiesto completo; replay no duplica efectos y un gap solicita recuperación.

**Primer PR útil:** contrato de `SessionWrite` y conflicto + migraciones de `venues`, `programs` y `sessions` + creación de una sede/programa/sesión con fixture de evento + prueba de solapamiento en PostgreSQL.

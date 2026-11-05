# Acuerdo de desarrollo paralelo — Equipo 2: Configuración de eventos

**Estado:** propuesta de acuerdo técnico y reparto para los tres integrantes; las decisiones de stack de este documento son recomendaciones, no tecnologías ya adoptadas por el proyecto.  
**Alcance:** Event Configuration API, base lógica de datos, outbox y módulos React de backoffice.  
**Fuentes normativas:** [backlog del Equipo 2](backlogs/TEAM-2-EVENT-CONFIGURATION.md), [API](contracts/API-CONTRACTS.md), [eventos](contracts/EVENT-CONTRACTS.md), [estados](contracts/STATE-MACHINES.md), [datos](contracts/DATABASE-BOUNDARIES-AND-MIGRATIONS.md), [autorización](AUTH-AND-AUTHORIZATION-CONTRACT.md) e [integración](INTEGRATION-CONTRACTS.md).

Este documento organiza **únicamente el desarrollo del Equipo 2**. Si contradice un contrato normativo, prevalece el contrato normativo y se corrige este acuerdo antes de implementar la parte afectada. Los nombres de carpetas, tecnologías internas e interfaces que siguen son **decisiones propuestas aquí**, no componentes ya existentes en el repositorio.

## Resultado que deben entregar juntos

Un organizador autorizado puede crear un evento, configurar agenda y formularios, validar que todo sea compatible y publicar una versión completa. Los otros equipos reciben un único manifiesto versionado. El Equipo 2 no administra inscripciones, cupos efectivos, tickets, asistencia, páginas CMS ni usuarios de la plataforma.

## Lenguaje, herramientas y arquitectura interna recomendados

**Lenguaje común:** TypeScript en backend y frontend. Así los tres pueden compartir tipos generados desde OpenAPI y JSON Schema, revisar el código de otro módulo y mantener una sola cadena de herramientas. Esta elección no obliga a los otros equipos a usar TypeScript.

| Capa | Elección para el Equipo 2 | Motivo |
|---|---|---|
| API | Node.js LTS + TypeScript + NestJS con su adaptador HTTP predeterminado | Módulos, inyección de dependencias y HTTP bajo un solo despliegue; para esta API administrativa importa más la compatibilidad y simplicidad que optimizar el adaptador. |
| Administración | React + TypeScript + Vite, integrado como módulo del Admin shell | Pantallas de eventos, agenda y formularios sin duplicar identidad ni navegación general. |
| Datos | PostgreSQL + Kysely sobre `pg`; migraciones SQL versionadas | Transacciones, constraints, RLS y exclusion constraints de agenda sin depender de abstracciones difíciles de auditar. |
| Formularios | JSON Schema 2020-12 + Ajv para validación server-side | Coincide con EC-021 y permite validar definiciones y preview con el mismo contrato. |
| Contratos | OpenAPI 3.1 y JSON Schema/AsyncAPI; tipos generados | El contrato se revisa antes que controladores y UI. |
| Pruebas | Vitest para lógica; pruebas de integración contra PostgreSQL real; contract tests de API/eventos | Verifican transacciones, restricciones, versiones y compatibilidad. |

**Forma de despliegue:** un **servicio modular** de Configuración con una sola base lógica PostgreSQL propia. Tiene tres módulos de dominio (`events`, `schedule`, `forms`) y un módulo transversal (`publishing`). No se crean tres microservicios para los tres integrantes: la frontera de microservicio ya es *Event Configuration*; dividirlo más añadiría llamadas de red y transacciones distribuidas dentro de la misma responsabilidad. Un proceso worker del mismo servicio entrega el outbox y gestiona reintentos; puede escalarse aparte de la API sin tener otra base ni otro dueño.

```text
React Admin: events | schedule | forms
                 ↓ HTTP /configuration/v1
NestJS API:   events | schedule | forms | publishing
                 ↓ repositorios / transacciones
PostgreSQL de Configuration: tablas de los cuatro módulos + audit + outbox
                 ↓ worker de outbox del mismo servicio
Bus de eventos: release_published / cancelled / schedule_changed
```

**Dependencias internas:** `publishing` consulta interfaces de lectura de `events`, `schedule` y `forms`; esos módulos no importan código de `publishing` ni se llaman entre sí. La UI consume la API, no accede a PostgreSQL. Las reglas de dominio se prueban sin HTTP; controladores y repositorios son adaptadores. Esta es una arquitectura de **módulos por dominio con puertos y adaptadores**, sin exigir una capa o patrón distinto para cada entidad.

Estructura de carpetas propuesta para crear al iniciar código:

```text
apps/
  configuration-api/src/
    events/             # Integrante A
    schedule/           # Integrante B
    forms/              # Integrante C
    publishing/          # A: release; B/C: artefactos y propagación
    shared/              # auth, errores, DB, idempotencia, telemetría
  configuration-worker/src/  # relay de outbox; mismo ownership de servicio
  configuration-admin/src/
    events/             # A
    schedule/           # B
    forms/              # C
contracts/configuration/      # OpenAPI, schemas de eventos, ejemplos
db/migrations/                # SQL forward-only, ordenado al integrar
```

Si el repositorio general impone otra disposición, se conserva la separación de módulos y contratos, y se adapta sólo la ruta física.

## Reparto y propiedad

Guías individuales: [Integrante A — eventos y publicación](equipo-2/INTEGRANTE-A-EVENTOS-PUBLICACION.md), [Integrante B — agenda y recursos](equipo-2/INTEGRANTE-B-AGENDA-RECURSOS.md) e [Integrante C — formularios y operación](equipo-2/INTEGRANTE-C-FORMULARIOS-OPERACION.md).

| Integrante | Módulo y archivos propios | Historias de las que responde | Entregable comprobable |
|---|---|---|---|
| **A — Eventos y núcleo de publicación** | API/UI de eventos, revisiones, asignaciones, validación general, releases, auditoría y migraciones de esas tablas | EC-001–006, EC-030–031, EC-040–041 | Crear/editar/listar evento; validar y publicar un manifiesto completo de forma idempotente. |
| **B — Agenda y recursos** | API/UI de sedes, ponentes, programas, sesiones y conflictos; migraciones de esas tablas | EC-010–015, EC-032, EC-034 | Configurar agenda paralela y producir su artefacto versionado; aportar simulador/contrato para materialización y cambios de agenda. |
| **C — Formularios y operación de publicación** | API/UI de definiciones, versiones, consentimiento y bindings; migraciones de esas tablas; vista de propagación y herramientas de operación | EC-020–025, EC-033, EC-042–043 | Publicar formularios inmutables, producir su artefacto versionado y observar/reintentar fallos de propagación. |

**Límite de EC-032:** los equipos 1, 3 y 4 implementan sus propios consumidores. B prepara el ejemplo de consumidor, pruebas de replay/gap y contrato de aceptación; no escribe en las bases ni en el código de esos equipos. **EC-043** pertenece a C para la interfaz y el flujo operativo; A implementa el outbox transaccional del productor y su relay. A, B y C revisan juntos el contrato del manifiesto antes de integrarlo.

### Reglas y acuerdos por integrante

**A — Eventos y publicación**

- Es dueño de `events`, `event_revisions`, `assignments`, `releases`, `release_artifacts`, `audit` y `outbox` y de las pantallas de ciclo de vida/listado.
- Expone `EventSnapshotProvider(event_id, expected_event_revision)` y el contrato `ReleaseAssembler`. El ensamblador pide a B y C artefactos correspondientes al **mismo corte de publicación validado**, aunque cada agregado tenga su propia revisión; si falta uno o cambia algún input validado, no publica.
- No implementa por cuenta propia la lógica de agenda ni el contenido de formularios. Usa sus proveedores, inicialmente simulados, y reemplaza los simuladores en la integración.
- Una publicación persiste snapshot, manifiesto y outbox en **una transacción**. No declara éxito operativo sólo porque escribió la fila del release: presenta el estado de propagación real.

**B — Agenda y recursos**

- Es dueño de `venues`, `speakers`, `programs`, `sessions`, CRUD/preview y validación de solapamientos; sus migraciones no modifican tablas de formularios.
- Expone `ScheduleArtifactProvider(event_id, publication_context)` y `validateSchedule(event_id, publication_context)`. Devuelve datos públicos versionados, hash reproducible, errores bloqueantes y advertencias.
- Resuelve conflictos de sala/recurso y rangos de tiempo con transacción/constraint en PostgreSQL, no sólo con una comprobación de React.
- En EC-032 entrega un consumidor **simulado para pruebas de contrato**; la activación en los sistemas consumidores queda fuera del código del Equipo 2.

**C — Formularios y operación**

- Es dueño de `form_definitions`, `form_versions`, `form_bindings`, editor/preview, validaciones, consentimiento y vista operativa de propagación.
- Expone `FormArtifactProvider(event_id, publication_context)` y `validateBindings(event_id, publication_context)`. La salida incluye versión, esquema, UI, consentimiento, políticas por campo y hashes; no contiene respuestas de participantes.
- Un formulario publicado es inmutable. Para modificarlo crea otra versión; cerrar o reemplazar un binding no reescribe respuestas existentes.
- La vista de propagación y requeue consume el estado del release/outbox de A mediante una interfaz acordada; no escribe directamente en las tablas de A. EC-042 incluye pruebas de productor que A y B ayudan a mantener.

## Sprint 0: acuerdo mínimo para arrancar sin bloqueos

Antes de desarrollar controladores, los tres aprueban en un mismo cambio pequeño:

1. **OpenAPI 3.1 de Configuration** para las rutas de [API-CONTRACTS.md](contracts/API-CONTRACTS.md#event-configuration-api), con esquemas, ejemplos, scopes, errores y reglas de idempotencia/ETag. Cada integrante redacta sus rutas; A integra el archivo y CI lo valida.
2. **JSON Schema/AsyncAPI** para `configuration.event.release_published.v1`, `configuration.event.cancelled.v1` y `configuration.schedule.changed.v1`, con ejemplos válidos. A es owner del primero y segundo; B del tercero; C revisa que el manifiesto incluya formulario y consentimiento.
3. **Formato del manifiesto fijado**: `organization_id`, `business_event_id`, `publication_id` UUIDv7, `release_version` creciente por evento, `effective_at`, `manifest_ref`, `manifest_hash` y artefactos `event`, `schedule`, `forms`, cada uno con `kind`, `version`, `ref`, `sha256`. Los artefactos se guardan inmutables en Configuration; el hash es SHA-256 del JSON UTF-8 canonicalizado según [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785.html). Los consumidores activan el conjunto completo o ninguno.
4. **Interfaces internas fijadas**: A pasa un `PublicationContext` con tenant, evento, revisión esperada, fecha efectiva y transacción PostgreSQL `SERIALIZABLE`. B implementa `buildScheduleArtifact(context)` y C `buildFormArtifact(context)`. Ambos devuelven `{ kind, version, body, hash, errors, warnings }`. A ensambla y persiste el manifiesto *server-side*; errores bloquean y advertencias se presentan. Ningún cliente envía un snapshot sustituto.
5. **Modelo de datos y migraciones**: una sola base lógica de Configuration. A posee `events`, `event_revisions`, `releases`, `release_artifacts`, `release_consumers`, `assignments`, `audit` y `outbox`; B posee `venues`, `speakers`, `programs`, `sessions` y reservas de recursos exclusivos; C posee `form_definitions`, `form_versions`, `form_bindings`. IDs UUIDv7, `organization_id NOT NULL`, RLS e índices tenant-first; migraciones forward-only. Referencias internas usan `(organization_id,id)`; no hay FK a bases de otros servicios.
6. **Entorno local**: un evento de ejemplo, agenda de ejemplo y formulario de ejemplo; claims de prueba para dos organizaciones y roles `events:write`/`events:publish`; adaptadores locales para site/membership y bus hasta que el Equipo 1 entregue sus contratos ejecutables. Los adaptadores de prueba nunca se habilitan en producción.

El criterio de cierre de Sprint 0 es que OpenAPI y schemas validen, existan ejemplos de los tres artefactos, se pueda levantar una base vacía con las migraciones iniciales y cada integrante tenga datos de prueba para trabajar sin llamadas a módulos inacabados. El [gate contractual](INTEGRATION-CONTRACTS.md#gate-contractual) exige contratos como código, no sólo esta descripción.

## Reglas inmutables para los tres integrantes

- JSON `snake_case`, horas UTC RFC 3339, IDs UUIDv7, cursores opacos y errores `application/problem+json`.
- Los `POST` de comando aceptan `Idempotency-Key`; los cambios por revisión usan `ETag`/`If-Match`. Misma key con payload distinto: `409`; revisión obsoleta: `412`.
- `organization_id` y actor vienen de claims validados, nunca del body/header del navegador. Cada operación comprueba scope y asignación a evento/sede; un recurso de otro tenant no se expone.
- El evento sigue `draft → published ⇄ closed`, puede pasar a `cancelled` desde draft/published/closed y sólo `closed` o `cancelled` pasa a `archived`. Formularios publicados y releases son inmutables; un cambio crea versión nueva.
- Las publicaciones escriben release y outbox en la misma transacción. `configuration.event.release_published.v1` lleva el envelope canónico; no contiene respuestas de formularios ni datos personales.
- Cada tabla tenant-scoped tiene `organization_id`, índice por tenant y RLS forzada. El rol runtime no evade RLS. Migraciones forward-only.
- Los conflictos de horario o recurso informan recurso e intervalo sin datos privados. La validación de publicación distingue errores bloqueantes de advertencias.

## Cómo trabajar en paralelo

| Fase | A | B | C | Punto de integración |
|---|---|---|---|---|
| **1. Contratos y base** | Eventos/release y estructura OpenAPI | Agenda, conflictos y artefacto agenda | Formulario/binding y artefacto formulario | Se aprueban esquemas y fixtures; nadie espera implementación ajena. |
| **2. Primer flujo propio** | Borrador, edición con ETag y listado | CRUD de recursos/sesiones y preview | Definición, validación y versión de formulario | Cada módulo usa fixtures de los demás. |
| **3. Publicación** | Readiness, snapshot, hash, outbox, release | Validación final y snapshot de agenda; cambio de agenda | Validación final, consentimiento y snapshot de binding/formulario | Se reemplazan fixtures por proveedores reales. |
| **4. Operación y prueba** | Estados, auditoría y cancelación | Replay/gap y prueba de consumidor simulado | Propagación, retry/DLQ y pruebas de contrato/carga | Flujo completo en entorno de integración. |

Para evitar conflictos de código, cada integrante modifica principalmente su módulo y sus migraciones. Los archivos compartidos (router principal, composición de dependencias, OpenAPI raíz, manifiesto, CI) tienen **un integrador por cambio**, indicado en el PR; los otros aportan cambios en archivos propios o revisan. Las migraciones reciben numeración/orden de una sola persona al integrar, aunque cada autor escriba el contenido de su tabla. No se hacen cambios incompatibles del contrato sin PR que actualice esquema, ejemplo y prueba de consumidor.

## Fronteras del Equipo 2 y decisiones que deben cerrar

| Necesidad | Dueño externo | Cómo avanzar mientras llega |
|---|---|---|
| Identidad, membresías, tenant, site y gateway | Equipo 1 | Claims y adaptador local conformes al contrato; probar aislamiento con dos tenants. A coordina la integración. |
| Landing/proyección pública | Equipo 1 | Publicar manifiesto y verificarlo con consumidor simulado; después hacer contract test real. |
| Registro y policy de inscripción | Equipo 3 | Compartir snapshot/policy y binding por release; no implementar cupos en Configuration. |
| Check-in y agenda asignada | Equipo 4 | Compartir release y cambios de agenda; no implementar asistencia en Configuration. |

**Decisión interna recomendada:** TypeScript, NestJS, React y PostgreSQL como se indica arriba. Al adoptarla, congelen versiones mayores compatibles y un único gestor de paquetes antes de crear el primer proyecto. Si el curso o la plataforma general exige otro stack, cambien esta sección mediante una decisión de equipo antes de escribir infraestructura.

**Decisiones de ejecución fijadas aquí:** los artefactos inmutables se guardan en PostgreSQL de Configuration durante el MVP; un worker del mismo servicio los publica mediante outbox. El Admin shell carga las rutas React del Equipo 2 como módulo, sin duplicar login. CI ejecuta validación OpenAPI/JSON Schema, migraciones en base vacía, pruebas de integración PostgreSQL y contrato productor. El broker concreto lo suministra la plataforma y queda detrás de un adaptador; su elección no bloquea el desarrollo del dominio ni cambia el envelope. Antes de integrar con otros equipos, A incorpora al OpenAPI las rutas autenticadas para resolver `manifest_ref` y recibir acuses de consumidor; esas rutas adicionales pasan revisión de ownership como exige el catálogo.

## Criterios de integración y terminado

- Una release incluye exactamente las revisiones validadas de evento, agenda y formularios; una edición concurrente invalida la publicación con `412` o conflicto documentado. No se observa publicación parcial.
- Repetir el mismo comando con la misma `Idempotency-Key` devuelve el mismo resultado; replay del evento no crea otra release efectiva.
- Un consumidor simulado recibe el manifiesto, comprueba hashes y activa sólo cuando están todos los artefactos; duplicados, gaps y mensajes fuera de orden tienen prueba.
- Crear/editar/publicar con otro tenant o sin el scope requerido falla. Se prueba con dos organizaciones usando el mismo pool de conexiones.
- La agenda rechaza solapamientos exclusivos; un formulario publicado no cambia; una nueva publicación no modifica snapshots anteriores.
- CI valida OpenAPI, schemas de eventos, migraciones, pruebas de contrato y un flujo e2e: borrador → agenda → formulario → validación → release → propagación.
- El PR de cada historia incluye endpoint/pantalla, migración si aplica, prueba de su regla de negocio, ejemplo de request/response y actualización de contrato. Dos integrantes revisan los cambios de manifiesto, autorización o migración compartida.

## Primera tarea concreta para cada persona

- **A:** definir `EventCreate` y `Event` en OpenAPI, crear borrador/listado con aislamiento por tenant y dejar un `ReleaseAssembler` que acepte proveedores de artefactos simulados.
- **B:** definir `SessionWrite` y conflictos en OpenAPI, crear sedes/programas/sesiones con fixture de `event_id` y entregar el artefacto de agenda al ensamblador.
- **C:** definir `FormVersionCreate` y binding en OpenAPI, crear formulario/versiones con fixture de `event_id` y entregar el artefacto de formulario al ensamblador.

Al terminar esas tres tareas, los módulos ya se conectan por interfaces acordadas y cada integrante puede seguir su backlog sin esperar las pantallas de los demás.

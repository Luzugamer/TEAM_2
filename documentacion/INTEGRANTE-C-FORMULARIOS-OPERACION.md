# Integrante C — Formularios y operación de publicación

**Rol dentro del Equipo 2:** responsable del constructor de formularios, sus versiones/bindings y la visibilidad operativa de las publicaciones. Esta guía desarrolla el [acuerdo común](../ACUERDO-DESARROLLO-EQUIPO-2.md); las reglas normativas siguen en el [backlog](../backlogs/TEAM-2-EVENT-CONFIGURATION.md) y los [contratos de API](../contracts/API-CONTRACTS.md).

## Historias asignadas

| Historia | Entrega concreta |
|---|---|
| EC-020 | Crear definición en borrador para `registration`, `application` o `feedback`, con campos estándar y personalizados permitidos. |
| EC-021 | Editar y validar JSON Schema 2020-12, UI schema, required/pattern/range/options; ofrecer preview accesible sin código arbitrario. |
| EC-022 | Definir finalidad, clasificación, retención y exportación por campo; versionar texto y hash del consentimiento; señalar campos sensibles. |
| EC-023 | Publicar versión inmutable con hashes de schema/UI/consentimiento y revisión de compatibilidad. |
| EC-024 | Vincular versión publicada a evento y propósito con ventana; como máximo un binding `open` por propósito. |
| EC-025 | Cerrar/reemplazar binding mediante transición y nueva versión, sin modificar respuestas recibidas. |
| EC-033 | Mostrar propagación por consumidor/version con `pending`, `active`, `failed` y lag; reintentos seguros y estado operativo veraz. |
| EC-042 | Coordinar pruebas de contratos, productor, replay/gap/out-of-order y carga de publicación; A y B aportan pruebas de sus módulos. |
| EC-043 | Vista/flujo de recuperación de fallos de outbox/release, requeue auditado y runbook; A proporciona relay y persistencia. |

## Archivos y datos bajo su responsabilidad

- Backend: `apps/configuration-api/src/forms/`; adaptador de lectura/operación de propagación en `publishing` según interfaz acordada.
- Frontend: `apps/configuration-admin/src/forms/` y vista de propagación/recuperación autorizada.
- Datos: `form_definitions`, `form_versions`, `form_bindings`; migraciones forward-only. No escribe las tablas `releases`/`outbox` directamente.
- Contratos: `/configuration/v1/forms`, `/forms/{id}/versions`, `/form-versions/{id}/validations`, `/form-versions/{id}/publications`, `/events/{id}/form-bindings`, `/bindings/{id}/closures` y lectura de propagación.
- Pruebas de contrato y runbook del flujo de publicación del Equipo 2.

## Acuerdos mínimos ya fijados para su módulo

1. **API y permisos.** C materializa en OpenAPI 3.1 las rutas de forms, versions, validations, publications, form-bindings y closures del [catálogo](../contracts/API-CONTRACTS.md#event-configuration-api). Definir/editar/validar/vincular exige `events:write`; publicar versión exige `events:publish`. POST usa `Idempotency-Key`; edición usa `If-Match`; errores usan `application/problem+json`. `FormVersionCreate` exige `schema`, `ui_schema`, `consent` y `field_policies`; incluye ejemplos válidos de `registration`, `application` y `feedback`.
2. **Definición permitida.** El propósito es exactamente `registration`, `application` o `feedback`. Los campos estándar iniciales son nombre, email, teléfono y organización; campos personalizados se limitan a `string`, `number`, `integer`, `boolean` y `array` de opciones. Validaciones permitidas: required, longitud, pattern, mínimo/máximo y opciones. No se admiten expresiones ejecutables ni scripts en schema/UI. Los archivos y anexos se representan como **referencias de campo** configuradas; el almacenamiento de archivos/respuestas pertenece a Participation. C documenta la allowlist en el schema del editor y rechaza lo demás.
3. **Política por campo.** Cada campo tiene `purpose`, `classification`, `retention`, `export_allowlist`. `classification` usa las clases del [contrato de datos](../contracts/DATA-OWNERSHIP-AND-RETENTION.md#clasificación-y-controles): `publica`, `interna`, `confidencial`, `restringida`. `retention` es una referencia a la política aprobada, no un plazo inventado por quien edita; por defecto se usan los plazos del contrato hasta ratificación institucional. Campos confidenciales/restringidos se señalan en el editor y requieren propósito y consentimiento explícitos. Un formulario sin política completa no se publica.
4. **Versiones, binding y artefacto.** C implementa `buildFormArtifact(context)` y `validateBindings(context)` dentro de la transacción de A. Devuelve `{ kind: "forms", version, body, hash, errors, warnings }`, con propósito, binding/ventana, versión publicada, `schema`, `ui_schema`, consentimiento y políticas; nunca respuestas. Cada versión publicada guarda SHA-256 de JSON canonicalizado [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785.html) para schema/UI/consentimiento. Una versión publicada no se actualiza; el binding nuevo apunta a otra versión. Un índice/constraint garantiza un único binding `open` por `(organization_id,event_id,purpose)` y ventanas válidas.
5. **Propagación y recuperación.** C consume `getPropagation(publication_id)` (`events:read`) y `requeue(publication_id, reason, actor)` (`events:publish`) de A, no las tablas directamente. La vista muestra `pending`, `active`, `failed`, lag y `unknown` si no hay acuse; no deduce `active` del envío al bus. Requeue exige razón, `Idempotency-Key` y auditoría; conserva el mismo contenido/hash del release. EC-042 usa ejemplos de A y B para verificar schema de productor, duplicados, gaps, orden alterado y lag.

Puede avanzar con un `event_id` de fixture y un proveedor simulado del estado del evento. Para probar propagación, usa estados simulados conforme al contrato de A; luego cambia al adaptador real.

## Orden de desarrollo propio

1. **Contrato y base:** OpenAPI, ejemplos JSON Schema 2020-12, migraciones de definiciones/versiones/bindings y fixture de dos tenants.
2. **Editor de formularios:** EC-020 y EC-021. Crear borrador, editar campos admitidos, validar en servidor y previsualizar en React con errores por campo.
3. **Privacidad/versiones:** EC-022 y EC-023. Asociar políticas/consentimiento, revisar compatibilidad y publicar una versión que ya no puede modificarse.
4. **Vínculos:** EC-024 y EC-025. Vincular al evento, abrir/cerrar/reemplazar y entregar `FormArtifactProvider` para la publicación completa.
5. **Operación:** EC-033, EC-042 y EC-043. Vista de propagación, requeue auditado, métricas/lag, pruebas de contrato y runbook de recuperación.

## Reglas que debe respetar siempre

- Sólo se publican versiones válidas; una versión publicada no se actualiza ni elimina. Corregirla implica crear otra versión.
- El propósito del formulario coincide con el del binding y la ventana está dentro de las reglas del evento. No hay dos bindings `open` del mismo propósito.
- Cada campo declara finalidad, clasificación, retención y exportación permitida. El consentimiento conserva texto, versión y hash exactos.
- El schema admite sólo campos/validaciones permitidos; no ejecuta JavaScript proporcionado por el organizador.
- La UI de preview muestra la estructura publicada sin guardar respuestas. El Equipo 2 no almacena datos personales ni anexos enviados por participantes.
- Cerrar un binding afecta nuevas operaciones conforme a la release activa; respuestas previas mantienen su referencia de versión.
- Una pantalla no puede afirmar que la publicación está activa en otros consumidores sólo porque A escribió el outbox; muestra estados y lag reales o `desconocido`.
- Rutas y datos usan tenant/scopes derivados de claims, `Idempotency-Key`, ETag y errores normativos cuando corresponde.

## Pruebas y criterios para entregar sus cambios

- Schema inválido, campo no permitido, consentimiento ausente y política incompleta bloquean publicación con errores localizables.
- Reintentar publicar la misma versión no crea otra; modificar versión publicada falla; una nueva versión conserva el hash antiguo.
- Dos bindings `open` para el mismo evento/propósito no pueden coexistir, incluso con dos peticiones concurrentes.
- Tenant B no puede consultar, editar, publicar ni vincular formularios de tenant A.
- La vista de propagación distingue pending/active/failed y lag; requeue exige autorización, deja auditoría y no cambia el contenido del release.
- Las pruebas de productor validan OpenAPI/AsyncAPI y ejemplos; replay, gaps y mensajes fuera de orden no producen activación parcial. El runbook explica cómo diagnosticar y recuperar una entrega fallida.

**Primer PR útil:** contrato `FormVersionCreate` + migraciones de las tres tablas + creación/validación de una definición y versión en borrador + preview mínimo + prueba de schema inválido y tenant ajeno.

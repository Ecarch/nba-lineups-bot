# Referencia de la API de Discord para bots

Resumen de https://docs.discord.com/developers (leído el 2026-10-21, índice completo en https://docs.discord.com/llms.txt).
Las cifras salen de la documentación oficial. Lo marcado **[no confirmado]** no aparece en las páginas leídas.
Ante cualquier duda, la fuente de verdad es la doc (también hay un servidor MCP en `docs.discord.com/mcp`).

---

## 1. Conceptos base

- **Application** = entidad en el Developer Portal (credenciales, OAuth2, comandos). Cada app tiene un **bot user** que se autentica con el **bot token** (`Authorization: Bot <token>`).
- Credenciales: Application ID, Public Key (verificar firmas de interacciones HTTP), Bot Token (se muestra una sola vez; resetear en la página Bot), Client Secret (OAuth2).
- API REST: `https://discord.com/api/v10`. Versiones 10 y 9 vigentes; 6-8 deprecadas.
- Header obligatorio `User-Agent: DiscordBot ($url, $version)`; sin él Cloudflare puede bloquear (error 40333).
- IDs = snowflakes de 64 bits **serializados como string**. Timestamp = `(id >> 22) + 1420070400000`.
- Permisos = bitfield **string** (usar BigInt; hay bits > 50).
- Consistencia eventual: los eventos pueden llegar 0, 1 o varias veces. Los handlers deben ser idempotentes.
- Tamaño de subida por defecto: **20 MiB** por archivo (desde 2026-09-03), 25 MiB por request. Multipart con `files[n]` + `payload_json`.

### Dos formas de recibir datos (combinables)

| | Gateway (WebSocket) | HTTP Interactions Endpoint |
|---|---|---|
| Qué recibe | Todos los eventos (mensajes, miembros, voz, reacciones…) + interacciones | Solo interacciones (comandos, botones, modales) |
| Hosting | Proceso persistente | Serverless posible (Cloudflare Workers, etc.) |
| Voz, presencia, leer mensajes | Sí | **No** |

Si se configura el *Interactions Endpoint URL*, las interacciones dejan de llegar por Gateway. Las respuestas siempre van por HTTP.

### Contextos de instalación

- **Guild install (0):** scopes `bot` + `applications.commands`, con permisos en el servidor. Requiere que quien instala tenga MANAGE_GUILD.
- **User install (1):** solo `applications.commands`, sin bot user. Los comandos siguen al usuario por DMs y servidores. Si la app no está en ese servidor, máximo 5 follow-ups, y la respuesta es forzada a efímera salvo que el usuario tenga USE_EXTERNAL_APPS.
- Habilitar un contexto nuevo **no** habilita los comandos existentes en él: hay que actualizar `integration_types`/`contexts` de cada comando.

---

## 2. Interacciones (comandos y componentes)

### Reglas de tiempo (críticas)

- **Respuesta inicial en ≤ 3 segundos**, si no el token se invalida (error 10062 después).
- Token de la interacción válido **15 minutos** para editar y hacer follow-ups.
- Si la tarea tarda, **diferir** (tipo 5) de inmediato y luego `PATCH /webhooks/{app_id}/{token}/messages/@original`.
- Si una respuesta es efímera se decide en la respuesta inicial o el defer, y no se puede cambiar después.
- Un **modal solo puede ser la respuesta inicial**: no se puede abrir tras un defer, ni desde un modal submit, ni desde autocomplete.

### Tipos

- Interacción: 1 PING, 2 APPLICATION_COMMAND, 3 MESSAGE_COMPONENT, 4 AUTOCOMPLETE, 5 MODAL_SUBMIT.
- Callback: 1 PONG, 4 mensaje, 5 defer mensaje, 6 defer update (solo componentes y modales), 7 update message (solo componentes y modales), 8 autocomplete result (≤25), 9 modal, 12 launch activity.
- Flags: EPHEMERAL = 64, IS_COMPONENTS_V2 = 32768. Con el defer tipo 5 **solo** se admite EPHEMERAL; el flag V2 se pone al editar `@original`.
- Quién invocó: `member.user` (en un guild) o `user` (en DM). `context`: 0 GUILD, 1 BOT_DM, 2 PRIVATE_CHANNEL.
- `authorizing_integration_owners["1"]` es quien **instaló** la app, que no necesariamente es quien hizo clic.

### Endpoint HTTP

- Verificar Ed25519 sobre `timestamp + rawBody` con la Public Key. Si falla, responder **401**.
- Discord envía firmas inválidas a propósito. Si se aceptan, **elimina la URL del endpoint**.
- Responder PING `{type:1}` con `{type:1}`.

### Application commands

- Tipos: 1 CHAT_INPUT (slash), 2 USER, 3 MESSAGE (menús contextuales), 4 PRIMARY_ENTRY_POINT (Activities).
- Límites: **100 slash + 15 user + 15 message** globales (y lo mismo por guild).
  - 25 opciones por comando, 25 choices por opción, 8000 caracteres en total por comando.
  - Nombre: 1-32 caracteres en **minúsculas**. Descripción: 1-100. USER/MESSAGE: sin descripción.
  - **200 creaciones de comandos por día por guild.**
- **Guild commands:** se actualizan al instante (ideales para desarrollo), no disponibles en DMs. **Globales:** pueden tardar en propagarse.
- `PUT` bulk **reemplaza todos** los comandos de ese ámbito (borra los que no estén en el payload).
- Tipos de opción: SUB_COMMAND 1, SUB_COMMAND_GROUP 2, STRING 3, INTEGER 4, BOOLEAN 5, USER 6, CHANNEL 7, ROLE 8, MENTIONABLE 9, NUMBER 10, ATTACHMENT 11.
  - Un solo nivel de anidación (grupo → subcomando). Con subcomandos, el comando base no es invocable.
- **Autocomplete:** solo STRING/INTEGER/NUMBER, incompatible con `choices`. El valor final **no se valida**: validarlo en el servidor.
- `default_member_permissions` (string, `"0"` = solo admins), `contexts`, `integration_types`, `nsfw`, localizaciones.
- Overrides de permisos por comando: requieren **Bearer token** con `applications.commands.permissions.update`. El bot token no sirve.

### Componentes

- `custom_id` de 1-100 caracteres, único por mensaje. Sirve para guardar estado (p. ej. `accept_button_<id>`).
- **Mensajes legacy:** `content`/`embeds` + máximo **5 Action Rows**. Cada Action Row lleva ≤5 botones **o** 1 select.
- **Components V2** (flag 32768): hasta **40 componentes**. Desactiva `content`, `embeds`, `poll` y `stickers`, y **no se puede quitar** una vez puesto.

| # | Componente | Dónde | Notas |
|---|---|---|---|
| 1 | Action Row | mensaje | |
| 2 | Button | mensaje | Estilos 1-4 usan `custom_id`. 5 Link (url, no genera interacción). 6 Premium (`sku_id`). Label ≤80 |
| 3 | String Select | mensaje / modal | ≤25 opciones |
| 4 | Text Input | modal (dentro de Label) | ≤4000 caracteres |
| 5-8 | User/Role/Mentionable/Channel Select | mensaje / modal | |
| 9 | Section | V2 | 1-3 Text Display + accessory (botón o thumbnail) |
| 10 | Text Display | V2 / modal | markdown |
| 11 | Thumbnail | accessory | |
| 12 | Media Gallery | V2 | 1-10 items |
| 13 | File | V2 | `attachment://` |
| 14 | Separator | V2 | |
| 17 | Container | V2 | `accent_color` |
| 18 | Label | modal | envuelve un input |
| 19 | File Upload | modal | 0-10 archivos |
| 21/22/23 | Radio Group / Checkbox Group / Checkbox | modal | |

- **Modal:** `title` ≤45 caracteres, 1-5 componentes de primer nivel (Labels), sin componentes `disabled`.
- **Webhooks no-app:** los componentes se ignoran sin `?with_components=true` y no pueden ser interactivos.

---

## 3. Gateway

### Ciclo de vida

1. `GET /gateway/bot` devuelve la URL, los shards recomendados y `session_start_limit`.
2. Conectar a `wss://gateway.discord.gg/?v=10&encoding=json`.
3. Recibir **Hello (op 10)** con `heartbeat_interval`. El primer heartbeat va tras `interval * random()` y después uno cada `interval`. Discord responde ACK con op 11.
   - Si no llega el ACK, la conexión está zombie: cerrar con un código distinto de 1000/1001 y hacer resume.
4. **Identify (op 2)** con token + intents. Llega `READY` (`session_id`, `resume_gateway_url`) y después `GUILD_CREATE` por cada guild.
5. **Resume (op 6)**: se hace contra `resume_gateway_url`, no la URL original.
6. Cerrar con 1000/1001 **mata la sesión**.
7. op 7 Reconnect → hacer resume. op 9 Invalid Session `d:false` → volver a hacer Identify.

### Límites

- **1000 Identify por 24 h.** Pasarse **resetea el token** del bot (cuidado con los bucles de crash).
- `max_concurrency` Identify cada 5 s.
- **120 eventos enviados por conexión cada 60 s** (incluye heartbeats). Presence update: 5 cada 20 s. Payload enviado ≤ 4096 bytes.
- **Sharding obligatorio desde 2500 guilds** (código 4011). Fórmula: `shard_id = (guild_id >> 22) % num_shards`. Los DMs van al shard 0.

### Intents

| Bit | Intent | Eventos |
|---|---|---|
| 0 | GUILDS | guild, roles, canales, hilos, stage |
| 1 | **GUILD_MEMBERS** (privilegiado) | member add/update/remove, lista completa de miembros |
| 2 | GUILD_MODERATION | bans, audit log entries |
| 3 | GUILD_EXPRESSIONS | emojis, stickers, soundboard |
| 4 | GUILD_INTEGRATIONS | |
| 5 | GUILD_WEBHOOKS | |
| 6 | GUILD_INVITES | |
| 7 | GUILD_VOICE_STATES | voice state |
| 8 | **GUILD_PRESENCES** (privilegiado) | PRESENCE_UPDATE |
| 9 | GUILD_MESSAGES | MESSAGE_* en servidores |
| 10 | GUILD_MESSAGE_REACTIONS | |
| 11 | GUILD_MESSAGE_TYPING | |
| 12-14 | DIRECT_MESSAGES / _REACTIONS / _TYPING | |
| 15 | **MESSAGE_CONTENT** (privilegiado) | rellena `content`, `embeds`, `attachments`, `components`, `poll` |
| 16 | GUILD_SCHEDULED_EVENTS | |
| 20-21 | AUTO_MODERATION_CONFIGURATION / _EXECUTION | |
| 24-25 | GUILD_MESSAGE_POLLS / DIRECT_MESSAGE_POLLS | |

- **Sin MESSAGE_CONTENT**, MESSAGE_CREATE sigue llegando pero **vacío**: los comandos con prefijo (`!cmd`) dejan de funcionar sin dar error. Excepciones (sí traen contenido): mensajes del propio bot, DMs, mensajes que mencionan al bot, el mensaje objetivo de un menú contextual y las respuestas a mensajes del bot.
- Los intents privilegiados se activan en el Portal **y** se piden en el Identify. Pedir uno no activado cierra la conexión con 4014.
- **Revisión (desde 2026-06-10):** se activa al llegar a **10.000 usuarios únicos** que pueden ver la app (ya no a los 100 servidores).
  - Hay 90 días para solicitar la revisión, y se **re-solicita cada año**.
  - "Replicar AutoMod" no se considera un caso de uso válido para MESSAGE_CONTENT.
  - Discord recomienda slash commands en lugar de leer mensajes.

### Códigos de cierre sin reconexión

4004 (token inválido), 4010 (shard inválido), 4011 (sharding requerido), 4012 (versión inválida), 4013 (intents inválidos), 4014 (intents no permitidos).

### Webhook events (HTTP, sin gateway)

- Solo APPLICATION_AUTHORIZED/DEAUTHORIZED, ENTITLEMENT_*, LOBBY_*, GAME_DIRECT_MESSAGE_*. Responder **204 en ≤3 s**.
- **No** incluye mensajes ni miembros.

---

## 4. Rate limits REST

- Headers: `X-RateLimit-Limit/Remaining/Reset/Reset-After/Bucket/Scope`. **No hardcodear límites**: leer los headers.
- **Global: 50 req/s por bot.** Los endpoints de interacciones están exentos.
- Los límites son por ruta y por recurso padre (channel_id / guild_id / webhook_id).
- 429: usar el `retry_after` del body (float).
- **10.000 requests inválidas (401/403/429) en 10 min por IP → ban temporal de Cloudflare.** No reintentar 401/403/404.
- Las rutas de emojis tienen límites raros por guild.

---

## 5. Recursos principales: límites clave

### Mensajes

- `content` ≤ **2000** caracteres, ≤ **10 embeds**, ≤ 3 stickers, 25 MiB por request.
- Embeds:
  - title 256, description 4096, 25 fields (name 256, value 1024), footer 2048, author 256.
  - **6000 caracteres en total** sumando todos los embeds.
- Bulk delete: **2-100 mensajes**, todos de **menos de 14 días** (uno viejo hace fallar todo el request). Solo en guilds.
- Solo se puede editar el contenido de mensajes propios. De mensajes ajenos solo `flags` (con MANAGE_MESSAGES).
- Pin: permiso **PIN_MESSAGES** (desde 2026-02-23; MANAGE_MESSAGES ya no basta). Rutas nuevas `/messages/pins`.
- `allowed_mentions`: controla los pings. Un edit **sin** este campo vuelve a los defaults. Usarlo siempre al repetir input del usuario.
- Reenviar un mensaje que el bot no puede leer da error 160014.
- **Search Guild Messages:** necesita READ_MESSAGE_HISTORY + MESSAGE_CONTENT.

### Canales e hilos

- Tipos: 0 text, 2 voice, 4 category (≤50 hijos), 5 announcement, 10/11/12 threads, 13 stage, 15 forum, 16 media.
- Slowmode (0-21600 s) **no afecta a bots**.
- En hilos: **SEND_MESSAGES no sirve**, hace falta SEND_MESSAGES_IN_THREADS. En forum/media solo se crean posts (hilos), con SEND_MESSAGES.
- `auto_archive_duration`: 60, 1440, 4320 o 10080 min. En hilos archivados no se puede reaccionar, editar ni unirse.
- **Ofuscación de canales (2026-11-16):** los canales que el bot no puede ver llegan ofuscados por gateway (flag CHANNEL_OBFUSCATED) y se omiten en `GET /guilds/{id}/channels`.

### Guild y miembros

- `GET /guilds/{id}/members` requiere el intent **GUILD_MEMBERS**. Alternativa sin intent: Search Guild Members (por prefijo) o el `member` incluido en cada interacción.
- Timeout (`communication_disabled_until`): máximo **28 días**. No se aplica a admins ni al owner.
- Bulk ban ≤ 200 usuarios (BAN_MEMBERS + MANAGE_GUILD). Al banear, `delete_message_seconds` ≤ 7 días.
- **Añadir un usuario a un guild** solo es posible con su token OAuth2 `guilds.join`, y el bot debe estar ya en ese guild.
- Header `X-Audit-Log-Reason` (≤512 caracteres) en acciones de moderación. Audit log: retención de **45 días**, requiere VIEW_AUDIT_LOG.

### DMs

- `POST /users/@me/channels {recipient_id}` abre un DM. La doc dice explícitamente: **no usar para mandar DMs a todo un servidor**.
- Abrir muchos DMs seguidos lleva a rate limit o bloqueo (40003). 50007 = no se puede enviar DM a ese usuario.

### Otros

- **Polls:** pregunta 300 caracteres, ≤10 respuestas de 55 caracteres, duración ≤ 32 días. Las apps **no pueden votar** y la encuesta no se puede editar.
- **Webhooks:** nombre 1-80 caracteres, sin "clyde" ni "discord". 15 por canal, 1000 por guild. Execute: `?wait=true` para recibir el mensaje.
- **Emojis de app:** hasta **2000 por app**, usables en cualquier sitio sin USE_EXTERNAL_EMOJIS (mejor que un "servidor de emojis"). 256 KiB.
- **Stickers:** 512 KiB, 320x320. Lottie solo en guilds verificados/partner.
- **Soundboard:** el bot debe estar conectado a voz, y Discord reproduce el sonido (no hace falta stream Opus). 512 KB, ≤5,2 s.
- **Eventos programados:** CREATE_EVENTS (desde 2026-02-23). Máximo 100 activos/programados por guild.
- **AutoMod:** MANAGE_GUILD.
  - Límites de reglas por guild: 6 KEYWORD, 1 SPAM, 1 KEYWORD_PRESET, 1 MENTION_SPAM, 1 MEMBER_PROFILE.
  - Regex: Rust, ≤10 patrones de 260 caracteres.
  - `enabled` es `false` por defecto al crear.
- **Stage:** crear o editar requiere MANAGE_CHANNELS + MUTE_MEMBERS + MOVE_MEMBERS.
- **Linked Roles:** ≤5 registros de metadata por app, flujo OAuth2 con `role_connections.write`.

---

## 6. Voz

- Flujo:
  1. Gateway op 4 (Voice State Update).
  2. Esperar **VOICE_STATE_UPDATE** + **VOICE_SERVER_UPDATE**.
  3. Abrir el WS de voz (`?v=8`).
  4. Descubrimiento de IP por UDP.
  5. Select Protocol.
  6. Enviar op 5 Speaking **antes** del audio.
  7. RTP por UDP.
- Audio: **Opus 48 kHz estéreo**. Al parar, enviar 5 frames de silencio.
- Cifrado: `aead_aes256_gcm_rtpsize` (preferido) o `aead_xchacha20_poly1305_rtpsize` (requerido). Los modos xsalsa20 están discontinuados.
- **DAVE (E2EE) obligatorio desde 2026-03-01.** Sin soporte DAVE el bot no puede entrar a voz (cierre 4017). Usar una librería con DAVE (versión reciente de @discordjs/voice o discord.py). **No implementarlo a mano.**
- **Recibir audio de otros usuarios no está documentado ni soportado oficialmente.** Es frágil.
- Si el `user_limit` del canal está lleno, el bot no recibe respuesta (MOVE_MEMBERS lo salta).

---

## 7. OAuth2 y permisos

### URL de invitación del bot

`https://discord.com/oauth2/authorize?client_id=X&scope=bot+applications.commands&permissions=N`

- Con "Discord Provided Link" se usan los defaults del Portal.
- El `guild_id` del redirect es solo una pista. Para garantizar el guild hay que activar "Require OAuth2 Code Grant".
- Los endpoints de token/revoke solo aceptan `application/x-www-form-urlencoded`.

### Scopes

- Útiles: `bot`, `applications.commands`, `identify`, `guilds`, `guilds.join`, `guilds.members.read`, `role_connections.write`, `webhook.incoming`.
- Requieren aprobación o no disponibles: `dm_channels.read`, `messages.read`, `rpc*`, `voice`, `relationships.read`, `activities.*`.

### Permisos

- **Cálculo:**
  1. Owner → todos.
  2. `@everyone` | roles → si incluye ADMINISTRATOR, todos (ignora overwrites).
  3. Overwrites de `@everyone` → overwrites de roles (combinados; **un allow gana a un deny de otro rol**, el orden no importa) → overwrite del miembro.
- **Jerarquía:** el bot solo puede gestionar roles y moderar miembros cuyo rol más alto esté **por debajo** del suyo, aunque tenga ADMINISTRATOR. Solo puede otorgar permisos que él mismo tiene.
- **Implícitos:**
  - Sin VIEW_CHANNEL no aplica nada más.
  - Sin SEND_MESSAGES se pierden MENTION_EVERYONE, TTS, ATTACH y EMBED.
  - Usuarios en timeout: solo VIEW_CHANNEL + READ_MESSAGE_HISTORY.
- **Permisos con flag MFA:** si el guild exige 2FA, el **dueño del bot** debe tener 2FA. Lista: KICK, BAN, ADMINISTRATOR, MANAGE_CHANNELS/GUILD/MESSAGES/ROLES/WEBHOOKS/GUILD_EXPRESSIONS/THREADS…
- **Permisos nuevos (2026-02-23)** que hay que incluir en la invitación: PIN_MESSAGES, CREATE_GUILD_EXPRESSIONS, CREATE_EVENTS.

---

## 8. Qué NO puede hacer un bot

- Aceptar invitaciones normales o unirse a servidores por su cuenta (solo vía OAuth2). Tener amigos, o unirse o crear group DMs normales.
- Leer el contenido de mensajes sin MESSAGE_CONTENT (salvo las excepciones de la sección 3), ni listar miembros sin GUILD_MEMBERS, ni ver presencias sin GUILD_PRESENCES.
- Leer DMs entre otros usuarios.
- Añadir usuarios a servidores sin su consentimiento OAuth2 (`guilds.join`).
- Editar el contenido de mensajes ajenos. Borrar en bloque mensajes de más de 14 días. Editar mensajes de voz.
- Votar en encuestas o editarlas.
- Abrir un modal tras un defer o sin una interacción.
- Mandar mensajes a un usuario espontáneamente sin canal compartido o instalación **[no confirmado textualmente; el DM requiere que Discord lo permita, error 50007]**.
- Moderar a usuarios con un rol igual o superior, ni hacer timeout al owner o a admins.
- Quitar el flag Components V2 de un mensaje.
- Recibir audio de forma oficialmente soportada. Conectarse a voz sin DAVE.
- Ver más de 50 integraciones por guild.
- Superar ~100 servidores sin verificación **[no confirmado en las páginas leídas; es la regla histórica]**.

---

## 9. Políticas (Developer Policy y Terms of Service)

**Prohibido:**

- **Self-bots** (automatizar cuentas de usuario).
- Pedir contraseñas o tokens.
- **DMs no solicitados** o publicidad.
- Inflar la actividad o el número de miembros, incluidos los mensajes automáticos para "mantener activo" un servidor.
- Scraping o minería de datos.
- **Entrenar modelos de IA/ML con el contenido de mensajes** sin permiso expreso de Discord.
- Vender datos o compartirlos con data brokers o redes de publicidad.
- Perfilar usuarios.
- Dirigirse a menores de 13.
- Contenido adulto sin restricción de edad.
- Suplantar identidad.
- Evadir rate limits.

**Obligatorio:**

- Usar los datos solo para las funciones declaradas.
- **Política de privacidad** (GDPR/CCPA) enlazada en el Portal.
- Cifrar los datos en reposo y borrarlos cuando ya no se necesiten o el usuario lo pida.
- Ofrecer una vía para reportar problemas.
- No publicar tokens en repos open source.

**Otros puntos:**

- Los tokens sin uso durante 30 días pueden ser revocados.
- Vender o transferir la app requiere el consentimiento de Discord.

---

## 10. Verificación, Discovery y monetización

- **App Verification:** necesaria para Discovery y monetización. La hace el owner del team.
- **Discovery (App Directory):** descripción ≤400 caracteres, resumen ≤200, ≤5 tags. Puede tardar hasta 24 h en aparecer.
- **Teams:** requieren 2FA, ≤75 apps por team, y la transferencia de una app a un team es irreversible.
- **Monetización (Premium Apps):**
  - Requisitos:
    - App verificada y propiedad de un team.
    - Owner ≥ 18 años.
    - Solo en EE. UU., UE y Reino Unido.
    - ToS y política de privacidad.
    - Payout vía Stripe a partir de $100.
  - SKUs: suscripción de usuario **o** de guild (no ambas), durable o consumible. Máximo 50 SKUs.
  - Usar **entitlements** (no subscriptions) para dar acceso. Los consumibles deben "consumirse" antes de poder recomprarse.
  - Desde 2024-10-07, las funciones de pago deben poder comprarse vía Premium Apps a un precio ≤ que en otros sitios.

---

## 11. Plataforma más allá de los bots (normalmente no relevante)

- **Activities:** apps web en un iframe dentro de Discord (Embedded App SDK). Un bot puede lanzarlas con el callback 12.
- **Social SDK, Rich Presence, Lobbies, Game Stats Widgets, Social Commerce, Game Profiles:** orientados a estudios de videojuegos.
- **RPC:** controla el cliente local del usuario. Requiere aprobación y no es una API de bots.
- **Certified Devices:** para fabricantes de hardware.

---

## 12. Librerías (Discord no tiene SDK oficial)

| Lenguaje | Librerías |
|---|---|
| JavaScript/TS | **discord.js**, Eris, Oceanic. Para HTTP: discord-interactions-js, slash-create. Tipos: discord-api-types |
| Python | **discord.py**, disnake, hikari, interactions.py, nextcord, pycord |
| C# | Discord.Net, DSharpPlus |
| Java | JDA, Discord4J |
| Go | DiscordGo |
| Rust | Serenity |
| Otros | D++ (C++), Concord (C), discordrb (Ruby), DiscordPHP, Discordia (Lua), discljord (Clojure) |

- Ejemplo oficial: https://github.com/discord/discord-example-app (Express + discord-interactions + ngrok).
- Herramientas: calculadoras de permisos e intents, Embed Debugger (discord.com/developers/embeds), OpenAPI spec (discord-api-spec).

---

## 13. Errores fáciles de cometer

1. No responder en 3 s: hay que diferir enseguida si hay trabajo lento.
2. Esperar `message.content` sin el intent MESSAGE_CONTENT.
3. Usar comandos globales en desarrollo: tardan en propagarse. Usar comandos de guild.
4. Un bulk `PUT` de comandos borra los que faltan.
5. Bucles de reconexión que agotan los 1000 Identify al día y resetean el token.
6. Cerrar el WebSocket con 1000 en reinicios (mata la sesión). Hacer resume contra la URL equivocada.
7. Reintentar 401/403/404, que lleva al ban de Cloudflare.
8. El rol del bot está por debajo del rol que intenta gestionar.
9. Usar SEND_MESSAGES para hilos (hace falta SEND_MESSAGES_IN_THREADS).
10. No incluir `allowed_mentions` y provocar pings masivos.
11. Commitear el token. Usar `.env` y `.gitignore`.
12. Endpoint HTTP sin verificación de firma, que Discord elimina.
13. Fechas próximas: la ofuscación de canales empieza el 2026-11-16.

# Bot de alineaciones y estadísticas deportivas para Discord: diseño

**Fecha:** 2026-10-21
**Estado:** borrador para aprobación
**Repo:** https://github.com/Ecarch/nba-lineups-bot (público). Código local en `X:\Projects\Bots`.

## 1. Intención

El usuario tiene un servidor de Discord donde se sigue la NBA y la Champions League. Quiere dos cosas:

1. **Saber las alineaciones titulares minutos antes de cada partido**, sin buscarlas a mano. Hoy las conseguía con los posts "Lineup alert" de @UnderdogNBA en X. Acepta cualquier otra fuente, siempre que sea la alineación del partido y llegue antes del inicio. Llegar horas tarde no le sirve.
2. **Consultar las estadísticas de un jugador** con un comando, por ejemplo `/player doncic` o `/player mbappe`.

Restricción principal: **todo gratis.** Rechazó pagar la API de X (~$4.50/mes) y no quiere depender de que su PC esté encendida.

Referencia visual que dio: los posts "Wowhead News" que aparecen automáticamente en un canal con nombre y avatar propios.

## 2. Objetivos

- **Alertas de alineaciones** publicadas automáticamente, un mensaje por partido, para:
  - NBA → foro de NBA (webhook existente, secret `DISCORD_WEBHOOK_URL`).
  - Champions League → canal de Champions (webhook existente, secret `UCL_WEBHOOK_URL`).
- **Comando `/player <nombre>`** con autocompletado de nombres, que responde con las estadísticas de la temporada de jugadores de NBA y de fútbol.
- **Coste $0:** GitHub Actions (repo público) para las alertas y Vercel Hobby para el comando.
- **Fácil añadir ligas nuevas** (LaLiga, Premier…): una entrada de configuración y un webhook, sin tocar la lógica.

## 3. No objetivos

- No usa la API de X ni hace scraping de X (salvo el plan B de la sección 9).
- No hace estadísticas avanzadas (pases, xG, rating, mapas de calor).
- No transmite marcadores en vivo, goles ni notificaciones durante el partido.
- No usa base de datos ni panel web.
- No usa comandos con prefijo (`!Player-...`). El usuario aceptó `/player` a cambio de alojarlo gratis sin servidor propio.

## 4. Anti-objetivos (fallaría aunque "funcione")

- **Publicar la misma alineación dos veces** en un canal.
- **Publicar en el canal equivocado** (NBA en Champions o al revés).
- **Que una alineación llegue después del inicio** sin que se note. Si se detecta tarde, el mensaje debe decirlo.
- **Que el bot deje de funcionar sin que nadie se entere** durante días. Ejemplos: ESPN cambia su formato o GitHub desactiva la tarea programada.
- **Que se filtren webhooks o tokens** en el repo público.

## 5. Restricciones

### GitHub Actions (alertas)
- Repos públicos: minutos gratis ilimitados en runners estándar. Máximo **6 h por job**.
- El cron puede retrasarse 5–30 min, sobre todo a la hora en punto. Se usan minutos "raros" (:17).
- GitHub **desactiva los workflows programados tras 60 días sin actividad en el repo**. *(Dato de memoria, verificar.)*
- No está pensado como hosting permanente. Se acepta como solución actual, y la alternativa sería un VPS gratuito.

### Vercel Hobby (comando)
- Funciones de hasta 300 s.
- **Cron solo diario**: por eso las alertas no van en Vercel.
- El comando no necesita cron: Discord llama al endpoint en cada uso.

### Discord
- Cada interacción debe responderse en **≤3 s**: hay que diferir (tipo 5) si ESPN tarda.
- **Autocompletado:** responder en ≤3 s con un máximo de 25 opciones.
- Verificación de firma **Ed25519** obligatoria. Discord prueba con firmas falsas y quita el endpoint si se aceptan.
- **Canal destino:** el de NBA es un **foro**, así que los webhooks necesitan `thread_name` (un post por partido). El de Champions puede ser foro o texto; el código ya soporta ambos.

### ESPN
API pública no documentada, sin key. Puede cambiar sin aviso.

### Horario
Todo trabaja en **UTC** (hora del servidor, decisión del usuario). Las horas en los mensajes usan timestamps de Discord (`<t:unix:t>` y `<t:unix:R>`), que cada usuario ve en su hora local.

## 6. Fuentes de datos (verificadas el 2026-10-21)

Base: `https://site.api.espn.com/apis/site/v2/sports/{path}`, con `path` = `basketball/nba` o `soccer/uefa.champions`.

### Partidos del día
`GET {base}/scoreboard` (o `?dates=YYYYMMDD`): `events[].id`, `date` (UTC), `shortName`, `name`, `status.type.name`.

### Alineaciones
`GET {base}/summary?event={id}`:
- **Fútbol:** `rosters[]` con `team`, `homeAway`, `formation` y `roster[]` (`starter`, `jersey`, `position.abbreviation`, `athlete.displayName`).
  - **Medido:** en Champions aparecieron **58,5 min antes** del inicio (7/7 partidos, 2026-10-21).
- **NBA:** `boxscore.players[].statistics[0].athletes[]` con `starter`, `athlete.displayName` y `athlete.position.abbreviation`.
  - **Sin medir:** no se sabe si aparecen antes del inicio. Se mide la noche del 2026-10-21 (sección 9).

### Buscar jugador
`GET https://site.web.api.espn.com/apis/common/v3/search?query={q}&type=player&limit=N` (opcional `&sport=soccer`): `items[]` con `id`, `displayName`, `sport`, `league`.

### Estadísticas del jugador
`GET https://site.web.api.espn.com/apis/common/v3/sports/{sport}/{league}/athletes/{id}/overview`. Devuelve `statistics.labels` y `statistics.splits[]` (una fila por competición o temporada), además de `gameLog` y `nextGame`.
- **NBA:** GP, MIN, FG%, 3P%, FT%, REB, AST, BLK, STL, PF, TO, PTS (promedios).
- **Fútbol:** STRT (titular), FC/FA (faltas), YC, RC, G, A, SHOT, SOG, OF. Filas por competición (Champions, liga, selección…).

## 7. Diseño decidido

### 7.1 Alertas de alineaciones (GitHub Actions)

Evoluciona el spike `spike/lineup-spike.mjs`, que ya funciona.

**Configuración por liga:**
- clave, `path` de ESPN, emoji, color, nombre visible
- número de titulares esperado (NBA 5, fútbol 11)
- nombre del secret del webhook
- horario de ejecución

**Ciclo, en cada ejecución y cada minuto:**
1. Leer el scoreboard.
2. Para cada partido entre **90 min antes** y **15 min después** del inicio, todavía sin publicar, leer el summary.
3. Si los dos equipos tienen los titulares completos, publicar un mensaje y marcarlo como publicado.
4. Terminar cuando no queden partidos pendientes ese día.

**Mensaje:** un embed por partido.
- **Título:** `{emoji} Alineación titular: {event.name}`.
- **Descripción:** liga y hora de inicio con timestamps de Discord.
- **Campos:** un campo por equipo con nombre (y formación en fútbol) y la lista de titulares: posición, dorsal en fútbol y nombre.
- **Pie:** fuente ESPN y "detectado X min antes del inicio". Si llega tarde: "X min DESPUÉS del inicio".
- **Foros:** `thread_name` = `{emoji} {shortName} · dd/mm`.
- **Menciones:** `allowed_mentions: {parse: []}`.

**Horarios:**
- **Champions:** martes y miércoles, 15:17 UTC (partidos a las 16:45 y 19:00 UTC).
- **NBA:** hoy diario a las 21:17 UTC. **No cubre** los partidos de tarde de fin de semana y festivos (inicio desde ~17:00 UTC). El builder debe garantizar que **todo partido** quede cubierto, por ejemplo con varias ejecuciones al día.

**Cambios de última hora (decisión del usuario):**
- Tras publicar, el bot **sigue vigilando el partido hasta el inicio**.
- Si cambia algún titular, publica una **corrección dentro del mismo post o hilo**, por ejemplo: `⚠️ Cambio en {equipo}: sale X, entra Y`. **No edita** el mensaje original.
- Implica publicar con `?wait=true` y guardar el ID del hilo y del mensaje, junto con la alineación publicada, en el estado.
- En un canal de texto normal (sin foro), la corrección se publica como un mensaje nuevo que nombra el partido.

**Sin duplicados:** si hay varias ejecuciones el mismo día o se solapan, el estado de "ya publicado" debe sobrevivir entre ejecuciones. Hoy solo vive dentro de una ejecución.

### 7.2 Comando `/player` (Vercel)

**App de Discord nueva**, creada por el usuario en el Developer Portal:
- Solo slash commands por HTTP: no hace falta Gateway ni intents privilegiados.
- Instalación en servidor con scope `applications.commands`.

**Comando global** `/player`:
- Opción `nombre` (STRING, requerida, con autocompletado).
- Se registra con un script aparte (bulk PUT).

**Autocompletado:** usa la búsqueda de ESPN. Muestra hasta 25 jugadores como `Nombre · Liga/Equipo`, y el `value` lleva el ID de ESPN más el deporte y la liga.

**Respuesta:**
1. Diferir (tipo 5).
2. Consultar `overview`.
3. Editar `@original` con un embed:
   - **NBA:** promedios de la temporada actual (PTS, REB, AST, MIN, FG%, 3P%, STL, BLK).
   - **Fútbol:** una sección por competición de la temporada actual, con titular, goles, asistencias, tiros totales, **al arco (SOG)**, **desviados (SHOT − SOG)**, **atajados aprox. (SOG − G)**, amarillas y rojas.
4. Pie: "Fuente: ESPN".

**Si se escribe un nombre sin elegir sugerencia:** buscar y usar el primer resultado. Si hay varios muy parecidos, sugerir los otros en el pie.

**Respuesta pública** (no efímera) en el canal donde se usó.

### 7.3 Secretos y repo
- Webhooks y tokens solo en GitHub Secrets o variables de entorno de Vercel. **Nunca** en el código.
- `.env` está en `.gitignore`.
- **Regenerar los dos webhooks**: se pegaron en el chat del 2026-10-21. Pedirle al usuario los nuevos y actualizar los secrets.

## 8. A decisión del builder

- Lenguaje y estructura: Node.js 22, sin framework o mínimo. Dependencias a elección (p. ej. `discord-interactions` o `tweetnacl` para las firmas).
- Mecanismo para persistir el estado entre ejecuciones de Actions: cache, artifact, rama `state` o commit.
- **Monitoreo:** cómo y dónde avisar si una ejecución falla o ESPN cambia de formato. Sugerencia: mensaje a un webhook de admin o a los mismos canales.
- Orden y diseño visual exacto de los embeds, dentro de lo descrito.
- Pruebas automáticas con fixtures de respuestas reales de ESPN.
- Retirar o conservar el modo `--test` del spike y el workflow de prueba.

## 9. Pendiente y plan B

**Medición NBA (noche del 2026-10-21):** el workflow `lineups.yml` registrará en qué minuto aparecen los titulares en ESPN para 11 partidos.

- **Si aparecen antes del inicio** (lo deseable es ≥15 min): ESPN es la fuente definitiva de la NBA.
- **Si solo aparecen al empezar:** ESPN no sirve para alertas NBA. Plan B a decidir con el usuario según el resultado. Candidatos:
  - Una web de alineaciones NBA scrapeable sin login, a investigar (RotoWire, etc.).
  - Volver a X @UnderdogNBA con navegador automatizado y cuenta secundaria. Implica riesgo de suspensión y VPS; el usuario no lo ha confirmado.

**Verificación:** comprobar que los titulares que da ESPN antes del partido coinciden con los que realmente empezaron, es decir, que son oficiales y no una proyección.

## 10. Estado actual (spike en producción provisional)

- `spike/lineup-spike.mjs` con `--league nba|ucl` y `--test`.
- `.github/workflows/lineups.yml` (NBA, diario 21:17 UTC) y `ucl.yml` (martes y miércoles, 15:17 UTC). Ambos aceptan ejecución manual con `test=true`.
- **Champions validada** en producción el 2026-10-21: 7 alineaciones publicadas 58,5 min antes del inicio.

// PRUEBA DESECHABLE (spike): publica los titulares de cada partido NBA en un canal
// de Discord en cuanto ESPN los muestra, y mide cuántos minutos antes del inicio llegan.
// No es el bot final. Uso:
//   node lineup-spike.mjs          -> vigila los partidos de hoy
//   node lineup-spike.mjs --test   -> publica un ejemplo con un partido ya jugado
// Requiere DISCORD_WEBHOOK_URL en spike/.env o como variable de entorno.

import { readFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = dirname(fileURLToPath(import.meta.url));
const STATE_FILE = join(DIR, "state.json");
const LOG_FILE = join(DIR, "log.csv");
const ESPN = "https://site.api.espn.com/apis/site/v2/sports/basketball/nba";

const POLL_MS = 60_000;
const WATCH_FROM_MIN = 90; // empezar a vigilar 90 min antes del inicio
const GIVE_UP_AFTER_MIN = 15; // dejar de vigilar 15 min después del inicio

function loadEnv() {
  const envPath = join(DIR, ".env");
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

async function getJson(url) {
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

function extractStarters(summary) {
  const teams = [];
  for (const t of summary.boxscore?.players ?? []) {
    const athletes = t.statistics?.[0]?.athletes ?? [];
    const starters = athletes
      .filter((a) => a.starter)
      .map((a) => ({ name: a.athlete.displayName, pos: a.athlete.position?.abbreviation ?? "" }));
    teams.push({ name: t.team.displayName, abbr: t.team.abbreviation, starters });
  }
  return teams;
}

async function postToDiscord(event, teams, minsToTip, threadSuffix = "") {
  const tipUnix = Math.floor(new Date(event.date).getTime() / 1000);
  const day = new Date(event.date).toLocaleDateString("es", { day: "2-digit", month: "2-digit", timeZone: "America/New_York" });
  const when =
    minsToTip >= 0
      ? `detectado ${Math.round(minsToTip)} min antes del inicio`
      : `detectado ${Math.round(-minsToTip)} min DESPUÉS del inicio`;
  const body = {
    username: "NBA Lineups",
    // el canal es un foro: cada mensaje crea un post nuevo con este título
    thread_name: `🏀 ${event.shortName} · ${day}${threadSuffix}`,
    allowed_mentions: { parse: [] },
    embeds: [
      {
        title: `🏀 Alineación titular: ${event.shortName}`,
        description: `Inicio: <t:${tipUnix}:t> (<t:${tipUnix}:R>)`,
        color: 0x1d428a,
        fields: teams.map((t) => ({
          name: t.name,
          value: t.starters.map((s) => `\`${s.pos.padEnd(2)}\` ${s.name}`).join("\n") || "—",
          inline: true,
        })),
        footer: { text: `Fuente: ESPN · ${when} · versión de prueba` },
        timestamp: new Date().toISOString(),
      },
    ],
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(process.env.DISCORD_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) return;
    if (res.status === 429) {
      const { retry_after = 1 } = await res.json().catch(() => ({}));
      await new Promise((r) => setTimeout(r, retry_after * 1000));
      continue;
    }
    throw new Error(`Discord webhook ${res.status}: ${await res.text()}`);
  }
}

function log(row) {
  if (!existsSync(LOG_FILE)) {
    appendFileSync(LOG_FILE, "checked_at_utc,event_id,game,mins_to_tip,status,starters_per_team,summary_keys\n");
  }
  appendFileSync(LOG_FILE, row.map((v) => `"${String(v).replace(/"/g, "'")}"`).join(",") + "\n");
}

const loadState = () => (existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : {});
const saveState = (s) => writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));

async function runTest() {
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10).replace(/-/g, "");
  const board = await getJson(`${ESPN}/scoreboard?dates=${yesterday}`);
  const event = board.events.find((e) => e.status.type.completed) ?? board.events[0];
  const teams = extractStarters(await getJson(`${ESPN}/summary?event=${event.id}`));
  await postToDiscord(event, teams, 30, " (prueba)");
  console.log(`Ejemplo publicado con ${event.shortName}. Revisa tu canal de Discord.`);
}

async function tick(state) {
  const board = await getJson(`${ESPN}/scoreboard`);
  let pending = 0;
  for (const event of board.events) {
    if (state[event.id]) continue;
    const minsToTip = (new Date(event.date).getTime() - Date.now()) / 60_000;
    if (minsToTip > WATCH_FROM_MIN) {
      pending++;
      continue;
    }
    if (minsToTip < -GIVE_UP_AFTER_MIN) {
      state[event.id] = { game: event.shortName, result: "no_encontrado", minsToTip };
      console.log(`[${event.shortName}] sin titulares a ${Math.round(-minsToTip)} min del inicio, se descarta`);
      continue;
    }
    pending++;
    const summary = await getJson(`${ESPN}/summary?event=${event.id}`);
    const teams = extractStarters(summary);
    const counts = teams.map((t) => t.starters.length).join("/") || "0";
    log([new Date().toISOString(), event.id, event.shortName, minsToTip.toFixed(1),
      event.status.type.name, counts, Object.keys(summary).join("|")]);
    if (teams.length === 2 && teams.every((t) => t.starters.length >= 5)) {
      await postToDiscord(event, teams, minsToTip);
      state[event.id] = { game: event.shortName, result: "publicado", minsToTip, at: new Date().toISOString() };
      console.log(`[${event.shortName}] titulares publicados, ${minsToTip.toFixed(1)} min antes del inicio`);
    } else {
      console.log(`[${event.shortName}] faltan ${minsToTip.toFixed(1)} min, aún sin titulares (${counts})`);
    }
  }
  saveState(state);
  return pending;
}

loadEnv();
if (!process.env.DISCORD_WEBHOOK_URL) {
  console.error("Falta DISCORD_WEBHOOK_URL (ponlo en spike/.env)");
  process.exit(1);
}

if (process.argv.includes("--test")) {
  await runTest();
} else {
  const state = loadState();
  console.log("Vigilando partidos de hoy. Ctrl+C para detener.");
  while (true) {
    let pending = 1;
    try {
      pending = await tick(state);
    } catch (err) {
      console.error(new Date().toISOString(), "error:", err.message);
    }
    if (pending === 0) {
      console.log("Todos los partidos de hoy procesados. Fin.");
      break;
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

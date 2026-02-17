// ═══════════════════════════════════════════════════════════
// Space Chaos — Сервер v0.7 (Redis)
// ═══════════════════════════════════════════════════════════

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const Redis = require('ioredis');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(express.static(path.join(__dirname)));

// ── Redis ─────────────────────────────────────────────────
const redisUrl = process.env.REDIS_URL;
const redisOpts = redisUrl
  ? { enableReadyCheck: true, maxRetriesPerRequest: 3 }
  : {
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT || '6379', 10),
      enableReadyCheck: true,
      maxRetriesPerRequest: 3
    };
const redis = redisUrl ? new Redis(redisUrl, redisOpts) : new Redis(redisOpts);

const PLAYERS_KEY = 'players:nicks';
function playerKey(nick) { return `player:${nick}`; }

async function loadPlayersFromRedis() {
  const nicks = await redis.smembers(PLAYERS_KEY);
  const out = {};
  for (const nick of nicks) {
    const raw = await redis.get(playerKey(nick));
    if (raw) {
      try {
        out[nick] = JSON.parse(raw);
      } catch (_) { /* пропускаем битые записи */ }
    }
  }
  return out;
}

async function persistPlayer(nick) {
  const p = players[nick];
  if (!p) return;
  await redis.set(playerKey(nick), JSON.stringify(p));
  await redis.sadd(PLAYERS_KEY, nick);
}

async function removePlayerFromRedis(nick) {
  await redis.del(playerKey(nick));
  await redis.srem(PLAYERS_KEY, nick);
}

function persist(nick) {
  if (nick) persistPlayer(nick).catch(err => console.warn('Redis persist', err));
}
function removePersist(nick) {
  if (nick) removePlayerFromRedis(nick).catch(err => console.warn('Redis remove', err));
}

// ── Хранилище ─────────────────────────────────────────────
const players = {};       // ключ — nick (заполняется из Redis при старте)
const missions = [];      // летящие флоты и шахтёры (in-memory)
const asteroids = [];     // астероидные поля (in-memory)

// ── Константы ─────────────────────────────────────────────
const TICK_RATE = 1000;
const MISSION_TICK = 50;           // обновление миссий (мс)
const MAP_BASE_W = 4000;
const MAP_BASE_H = 3000;
const MAP_PER_PLAYER_W = 280;
const MAP_PER_PLAYER_H = 220;
const MAP_MAX_W = 10000;
const MAP_MAX_H = 7500;
const MIN_SPAWN_DIST = 500;          // минимальное расстояние спавна от других игроков (px)
const SPAWN_ATTEMPTS = 50;           // попыток найти место до расширения карты
const SPAWN_EXPAND_STEP_W = 600;     // расширение карты за раз (ширина)
const SPAWN_EXPAND_STEP_H = 450;     // расширение карты за раз (высота)

// Текущее расширение карты от спавна (добавляется поверх формулы)
let mapSpawnExpandW = 0;
let mapSpawnExpandH = 0;

function getMapW() {
  const n = Object.keys(players).length;
  return Math.min(MAP_MAX_W, MAP_BASE_W + n * MAP_PER_PLAYER_W + mapSpawnExpandW);
}
function getMapH() {
  const n = Object.keys(players).length;
  return Math.min(MAP_MAX_H, MAP_BASE_H + n * MAP_PER_PLAYER_H + mapSpawnExpandH);
}
const NICK_MIN = 3;
const NICK_MAX = 16;
const ALLIANCE_NAME_MIN = 2;
const ALLIANCE_NAME_MAX = 20;

// Экономика
const RES_PER_LVL = 8;
const LVL_COST_BASE = 100;
const LVL_COST_MULT = 1.6;
const FLEET_COST_BASE = 10;
const FLEET_COST_MULT = 1.01;         // +1% за каждый имеющийся корабль
const DEFENSE_COST_BASE = 15;
const DEFENSE_COST_MULT = 1.01;       // +1% за каждый имеющийся щит

// Защита новичков
const NEWBIE_PROTECTION_TIME = 300000; // 5 мин (fallback-таймер)
const NEWBIE_PROTECTION_LVL = 6;      // защита снимается при достижении lvl 6

// Боевая система
const ATTACK_THRESHOLD = 0.6;
const FLEET_SPEED = 40;            // px/сек (медленный флот — ~1 мин на полкарты)
const ATTACK_COOLDOWN = 30000;     // 30 сек между атаками
const COMBAT_RANDOM_SPREAD = 0.15; // ±15% разброс в бою (близкие армии могут побеждать)

// Дерево улучшений
const MIL_COST_BASE = 120;
const MIL_COST_MULT = 1.7;
const FORT_COST_BASE = 100;
const FORT_COST_MULT = 1.5;
const MIL_BONUS = 0.05;            // +5% урона за lvl
const FORT_DEF_REGEN = 0.5;        // +0.5 defense/тик за lvl fortification
const FORT_MAX_DEF_PER_LVL = 10;   // +10 макс defense за lvl

// Астероиды
const ASTEROID_COUNT = 12;
const ASTEROID_MIN_RES = 50;
const ASTEROID_MAX_RES = 200;
const ASTEROID_RESPAWN = 60000;     // 60 сек
const MINER_SPEED = 30;            // px/сек (медленнее флота)

// AI боты
const BOT_NAMES = ['Зевс', 'Атлант', 'Кронос', 'Гелиос', 'Арес', 'Посейдон', 'Гермес', 'Аполлон', 'Гефест', 'Дионис', 'Персей', 'Орион', 'Титан', 'Астра', 'Нова'];
const BOTS_PER_PLAYER = 1.5;       // 1-2 бота на игрока (в среднем)
const BOT_TICK_INTERVAL = 5000;    // AI обновление раз в 5 сек
const BOT_UPGRADE_CHANCE = 0.3;    // 30% шанс апгрейда при наличии res
const BOT_ATTACK_CHANCE = 0.15;    // 15% шанс атаки
const BOT_MINE_CHANCE = 0.4;       // 40% шанс добычи астероида

// ── Утилиты ───────────────────────────────────────────────
function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function dist(x1, y1, x2, y2) {
  return Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2);
}

function findSpawnPosition() {
  const margin = 200;
  const otherPlayers = Object.values(players);

  // Пробуем найти место с учётом минимальной дистанции
  for (let attempt = 0; attempt < SPAWN_ATTEMPTS; attempt++) {
    const w = getMapW(), h = getMapH();
    const x = randInt(margin, w - margin);
    const y = randInt(margin, h - margin);
    const tooClose = otherPlayers.some(p => dist(x, y, p.x, p.y) < MIN_SPAWN_DIST);
    if (!tooClose) return { x, y };
  }

  // Не нашли место — расширяем карту и пробуем ещё раз
  if (getMapW() < MAP_MAX_W || getMapH() < MAP_MAX_H) {
    mapSpawnExpandW = Math.min(mapSpawnExpandW + SPAWN_EXPAND_STEP_W, MAP_MAX_W - MAP_BASE_W);
    mapSpawnExpandH = Math.min(mapSpawnExpandH + SPAWN_EXPAND_STEP_H, MAP_MAX_H - MAP_BASE_H);

    // После расширения пробуем ещё раз
    for (let attempt = 0; attempt < SPAWN_ATTEMPTS; attempt++) {
      const w = getMapW(), h = getMapH();
      const x = randInt(margin, w - margin);
      const y = randInt(margin, h - margin);
      const tooClose = otherPlayers.some(p => dist(x, y, p.x, p.y) < MIN_SPAWN_DIST);
      if (!tooClose) return { x, y };
    }
  }

  // Крайний случай — случайная позиция на максимальной карте
  const w = getMapW(), h = getMapH();
  return { x: randInt(margin, w - margin), y: randInt(margin, h - margin) };
}

function createPlayer(nick, isBot = false) {
  const { x, y } = findSpawnPosition();
  return {
    nick,
    x,
    y,
    lvl: 1,
    res: 50,
    fleet: 0,
    defense: 0,
    militaryLvl: 0,
    fortLvl: 0,
    lastAttack: 0,
    last_seen: Date.now(),
    spawnedAt: Date.now(),
    online: true,
    color: `hsl(${randInt(0, 360)}, 70%, 55%)`,
    allianceName: null,
    wins: 0,
    isBot
  };
}

// ── AI Боты ───────────────────────────────────────────────
function createBot() {
  const usedNames = Object.values(players).filter(p => p.isBot).map(p => p.nick);
  const availableNames = BOT_NAMES.filter(n => !usedNames.includes(n));
  if (availableNames.length === 0) return null; // Нет свободных имён
  const name = availableNames[randInt(0, availableNames.length - 1)];
  const bot = createPlayer(name, true);
  bot.lvl = randInt(1, 4); // Боты слабее игроков
  bot.res = bot.lvl * 30;
  bot.fleet = randInt(5, 15);
  bot.defense = randInt(0, 10);
  bot.color = `hsl(${randInt(0, 60)}, 30%, 50%)`; // Серо-коричневый оттенок для ботов
  return bot;
}

function manageBots() {
  const humanCount = Object.values(players).filter(p => !p.isBot).length;
  const botCount = Object.values(players).filter(p => p.isBot).length;
  const targetBots = Math.floor(humanCount * BOTS_PER_PLAYER);

  // Добавляем ботов
  if (botCount < targetBots) {
    const toAdd = Math.min(2, targetBots - botCount); // Не более 2 за раз
    for (let i = 0; i < toAdd; i++) {
      const bot = createBot();
      if (bot) {
        players[bot.nick] = bot;
        persist(bot.nick);
      }
    }
  }

  // Удаляем лишних ботов
  if (botCount > targetBots + 2) { // Гистерезис ±2
    const bots = Object.values(players).filter(p => p.isBot);
    const toRemove = botCount - targetBots;
    for (let i = 0; i < toRemove && i < bots.length; i++) {
      const bot = bots[i];
      delete players[bot.nick];
      removePersist(bot.nick);
      // Удаляем миссии бота
      for (let j = missions.length - 1; j >= 0; j--) {
        if (missions[j].owner === bot.nick) missions.splice(j, 1);
      }
    }
  }
}

function botTick() {
  const bots = Object.values(players).filter(p => p.isBot);
  for (const bot of bots) {
    // Доход ресурсов (уже идёт в основном тике)

    // Случайные апгрейды
    if (Math.random() < BOT_UPGRADE_CHANCE) {
      if (bot.res >= lvlUpCost(bot.lvl) && bot.lvl < 5) {
        bot.res -= lvlUpCost(bot.lvl);
        bot.lvl++;
      } else if (bot.res >= fleetBuyCost(getEffectiveFleet(bot.nick), 5)) {
        bot.res -= fleetBuyCost(getEffectiveFleet(bot.nick), 5);
        bot.fleet += 5;
      } else if (bot.res >= defenseBuyCost(bot.defense, 3) && bot.defense < 20) {
        bot.res -= defenseBuyCost(bot.defense, 3);
        bot.defense += 3;
      }
    }

    // Добыча астероидов
    if (Math.random() < BOT_MINE_CHANCE && bot.fleet > 0) {
      const nearAsteroids = asteroids.filter(a => {
        if (!a.alive) return false;
        const d = dist(bot.x, bot.y, a.x, a.y);
        return d < 1500; // В пределах 1500px
      });
      if (nearAsteroids.length > 0) {
        const asteroid = nearAsteroids[randInt(0, nearAsteroids.length - 1)];
        bot.fleet -= 1;
        missions.push({
          type: 'mine',
          owner: bot.nick,
          asteroidId: asteroid.id,
          x: bot.x, y: bot.y,
          tx: asteroid.x, ty: asteroid.y,
          speed: MINER_SPEED
        });
      }
    }

    // Атака слабых целей
    if (Math.random() < BOT_ATTACK_CHANCE && bot.fleet > 10) {
      const now = Date.now();
      if (now - bot.lastAttack < ATTACK_COOLDOWN) continue;

      const targets = Object.values(players).filter(p => {
        if (p.nick === bot.nick || p.isBot) return false;
        if (isProtected(p)) return false;
        const d = dist(bot.x, bot.y, p.x, p.y);
        return d < 2000; // В пределах 2000px
      });

      if (targets.length > 0) {
        // Атакуем самую слабую цель
        const weakest = targets.sort((a, b) => (a.fleet + a.defense) - (b.fleet + b.defense))[0];
        const toSend = Math.min(bot.fleet, randInt(5, 15));
        bot.fleet -= toSend;
        bot.lastAttack = now;

        const speed = FLEET_SPEED * (1 + bot.militaryLvl * 0.1);
        missions.push({
          type: 'attack',
          owner: bot.nick,
          targetNick: weakest.nick,
          fleetCount: toSend,
          x: bot.x, y: bot.y,
          tx: weakest.x, ty: weakest.y,
          speed
        });
      }
    }

    persist(bot.nick);
  }
}

// ── Защита новичков ──────────────────────────────────────
function isProtected(player) {
  if (!player || !player.spawnedAt) return false;
  return player.lvl < NEWBIE_PROTECTION_LVL &&
         (Date.now() - player.spawnedAt) < NEWBIE_PROTECTION_TIME;
}

// ── Масштабируемые цены кораблей и щитов ─────────────────
function fleetUnitCost(currentFleet) {
  return Math.floor(FLEET_COST_BASE * Math.pow(FLEET_COST_MULT, currentFleet));
}
function defenseUnitCost(currentDef) {
  return Math.floor(DEFENSE_COST_BASE * Math.pow(DEFENSE_COST_MULT, currentDef));
}
// Подсчёт эффективного флота (на планете + в миссиях)
function getEffectiveFleet(nick) {
  const p = players[nick];
  if (!p) return 0;
  const inMissions = missions
    .filter(m => m.owner === nick && m.fleetCount)
    .reduce((sum, m) => sum + (m.fleetCount || 0), 0);
  return p.fleet + inMissions;
}

function fleetBuyCost(currentFleet, amount) {
  let total = 0;
  for (let i = 0; i < amount; i++) total += fleetUnitCost(currentFleet + i);
  return total;
}
function defenseBuyCost(currentDef, amount) {
  let total = 0;
  for (let i = 0; i < amount; i++) total += defenseUnitCost(currentDef + i);
  return total;
}

function lvlUpCost(lvl) {
  return Math.floor(LVL_COST_BASE * Math.pow(LVL_COST_MULT, lvl - 1));
}
function milUpCost(lvl) {
  return Math.floor(MIL_COST_BASE * Math.pow(MIL_COST_MULT, lvl));
}
function fortUpCost(lvl) {
  return Math.floor(FORT_COST_BASE * Math.pow(FORT_COST_MULT, lvl));
}
function maxDefense(fortLvl) {
  return 5 + fortLvl * FORT_MAX_DEF_PER_LVL;
}

// ── Астероиды ─────────────────────────────────────────────
function spawnAsteroid() {
  const w = getMapW(), h = getMapH();
  return {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    x: randInt(100, w - 100),
    y: randInt(100, h - 100),
    res: randInt(ASTEROID_MIN_RES, ASTEROID_MAX_RES),
    alive: true
  };
}

// Начальная генерация
for (let i = 0; i < ASTEROID_COUNT; i++) {
  asteroids.push(spawnAsteroid());
}

// Респавн астероидов
setInterval(() => {
  const alive = asteroids.filter(a => a.alive).length;
  if (alive < ASTEROID_COUNT) {
    const missing = ASTEROID_COUNT - alive;
    // Респавним по 1-2 за тик
    const toSpawn = Math.min(missing, 2);
    for (let i = 0; i < toSpawn; i++) {
      // Заменяем мёртвый или добавляем
      const deadIdx = asteroids.findIndex(a => !a.alive);
      if (deadIdx >= 0) {
        asteroids[deadIdx] = spawnAsteroid();
      } else {
        asteroids.push(spawnAsteroid());
      }
    }
  }
}, ASTEROID_RESPAWN);

// ── Экономический тик (1 сек) ────────────────────────────
setInterval(() => {
  for (const nick in players) {
    const p = players[nick];
    // Доход ресурсов
    p.res += p.lvl * RES_PER_LVL;
    // Реген защиты (fortification)
    if (p.fortLvl > 0) {
      const max = maxDefense(p.fortLvl);
      if (p.defense < max) {
        p.defense = Math.min(max, p.defense + p.fortLvl * FORT_DEF_REGEN);
      }
    }
  }
  io.emit('state', getStatePayload());
}, TICK_RATE);

// ── AI боты (тик каждые 5 сек) ──────────────────────────
setInterval(() => {
  botTick();
}, BOT_TICK_INTERVAL);

// ── Тик миссий (50мс — плавное движение) ─────────────────
setInterval(() => {
  const dt = MISSION_TICK / 1000;
  for (let i = missions.length - 1; i >= 0; i--) {
    const m = missions[i];
    const dx = m.tx - m.x;
    const dy = m.ty - m.y;
    const d = Math.sqrt(dx * dx + dy * dy);

    if (d < m.speed * dt + 5) {
      // Прибыл
      if (m.type === 'attack') {
        resolveAttack(m);
      } else if (m.type === 'mine') {
        resolveMining(m);
      } else if (m.type === 'return') {
        resolveReturn(m);
      }
      missions.splice(i, 1);
    } else {
      // Двигаем
      m.x += (dx / d) * m.speed * dt;
      m.y += (dy / d) * m.speed * dt;
    }
  }
  // Рассылаем позиции миссий (всегда, чтобы клиент очистил массив при пустом списке)
  io.emit('missions', getMissionsPublic());
}, MISSION_TICK);

// ── Разрешение атаки при прибытии ─────────────────────────
function getAllianceDefensePower(targetNick) {
  const target = players[targetNick];
  if (!target) return 0;
  const allianceName = target.allianceName || null;
  if (!allianceName) return (target.fleet + target.defense) * ATTACK_THRESHOLD;
  let total = 0;
  for (const nick in players) {
    const p = players[nick];
    if (p.online && (p.allianceName || null) === allianceName) {
      total += (p.fleet + p.defense) * ATTACK_THRESHOLD;
    }
  }
  return total;
}

function resolveAttack(m) {
  const attacker = players[m.owner];
  const target = players[m.targetNick];
  if (!attacker || !target) return;

  // Если цель получила защиту (напр. респавн) — вернуть флот
  if (isProtected(target)) {
    attacker.fleet += m.fleetCount;
    persist(m.owner);
    io.emit('chat', { from: '⚔ бой', text: `Атака ${m.owner} на ${m.targetNick} отменена: цель под защитой` });
    io.emit('state', getStatePayload());
    return;
  }

  const milBonus = 1 + (attacker.militaryLvl * MIL_BONUS);
  const attackBase = m.fleetCount * milBonus;
  const defenseBase = getAllianceDefensePower(m.targetNick);

  // Рандомный разброс ±15%: близкие по силе армии могут побеждать друг друга
  // Но если разница огромная (10 vs 100), рандом не поможет
  const attackRoll = attackBase * (1 - COMBAT_RANDOM_SPREAD + Math.random() * COMBAT_RANDOM_SPREAD * 2);
  const defenseRoll = defenseBase * (1 - COMBAT_RANDOM_SPREAD + Math.random() * COMBAT_RANDOM_SPREAD * 2);
  const win = attackRoll > defenseRoll;

  // Соотношение сил — определяет потери
  const ratio = defenseBase > 0 ? attackBase / defenseBase : 100;

  if (win) {
    attacker.wins = (attacker.wins || 0) + 1;
    const stolenRes = Math.floor(target.res * 0.5);
    attacker.res += stolenRes;

    io.emit('explosion', { x: target.x, y: target.y, big: true });

    // Потери атакующего пропорциональны силе обороны
    // Чем сильнее оборона — тем больше потерь (от 10% до 90%)
    const lossRatio = Math.min(0.9, Math.max(0.1, (1 / ratio) * 0.7));
    const surviving = Math.max(1, Math.floor(m.fleetCount * (1 - lossRatio)));
    const lost = m.fleetCount - surviving;
    attacker.fleet += surviving;

    io.emit('chat', { from: '⚔ бой', text: `${m.owner} уничтожил планету ${m.targetNick}! Украдено ${stolenRes} res, потеряно ${lost} кораблей` });

    // Уничтожаем планету цели — отправляем экран поражения
    const defeatData = {
      killedBy: m.owner,
      lostRes: target.res,
      hadLvl: target.lvl,
      hadFleet: target.fleet
    };

    // Убираем миссии цели
    for (let i = missions.length - 1; i >= 0; i--) {
      if (missions[i].owner === m.targetNick) missions.splice(i, 1);
    }

    // Удаляем игрока из мира и из Redis
    delete players[m.targetNick];
    removePersist(m.targetNick);

    // Отправляем defeated всем сокетам этого ника
    for (const [, s] of io.sockets.sockets) {
      if (s._currentNick === m.targetNick) {
        s.emit('defeated', defeatData);
        s._currentNick = null;
      }
    }
  } else {
    // Поражение атакующего — весь посланный флот теряется,
    // НО атакующий наносит пропорциональный урон обороне

    // Урон по флоту защитника: чем ближе силы, тем больше потерь
    const dmgRatio = Math.min(0.8, ratio * 0.5);
    const fleetDmg = Math.floor(target.fleet * dmgRatio);
    const defDmg = Math.floor(target.defense * dmgRatio * 0.6);

    target.fleet = Math.max(0, target.fleet - fleetDmg);
    target.defense = Math.max(0, target.defense - defDmg);
    persist(m.targetNick);

    io.emit('explosion', { x: m.x, y: m.y, big: false });
    const dmgMsg = (fleetDmg > 0 || defDmg > 0)
      ? ` Защитник потерял ${fleetDmg} кораблей и ${defDmg} щита.`
      : '';
    io.emit('chat', { from: '⚔ бой', text: `${m.owner} атаковал ${m.targetNick} и проиграл! Флот уничтожен.${dmgMsg}` });
  }
  persist(m.owner);

  io.emit('state', getStatePayload());
}

// ── Разрешение добычи ─────────────────────────────────────
function resolveMining(m) {
  const asteroid = asteroids.find(a => a.id === m.asteroidId && a.alive);
  if (!asteroid) {
    // Астероид уже собран — шахтёр возвращается с пустыми руками
    missions.push({
      type: 'return',
      owner: m.owner,
      x: m.x, y: m.y,
      tx: players[m.owner]?.x || m.x,
      ty: players[m.owner]?.y || m.y,
      speed: MINER_SPEED,
      cargo: 0
    });
    return;
  }

  const cargo = asteroid.res;
  asteroid.alive = false;

  // Шахтёр летит обратно с грузом
  const owner = players[m.owner];
  if (owner) {
    missions.push({
      type: 'return',
      owner: m.owner,
      x: m.x, y: m.y,
      tx: owner.x, ty: owner.y,
      speed: MINER_SPEED,
      cargo
    });
  }

  io.emit('chat', { from: '⛏', text: `${m.owner} добыл астероид (+${cargo} res в пути)` });
}

// ── Возврат шахтёра ───────────────────────────────────────
function resolveReturn(m) {
  const owner = players[m.owner];
  if (owner && m.cargo > 0) {
    owner.res += m.cargo;
    persist(m.owner);
    io.emit('chat', { from: '⛏', text: `Шахтёр ${m.owner} вернулся с ${m.cargo} res` });
  }
  // Шахтёр-единица fleet не возвращается (потрачена)
}

// ── Публичное состояние ───────────────────────────────────
function getPublicState() {
  const list = [];
  for (const nick in players) {
    const p = players[nick];
    list.push({
      nick: p.nick,
      x: p.x, y: p.y,
      lvl: p.lvl,
      res: p.res,
      fleet: p.fleet,
      defense: Math.floor(p.defense),
      militaryLvl: p.militaryLvl,
      fortLvl: p.fortLvl,
      lastAttack: p.lastAttack,
      online: p.online,
      color: p.color,
      allianceName: p.allianceName || null,
      wins: p.wins || 0,
      spawnedAt: p.spawnedAt || 0,
      isProtected: isProtected(p),
      isBot: p.isBot || false
    });
  }
  return list;
}

function getStatePayload() {
  return { list: getPublicState(), mapW: getMapW(), mapH: getMapH() };
}

function getMissionsPublic() {
  return missions.map(m => ({
    type: m.type,
    owner: m.owner,
    x: m.x, y: m.y,
    tx: m.tx, ty: m.ty,
    targetNick: m.targetNick || null,
    cargo: m.cargo || 0,
    fleetCount: m.fleetCount || 0
  }));
}

// ── Socket.io ─────────────────────────────────────────────
io.on('connection', (socket) => {
  let currentNick = null;

  // Геттер/сеттер для синхронизации _currentNick на сокете
  function setNick(nick) {
    currentNick = nick;
    socket._currentNick = nick;
  }

  // Регистрация / восстановление
  socket.on('join', (nick, callback) => {
    if (typeof nick !== 'string') return callback({ ok: false, msg: 'Неверный ник' });
    nick = nick.trim();
    if (nick.length < NICK_MIN || nick.length > NICK_MAX) {
      return callback({ ok: false, msg: `Ник: ${NICK_MIN}–${NICK_MAX} символов` });
    }

    if (players[nick]) {
      players[nick].online = true;
      players[nick].last_seen = Date.now();
      setNick(nick);
      callback({ ok: true, restored: true, player: players[nick] });
    } else {
      players[nick] = createPlayer(nick);
      setNick(nick);
      callback({ ok: true, restored: false, player: players[nick] });
    }
    persist(nick);

    // Отправить текущее состояние подключившемуся
    socket.emit('state', getStatePayload());
    socket.emit('missions', getMissionsPublic());
    socket.emit('asteroids', asteroids.filter(a => a.alive));

    io.emit('state', getStatePayload());
    io.emit('chat', { from: '⚙ система', text: `${nick} присоединился` });

    // Управление ботами при изменении числа игроков
    manageBots();
  });

  // ── Улучшение Economy (lvl) ─────────────────────────────
  socket.on('upgradeLvl', () => {
    if (!currentNick || !players[currentNick]) return;
    const p = players[currentNick];
    const cost = lvlUpCost(p.lvl);
    if (p.res >= cost) {
      p.res -= cost;
      p.lvl += 1;
      persist(currentNick);
      socket.emit('upgraded', { type: 'lvl', lvl: p.lvl, res: p.res });
    }
  });

  // ── Улучшение Military ──────────────────────────────────
  socket.on('upgradeMilitary', () => {
    if (!currentNick || !players[currentNick]) return;
    const p = players[currentNick];
    const cost = milUpCost(p.militaryLvl);
    if (p.res >= cost) {
      p.res -= cost;
      p.militaryLvl += 1;
      persist(currentNick);
      socket.emit('upgraded', { type: 'military', militaryLvl: p.militaryLvl, res: p.res });
    }
  });

  // ── Улучшение Fortification ─────────────────────────────
  socket.on('upgradeFort', () => {
    if (!currentNick || !players[currentNick]) return;
    const p = players[currentNick];
    const cost = fortUpCost(p.fortLvl);
    if (p.res >= cost) {
      p.res -= cost;
      p.fortLvl += 1;
      persist(currentNick);
      socket.emit('upgraded', { type: 'fort', fortLvl: p.fortLvl, res: p.res });
    }
  });

  // ── Покупка флота ───────────────────────────────────────
  socket.on('buyFleet', (amount) => {
    if (!currentNick || !players[currentNick]) return;
    amount = Math.max(1, Math.floor(Number(amount) || 1));
    const p = players[currentNick];
    // Цена считается от эффективного флота (включая корабли в миссиях)
    const effectiveFleet = getEffectiveFleet(currentNick);
    const cost = fleetBuyCost(effectiveFleet, amount);
    if (p.res >= cost) {
      p.res -= cost;
      p.fleet += amount;
      persist(currentNick);
      socket.emit('fleetBought', { fleet: p.fleet, res: p.res });
    }
  });

  // ── Покупка защиты ──────────────────────────────────────
  socket.on('buyDefense', (amount) => {
    if (!currentNick || !players[currentNick]) return;
    amount = Math.max(1, Math.floor(Number(amount) || 1));
    const p = players[currentNick];
    const max = maxDefense(p.fortLvl);
    const canBuy = Math.min(amount, Math.floor(max - p.defense));
    if (canBuy <= 0) return socket.emit('info', 'Максимум defense для текущего уровня Fort');
    const cost = defenseBuyCost(Math.floor(p.defense), canBuy);
    if (p.res >= cost) {
      p.res -= cost;
      p.defense += canBuy;
      persist(currentNick);
      socket.emit('defenseBought', { defense: Math.floor(p.defense), res: p.res });
    }
  });

  // ── Альянсы ────────────────────────────────────────────
  socket.on('createAlliance', (name, callback) => {
    if (!currentNick || !players[currentNick]) return callback?.({ ok: false, msg: 'Нет игрока' });
    const n = typeof name === 'string' ? name.trim() : '';
    if (n.length < ALLIANCE_NAME_MIN || n.length > ALLIANCE_NAME_MAX) {
      return callback?.({ ok: false, msg: `Название альянса: ${ALLIANCE_NAME_MIN}–${ALLIANCE_NAME_MAX} символов` });
    }
    players[currentNick].allianceName = n;
    persist(currentNick);
    callback?.({ ok: true, allianceName: n });
    io.emit('state', getStatePayload());
    io.emit('chat', { from: '🤝', text: `${currentNick} создал альянс «${n}»` });
  });

  socket.on('joinAlliance', (name, callback) => {
    if (!currentNick || !players[currentNick]) return callback?.({ ok: false, msg: 'Нет игрока' });
    const n = typeof name === 'string' ? name.trim() : '';
    if (n.length < ALLIANCE_NAME_MIN || n.length > ALLIANCE_NAME_MAX) {
      return callback?.({ ok: false, msg: `Название: ${ALLIANCE_NAME_MIN}–${ALLIANCE_NAME_MAX} символов` });
    }
    players[currentNick].allianceName = n;
    persist(currentNick);
    callback?.({ ok: true, allianceName: n });
    io.emit('state', getStatePayload());
    io.emit('chat', { from: '🤝', text: `${currentNick} вступил в альянс «${n}»` });
  });

  socket.on('leaveAlliance', (callback) => {
    if (!currentNick || !players[currentNick]) return callback?.({ ok: false });
    players[currentNick].allianceName = null;
    persist(currentNick);
    callback?.({ ok: true });
    io.emit('state', getStatePayload());
  });

  // ── Торговля ───────────────────────────────────────────
  socket.on('trade', (data, callback) => {
    if (!currentNick || !players[currentNick]) return callback?.({ ok: false, msg: 'Нет игрока' });
    const toNick = typeof data === 'object' && data?.to ? String(data.to).trim() : '';
    const amount = Math.floor(Number(data?.amount) || 0);
    if (!toNick || !players[toNick]) return callback?.({ ok: false, msg: 'Игрок не найден' });
    if (toNick === currentNick) return callback?.({ ok: false, msg: 'Нельзя отправить себе' });
    if (amount < 1) return callback?.({ ok: false, msg: 'Укажите сумму > 0' });
    const from = players[currentNick];
    if (from.res < amount) return callback?.({ ok: false, msg: 'Недостаточно ресурсов' });
    from.res -= amount;
    players[toNick].res += amount;
    persist(currentNick);
    persist(toNick);
    callback?.({ ok: true, res: from.res });
    io.emit('state', getStatePayload());
    io.emit('chat', { from: '📦', text: `${currentNick} передал ${amount} res игроку ${toNick}` });
  });

  // ── Атака (отправка флота) ──────────────────────────────
  socket.on('attack', (data) => {
    if (!currentNick || !players[currentNick]) return;
    const targetNick = typeof data === 'string' ? data : data?.target;
    const sendCount = typeof data === 'object' ? Math.floor(Number(data.count) || 0) : 0;

    if (typeof targetNick !== 'string' || !players[targetNick]) return;
    if (targetNick === currentNick) return;

    // Проверка защиты новичка
    if (isProtected(players[targetNick])) {
      return socket.emit('attackResult', { ok: false, msg: 'Игрок под защитой новичка' });
    }

    const attacker = players[currentNick];

    // Кулдаун
    const now = Date.now();
    if (now - attacker.lastAttack < ATTACK_COOLDOWN) {
      const remain = Math.ceil((ATTACK_COOLDOWN - (now - attacker.lastAttack)) / 1000);
      return socket.emit('attackResult', { ok: false, msg: `Кулдаун: ${remain} сек` });
    }

    // Сколько флота отправляем
    const fleetToSend = sendCount > 0 ? Math.min(sendCount, attacker.fleet) : attacker.fleet;
    if (fleetToSend <= 0) {
      return socket.emit('attackResult', { ok: false, msg: 'Нет флота для атаки' });
    }

    const target = players[targetNick];
    attacker.fleet -= fleetToSend;
    attacker.lastAttack = now;

    // Создаём миссию
    const speed = FLEET_SPEED * (1 + attacker.militaryLvl * 0.1);
    missions.push({
      type: 'attack',
      owner: currentNick,
      targetNick,
      fleetCount: fleetToSend,
      x: attacker.x, y: attacker.y,
      tx: target.x, ty: target.y,
      speed
    });

    const d = dist(attacker.x, attacker.y, target.x, target.y);
    const eta = Math.ceil(d / speed);

    persist(currentNick);
    socket.emit('attackResult', { ok: true, launched: true, fleetSent: fleetToSend, eta });
    io.emit('chat', { from: '⚔ бой', text: `${currentNick} отправил ${fleetToSend} кораблей к ${targetNick} (ETA ~${eta} сек)` });
    io.emit('state', getStatePayload());
  });

  // ── Отправить шахтёра на астероид ───────────────────────
  socket.on('mine', (asteroidId) => {
    if (!currentNick || !players[currentNick]) return;
    const p = players[currentNick];
    if (p.fleet < 1) return socket.emit('info', 'Нужен хотя бы 1 корабль для добычи');

    const asteroid = asteroids.find(a => a.id === asteroidId && a.alive);
    if (!asteroid) return socket.emit('info', 'Астероид уже собран');

    p.fleet -= 1;

    missions.push({
      type: 'mine',
      owner: currentNick,
      asteroidId,
      x: p.x, y: p.y,
      tx: asteroid.x, ty: asteroid.y,
      speed: MINER_SPEED
    });

    persist(currentNick);
    socket.emit('minerSent', { fleet: p.fleet, asteroidId });
    io.emit('state', getStatePayload());
  });

  // ── Самоуничтожение ─────────────────────────────────────
  socket.on('selfDestruct', () => {
    if (!currentNick || !players[currentNick]) return;
    const nick = currentNick;
    io.emit('explosion', { x: players[nick].x, y: players[nick].y, big: true });
    io.emit('chat', { from: '💥', text: `${nick} самоуничтожился` });
    // Удалить миссии этого игрока
    for (let i = missions.length - 1; i >= 0; i--) {
      if (missions[i].owner === nick) missions.splice(i, 1);
    }
    delete players[nick];
    removePersist(nick);
    setNick(null);
    socket.emit('destroyed');
    io.emit('state', getStatePayload());
  });

  // ── Отключение ──────────────────────────────────────────
  socket.on('disconnect', () => {
    if (currentNick && players[currentNick]) {
      players[currentNick].online = false;
      players[currentNick].last_seen = Date.now();
      persist(currentNick);
      io.emit('state', getStatePayload());

      // Управление ботами при изменении числа игроков
      manageBots();
    }
  });
});

// ── Рассылка астероидов (каждые 2 сек) ────────────────────
setInterval(() => {
  io.emit('asteroids', asteroids.filter(a => a.alive));
}, 2000);

// ── Запуск ────────────────────────────────────────────────
async function start() {
  try {
    const loaded = await loadPlayersFromRedis();
    Object.assign(players, loaded);
    console.log(`📦 Загружено игроков из Redis: ${Object.keys(loaded).length}`);
  } catch (e) {
    console.warn('Redis load failed, starting with empty players:', e.message);
  }

  // Инициализация ботов при старте
  manageBots();

  const PORT = process.env.PORT || 3000;
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`🪐 Space Chaos v0.7 запущен на http://localhost:${PORT}`);
  });
}
start();

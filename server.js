/**
 * TANKI.IO — WebSocket Multiplayer Server
 * Авторитарный сервер: хранит арену, считает физику, рассылает состояние
 * Запуск:  node server.js  (или через screen для постоянной работы)
 */

const WebSocket = require('ws');
const http = require('http');

// ==================== КОНФИГ ====================
const CONFIG = {
  PORT: 3000,                  // порт, который нужно открыть в фаерволе sweb.ru
  ARENA_SIZE: 5000,
  TICK_RATE: 30,               // обновлений в секунду — выше для плавности
  PHYSICS_RATE: 60,            // физика в секунду
  BOT_COUNT: 10,               // минимальное количество ботов (если игроков мало)
  NPC_COUNT: 70,
  MAX_PLAYERS: 50,
  PLAYER_SPEED: 3.4,
  BULLET_LIFE: 95,
  REGEN_DELAY: 240,
  REGEN_RATE: 0.6,
};

const NPC_TYPES = {
  square:   { health: 15,  power: 5,  damage: 5,  speed: 0.25, color: '#ffe066', size: 18, sides: 4 },
  triangle: { health: 40,  power: 12, damage: 12, speed: 0.55, color: '#ff6677', size: 22, sides: 3 },
  pentagon: { health: 140, power: 32, damage: 22, speed: 0.12, color: '#5588ff', size: 32, sides: 5 },
  drone:    { health: 28,  power: 16, damage: 14, speed: 1.3,  color: '#aa66ff', size: 14, sides: 3 },
};

const BOT_NAMES = [
  'PanzerKiller','IronFist','ThunderBolt','SteelStorm','BlitzKrieg','TankMaster',
  'WarMachine','DarkKnight','ShadowHunter','RedBaron','IronClad','BattleAxe',
  'FireStorm','ColdSteel','GhostRider','VenomShot','SniperX','RapidFire',
  'HeavyMetal','WarLord','SteelFang','Nightmare','Crimson','Vortex',
  'Reaper','Striker','Phantom','TitanX','Predator','Annihilator',
];

const TANK_COLORS = [
  '#ff5566','#55ff77','#ffcc44','#ff66ff','#44ffff','#ffaa44',
  '#aa66ff','#44ffaa','#ff88aa','#88aaff','#aaff66','#66aaff',
];

// ==================== УТИЛИТЫ ====================
const rand = (a, b) => Math.random() * (b - a) + a;
const randInt = (a, b) => Math.floor(rand(a, b + 1));
const randPick = arr => arr[randInt(0, arr.length - 1)];
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const lerp = (a, b, t) => a + (b - a) * t;
const angleBetween = (from, to) => Math.atan2(to.y - from.y, to.x - from.x);
const normAngle = a => { while (a > Math.PI) a -= 2*Math.PI; while (a < -Math.PI) a += 2*Math.PI; return a; };
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// ==================== СОСТОЯНИЕ ИГРЫ ====================
const state = {
  tanks: [],   // все танки (игроки + боты)
  npcs: [],
  bullets: [],
  nextId: 1,
};

function nextId() { return state.nextId++; }

// ==================== КЛАСС TANK ====================
class Tank {
  constructor(x, y, name, color, isBot = false) {
    this.id = nextId();
    this.x = x; this.y = y;
    this.vx = 0; this.vy = 0;
    this.angle = 0;
    this.turretAngle = 0;
    this.name = name;
    this.color = color;
    this.isBot = isBot;
    this.health = 100;
    this.maxHealth = 100;
    this.power = 0;
    this.kills = 0;
    this.shootCooldown = 0;
    this.regenTimer = 0;
    this.dead = false;
    this.respawnTimer = 0;
    this.invincible = 60;
    this.flashTimer = 0;
    // Управление (от клиента)
    this.input = { mx: 0, my: 0, turretAngle: 0, shoot: false };
    // AI (для ботов)
    this.aiState = 'wander';
    this.aiTimer = 0;
    this.wanderAngle = rand(0, Math.PI * 2);
    this.strafeDir = Math.random() < 0.5 ? 1 : -1;
    this.ws = null; // websocket для реальных игроков
  }

  get radius() { return 22 + Math.min(28, this.power * 0.035); }
  get speed() { return CONFIG.PLAYER_SPEED * (1 - Math.min(0.35, this.power * 0.0007)); }
  get bulletDamage() { return 10 + this.power * 0.09; }
  get bulletSize() { return 5 + Math.min(8, this.power * 0.011); }
  get shootRate() { return Math.max(9, 24 - this.power * 0.011); }
  get bulletSpeed() { return 9 + Math.min(5, this.power * 0.006); }

  shoot() {
    if (this.shootCooldown > 0 || this.dead) return;
    this.shootCooldown = this.shootRate;
    const bx = this.x + Math.cos(this.turretAngle) * (this.radius + 14);
    const by = this.y + Math.sin(this.turretAngle) * (this.radius + 14);
    state.bullets.push({
      id: nextId(),
      x: bx, y: by,
      vx: Math.cos(this.turretAngle) * this.bulletSpeed,
      vy: Math.sin(this.turretAngle) * this.bulletSpeed,
      damage: this.bulletDamage,
      ownerId: this.id,
      size: this.bulletSize,
      color: this.color,
      life: CONFIG.BULLET_LIFE,
    });
    // Отдача
    this.vx -= Math.cos(this.turretAngle) * 0.3;
    this.vy -= Math.sin(this.turretAngle) * 0.3;
  }

  takeDamage(amount, killer) {
    if (this.invincible > 0 || this.dead) return;
    this.health -= amount;
    this.regenTimer = 0;
    this.flashTimer = 6;
    if (this.health <= 0) this.die(killer);
  }

  die(killer) {
    this.dead = true;
    this.health = 0;
    if (killer && killer !== this) {
      const isPvP = !killer.isBot || !this.isBot;
      const powerGain = Math.floor(50 + this.power * (isPvP ? 0.18 : 0.12));
      killer.power += powerGain;
      killer.kills++;
      killer.health = Math.min(killer.maxHealth, killer.health + 35);
      broadcastKill(killer.name, this.name, isPvP, killer.id, this.id);
    }
    // СМЕРТЬ = 0 МОЩНОСТИ (для всех — и игроков, и ботов)
    this.power = 0;
    this.respawnTimer = 200;
  }

  respawn() {
    let x, y, tries = 0;
    do {
      x = rand(300, CONFIG.ARENA_SIZE - 300);
      y = rand(300, CONFIG.ARENA_SIZE - 300);
      tries++;
    } while (tries < 25 && state.tanks.some(t => !t.dead && t !== this && dist({x,y}, t) < 500));
    this.x = x; this.y = y;
    this.vx = 0; this.vy = 0;
    this.maxHealth = 100 + this.power * 0.3;
    this.health = this.maxHealth;
    this.dead = false;
    this.invincible = 100;
    this.shootCooldown = 0;
    this.regenTimer = 0;
  }

  update() {
    if (this.dead) {
      this.respawnTimer--;
      // Игроки возрождаются по запросу (через /respawn), боты — автоматически
      if (this.isBot && this.respawnTimer <= 0) this.respawn();
      return;
    }
    if (this.invincible > 0) this.invincible--;
    if (this.shootCooldown > 0) this.shootCooldown--;
    if (this.flashTimer > 0) this.flashTimer--;
    this.regenTimer++;
    if (this.regenTimer > CONFIG.REGEN_DELAY && this.health < this.maxHealth) {
      this.health = Math.min(this.maxHealth, this.health + CONFIG.REGEN_RATE);
    }
    this.maxHealth = 100 + this.power * 0.3;

    // Для реальных игроков — движение на основе input (mx, my)
    // Для ботов — vx/vy уже установлены в updateBotAI()
    if (!this.isBot) {
      const inputMag = Math.hypot(this.input.mx, this.input.my);
      if (inputMag > 0.05) {
        const targetVx = this.input.mx * this.speed;
        const targetVy = this.input.my * this.speed;
        this.vx = lerp(this.vx, targetVx, 0.25);
        this.vy = lerp(this.vy, targetVy, 0.25);
        // Поворачиваем корпус в направлении движения
        const targetAngle = Math.atan2(this.input.my, this.input.mx);
        let diff = normAngle(targetAngle - this.angle);
        this.angle += diff * 0.2;
      } else {
        // Затухание когда нет ввода
        this.vx *= 0.85;
        this.vy *= 0.85;
      }
      // Башня сразу следует за прицелом (без интерполяции — для отзывчивости)
      this.turretAngle = this.input.turretAngle;
    }

    this.x += this.vx;
    this.y += this.vy;
    // Затухание только для ботов (для игроков уже применено выше)
    if (this.isBot) {
      this.vx *= 0.92;
      this.vy *= 0.92;
    }

    const r = this.radius;
    if (this.x < r) { this.x = r; this.vx = Math.abs(this.vx) * 0.5; }
    if (this.x > CONFIG.ARENA_SIZE - r) { this.x = CONFIG.ARENA_SIZE - r; this.vx = -Math.abs(this.vx) * 0.5; }
    if (this.y < r) { this.y = r; this.vy = Math.abs(this.vy) * 0.5; }
    if (this.y > CONFIG.ARENA_SIZE - r) { this.y = CONFIG.ARENA_SIZE - r; this.vy = -Math.abs(this.vy) * 0.5; }

    if (Math.abs(this.vx) > 0.2 || Math.abs(this.vy) > 0.2) {
      const targetAngle = Math.atan2(this.vy, this.vx);
      let diff = normAngle(targetAngle - this.angle);
      this.angle += diff * 0.15;
    }

    if (this.input.shoot) this.shoot();
  }
}

// ==================== AI ДЛЯ БОТОВ ====================
function updateBotAI(bot) {
  if (bot.dead) return;
  bot.aiTimer--;

  let nearestTank = null, nearestTankDist = 700;
  let weakestNearby = null, weakestPower = Infinity;
  let nearestNPC = null, nearestNPCDist = 450;

  for (const t of state.tanks) {
    if (t === bot || t.dead || t.invincible > 30) continue;
    const d = dist(bot, t);
    if (d < nearestTankDist) { nearestTankDist = d; nearestTank = t; }
    if (d < 500 && t.power < weakestPower) { weakestPower = t.power; weakestNearby = t; }
  }
  for (const n of state.npcs) {
    if (n.dead) continue;
    const d = dist(bot, n);
    if (d < nearestNPCDist) { nearestNPCDist = d; nearestNPC = n; }
  }

  if (bot.health < bot.maxHealth * 0.28 && nearestTank && nearestTankDist < 500) {
    bot.aiState = 'flee';
  } else if (weakestNearby && weakestPower < bot.power * 0.6 && nearestTankDist < 550) {
    bot.aiState = 'hunt';
  } else if (nearestTank && nearestTankDist < 280) {
    bot.aiState = 'fight';
  } else if (nearestNPC) {
    bot.aiState = 'collect';
  } else {
    bot.aiState = 'wander';
  }

  let moveX = 0, moveY = 0, aimX = bot.x, aimY = bot.y, shoot = false;

  switch (bot.aiState) {
    case 'wander':
      if (bot.aiTimer <= 0) { bot.wanderAngle = rand(0, Math.PI * 2); bot.aiTimer = randInt(80, 200); }
      moveX = Math.cos(bot.wanderAngle); moveY = Math.sin(bot.wanderAngle);
      aimX = bot.x + Math.cos(bot.wanderAngle) * 100;
      aimY = bot.y + Math.sin(bot.wanderAngle) * 100;
      break;
    case 'collect':
      if (nearestNPC) {
        aimX = nearestNPC.x; aimY = nearestNPC.y;
        const d = dist(bot, nearestNPC);
        if (d > 120) { moveX = nearestNPC.x - bot.x; moveY = nearestNPC.y - bot.y; }
        shoot = d < 450;
      }
      break;
    case 'hunt':
    case 'fight': {
      const target = weakestNearby || nearestTank;
      if (target) {
        const d = dist(bot, target);
        const ang = angleBetween(bot, target);
        const strafeAng = ang + (Math.PI/2) * bot.strafeDir;
        if (bot.aiTimer % 120 === 0) bot.strafeDir *= -1;
        const desired = bot.aiState === 'hunt' ? 280 : 220;
        if (d > desired + 60) { moveX = Math.cos(ang)*0.8 + Math.cos(strafeAng)*0.4; moveY = Math.sin(ang)*0.8 + Math.sin(strafeAng)*0.4; }
        else if (d < desired - 60) { moveX = -Math.cos(ang)*0.7 + Math.cos(strafeAng)*0.5; moveY = -Math.sin(ang)*0.7 + Math.sin(strafeAng)*0.5; }
        else { moveX = Math.cos(strafeAng); moveY = Math.sin(strafeAng); }
        const ttime = d / bot.bulletSpeed;
        aimX = target.x + target.vx * ttime;
        aimY = target.y + target.vy * ttime;
        shoot = d < 550;
      }
      break;
    }
    case 'flee':
      if (nearestTank) {
        const ang = angleBetween(bot, nearestTank) + Math.PI;
        moveX = Math.cos(ang); moveY = Math.sin(ang);
        aimX = nearestTank.x; aimY = nearestTank.y;
        shoot = nearestTankDist < 350;
      }
      break;
  }

  const mag = Math.hypot(moveX, moveY);
  if (mag > 0) { moveX /= mag; moveY /= mag; }
  bot.vx = lerp(bot.vx, moveX * bot.speed, 0.12);
  bot.vy = lerp(bot.vy, moveY * bot.speed, 0.12);
  const targetAngle = Math.atan2(aimY - bot.y, aimX - bot.x);
  let diff = normAngle(targetAngle - bot.turretAngle);
  bot.turretAngle += diff * 0.18;
  bot.input.shoot = shoot && Math.abs(diff) < 0.25;

  const margin = 250;
  if (bot.x < margin || bot.x > CONFIG.ARENA_SIZE - margin ||
      bot.y < margin || bot.y > CONFIG.ARENA_SIZE - margin) {
    bot.wanderAngle = angleBetween(bot, {x: CONFIG.ARENA_SIZE/2, y: CONFIG.ARENA_SIZE/2});
    bot.aiState = 'wander';
  }
}

// ==================== NPC ====================
function spawnNPC() {
  const r = Math.random();
  let type;
  if (r < 0.55) type = 'square';
  else if (r < 0.80) type = 'triangle';
  else if (r < 0.92) type = 'drone';
  else type = 'pentagon';
  let x, y, tries = 0;
  // Спавним ПОЗАДИ видимой зоны игроков (чтобы не появлялись резко на экране)
  do {
    x = rand(150, CONFIG.ARENA_SIZE - 150);
    y = rand(150, CONFIG.ARENA_SIZE - 150);
    tries++;
  } while (tries < 15 && (
    state.tanks.some(t => !t.dead && dist({x,y}, t) < 500) ||
    state.npcs.some(n => !n.dead && dist({x,y}, n) < 80)
  ));
  const s = NPC_TYPES[type];
  state.npcs.push({
    id: nextId(),
    x, y, type,
    health: s.health, maxHealth: s.health,
    power: s.power, damage: s.damage,
    speed: s.speed, color: s.color, size: s.size, sides: s.sides,
    angle: rand(0, Math.PI*2), rotSpeed: rand(-0.025, 0.025),
    vx: rand(-0.5, 0.5), vy: rand(-0.5, 0.5),
    dead: false, flashTimer: 0,
    aggro: false, aggroTargetId: null,
    spawnTime: Date.now(),  // для анимации появления
  });
}

function updateNPC(n) {
  if (n.dead) return;
  if (n.flashTimer > 0) n.flashTimer--;
  n.angle += n.rotSpeed;
  let target = null;
  if (n.aggro && n.aggroTargetId != null) {
    target = state.tanks.find(t => t.id === n.aggroTargetId && !t.dead);
    if (!target) { n.aggro = false; n.aggroTargetId = null; }
  }
  if (target) {
    const ang = angleBetween(n, target);
    n.vx = lerp(n.vx, Math.cos(ang) * n.speed * 2.2, 0.05);
    n.vy = lerp(n.vy, Math.sin(ang) * n.speed * 2.2, 0.05);
  } else {
    n.vx += rand(-0.1, 0.1);
    n.vy += rand(-0.1, 0.1);
    n.vx = clamp(n.vx, -n.speed, n.speed);
    n.vy = clamp(n.vy, -n.speed, n.speed);
  }
  n.x += n.vx; n.y += n.vy;
  if (n.x < n.size) { n.vx = Math.abs(n.vx); n.x = n.size; }
  if (n.x > CONFIG.ARENA_SIZE - n.size) { n.vx = -Math.abs(n.vx); n.x = CONFIG.ARENA_SIZE - n.size; }
  if (n.y < n.size) { n.vy = Math.abs(n.vy); n.y = n.size; }
  if (n.y > CONFIG.ARENA_SIZE - n.size) { n.vy = -Math.abs(n.vy); n.y = CONFIG.ARENA_SIZE - n.size; }
}

// ==================== СТОЛКНОВЕНИЯ (отскок) ====================
// Танки сталкиваются с NPC и другими танками — отскакивают назад
function resolveCollisions() {
  // 1. Танк ↔ NPC
  for (const t of state.tanks) {
    if (t.dead) continue;
    for (const n of state.npcs) {
      if (n.dead) continue;
      const dx = t.x - n.x;
      const dy = t.y - n.y;
      const d = Math.hypot(dx, dy);
      const minDist = t.radius + n.size;
      if (d < minDist && d > 0.001) {
        // Нормализованный вектор от NPC к танку
        const nx = dx / d;
        const ny = dy / d;
        // overlap — насколько они проникли друг в друга
        const overlap = minDist - d;
        // Танк тяжелее NPC (танк ~radius 22+, NPC 14-32) — но танк "катится" по NPC
        // Отталкиваем танк меньше, NPC больше (танк как бы "сдвигает" NPC)
        const tankMass = t.radius;
        const npcMass = n.size;
        const totalMass = tankMass + npcMass;
        // Раздвигаем их
        t.x += nx * overlap * (npcMass / totalMass);
        t.y += ny * overlap * (npcMass / totalMass);
        n.x -= nx * overlap * (tankMass / totalMass);
        n.y -= ny * overlap * (tankMass / totalMass);
        // Отскок — добавляем скорость вдоль нормали
        const bounceForce = 2.5;
        t.vx += nx * bounceForce * (npcMass / totalMass);
        t.vy += ny * bounceForce * (npcMass / totalMass);
        n.vx -= nx * bounceForce * (tankMass / totalMass);
        n.vy -= ny * bounceForce * (tankMass / totalMass);
        // NPC становится агрессивным при ударе
        n.aggro = true;
        n.aggroTargetId = t.id;
      }
    }
  }

  // 2. Танк ↔ Танк
  for (let i = 0; i < state.tanks.length; i++) {
    const a = state.tanks[i];
    if (a.dead) continue;
    for (let j = i + 1; j < state.tanks.length; j++) {
      const b = state.tanks[j];
      if (b.dead) continue;
      // Не сталкиваем invincible танки (только что возродились)
      if (a.invincible > 0 || b.invincible > 0) continue;
      const dx = a.x - b.x;
      const dy = a.y - b.y;
      const d = Math.hypot(dx, dy);
      const minDist = a.radius + b.radius;
      if (d < minDist && d > 0.001) {
        const nx = dx / d;
        const ny = dy / d;
        const overlap = minDist - d;
        // Масса пропорциональна размеру (мощности)
        const massA = a.radius;
        const massB = b.radius;
        const totalMass = massA + massB;
        // Раздвигаем
        a.x += nx * overlap * (massB / totalMass);
        a.y += ny * overlap * (massB / totalMass);
        b.x -= nx * overlap * (massA / totalMass);
        b.y -= ny * overlap * (massA / totalMass);
        // Отскок — сильнее чем с NPC (реальный удар танков)
        const bounceForce = 4;
        a.vx += nx * bounceForce * (massB / totalMass);
        a.vy += ny * bounceForce * (massB / totalMass);
        b.vx -= nx * bounceForce * (massA / totalMass);
        b.vy -= ny * bounceForce * (massA / totalMass);
        // Лёгкий урон при таране (опционально — небольшое повреждение)
        const ramDamage = 3;
        a.takeDamage(ramDamage, b);
        b.takeDamage(ramDamage, a);
      }
    }
  }
}

// ==================== ПУЛИ ====================
function updateBullet(b) {
  if (b.dead) return;
  b.x += b.vx; b.y += b.vy;
  b.life--;
  if (b.life <= 0 || b.x < 0 || b.x > CONFIG.ARENA_SIZE || b.y < 0 || b.y > CONFIG.ARENA_SIZE) {
    b.dead = true; return;
  }
  const owner = state.tanks.find(t => t.id === b.ownerId);
  for (const t of state.tanks) {
    if (t.id === b.ownerId || t.dead || t.invincible > 0) continue;
    if (dist(b, t) < t.radius + b.size) {
      t.takeDamage(b.damage, owner);
      b.dead = true; return;
    }
  }
  for (const n of state.npcs) {
    if (n.dead) continue;
    if (dist(b, n) < n.size + b.size) {
      n.health -= b.damage;
      n.flashTimer = 5;
      n.aggro = true; n.aggroTargetId = b.ownerId;
      if (n.health <= 0) {
        n.dead = true;
        if (owner) owner.power += n.power;
      }
      b.dead = true; return;
    }
  }
}

// ==================== ИНИЦИАЛИЗАЦИЯ ====================
function initGame() {
  state.tanks = [];
  state.npcs = [];
  state.bullets = [];
  state.nextId = 1;
  // Ботов не создаём — они спавнятся по 1 на каждого игрока
  for (let i = 0; i < CONFIG.NPC_COUNT; i++) spawnNPC();
  console.log(`[INIT] Арена создана: ${CONFIG.ARENA_SIZE}x${CONFIG.ARENA_SIZE}`);
  console.log(`[INIT] NPC: ${CONFIG.NPC_COUNT}. Ботов = игроков (динамически).`);
}

function spawnBot() {
  const name = randPick(BOT_NAMES) + randInt(1, 999);
  const color = randPick(TANK_COLORS);
  let x, y, tries = 0;
  do {
    x = rand(400, CONFIG.ARENA_SIZE - 400);
    y = rand(400, CONFIG.ARENA_SIZE - 400);
    tries++;
  } while (tries < 25 && state.tanks.some(t => !t.dead && dist({x,y}, t) < 500));
  const bot = new Tank(x, y, name, color, true);
  bot.power = randInt(0, 250);
  state.tanks.push(bot);
  return bot;
}

// ==================== СЕРВЕРНЫЙ ТИК ====================
let lastTick = Date.now();
function gameTick() {
  const now = Date.now();
  // Физика на 60 Гц (фиксированный шаг)
  for (const t of state.tanks) {
    if (t.isBot) updateBotAI(t);
    t.update();
  }
  for (const n of state.npcs) updateNPC(n);
  for (const b of state.bullets) updateBullet(b);

  // Столкновения (отскок) — после обновления позиций
  resolveCollisions();

  // Чистка
  state.npcs = state.npcs.filter(n => !n.dead);
  state.bullets = state.bullets.filter(b => !b.dead);
  // Спавн NPC — по 1 за тик (плавно, без лагов)
  if (state.npcs.length < CONFIG.NPC_COUNT) {
    spawnNPC();
  }

  // Возрождение ботов (парные — возрождаются всегда, как и игроки по запросу)
  for (const t of state.tanks) {
    if (t.isBot && t.dead && t.respawnTimer <= 0) {
      t.respawn();
    }
  }
}

// ==================== РАССЫЛКА СОСТОЯНИЯ ====================
function broadcastState() {
  // Оптимизация: для каждого игрока отправляем только то, что в его видимой области + запас
  const VIEW_MARGIN = 800; // запас за пределами экрана (для интерполяции)
  for (const player of state.tanks) {
    if (!player.ws || player.ws.readyState !== WebSocket.OPEN) continue;

    // Видимая область игрока (используем его последние известные координаты)
    const px = player.x, py = player.y;
    // Предполагаем экран ~1400x800 + запас
    const viewLeft = px - 700 - VIEW_MARGIN;
    const viewRight = px + 700 + VIEW_MARGIN;
    const viewTop = py - 400 - VIEW_MARGIN;
    const viewBottom = py + 400 + VIEW_MARGIN;

    // Фильтруем NPC по видимости
    const visibleNpcs = [];
    for (const n of state.npcs) {
      if (n.x >= viewLeft && n.x <= viewRight && n.y >= viewTop && n.y <= viewBottom) {
        visibleNpcs.push({
          id: n.id, x: n.x, y: n.y, type: n.type, color: n.color,
          size: n.size, sides: n.sides, angle: n.angle,
          health: n.health, maxHealth: n.maxHealth,
          spawnTime: n.spawnTime,
        });
      }
    }

    // Фильтруем пули по видимости
    const visibleBullets = [];
    for (const b of state.bullets) {
      if (b.x >= viewLeft && b.x <= viewRight && b.y >= viewTop && b.y <= viewBottom) {
        visibleBullets.push({
          id: b.id, x: b.x, y: b.y, color: b.color, size: b.size, ownerId: b.ownerId,
        });
      }
    }

    // Танки — отправляем все (их немного, и нужно видеть врагов на миникарте)
    const payload = {
      type: 'state',
      arena: CONFIG.ARENA_SIZE,
      tanks: state.tanks.map(t => ({
        id: t.id, x: t.x, y: t.y, angle: t.angle, turretAngle: t.turretAngle,
        name: t.name, color: t.color, health: t.health, maxHealth: t.maxHealth,
        power: Math.floor(t.power), kills: t.kills,
        dead: t.dead, invincible: t.invincible > 0,
        flash: t.flashTimer > 0, isBot: t.isBot,
      })),
      npcs: visibleNpcs,
      bullets: visibleBullets,
    };
    player.ws.send(JSON.stringify(payload));
  }
}

const killFeed = [];
function broadcastKill(killerName, victimName, isPvP, killerId, victimId) {
  const msg = {
    type: 'kill',
    killer: killerName, victim: victimName, isPvP,
    killerId, victimId,
    time: Date.now(),
  };
  killFeed.push(msg);
  if (killFeed.length > 10) killFeed.shift();
  const str = JSON.stringify(msg);
  for (const t of state.tanks) {
    if (t.ws && t.ws.readyState === WebSocket.OPEN) t.ws.send(str);
  }
}

// ==================== HTTP СЕРВЕР (для health-check) ====================
const server = http.createServer((req, res) => {
  // CORS заголовки — разрешаем запросы с любого домена (mm05.ru)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }
  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      players: state.tanks.filter(t => t.ws).length,
      bots: state.tanks.filter(t => t.isBot).length,
      npcs: state.npcs.length,
      uptime: process.uptime(),
    }));
    return;
  }
  res.writeHead(404); res.end('Not Found');
});

// ==================== WEBSOCKET ====================
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws, req) => {
  // Игрок подключился — создаём танк
  let playerName = 'Player' + randInt(1, 999);
  let playerColor = randPick(TANK_COLORS);

  // Парсим имя из URL query (?name=...)
  try {
    const url = new URL(req.url, 'http://localhost');
    const n = url.searchParams.get('name');
    if (n) playerName = String(n).substring(0, 16);
  } catch (e) {}

  let spawnX, spawnY, tries = 0;
  do {
    spawnX = rand(400, CONFIG.ARENA_SIZE - 400);
    spawnY = rand(400, CONFIG.ARENA_SIZE - 400);
    tries++;
  } while (tries < 25 && state.tanks.some(t => !t.dead && dist({x: spawnX, y: spawnY}, t) < 500));

  const tank = new Tank(spawnX, spawnY, playerName, playerColor, false);
  tank.ws = ws;
  state.tanks.push(tank);

  // Создаём парного бота (1 бот = 1 игрок)
  const pairedBot = spawnBot();
  tank.pairedBotId = pairedBot.id;
  pairedBot.pairedPlayerId = tank.id;

  console.log(`[JOIN] ${playerName} подключился. Всего игроков: ${state.tanks.filter(t => t.ws).length}. Спавн бота ${pairedBot.name}.`);

  // Отправляем игроку его ID
  ws.send(JSON.stringify({ type: 'welcome', id: tank.id, arena: CONFIG.ARENA_SIZE }));

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.type === 'input') {
        // Обновляем управление (движение применится в update())
        tank.input.mx = clamp(msg.mx || 0, -1, 1);
        tank.input.my = clamp(msg.my || 0, -1, 1);
        tank.input.turretAngle = msg.turretAngle || 0;
        tank.input.shoot = !!msg.shoot;
      } else if (msg.type === 'respawn') {
        if (tank.dead) tank.respawn();
      } else if (msg.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong', t: msg.t }));
      }
    } catch (e) {
      console.error('[ERROR] parse message:', e.message);
    }
  });

  ws.on('close', () => {
    console.log(`[LEAVE] ${playerName} отключился`);
    // Удаляем танк игрока сразу
    const playerIdx = state.tanks.indexOf(tank);
    if (playerIdx !== -1) state.tanks.splice(playerIdx, 1);
    // Удаляем парного бота
    if (tank.pairedBotId) {
      const botIdx = state.tanks.findIndex(t => t.id === tank.pairedBotId);
      if (botIdx !== -1) {
        const bot = state.tanks[botIdx];
        console.log(`[LEAVE] Удаляем парного бота ${bot.name}`);
        state.tanks.splice(botIdx, 1);
      }
    }
  });

  ws.on('error', () => {});
});

// ==================== ЗАПУСК ====================
initGame();

// Физика 60 Гц
setInterval(gameTick, 1000 / CONFIG.PHYSICS_RATE);
// Рассылка 30 Гц
setInterval(broadcastState, 1000 / CONFIG.TICK_RATE);

server.listen(CONFIG.PORT, '0.0.0.0', () => {
  console.log('========================================');
  console.log('  TANKI.IO WebSocket Server запущен!');
  console.log('========================================');
  console.log(`  Порт:        ${CONFIG.PORT}`);
  console.log(`  Арена:       ${CONFIG.ARENA_SIZE}x${CONFIG.ARENA_SIZE}`);
  console.log(`  Ботов:       ${CONFIG.BOT_COUNT}`);
  console.log(`  NPC:         ${CONFIG.NPC_COUNT}`);
  console.log(`  WebSocket:   ws://<your-host>:${CONFIG.PORT}`);
  console.log(`  Health:      http://<your-host>:${CONFIG.PORT}/health`);
  console.log('========================================');
  console.log('');
  console.log('Ожидание игроков...');
});

// Graceful shutdown (важно для Render free-tier — сервис перезапускается)
function shutdown(signal) {
  console.log(`\n[${signal}] Завершение работы...`);
  // Закрываем все WebSocket соединения
  for (const t of state.tanks) {
    if (t.ws && t.ws.readyState === WebSocket.OPEN) {
      try { t.ws.close(); } catch (e) {}
    }
  }
  wss.close();
  server.close(() => {
    console.log('Сервер остановлен.');
    process.exit(0);
  });
  // Принудительный выход через 3 сек если что-то зависло
  setTimeout(() => process.exit(0), 3000);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Защита от падения — логируем ошибки но не падаем
process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT EXCEPTION]', err.message);
  console.error(err.stack);
});
process.on('unhandledRejection', (err) => {
  console.error('[UNHANDLED REJECTION]', err);
});

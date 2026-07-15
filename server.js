/**
 * TANKI.IO — WebSocket Multiplayer Server (OPTIMIZED)
 * Авторитарный сервер: хранит арену, считает физику, рассылает состояние
 * Запуск:  node server.js
 *
 * Оптимизации:
 *  - Spatial hash grid для коллизий (O(n) вместо O(n²))
 *  - Квадрат расстояний вместо Math.hypot
 *  - Переиспользуемые буферы в broadcastState (0 аллокаций/тик)
 *  - Общая сериализация танков (1 раз вместо 50)
 *  - Map для O(1) lookup танков по ID
 *  - Swap-and-pop удаление мёртвых сущностей
 *  - Единый игровой цикл с аккумулятором
 *  - AI ботов на 15Hz вместо 60Hz
 *  - Кешированные статы танков
 *  - Backpressure проверка WebSocket
 */

const WebSocket = require('ws');
const http = require('http');

// ==================== КОНФИГ ====================
const CONFIG = {
  PORT: 3000,
  ARENA_SIZE: 5000,
  TICK_RATE: 30,
  PHYSICS_RATE: 60,
  BOT_COUNT: 10,
  NPC_COUNT: 70,
  MAX_PLAYERS: 50,
  PLAYER_SPEED: 3.4,
  BULLET_LIFE: 95,
  REGEN_DELAY: 240,
  REGEN_RATE: 0.6,
  BOT_AI_INTERVAL: 4, // AI тикает каждые N физических тиков (~15Hz)
  CELL_SIZE: 250,     // размер ячейки spatial hash
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
const distSq = (ax, ay, bx, by) => { const dx = ax - bx, dy = ay - by; return dx * dx + dy * dy; };
const dist = (a, b) => Math.sqrt(distSq(a.x, a.y, b.x, b.y)); // только для не-коллизий
const lerp = (a, b, t) => a + (b - a) * t;
const angleBetween = (from, to) => Math.atan2(to.y - from.y, to.x - from.x);
const normAngle = a => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// ==================== SPATIAL HASH GRID ====================
const grid = new Map();

function gridKey(cx, cy) { return (cx * 73856093) ^ (cy * 19349663); }

function getCell(x, y) {
  return Math.floor(x / CONFIG.CELL_SIZE) | 0;
}

function buildGrid() {
  grid.clear();
  const CS = CONFIG.CELL_SIZE;
  // Вставляем танки
  for (const t of state.tanks) {
    if (t.dead) continue;
    const cx = (t.x / CS) | 0, cy = (t.y / CS) | 0;
    const key = gridKey(cx, cy);
    let cell = grid.get(key);
    if (!cell) { cell = []; grid.set(key, cell); }
    cell.push(t);
  }
  // Вставляем NPC
  for (const n of state.npcs) {
    if (n.dead) continue;
    const cx = (n.x / CS) | 0, cy = (n.y / CS) | 0;
    const key = gridKey(cx, cy);
    let cell = grid.get(key);
    if (!cell) { cell = []; grid.set(key, cell); }
    cell.push(n);
  }
  // Вставляем пули
  for (const b of state.bullets) {
    if (b.dead) continue;
    const cx = (b.x / CS) | 0, cy = (b.y / CS) | 0;
    const key = gridKey(cx, cy);
    let cell = grid.get(key);
    if (!cell) { cell = []; grid.set(key, cell); }
    cell.push(b);
  }
}

// Получить все сущности в соседних ячейках (включая свою)
function queryGrid(x, y, radius) {
  const CS = CONFIG.CELL_SIZE;
  const results = [];
  const minCX = ((x - radius) / CS) | 0;
  const maxCX = ((x + radius) / CS) | 0;
  const minCY = ((y - radius) / CS) | 0;
  const maxCY = ((y + radius) / CS) | 0;
  for (let cx = minCX; cx <= maxCX; cx++) {
    for (let cy = minCY; cy <= maxCY; cy++) {
      const cell = grid.get(gridKey(cx, cy));
      if (cell) {
        for (let i = 0; i < cell.length; i++) results.push(cell[i]);
      }
    }
  }
  return results;
}

// ==================== СОСТОЯНИЕ ИГРЫ ====================
const state = {
  tanks: [],
  npcs: [],
  bullets: [],
  nextId: 1,
};

// O(1) lookup по ID
const tankById = new Map();

function nextId() { return state.nextId++; }

function registerTank(tank) {
  tankById.set(tank.id, tank);
}
function unregisterTank(id) {
  tankById.delete(id);
}

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
    this.input = { mx: 0, my: 0, turretAngle: 0, shoot: false };
    this.aiState = 'wander';
    this.aiTimer = 0;
    this.wanderAngle = rand(0, Math.PI * 2);
    this.strafeDir = Math.random() < 0.5 ? 1 : -1;
    this.ws = null;
    // Кешированные статы (пересчитываются при изменении power)
    this._lastPower = -1;
    this._radius = 22;
    this._speed = CONFIG.PLAYER_SPEED;
    this._bulletDamage = 10;
    this._bulletSize = 5;
    this._shootRate = 24;
    this._bulletSpeed = 9;
    this._updateStats();
    registerTank(this);
  }

  _updateStats() {
    if (this._lastPower === this.power) return;
    this._lastPower = this.power;
    this._radius = 22 + Math.min(28, this.power * 0.035);
    this._speed = CONFIG.PLAYER_SPEED * (1 - Math.min(0.35, this.power * 0.0007));
    this._bulletDamage = 10 + this.power * 0.09;
    this._bulletSize = 5 + Math.min(8, this.power * 0.011);
    this._shootRate = Math.max(9, 24 - this.power * 0.011);
    this._bulletSpeed = 9 + Math.min(5, this.power * 0.006);
    this.maxHealth = 100 + this.power * 0.3;
  }

  get radius() { return this._radius; }
  get speed() { return this._speed; }
  get bulletDamage() { return this._bulletDamage; }
  get bulletSize() { return this._bulletSize; }
  get shootRate() { return this._shootRate; }
  get bulletSpeed() { return this._bulletSpeed; }

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
      killer._updateStats();
      killer.kills++;
      killer.health = Math.min(killer.maxHealth, killer.health + 35);
      broadcastKill(killer.name, this.name, isPvP, killer.id, this.id);
    }
    this.power = 0;
    this._updateStats();
    this.respawnTimer = 200;
  }

  respawn() {
    let x, y, tries = 0;
    const tankArr = state.tanks;
    do {
      x = rand(300, CONFIG.ARENA_SIZE - 300);
      y = rand(300, CONFIG.ARENA_SIZE - 300);
      tries++;
    } while (tries < 25 && tankArr.some(t => !t.dead && t !== this && distSq(x, y, t.x, t.y) < 250000));
    this.x = x; this.y = y;
    this.vx = 0; this.vy = 0;
    this._updateStats();
    this.health = this.maxHealth;
    this.dead = false;
    this.invincible = 100;
    this.shootCooldown = 0;
    this.regenTimer = 0;
  }

  update() {
    if (this.dead) {
      this.respawnTimer--;
      if (this.isBot && this.respawnTimer <= 0) this.respawn();
      return;
    }
    if (this.invincible > 0) this.invincible--;
    if (this.shootCooldown > 0) this.shootCooldown--;
    if (this.flashTimer > 0) this.flashTimer--;
    this.regenTimer++;
    this._updateStats();
    if (this.regenTimer > CONFIG.REGEN_DELAY && this.health < this.maxHealth) {
      this.health = Math.min(this.maxHealth, this.health + CONFIG.REGEN_RATE);
    }

    if (!this.isBot) {
      const imx = this.input.mx, imy = this.input.my;
      const inputMagSq = imx * imx + imy * imy;
      if (inputMagSq > 0.0025) {
        const targetVx = imx * this.speed;
        const targetVy = imy * this.speed;
        this.vx = lerp(this.vx, targetVx, 0.25);
        this.vy = lerp(this.vy, targetVy, 0.25);
        const targetAngle = Math.atan2(imy, imx);
        let diff = normAngle(targetAngle - this.angle);
        this.angle += diff * 0.2;
      } else {
        this.vx *= 0.85;
        this.vy *= 0.85;
      }
      this.turretAngle = this.input.turretAngle;
    }

    this.x += this.vx;
    this.y += this.vy;
    if (this.isBot) {
      this.vx *= 0.92;
      this.vy *= 0.92;
    }

    const r = this.radius;
    const AS = CONFIG.ARENA_SIZE;
    if (this.x < r) { this.x = r; this.vx = Math.abs(this.vx) * 0.5; }
    if (this.x > AS - r) { this.x = AS - r; this.vx = -Math.abs(this.vx) * 0.5; }
    if (this.y < r) { this.y = r; this.vy = Math.abs(this.vy) * 0.5; }
    if (this.y > AS - r) { this.y = AS - r; this.vy = -Math.abs(this.vy) * 0.5; }

    if (this.vx * this.vx + this.vy * this.vy > 0.04) {
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

  let nearestTank = null, nearestTankDistSq = 490000; // 700²
  let weakestNearby = null, weakestPower = Infinity;
  let nearestNPC = null, nearestNPCDistSq = 202500; // 450²

  const tanks = state.tanks;
  const npcs = state.npcs;
  const bx = bot.x, by = bot.y;

  for (let i = 0; i < tanks.length; i++) {
    const t = tanks[i];
    if (t === bot || t.dead || t.invincible > 30) continue;
    const dsq = distSq(bx, by, t.x, t.y);
    if (dsq < nearestTankDistSq) { nearestTankDistSq = dsq; nearestTank = t; }
    if (dsq < 250000 && t.power < weakestPower) { weakestPower = t.power; weakestNearby = t; }
  }
  for (let i = 0; i < npcs.length; i++) {
    const n = npcs[i];
    if (n.dead) continue;
    const dsq = distSq(bx, by, n.x, n.y);
    if (dsq < nearestNPCDistSq) { nearestNPCDistSq = dsq; nearestNPC = n; }
  }

  const nearestTankDist = Math.sqrt(nearestTankDistSq);
  const nearestNPCDist = Math.sqrt(nearestNPCDistSq);

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
        if (nearestNPCDist > 120) { moveX = nearestNPC.x - bot.x; moveY = nearestNPC.y - bot.y; }
        shoot = nearestNPCDist < 450;
      }
      break;
    case 'hunt':
    case 'fight': {
      const target = weakestNearby || nearestTank;
      if (target) {
        const d = Math.sqrt(distSq(bx, by, target.x, target.y));
        const ang = angleBetween(bot, target);
        const strafeAng = ang + (Math.PI / 2) * bot.strafeDir;
        if (bot.aiTimer % 120 === 0) bot.strafeDir *= -1;
        const desired = bot.aiState === 'hunt' ? 280 : 220;
        if (d > desired + 60) { moveX = Math.cos(ang) * 0.8 + Math.cos(strafeAng) * 0.4; moveY = Math.sin(ang) * 0.8 + Math.sin(strafeAng) * 0.4; }
        else if (d < desired - 60) { moveX = -Math.cos(ang) * 0.7 + Math.cos(strafeAng) * 0.5; moveY = -Math.sin(ang) * 0.7 + Math.sin(strafeAng) * 0.5; }
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

  const mag = Math.sqrt(moveX * moveX + moveY * moveY);
  if (mag > 0) { moveX /= mag; moveY /= mag; }
  bot.vx = lerp(bot.vx, moveX * bot.speed, 0.12);
  bot.vy = lerp(bot.vy, moveY * bot.speed, 0.12);
  const targetAngle = Math.atan2(aimY - bot.y, aimX - bot.x);
  let diff = normAngle(targetAngle - bot.turretAngle);
  bot.turretAngle += diff * 0.18;
  bot.input.shoot = shoot && Math.abs(diff) < 0.25;

  const margin = 250;
  const AS = CONFIG.ARENA_SIZE;
  if (bot.x < margin || bot.x > AS - margin || bot.y < margin || bot.y > AS - margin) {
    bot.wanderAngle = Math.atan2(AS / 2 - bot.y, AS / 2 - bot.x);
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
  const tanks = state.tanks, npcs = state.npcs;
  do {
    x = rand(150, CONFIG.ARENA_SIZE - 150);
    y = rand(150, CONFIG.ARENA_SIZE - 150);
    tries++;
  } while (tries < 15 && (
    tanks.some(t => !t.dead && distSq(x, y, t.x, t.y) < 250000) ||
    npcs.some(n => !n.dead && distSq(x, y, n.x, n.y) < 6400)
  ));
  const s = NPC_TYPES[type];
  state.npcs.push({
    id: nextId(),
    x, y, type,
    health: s.health, maxHealth: s.health,
    power: s.power, damage: s.damage,
    speed: s.speed, color: s.color, size: s.size, sides: s.sides,
    angle: rand(0, Math.PI * 2), rotSpeed: rand(-0.025, 0.025),
    vx: rand(-0.5, 0.5), vy: rand(-0.5, 0.5),
    dead: false, flashTimer: 0,
    aggro: false, aggroTargetId: null,
    spawnTime: Date.now(),
  });
}

function updateNPC(n) {
  if (n.dead) return;
  if (n.flashTimer > 0) n.flashTimer--;
  n.angle += n.rotSpeed;
  let target = null;
  if (n.aggro && n.aggroTargetId != null) {
    target = tankById.get(n.aggroTargetId);
    if (!target || target.dead) { n.aggro = false; n.aggroTargetId = null; target = null; }
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
  const s = n.size, AS = CONFIG.ARENA_SIZE;
  if (n.x < s) { n.vx = Math.abs(n.vx); n.x = s; }
  if (n.x > AS - s) { n.vx = -Math.abs(n.vx); n.x = AS - s; }
  if (n.y < s) { n.vy = Math.abs(n.vy); n.y = s; }
  if (n.y > AS - s) { n.vy = -Math.abs(n.vy); n.y = AS - s; }
}

// ==================== СТОЛКНОВЕНИЯ (spatial hash) ====================
function resolveCollisions() {
  buildGrid();

  // 1. Танк ↔ NPC
  const tanks = state.tanks;
  for (let i = 0; i < tanks.length; i++) {
    const t = tanks[i];
    if (t.dead) continue;
    const nearby = queryGrid(t.x, t.y, 80);
    for (let j = 0; j < nearby.length; j++) {
      const n = nearby[j];
      if (n.dead || n === t || !n.sides) continue; // sides = NPC маркер
      const dx = t.x - n.x;
      const dy = t.y - n.y;
      const dSq = dx * dx + dy * dy;
      const minDist = t.radius + n.size;
      if (dSq < minDist * minDist && dSq > 0.000001) {
        const d = Math.sqrt(dSq);
        const nx = dx / d;
        const ny = dy / d;
        const overlap = minDist - d;
        const tankMass = t.radius;
        const npcMass = n.size;
        const totalMass = tankMass + npcMass;
        t.x += nx * overlap * (npcMass / totalMass);
        t.y += ny * overlap * (npcMass / totalMass);
        n.x -= nx * overlap * (tankMass / totalMass);
        n.y -= ny * overlap * (tankMass / totalMass);
        const bounceForce = 2.5;
        t.vx += nx * bounceForce * (npcMass / totalMass);
        t.vy += ny * bounceForce * (npcMass / totalMass);
        n.vx -= nx * bounceForce * (tankMass / totalMass);
        n.vy -= ny * bounceForce * (tankMass / totalMass);
        n.aggro = true;
        n.aggroTargetId = t.id;
      }
    }
  }

  // 2. Танк ↔ Танк
  for (let i = 0; i < tanks.length; i++) {
    const a = tanks[i];
    if (a.dead) continue;
    const nearby = queryGrid(a.x, a.y, 80);
    for (let j = 0; j < nearby.length; j++) {
      const b = nearby[j];
      if (b === a || b.dead || !b.input) continue; // input = Tank маркер
      if (b.id <= a.id) continue; // избегаем дублирования
      if (a.invincible > 0 || b.invincible > 0) continue;
      const dx = a.x - b.x;
      const dy = a.y - b.y;
      const dSq = dx * dx + dy * dy;
      const minDist = a.radius + b.radius;
      if (dSq < minDist * minDist && dSq > 0.000001) {
        const d = Math.sqrt(dSq);
        const nx = dx / d;
        const ny = dy / d;
        const overlap = minDist - d;
        const massA = a.radius;
        const massB = b.radius;
        const totalMass = massA + massB;
        a.x += nx * overlap * (massB / totalMass);
        a.y += ny * overlap * (massB / totalMass);
        b.x -= nx * overlap * (massA / totalMass);
        b.y -= ny * overlap * (massA / totalMass);
        const bounceForce = 4;
        a.vx += nx * bounceForce * (massB / totalMass);
        a.vy += ny * bounceForce * (massB / totalMass);
        b.vx -= nx * bounceForce * (massA / totalMass);
        b.vy -= ny * bounceForce * (massA / totalMass);
        const ramDamage = 3;
        a.takeDamage(ramDamage, b);
        b.takeDamage(ramDamage, a);
      }
    }
  }
}

// ==================== ПУЛИ (spatial hash) ====================
function updateBullet(b) {
  if (b.dead) return;
  b.x += b.vx; b.y += b.vy;
  b.life--;
  if (b.life <= 0 || b.x < 0 || b.x > CONFIG.ARENA_SIZE || b.y < 0 || b.y > CONFIG.ARENA_SIZE) {
    b.dead = true; return;
  }
  const owner = tankById.get(b.ownerId);
  const nearby = queryGrid(b.x, b.y, 60);

  // Пуля ↔ Танк
  for (let i = 0; i < nearby.length; i++) {
    const t = nearby[i];
    if (!t.input || t.id === b.ownerId || t.dead || t.invincible > 0) continue;
    const dx = b.x - t.x, dy = b.y - t.y;
    const minDist = t.radius + b.size;
    if (dx * dx + dy * dy < minDist * minDist) {
      t.takeDamage(b.damage, owner);
      b.dead = true; return;
    }
  }
  // Пуля ↔ NPC
  for (let i = 0; i < nearby.length; i++) {
    const n = nearby[i];
    if (n.dead || !n.sides) continue; // sides = NPC маркер
    const dx = b.x - n.x, dy = b.y - n.y;
    const minDist = n.size + b.size;
    if (dx * dx + dy * dy < minDist * minDist) {
      n.health -= b.damage;
      n.flashTimer = 5;
      n.aggro = true; n.aggroTargetId = b.ownerId;
      if (n.health <= 0) {
        n.dead = true;
        if (owner) { owner.power += n.power; owner._updateStats(); }
      }
      b.dead = true; return;
    }
  }
}

// ==================== УДАЛЕНИЕ МЁРТВЫХ (swap-and-pop, 0 аллокаций) ====================
function removeDead() {
  const npcs = state.npcs;
  for (let i = npcs.length - 1; i >= 0; i--) {
    if (npcs[i].dead) {
      npcs[i] = npcs[npcs.length - 1];
      npcs.pop();
    }
  }
  const bullets = state.bullets;
  for (let i = bullets.length - 1; i >= 0; i--) {
    if (bullets[i].dead) {
      bullets[i] = bullets[bullets.length - 1];
      bullets.pop();
    }
  }
}

// ==================== ИНИЦИАЛИЗАЦИЯ ====================
function initGame() {
  state.tanks = [];
  state.npcs = [];
  state.bullets = [];
  state.nextId = 1;
  tankById.clear();
  for (let i = 0; i < CONFIG.NPC_COUNT; i++) spawnNPC();
  console.log(`[INIT] Арена создана: ${CONFIG.ARENA_SIZE}x${CONFIG.ARENA_SIZE}`);
  console.log(`[INIT] NPC: ${CONFIG.NPC_COUNT}. Ботов = игроков (динамически).`);
}

function spawnBot() {
  const name = randPick(BOT_NAMES) + randInt(1, 999);
  const color = randPick(TANK_COLORS);
  let x, y, tries = 0;
  const tanks = state.tanks;
  do {
    x = rand(400, CONFIG.ARENA_SIZE - 400);
    y = rand(400, CONFIG.ARENA_SIZE - 400);
    tries++;
  } while (tries < 25 && tanks.some(t => !t.dead && distSq(x, y, t.x, t.y) < 250000));
  const bot = new Tank(x, y, name, color, true);
  bot.power = randInt(0, 250);
  bot._updateStats();
  state.tanks.push(bot);
  return bot;
}

// ==================== СЕРВЕРНЫЙ ТИК ====================
let physicsTick = 0;
function gameTick() {
  physicsTick++;
  const runAI = (physicsTick % CONFIG.BOT_AI_INTERVAL === 0);
  const tanks = state.tanks;
  const npcs = state.npcs;
  const bullets = state.bullets;

  for (let i = 0; i < tanks.length; i++) {
    const t = tanks[i];
    if (t.isBot && runAI) updateBotAI(t);
    t.update();
  }
  for (let i = 0; i < npcs.length; i++) updateNPC(npcs[i]);
  for (let i = 0; i < bullets.length; i++) updateBullet(bullets[i]);

  resolveCollisions();
  removeDead();

  if (state.npcs.length < CONFIG.NPC_COUNT) spawnNPC();

  for (let i = 0; i < tanks.length; i++) {
    if (tanks[i].isBot && tanks[i].dead && tanks[i].respawnTimer <= 0) {
      tanks[i].respawn();
    }
  }
}

// ==================== РАССЫЛКА СОСТОЯНИЯ (оптимизированная) ====================
// Переиспользуемые буферы — 0 аллокаций при нормальной работе
const _npcBuf = [];
const _bulletBuf = [];
let _tankSlice = '';

function broadcastState() {
  const VIEW_MARGIN = 800;
  const tanks = state.tanks;
  const npcs = state.npcs;
  const bullets = state.bullets;

  // Сериализуем танков ОДИН раз (они отправляются всем)
  const tankArr = [];
  for (let i = 0; i < tanks.length; i++) {
    const t = tanks[i];
    tankArr.push(
      t.id, t.x, t.y, t.angle, t.turretAngle,
      t.name, t.color, t.health, t.maxHealth,
      t.power | 0, t.kills, t.dead ? 1 : 0,
      t.invincible > 0 ? 1 : 0, t.flashTimer > 0 ? 1 : 0, t.isBot ? 1 : 0
    );
  }
  _tankSlice = JSON.stringify(tankArr);

  // Собираем данные NPC и пуль один раз
  const allNpcData = [];
  for (let i = 0; i < npcs.length; i++) {
    const n = npcs[i];
    allNpcData.push(n.id, n.x, n.y, n.type, n.color, n.size, n.sides, n.angle, n.health, n.maxHealth, n.spawnTime);
  }
  const allBulletData = [];
  for (let i = 0; i < bullets.length; i++) {
    const b = bullets[i];
    allBulletData.push(b.id, b.x, b.y, b.color, b.size, b.ownerId);
  }

  for (let p = 0; p < tanks.length; p++) {
    const player = tanks[p];
    if (!player.ws || player.ws.readyState !== WebSocket.OPEN) continue;

    // Backpressure check
    if (player.ws.bufferedAmount > 65536) continue;

    const px = player.x, py = player.y;
    const viewLeft = px - 1500, viewRight = px + 1500;
    const viewTop = py - 1200, viewBottom = py + 1200;

    // Фильтруем NPC по видимости (перезаписываем буфер)
    _npcBuf.length = 0;
    for (let i = 0; i < allNpcData.length; i += 11) {
      if (allNpcData[i + 1] >= viewLeft && allNpcData[i + 1] <= viewRight &&
          allNpcData[i + 2] >= viewTop && allNpcData[i + 2] <= viewBottom) {
        _npcBuf.push(
          allNpcData[i], allNpcData[i+1], allNpcData[i+2], allNpcData[i+3],
          allNpcData[i+4], allNpcData[i+5], allNpcData[i+6], allNpcData[i+7],
          allNpcData[i+8], allNpcData[i+9], allNpcData[i+10]
        );
      }
    }

    // Фильтруем пули
    _bulletBuf.length = 0;
    for (let i = 0; i < allBulletData.length; i += 6) {
      if (allBulletData[i + 1] >= viewLeft && allBulletData[i + 1] <= viewRight &&
          allBulletData[i + 2] >= viewTop && allBulletData[i + 2] <= viewBottom) {
        _bulletBuf.push(
          allBulletData[i], allBulletData[i+1], allBulletData[i+2],
          allBulletData[i+3], allBulletData[i+4], allBulletData[i+5]
        );
      }
    }

    player.ws.send('{"type":"state","arena":' + CONFIG.ARENA_SIZE +
      ',"tk":' + _tankSlice +
      ',"np":' + JSON.stringify(_npcBuf) +
      ',"bl":' + JSON.stringify(_bulletBuf) + '}');
  }
}

const killFeed = [];
function broadcastKill(killerName, victimName, isPvP, killerId, victimId) {
  const msg = '{"type":"kill","killer":"' + killerName + '","victim":"' + victimName + '","isPvP":' + (isPvP ? 1 : 0) + ',"killerId":' + killerId + ',"victimId":' + victimId + ',"time":' + Date.now() + '}';
  killFeed.push(msg);
  if (killFeed.length > 10) killFeed.shift();
  for (let i = 0; i < state.tanks.length; i++) {
    const t = state.tanks[i];
    if (t.ws && t.ws.readyState === WebSocket.OPEN) t.ws.send(msg);
  }
}

// ==================== HTTP СЕРВЕР ====================
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }
  if (req.url === '/health' || req.url === '/') {
    let players = 0, bots = 0;
    for (const t of state.tanks) { if (t.ws) players++; if (t.isBot) bots++; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      players, bots,
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
  let playerName = 'Player' + randInt(1, 999);
  let playerColor = randPick(TANK_COLORS);

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
  } while (tries < 25 && state.tanks.some(t => !t.dead && distSq(spawnX, spawnY, t.x, t.y) < 250000));

  const tank = new Tank(spawnX, spawnY, playerName, playerColor, false);
  tank.ws = ws;
  state.tanks.push(tank);

  const pairedBot = spawnBot();
  tank.pairedBotId = pairedBot.id;
  pairedBot.pairedPlayerId = tank.id;

  let playerCount = 0;
  for (const t of state.tanks) { if (t.ws) playerCount++; }
  console.log(`[JOIN] ${playerName} подключился. Всего игроков: ${playerCount}. Спавн бота ${pairedBot.name}.`);

  ws.send(JSON.stringify({ type: 'welcome', id: tank.id, arena: CONFIG.ARENA_SIZE }));

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.type === 'input') {
        tank.input.mx = clamp(msg.mx || 0, -1, 1);
        tank.input.my = clamp(msg.my || 0, -1, 1);
        tank.input.turretAngle = msg.turretAngle || 0;
        tank.input.shoot = !!msg.shoot;
      } else if (msg.type === 'respawn') {
        if (tank.dead) tank.respawn();
      } else if (msg.type === 'ping') {
        ws.send('{"type":"pong","t":' + (msg.t || 0) + '}');
      }
    } catch (e) {
      console.error('[ERROR] parse message:', e.message);
    }
  });

  ws.on('close', () => {
    console.log(`[LEAVE] ${playerName} отключился`);
    const playerIdx = state.tanks.indexOf(tank);
    if (playerIdx !== -1) {
      state.tanks.splice(playerIdx, 1);
      unregisterTank(tank.id);
    }
    if (tank.pairedBotId) {
      const botIdx = state.tanks.findIndex(t => t.id === tank.pairedBotId);
      if (botIdx !== -1) {
        const bot = state.tanks[botIdx];
        console.log(`[LEAVE] Удаляем парного бота ${bot.name}`);
        unregisterTank(bot.id);
        state.tanks.splice(botIdx, 1);
      }
    }
  });

  ws.on('error', () => {});
});

// ==================== ЗАПУСК (единый цикл с аккумулятором) ====================
initGame();

const PHYSICS_DT = 1000 / CONFIG.PHYSICS_RATE;
const BROADCAST_DT = 1000 / CONFIG.TICK_RATE;
let lastLoopTime = performance.now();
let physicsAccum = 0;
let broadcastAccum = 0;
let maxPhysicsPerFrame = 4; // не более 4 физических тиков за кадр (защита от spiral of death)

function mainLoop(now) {
  const delta = Math.min(now - lastLoopTime, 100); // cap 100ms
  lastLoopTime = now;

  physicsAccum += delta;
  let physicsTicks = 0;
  while (physicsAccum >= PHYSICS_DT && physicsTicks < maxPhysicsPerFrame) {
    gameTick();
    physicsAccum -= PHYSICS_DT;
    physicsTicks++;
  }

  broadcastAccum += delta;
  if (broadcastAccum >= BROADCAST_DT) {
    broadcastState();
    broadcastAccum -= BROADCAST_DT;
    if (broadcastAccum > BROADCAST_DT * 2) broadcastAccum = 0; // reset если сильно отстаёт
  }
}

// Высокочастотный таймер (~250Hz) для точного аккумулятора
setInterval(() => mainLoop(performance.now()), 4);

server.listen(CONFIG.PORT, '0.0.0.0', () => {
  console.log('========================================');
  console.log('  TANKI.IO WebSocket Server запущен! (OPTIMIZED)');
  console.log('========================================');
  console.log(`  Порт:        ${CONFIG.PORT}`);
  console.log(`  Арена:       ${CONFIG.ARENA_SIZE}x${CONFIG.ARENA_SIZE}`);
  console.log(`  Ботов:       ${CONFIG.BOT_COUNT}`);
  console.log(`  NPC:         ${CONFIG.NPC_COUNT}`);
  console.log(`  Spatial Grid: ${CONFIG.CELL_SIZE}px ячейки`);
  console.log(`  Bot AI:      ${(CONFIG.PHYSICS_RATE / CONFIG.BOT_AI_INTERVAL) | 0}Hz`);
  console.log(`  WebSocket:   ws://<your-host>:${CONFIG.PORT}`);
  console.log(`  Health:      http://<your-host>:${CONFIG.PORT}/health`);
  console.log('========================================');
  console.log('');
  console.log('Ожидание игроков...');
});

// Graceful shutdown
function shutdown(signal) {
  console.log(`\n[${signal}] Завершение работы...`);
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
  setTimeout(() => process.exit(0), 3000);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT EXCEPTION]', err.message);
  console.error(err.stack);
});
process.on('unhandledRejection', (err) => {
  console.error('[UNHANDLED REJECTION]', err);
});
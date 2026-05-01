'use strict';

// ============================================================
// Voice (Web Speech API)
// ============================================================
const voice = {
  synth: window.speechSynthesis || null,
  voice: null,
  enabled: localStorage.getItem('hm_voice') !== '0',

  init() {
    if (!this.synth) return;
    const pick = () => {
      const all = this.synth.getVoices();
      const ja  = all.filter(v => (v.lang || '').toLowerCase().startsWith('ja'));
      if (!ja.length) return;
      const prefer = [
        /Kyoko.*Premium/i, /Kyoko.*Enhanced/i,
        /Premium.*ja/i, /Enhanced.*ja/i, /Neural.*ja/i,
        /Google.*日本/, /Google.*Japanese/i,
        /Microsoft.*Nanami/i, /Microsoft.*Ayumi/i, /Microsoft.*Haruka/i,
        /Kyoko/i, /O-ren/i, /Otoya/i,
      ];
      for (const re of prefer) {
        const v = ja.find(v => re.test(v.name));
        if (v) { this.voice = v; return; }
      }
      this.voice = ja[0];
    };
    pick();
    this.synth.addEventListener('voiceschanged', pick);
    this._updateBtn();
  },

  unlock() {
    // iOS / Safari requires a user gesture before audio plays.
    if (!this.synth) return;
    try {
      const u = new SpeechSynthesisUtterance(' ');
      u.volume = 0; u.rate = 1; u.pitch = 1; u.lang = 'ja-JP';
      this.synth.speak(u);
    } catch (_) {}
  },

  speak(text, opts = {}) {
    if (!this.enabled || !this.synth || !text) return;
    try {
      this.synth.cancel(); // interrupt previous
      const u = new SpeechSynthesisUtterance(text);
      if (this.voice) u.voice = this.voice;
      u.lang = 'ja-JP';
      u.rate   = opts.rate   ?? 1.0;
      u.pitch  = opts.pitch  ?? 1.15;
      u.volume = opts.volume ?? 1.0;
      this.synth.speak(u);
    } catch (_) {}
  },

  toggle() {
    this.enabled = !this.enabled;
    localStorage.setItem('hm_voice', this.enabled ? '1' : '0');
    if (!this.enabled && this.synth) this.synth.cancel();
    this._updateBtn();
    return this.enabled;
  },

  _updateBtn() {
    const btn = document.getElementById('btn-voice');
    if (!btn) return;
    btn.textContent = this.enabled ? '🔊' : '🔇';
    btn.classList.toggle('muted', !this.enabled);
  },
};

function toggleVoice() {
  const on = voice.toggle();
  if (on) voice.speak('オン', { pitch: 1.2 });
}

// ============================================================
// Data
// ============================================================
const HIRAGANA = [...'あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろわをん'];
// 46 chars

const WORDS = [
  'さくら','うみ','はな','そら','かぜ','ゆき','つき','もり',
  'なつ','ふゆ','はる','あき','ことり','にじ','ほし','かわ',
  'やま','いぬ','ねこ','きつね','うさぎ','はなび','かたつむり',
  'あおぞら','ひまわり','なのはな','ゆうひ','あさひ','こもれび',
];

const ROOMS_W = 7, ROOMS_H = 7;
const GW = ROOMS_W * 2 + 1; // 15
const GH = ROOMS_H * 2 + 1; // 15
const CANVAS_SIZE = 600;     // fixed pixel size; CSS scaling handles display
const CS = CANVAS_SIZE / GW; // cell size ≈ 40px

// ============================================================
// Maze Generator (recursive backtracking)
// ============================================================
function buildMaze() {
  const grid = Array.from({ length: GH }, () => new Uint8Array(GW));
  const vis  = Array.from({ length: ROOMS_H }, () => new Uint8Array(ROOMS_W));

  function carve(rx, ry) {
    vis[ry][rx] = 1;
    grid[ry * 2 + 1][rx * 2 + 1] = 1;
    const dirs = [[0,1],[0,-1],[1,0],[-1,0]];
    for (let i = dirs.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [dirs[i], dirs[j]] = [dirs[j], dirs[i]];
    }
    for (const [dx, dy] of dirs) {
      const nx = rx + dx, ny = ry + dy;
      if (nx >= 0 && nx < ROOMS_W && ny >= 0 && ny < ROOMS_H && !vis[ny][nx]) {
        grid[ry * 2 + 1 + dy][rx * 2 + 1 + dx] = 1;
        carve(nx, ny);
      }
    }
  }
  carve(0, 0);
  return grid;
}

// ============================================================
// Game Class
// ============================================================
class Game {
  constructor(canvas, mode) {
    this.canvas = canvas;
    this.ctx    = canvas.getContext('2d');
    this.mode   = mode;

    this.grid = buildMaze();

    // Player (grid coords, start = room 0,0)
    this.px = 1; this.py = 1;
    this.sx = CS * 1 + CS / 2; // smooth pixel x
    this.sy = CS * 1 + CS / 2; // smooth pixel y

    // Goal = room (ROOMS_W-1, ROOMS_H-1)
    this.gx = GW - 2; this.gy = GH - 2;

    // Characters
    this.charMap  = new Map(); // `x,y` → char
    this.sequence = [];
    this.seqIdx   = 0;
    this.allDone  = false;
    this.word     = null;
    this._placeChars();

    // Timing / state
    this.t0      = performance.now();
    this.elapsed = 0;
    this.won     = false;

    // Visual
    this.phase = 0;
    this.parts = [];          // particles
    this.flashMap = new Map();// `x,y` → flash intensity (wrong collect)

    // Input
    this._onKey = e => this._key(e);
    this._tsX = 0; this._tsY = 0;
    this._onTS = e => { this._tsX = e.touches[0].clientX; this._tsY = e.touches[0].clientY; };
    this._onTE = e => {
      const dx = e.changedTouches[0].clientX - this._tsX;
      const dy = e.changedTouches[0].clientY - this._tsY;
      if (Math.abs(dx) > Math.abs(dy)) this._move(dx > 0 ? 1 : -1, 0);
      else this._move(0, dy > 0 ? 1 : -1);
    };
    document.addEventListener('keydown', this._onKey);
    document.addEventListener('touchstart', this._onTS, { passive: true });
    document.addEventListener('touchend',   this._onTE, { passive: true });

    // Tap target chars in HUD to re-speak
    const tEl = document.getElementById('target-chars');
    this._onTargetTap = () => {
      if (this.allDone) { voice.speak('ゴールへ！', { pitch: 1.2 }); return; }
      const c = this.sequence[this.seqIdx];
      if (c) voice.speak(c, { pitch: 1.25 });
    };
    if (tEl) tEl.addEventListener('click', this._onTargetTap);

    document.querySelectorAll('.dpad-btn').forEach(btn => {
      const go = () => {
        const d = btn.dataset.dir;
        if (d === 'up')    this._move(0, -1);
        if (d === 'down')  this._move(0,  1);
        if (d === 'left')  this._move(-1, 0);
        if (d === 'right') this._move(1,  0);
      };
      btn.addEventListener('click', go);
      btn.addEventListener('touchstart', e => { e.preventDefault(); go(); }, { passive: false });
    });

    this.raf = requestAnimationFrame(() => this._loop());
  }

  // ---- Setup ----
  _placeChars() {
    const rooms = [];
    for (let ry = 0; ry < ROOMS_H; ry++) {
      for (let rx = 0; rx < ROOMS_W; rx++) {
        const gx = rx * 2 + 1, gy = ry * 2 + 1;
        if (gx === 1 && gy === 1) continue;       // start
        if (gx === this.gx && gy === this.gy) continue; // goal
        rooms.push({ gx, gy });
      }
    }
    // shuffle
    for (let i = rooms.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [rooms[i], rooms[j]] = [rooms[j], rooms[i]];
    }

    if (this.mode === 'order') {
      this.sequence = [...HIRAGANA];
      for (let i = 0; i < HIRAGANA.length && i < rooms.length; i++) {
        this.charMap.set(`${rooms[i].gx},${rooms[i].gy}`, HIRAGANA[i]);
      }
    } else {
      // word mode
      this.word = WORDS[Math.floor(Math.random() * WORDS.length)];
      this.sequence = [...this.word];

      // place target chars in first N rooms
      for (let i = 0; i < this.word.length && i < rooms.length; i++) {
        this.charMap.set(`${rooms[i].gx},${rooms[i].gy}`, this.word[i]);
      }
      // fill remaining rooms with decoy chars
      const decoys = HIRAGANA.filter(c => !this.sequence.includes(c));
      for (let i = this.word.length; i < rooms.length; i++) {
        this.charMap.set(`${rooms[i].gx},${rooms[i].gy}`, decoys[i % decoys.length]);
      }
    }
    this._updateHUD();
  }

  // ---- Input ----
  _key(e) {
    const m = {
      ArrowUp: [0,-1], ArrowDown: [0,1], ArrowLeft: [-1,0], ArrowRight: [1,0],
      w: [0,-1], s: [0,1], a: [-1,0], d: [1,0],
    };
    const d = m[e.key];
    if (d) { e.preventDefault(); this._move(d[0], d[1]); }
  }

  _move(dx, dy) {
    if (this.won) return;
    const nx = this.px + dx, ny = this.py + dy;
    if (nx < 0 || nx >= GW || ny < 0 || ny >= GH) return;
    if (!this.grid[ny][nx]) return;
    this.px = nx; this.py = ny;
    this._collect();
    this._checkWin();
    this._updateHUD();
  }

  _collect() {
    const key  = `${this.px},${this.py}`;
    const char = this.charMap.get(key);
    if (!char) return;

    if (char === this.sequence[this.seqIdx]) {
      // correct!
      this.charMap.delete(key);
      this.seqIdx++;
      this._burst(this.px * CS + CS / 2, this.py * CS + CS / 2, char, false);
      voice.speak(char, { rate: 1.0, pitch: 1.3 });
      if (this.seqIdx >= this.sequence.length) {
        this.allDone = true;
        this._bigBurst();
        setTimeout(() => voice.speak('ぜんぶ あつめた！ゴールへ！', { rate: 1.0, pitch: 1.2 }), 450);
      }
    } else {
      // wrong char – flash red on that cell
      this.flashMap.set(key, 1.0);
      this._burst(this.px * CS + CS / 2, this.py * CS + CS / 2, null, true);
      voice.speak(char, { rate: 0.95, pitch: 0.95 });
    }
  }

  _checkWin() {
    if (this.allDone && this.px === this.gx && this.py === this.gy) {
      this.won = true;
      this.elapsed = (performance.now() - this.t0) / 1000;
      this._bigBurst();
      voice.speak('クリア！おめでとう！', { rate: 1.0, pitch: 1.3 });
      setTimeout(() => showWin(this.elapsed, this.word), 1100);
    }
  }

  // ---- Particles ----
  _burst(cx, cy, char, wrong) {
    for (let i = 0; i < 10; i++) {
      const a   = (i / 10) * Math.PI * 2 + Math.random() * 0.4;
      const spd = 2 + Math.random() * 3;
      this.parts.push({
        x: cx, y: cy,
        vx: Math.cos(a) * spd, vy: Math.sin(a) * spd - 1,
        r: 4 + Math.random() * 5,
        life: 1,
        hue: wrong ? 0 : 40 + Math.random() * 35,
        char: (i === 0 && !wrong) ? char : null,
      });
    }
  }

  _bigBurst() {
    const cx = CANVAS_SIZE / 2, cy = CANVAS_SIZE / 2;
    for (let i = 0; i < 50; i++) {
      this.parts.push({
        x: cx + (Math.random() - .5) * 400,
        y: cy + (Math.random() - .5) * 300,
        vx: (Math.random() - .5) * 7,
        vy: -3 - Math.random() * 5,
        r: 4 + Math.random() * 8,
        life: 1,
        hue: Math.random() * 360,
        char: null,
      });
    }
  }

  // ---- HUD ----
  _updateHUD() {
    const el = document.getElementById('target-chars');
    if (!el) return;

    if (this.allDone) {
      el.innerHTML = '<span class="tc-goal">⭐ ゴールへ！</span>';
      return;
    }

    if (this.mode === 'order') {
      const slice = this.sequence.slice(this.seqIdx, this.seqIdx + 9);
      el.innerHTML = slice.map((c, i) =>
        `<span class="tc-${i === 0 ? 'next' : 'rest'}">${c}</span>`
      ).join('') + (this.seqIdx + 9 < this.sequence.length ? '<span class="tc-rest"> …</span>' : '');
    } else {
      el.innerHTML = this.sequence.map((c, i) => {
        if (i < this.seqIdx)    return `<span class="tc-done">${c}</span>`;
        if (i === this.seqIdx)  return `<span class="tc-next">${c}</span>`;
        return `<span class="tc-rest">${c}</span>`;
      }).join('');
    }
  }

  // ---- Loop ----
  _loop() {
    this.phase += 0.038;
    if (!this.won) this.elapsed = (performance.now() - this.t0) / 1000;

    // timer
    const m = Math.floor(this.elapsed / 60);
    const s = Math.floor(this.elapsed % 60);
    const tEl = document.getElementById('timer');
    if (tEl) tEl.textContent = `${m}:${s.toString().padStart(2, '0')}`;

    // smooth player
    const tx = this.px * CS + CS / 2, ty = this.py * CS + CS / 2;
    this.sx += (tx - this.sx) * 0.24;
    this.sy += (ty - this.sy) * 0.24;

    // particles
    for (const p of this.parts) {
      p.x += p.vx; p.y += p.vy;
      p.vy += 0.18;
      p.life -= 0.028;
    }
    this.parts = this.parts.filter(p => p.life > 0);

    // flash decay
    for (const [k, v] of this.flashMap) {
      const nv = v - 0.06;
      if (nv <= 0) this.flashMap.delete(k);
      else this.flashMap.set(k, nv);
    }

    this._draw();
    this.raf = requestAnimationFrame(() => this._loop());
  }

  // ---- Draw ----
  _draw() {
    const { ctx, grid, charMap, gx, gy, phase, sequence, seqIdx, allDone } = this;
    ctx.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);

    // ---- Cells ----
    for (let y = 0; y < GH; y++) {
      for (let x = 0; x < GW; x++) {
        const bx = x * CS, by = y * CS;
        if (!grid[y][x]) {
          // wall
          ctx.fillStyle = '#131325';
          ctx.fillRect(bx, by, CS, CS);
          ctx.fillStyle = '#1c1c36';
          ctx.fillRect(bx + 1, by + 1, CS - 2, CS - 2);
        } else {
          ctx.fillStyle = '#f0e8d8';
          ctx.fillRect(bx, by, CS, CS);
          // subtle grid line
          ctx.strokeStyle = 'rgba(170,148,110,.2)';
          ctx.lineWidth = .5;
          ctx.strokeRect(bx + .5, by + .5, CS - 1, CS - 1);
        }
      }
    }

    // ---- Flash overlay (wrong collect) ----
    for (const [key, intensity] of this.flashMap) {
      const [fx, fy] = key.split(',').map(Number);
      ctx.fillStyle = `rgba(255,50,50,${intensity * 0.45})`;
      ctx.fillRect(fx * CS, fy * CS, CS, CS);
    }

    // ---- Goal ----
    {
      const cx = gx * CS + CS / 2, cy = gy * CS + CS / 2;
      if (allDone) {
        const p = .72 + .28 * Math.sin(phase * 4.5);
        ctx.save();
        ctx.shadowColor = '#2ed573'; ctx.shadowBlur = 20 * p;
        const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, CS * .46);
        g.addColorStop(0, `rgba(46,213,115,${.7 + .3 * p})`);
        g.addColorStop(1, 'rgba(46,213,115,0)');
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(cx, cy, CS * .46, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
        ctx.fillStyle = '#fff';
      } else {
        ctx.fillStyle = 'rgba(200,195,185,.55)';
        ctx.beginPath(); ctx.arc(cx, cy, CS * .36, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = 'rgba(140,130,115,.9)';
      }
      ctx.font = `bold ${CS * .44}px serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('★', cx, cy);
    }

    // ---- Hiragana chars ----
    const target = sequence[seqIdx];
    for (const [key, char] of charMap) {
      const [cx, cy] = key.split(',').map(Number);
      const mx = cx * CS + CS / 2, my = cy * CS + CS / 2;
      const isTarget = !allDone && char === target;

      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';

      if (isTarget) {
        const p = .6 + .4 * Math.sin(phase * 5.2);
        ctx.save();
        ctx.shadowColor = '#ff6b6b'; ctx.shadowBlur = 14 * p;
        const bg = ctx.createRadialGradient(mx, my, 0, mx, my, CS * .44);
        bg.addColorStop(0, `rgba(255,107,107,${.55 + .35 * p})`);
        bg.addColorStop(.6, `rgba(255,107,107,${.15 * p})`);
        bg.addColorStop(1, 'rgba(255,107,107,0)');
        ctx.fillStyle = bg;
        ctx.beginPath(); ctx.arc(mx, my, CS * .44, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
        ctx.fillStyle = '#c0000e';
        ctx.font = `900 ${CS * .54}px "Noto Sans JP", "Hiragino Sans", sans-serif`;
      } else {
        // dim non-target
        const isDecoy = this.mode === 'word' && !this.sequence.includes(char);
        if (isDecoy) {
          ctx.fillStyle = 'rgba(120,108,90,.5)';
          ctx.font = `400 ${CS * .4}px "Noto Sans JP", "Hiragino Sans", sans-serif`;
        } else {
          ctx.fillStyle = 'rgba(80,68,55,.85)';
          ctx.font = `600 ${CS * .46}px "Noto Sans JP", "Hiragino Sans", sans-serif`;
        }
      }
      ctx.fillText(char, mx, my);
    }

    // ---- Player ----
    {
      const cx = this.sx, cy = this.sy;
      const r  = CS * .34;

      // shadow
      ctx.save();
      ctx.globalAlpha = .28;
      ctx.fillStyle = '#000';
      ctx.beginPath();
      ctx.ellipse(cx, cy + r * .8, r * .7, r * .25, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      // glow
      ctx.save();
      ctx.shadowColor = '#fdcb6e'; ctx.shadowBlur = 10;
      const g = ctx.createRadialGradient(cx - r * .28, cy - r * .28, r * .05, cx, cy, r);
      g.addColorStop(0, '#fff5c8');
      g.addColorStop(.4, '#fdcb6e');
      g.addColorStop(1, '#e17055');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
      ctx.restore();

      // eyes
      ctx.fillStyle = '#2d3436';
      ctx.beginPath(); ctx.arc(cx - r * .27, cy - r * .1, r * .1, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(cx + r * .27, cy - r * .1, r * .1, 0, Math.PI * 2); ctx.fill();

      // smile
      ctx.strokeStyle = '#2d3436'; ctx.lineWidth = r * .1; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.arc(cx, cy + r * .12, r * .22, 0.1, Math.PI - 0.1); ctx.stroke();
    }

    // ---- Particles ----
    for (const p of this.parts) {
      ctx.save();
      ctx.globalAlpha = Math.max(0, p.life);
      ctx.fillStyle = `hsl(${p.hue},100%,62%)`;
      ctx.shadowColor = `hsl(${p.hue},100%,70%)`; ctx.shadowBlur = 6;
      ctx.beginPath(); ctx.arc(p.x, p.y, Math.max(.5, p.r * p.life), 0, Math.PI * 2); ctx.fill();
      if (p.char) {
        ctx.fillStyle = '#fff';
        ctx.font = `900 ${p.r * 2.2}px "Noto Sans JP", sans-serif`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(p.char, p.x, p.y);
      }
      ctx.restore();
    }
  }

  // ---- Cleanup ----
  destroy() {
    cancelAnimationFrame(this.raf);
    document.removeEventListener('keydown', this._onKey);
    document.removeEventListener('touchstart', this._onTS);
    document.removeEventListener('touchend',   this._onTE);
    const tEl = document.getElementById('target-chars');
    if (tEl && this._onTargetTap) tEl.removeEventListener('click', this._onTargetTap);
    if (voice.synth) voice.synth.cancel();
  }
}

// ============================================================
// UI
// ============================================================
let currentGame = null;
let currentMode = null;

function setScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

function _scaleCanvas() {
  const canvas = document.getElementById('canvas');
  if (!canvas) return;
  const pad   = 20;
  const hudH  = 52;
  const dpadH = window.matchMedia('(hover:none)').matches ? 120 : 0;
  const avW   = window.innerWidth  - pad;
  const avH   = window.innerHeight - hudH - dpadH - pad * 2;
  const scale = Math.min(avW / CANVAS_SIZE, avH / CANVAS_SIZE, 1);
  canvas.style.transform = `scale(${scale})`;
  canvas.style.marginBottom = `${-(CANVAS_SIZE * (1 - scale))}px`;
}

function startGame(mode) {
  currentMode = mode;
  voice.unlock(); // iOS audio gesture
  setScreen('screen-game');

  const canvas = document.getElementById('canvas');
  canvas.width  = CANVAS_SIZE;
  canvas.height = CANVAS_SIZE;
  canvas.style.transform = '';
  canvas.style.marginBottom = '';

  if (currentGame) currentGame.destroy();
  currentGame = new Game(canvas, mode);

  _scaleCanvas();

  if (mode === 'word' && currentGame.word) {
    setTimeout(() => voice.speak(`${currentGame.word}を、あつめよう！`, { rate: 0.95, pitch: 1.15 }), 350);
  } else if (mode === 'order') {
    setTimeout(() => voice.speak('あいうえお じゅんに、あつめよう！', { rate: 0.95, pitch: 1.15 }), 350);
  }
}

function goToMenu() {
  if (currentGame) { currentGame.destroy(); currentGame = null; }
  setScreen('screen-menu');
}

function restartGame() {
  if (currentMode) startGame(currentMode);
}

function showWin(elapsed, word) {
  setScreen('screen-win');
  const m = Math.floor(elapsed / 60);
  const s = Math.floor(elapsed % 60);
  document.getElementById('win-time').textContent = `${m}:${s.toString().padStart(2, '0')}`;
  const ww = document.getElementById('win-word-wrap');
  ww.textContent = word ? `「${word}」を集めた！` : 'あ〜ん全部集めた！';
}

window.addEventListener('resize', _scaleCanvas);
voice.init();

// ============================================================
// Stars (menu background)
// ============================================================
window.addEventListener('load', () => {
  const wrap = document.querySelector('.stars');
  if (!wrap) return;
  for (let i = 0; i < 70; i++) {
    const s = document.createElement('div');
    s.className = 'star';
    const sz = 1 + Math.random() * 2.2;
    s.style.cssText = [
      `left:${Math.random() * 100}%`,
      `top:${Math.random() * 100}%`,
      `width:${sz}px`,
      `height:${sz}px`,
      `animation-delay:${Math.random() * 4}s`,
      `animation-duration:${2 + Math.random() * 3}s`,
    ].join(';');
    wrap.appendChild(s);
  }
});

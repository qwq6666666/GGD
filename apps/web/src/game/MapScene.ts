import Phaser from 'phaser';
import { findPath, type MapState } from '@ss/sim';
import type { MapData, NpcView, Snapshot } from '../protocol.js';

export const T = 16;
const SEASON_GRASS = [0x6fae52, 0x4f9a3e, 0xb9a24a, 0xdbe6ec];
const SEASON_TREE = [0x3f7d3a, 0x2f6b2f, 0x9a5a2a, 0x9fb3a8];
const GROUP_COLOR = [0x4caf50, 0xff9800, 0xab47bc, 0x90a4ae];
const ROOF = [0xb5523b, 0x8d6e63, 0x3f6fb5];

export interface SceneHooks {
  onTapTile(x: number, y: number): void;
  onSelectNpc(id: number): void;
  onSelectBuilding(id: number): void;
  onCameraMove?(): void;
  /** 目前是否為一般選取模式；建設模式下點擊一律當作點格子。 */
  selecting(): boolean;
}

export interface Ghost {
  x: number;
  y: number;
  w: number;
  h: number;
  ok: boolean;
}

function hash2(x: number, y: number): number {
  let h = Math.imul(x, 73856093) ^ Math.imul(y, 19349663);
  h = Math.imul(h ^ (h >>> 13), 0x5bd1e995);
  return (h ^ (h >>> 15)) >>> 0;
}

interface Walker {
  /** 邏輯位置（像素）；顯示位置再加上走路／工作的晃動 */
  x: number;
  y: number;
  path: { x: number; y: number }[];
  speed: number;
  tx: number;
  ty: number;
  state: number;
  emoteAt: number;
  flip: boolean;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  age: number;
  life: number;
  r: number;
  color: number;
  alpha: number;
}

const TOOL_EMOJI: Record<string, string> = { farm: '🌾', lumber: '🪓', quarry: '⛏', toolshop: '🔧', furnshop: '🪑' };

export class MapScene extends Phaser.Scene {
  hooks!: SceneHooks;
  reduceMotion = false;
  private map: MapData | null = null;
  private snap: Snapshot | null = null;
  private terrain!: Phaser.GameObjects.Graphics;
  private bGfx!: Phaser.GameObjects.Graphics;
  private overlay!: Phaser.GameObjects.Graphics;
  private rain!: Phaser.GameObjects.Graphics;
  private npcSprites: Record<number, Phaser.GameObjects.Image> = {};
  private ghost: Ghost | null = null;
  private roadPreview: { x: number; y: number }[] = [];
  private selected: { kind: 'npc' | 'building'; id: number } | null = null;
  private buildSig = '';
  private terrainKey = '';
  private dragging = false;
  private pinchDist = 0;
  private followId = 0;
  // ---- 純顯示層動畫（不進模擬狀態，不影響決定性與存檔） ----
  private walkers: Record<number, Walker> = {};
  private fx!: Phaser.GameObjects.Graphics;
  private night!: Phaser.GameObjects.Rectangle;
  private emotes: Record<number, Phaser.GameObjects.Text> = {};
  private particles: Particle[] = [];
  private waterTiles: number[] = [];
  private lastTickAt = 0;
  private lastTick = -1;
  private dayMs = 3000;
  private spawnAcc = 0;

  constructor() {
    super('map');
  }

  /** 程序化像素人物：4 種群體 × 孩童／成人 × 是否玩家家族。 */
  private makeSprites(): void {
    const skin = '#f2c9a0';
    for (let g = 0; g < 4; g++) {
      for (let kid = 0; kid < 2; kid++) {
        for (let pl = 0; pl < 2; pl++) {
          const key = `npc-${g}-${kid}-${pl}`;
          if (this.textures.exists(key)) continue;
          const tex = this.textures.createCanvas(key, 8, 12)!;
          const c = tex.context;
          const col = '#' + GROUP_COLOR[g]!.toString(16).padStart(6, '0');
          const top = kid ? 4 : 1;
          c.fillStyle = pl ? '#ffd54f' : '#3e2723';
          c.fillRect(2, top, 4, 1);
          c.fillStyle = skin;
          c.fillRect(2, top + 1, 4, 2);
          c.fillStyle = col;
          c.fillRect(1, top + 3, 6, kid ? 3 : 4);
          c.fillStyle = '#37474f';
          c.fillRect(2, top + (kid ? 6 : 7), 1, 2);
          c.fillRect(5, top + (kid ? 6 : 7), 1, 2);
          tex.refresh();
        }
      }
    }
  }

  create(): void {
    this.makeSprites();
    this.terrain = this.add.graphics();
    this.bGfx = this.add.graphics();
    this.overlay = this.add.graphics().setDepth(50);
    this.rain = this.add.graphics().setDepth(60);
    this.fx = this.add.graphics().setDepth(24);
    this.night = this.add.rectangle(0, 0, 8000, 8000, 0x0b1a3a, 0).setDepth(45).setScrollFactor(0);
    const cam = this.cameras.main;
    cam.setBackgroundColor(0x1f261c);
    cam.setZoom(1.3);
    cam.centerOn(48 * T, 46 * T);
    this.input.addPointer(1);
    this.input.on('pointerdown', () => {
      this.dragging = false;
    });
    this.input.on('pointermove', (p: Phaser.Input.Pointer) => {
      const p1 = this.input.pointer1;
      const p2 = this.input.pointer2;
      if (p1.isDown && p2.isDown) {
        const d = Phaser.Math.Distance.Between(p1.x, p1.y, p2.x, p2.y);
        if (this.pinchDist > 0) this.setZoom(cam.zoom * (d / this.pinchDist));
        this.pinchDist = d;
        this.dragging = true;
        return;
      }
      this.pinchDist = 0;
      if (p.isDown && p.getDistance() > 8) {
        this.dragging = true;
        this.followId = 0;
        cam.scrollX -= (p.x - p.prevPosition.x) / cam.zoom;
        cam.scrollY -= (p.y - p.prevPosition.y) / cam.zoom;
        this.hooks.onCameraMove?.();
      }
    });
    this.input.on('pointerup', (p: Phaser.Input.Pointer) => {
      this.pinchDist = 0;
      if (this.dragging || p.getDistance() > 8) return;
      this.tap(p);
    });
    this.input.on('wheel', (_p: unknown, _o: unknown, _dx: number, dy: number) => this.setZoom(cam.zoom * (dy > 0 ? 0.9 : 1.1)));
    if (this.map) this.drawTerrain();
  }

  private setZoom(z: number): void {
    this.cameras.main.setZoom(Phaser.Math.Clamp(z, 0.7, 4));
  }

  zoomBy(f: number): void {
    this.setZoom(this.cameras.main.zoom * f);
  }

  private tap(p: Phaser.Input.Pointer): void {
    const wp = this.cameras.main.getWorldPoint(p.x, p.y);
    const tx = Math.floor(wp.x / T);
    const ty = Math.floor(wp.y / T);
    if (!this.snap) return;
    if (!this.hooks.selecting()) {
      this.hooks.onTapTile(tx, ty);
      return;
    }
    let best: NpcView | null = null;
    let bd = 14;
    for (const n of this.snap.npcs) {
      const s = this.npcSprites[n.id];
      if (!s) continue;
      const d = Phaser.Math.Distance.Between(wp.x, wp.y, s.x, s.y);
      if (d < bd) {
        bd = d;
        best = n;
      }
    }
    if (best) {
      this.hooks.onSelectNpc(best.id);
      return;
    }
    const b = this.snap.buildings.find((q) => tx >= q.x && tx < q.x + q.w && ty >= q.y && ty < q.y + q.h);
    if (b) {
      this.hooks.onSelectBuilding(b.id);
      return;
    }
    this.hooks.onTapTile(tx, ty);
  }

  setMap(map: MapData): void {
    this.map = map;
    this.waterTiles = [];
    for (let i = 0; i < map.water.length; i++) if (map.water[i]) this.waterTiles.push(i);
    if (this.terrain) this.drawTerrain();
  }

  setSnapshot(snap: Snapshot): void {
    const first = !this.snap;
    if (snap.tick !== this.lastTick) {
      const now = performance.now();
      if (this.lastTick >= 0 && snap.tick > this.lastTick) this.dayMs = Phaser.Math.Clamp(this.dayMs * 0.6 + ((now - this.lastTickAt) / (snap.tick - this.lastTick)) * 0.4, 40, 3200);
      this.lastTickAt = now;
      this.lastTick = snap.tick;
    }
    this.snap = snap;
    if (!this.terrain) return;
    if (this.terrainKey !== `${snap.season}|${snap.mapKey}`) this.drawTerrain();
    const sig = snap.buildings.map((b) => `${b.id}${b.state}${b.stage}`).join(',') + '|' + snap.season + '|' + snap.enterprises.map((e) => e.fallow).join('');
    if (sig !== this.buildSig) {
      this.buildSig = sig;
      this.drawBuildings();
    }
    this.syncNpcs();
    this.drawWeather();
    this.drawOverlay();
    if (first) this.cameras.main.centerOn(48 * T, 48 * T);
    if (this.followId) {
      const s = this.npcSprites[this.followId];
      if (s) this.cameras.main.pan(s.x, s.y, 250);
    }
  }

  follow(id: number): void {
    this.followId = id;
  }
  centerOn(tx: number, ty: number): void {
    this.cameras.main.pan(tx * T + 8, ty * T + 8, 300);
  }
  setGhost(g: Ghost | null): void {
    this.ghost = g;
    this.drawOverlay();
  }
  setRoadPreview(tiles: { x: number; y: number }[]): void {
    this.roadPreview = tiles;
    this.drawOverlay();
  }
  select(sel: { kind: 'npc' | 'building'; id: number } | null): void {
    this.selected = sel;
    this.drawOverlay();
  }

  private drawTerrain(): void {
    const m = this.map;
    if (!m || !this.snap) return;
    this.terrainKey = `${this.snap.season}|${this.snap.mapKey}`;
    const g = this.terrain;
    g.clear();
    const season = this.snap.season;
    for (let y = 0; y < m.h; y++) {
      for (let x = 0; x < m.w; x++) {
        const i = y * m.w + x;
        const r = hash2(x, y);
        let base = SEASON_GRASS[season]!;
        if (m.water[i]) base = 0x3b78b5;
        else if (m.stone[i]) base = 0x8a8a8a;
        else if (m.height[i]! >= 3) base = 0x6d5d50;
        else if (m.height[i]! === 2) base = season === 3 ? 0xc6cfd2 : 0x8f9a56;
        g.fillStyle(base, 1);
        g.fillRect(x * T, y * T, T, T);
        // 像素雜點
        g.fillStyle(0x000000, 0.07);
        g.fillRect(x * T + (r % 12), y * T + ((r >> 4) % 12), 2, 2);
        if (m.water[i]) {
          g.fillStyle(0xffffff, 0.25);
          g.fillRect(x * T + (r % 10), y * T + 6 + ((r >> 3) % 4), 5, 1);
        }
        if (m.stone[i]) {
          g.fillStyle(0x5f5f5f, 1);
          g.fillRect(x * T + 3, y * T + 4, 5, 4);
          g.fillRect(x * T + 9, y * T + 9, 5, 4);
        }
        const f = m.forest[i]!;
        if (f > 0) {
          const n = f > 700 ? 3 : f > 350 ? 2 : 1;
          g.fillStyle(SEASON_TREE[season]!, 1);
          for (let k = 0; k < n; k++) {
            const ox = 2 + ((r >> (k * 3)) % 9) + k * 2;
            const oy = 2 + ((r >> (k * 5 + 1)) % 8) + k * 2;
            g.fillRect(x * T + Math.min(ox, 11), y * T + Math.min(oy, 10), 5, 5);
            g.fillStyle(0x5d3a1a, 1);
            g.fillRect(x * T + Math.min(ox, 11) + 2, y * T + Math.min(oy, 10) + 5, 1, 2);
            g.fillStyle(SEASON_TREE[season]!, 1);
          }
        }
        const rd = m.road[i]!;
        if (rd) {
          g.fillStyle(rd === 2 ? 0x9a9a9a : rd === 1 ? 0xb08d57 : 0x8b6b3d, 1);
          g.fillRect(x * T, y * T + 3, T, T - 6);
          g.fillRect(x * T + 3, y * T, T - 6, T);
          g.fillStyle(0x000000, 0.12);
          g.fillRect(x * T + 4, y * T + 7, 2, 2);
        }
      }
    }
  }

  private drawBuildings(): void {
    const s = this.snap;
    if (!s) return;
    const g = this.bGfx;
    g.clear();
    for (const b of s.buildings) {
      const x = b.x * T;
      const y = b.y * T;
      const w = b.w * T;
      const h = b.h * T;
      const building = b.state !== 'active';
      const alpha = building ? 0.55 : 1;
      g.fillStyle(0x000000, 0.25);
      g.fillRect(x + 2, y + 3, w, h);
      const ent = s.enterprises.find((e) => e.buildingId === b.id);
      switch (b.type) {
        case 'field': {
          const fallow = ent?.fallow ?? 0;
          g.fillStyle(s.season === 3 ? 0xe9eef0 : fallow ? 0xb89b6b : 0x8b6a3e, alpha);
          g.fillRect(x, y, w, h);
          for (let r = 0; r < b.h; r++) {
            const gc = s.season === 3 || fallow ? 0x9c8a62 : s.season === 2 ? 0xe0b84a : s.season === 1 ? 0x5fae3f : 0x8dc063;
            g.fillStyle(gc, alpha);
            for (let c = 0; c < b.w * 2; c++) g.fillRect(x + 2 + c * 8, y + 3 + r * T, 4, 8);
          }
          break;
        }
        case 'home':
        case 'publichome': {
          const hh = s.households.find((q) => q.homeId === b.id);
          const roof = b.type === 'publichome' ? 0x2e8b8b : ROOF[hh ? hh.kind % 3 : 1]!;
          g.fillStyle(0xe6d5ae, alpha);
          g.fillRect(x + 2, y + h * 0.4, w - 4, h * 0.6 - 2);
          g.fillStyle(roof, alpha);
          g.fillRect(x, y + 2, w, h * 0.45);
          g.fillStyle(0x000000, 0.2 * alpha);
          g.fillRect(x, y + h * 0.45, w, 2);
          g.fillStyle(0x4e342e, alpha);
          g.fillRect(x + w / 2 - 2, y + h - 8, 4, 7);
          break;
        }
        case 'lumber':
          g.fillStyle(0x7b5a34, alpha);
          g.fillRect(x, y + 4, w, h - 4);
          g.fillStyle(0xc9a26a, alpha);
          for (let i = 0; i < 4; i++) g.fillRect(x + 3 + i * 7, y + 8, 5, 12);
          g.fillStyle(0x5d4125, alpha);
          g.fillRect(x, y, w, 5);
          break;
        case 'quarry':
          g.fillStyle(0x777777, alpha);
          g.fillRect(x, y + 4, w, h - 4);
          g.fillStyle(0xaaaaaa, alpha);
          g.fillRect(x + 4, y + 8, 8, 6);
          g.fillRect(x + 16, y + 14, 8, 8);
          g.fillStyle(0x5a4a3a, alpha);
          g.fillRect(x, y, w, 4);
          break;
        case 'toolshop':
        case 'furnshop':
          g.fillStyle(b.type === 'toolshop' ? 0x546e7a : 0x8d6e63, alpha);
          g.fillRect(x, y + 6, w, h - 6);
          g.fillStyle(b.type === 'toolshop' ? 0x37474f : 0x5d4037, alpha);
          g.fillRect(x - 1, y, w + 2, 8);
          g.fillStyle(0x3e2723, alpha);
          g.fillRect(x + w - 8, y - 3, 4, 8);
          g.fillStyle(0xffca28, alpha);
          g.fillRect(x + 5, y + 14, 6, 6);
          break;
        case 'market':
          g.fillStyle(0xd7ccc8, alpha);
          g.fillRect(x, y + 8, w, h - 8);
          for (let i = 0; i < b.w * 2; i++) {
            g.fillStyle(i % 2 ? 0xffffff : 0xd32f2f, alpha);
            g.fillRect(x + i * 8, y, 8, 10);
          }
          g.fillStyle(0xffb74d, alpha);
          g.fillRect(x + 6, y + 16, 6, 5);
          g.fillRect(x + 28, y + 16, 6, 5);
          break;
        default:
          g.fillStyle(0xa1887f, alpha);
          g.fillRect(x, y + 6, w, h - 6);
          g.fillStyle(0x6d4c41, alpha);
          g.fillRect(x - 1, y, w + 2, 8);
      }
      if (s.season === 3 && b.type !== 'field') {
        g.fillStyle(0xffffff, 0.85 * alpha);
        g.fillRect(x, y, w, 3);
      }
      if (building) {
        g.lineStyle(1, 0xffffff, 0.8);
        g.strokeRect(x, y, w, h);
        g.fillStyle(0xffd54f, 1);
        g.fillRect(x + 2, y + 2, 3, 3);
        g.fillRect(x + w - 5, y + h - 5, 3, 3);
      }
      g.fillStyle(0xfff59d, 0.9);
      g.fillRect(b.ex * T + 6, b.ey * T + 1, 4, 3);
    }
  }

  private syncNpcs(): void {
    const s = this.snap;
    if (!s) return;
    const alive: Record<number, boolean> = {};
    const mapState = this.map as unknown as MapState | null;
    for (const n of s.npcs) {
      alive[n.id] = true;
      let sp = this.npcSprites[n.id];
      const px = n.x * T + 8 + ((n.id * 7) % 9) - 4;
      const py = n.y * T + 10 + ((n.id * 5) % 7) - 3;
      const key = `npc-${n.interestGroup}-${n.age < 16 ? 1 : 0}-${n.controller === 'player' ? 1 : 0}`;
      let wk = this.walkers[n.id];
      if (!sp || !wk) {
        sp = sp ?? this.add.image(px, py, key).setDepth(20).setOrigin(0.5, 0.7);
        this.npcSprites[n.id] = sp;
        wk = { x: px, y: py, path: [], speed: 0, tx: n.x, ty: n.y, state: n.state, emoteAt: 2000 + ((n.id * 937) % 6000), flip: false };
        this.walkers[n.id] = wk;
      } else if (sp.texture.key !== key) sp.setTexture(key);
      sp.setAlpha(n.hunger > 70 ? 0.55 : 1);
      wk.state = n.state;
      if (this.reduceMotion) {
        wk.x = px;
        wk.y = py;
        wk.path = [];
        sp.setPosition(px, py);
        wk.tx = n.x;
        wk.ty = n.y;
        continue;
      }
      if (wk.tx !== n.x || wk.ty !== n.y) {
        // 目的地改變：沿道路走過去。速度快時只直線趨近，避免大量尋路。
        const pts: { x: number; y: number }[] = [];
        const fx0 = Math.floor(wk.x / T);
        const fy0 = Math.floor(wk.y / T);
        const far = Math.abs(fx0 - n.x) + Math.abs(fy0 - n.y) > 70;
        if (mapState && this.dayMs >= 250 && !far) {
          const p = findPath(mapState, Phaser.Math.Clamp(fx0, 0, mapState.w - 1), Phaser.Math.Clamp(fy0, 0, mapState.h - 1), n.x, n.y);
          if (p) for (const i of p.steps) pts.push({ x: (i % mapState.w) * T + 8 + ((n.id * 3) % 5) - 2, y: Math.floor(i / mapState.w) * T + 10 });
        }
        pts.push({ x: px, y: py });
        let len = 0;
        let lx = wk.x;
        let ly = wk.y;
        for (const q of pts) {
          len += Math.hypot(q.x - lx, q.y - ly);
          lx = q.x;
          ly = q.y;
        }
        wk.path = pts;
        // 一天的 85% 時間內走完；至少每秒 14 像素，避免慢吞吞
        wk.speed = Math.max(14, len / (Math.max(250, this.dayMs * 0.85) / 1000));
        wk.tx = n.x;
        wk.ty = n.y;
      }
    }
    for (const id of Object.keys(this.npcSprites).map(Number)) {
      if (!alive[id]) {
        this.npcSprites[id]!.destroy();
        delete this.npcSprites[id];
        delete this.walkers[id];
        this.emotes[id]?.destroy();
        delete this.emotes[id];
      }
    }
  }

  /** 每幀：人物走路與工作動作、頭上圖示、晝夜、煙、雲影、飛鳥、水面閃光、工地揚塵。 */
  override update(time: number, delta: number): void {
    const s = this.snap;
    if (!s || !this.terrain) return;
    const fx = this.fx;
    fx.clear();
    if (this.reduceMotion) {
      this.night.setAlpha(0);
      for (const t of Object.values(this.emotes)) t.setVisible(false);
      return;
    }
    const dt = Math.min(delta, 100) / 1000;
    const cam = this.cameras.main;
    const view = cam.worldView;
    // --- 人物 ---
    const toolOf = (n: NpcView): string => {
      if (n.jobKind === 1) {
        const e = s.enterprises.find((x) => x.id === n.jobId);
        return e ? TOOL_EMOJI[e.kind] ?? '🔨' : '🔨';
      }
      return n.jobKind === 2 ? '🔨' : '';
    };
    for (const n of s.npcs) {
      const sp = this.npcSprites[n.id];
      const wk = this.walkers[n.id];
      if (!sp || !wk) continue;
      let ox = 0;
      let oy = 0;
      if (wk.path.length) {
        const q = wk.path[0]!;
        const dx = q.x - wk.x;
        const dy = q.y - wk.y;
        const d = Math.hypot(dx, dy);
        const step = wk.speed * dt;
        if (d <= step) {
          wk.x = q.x;
          wk.y = q.y;
          wk.path.shift();
        } else {
          wk.x += (dx / d) * step;
          wk.y += (dy / d) * step;
        }
        if (Math.abs(dx) > 0.5) wk.flip = dx < 0;
        const ph = time / 90 + n.id;
        oy = -Math.abs(Math.sin(ph)) * 2.2; // 走路時上下彈跳
        ox = Math.sin(ph) * 0.6;
      } else if (wk.state === 5) {
        // 工作中：來回揮動
        const ph = time / 140 + n.id * 1.7;
        ox = Math.sin(ph) * 2.2;
        oy = -Math.max(0, Math.sin(ph * 2)) * 1.6;
      } else if (wk.state === 7 || n.hunger > 70) {
        oy = Math.sin(time / 600 + n.id) * 0.5; // 休息／疲憊：緩慢起伏
      } else {
        // 閒置：偶爾左右踱步
        ox = Math.sin(time / 1700 + n.id * 2.3) * 2.5;
        oy = -Math.max(0, Math.sin(time / 330 + n.id)) * 0.8 * (Math.sin(time / 1700 + n.id * 2.3) > 0.7 ? 1 : 0);
        if (Math.abs(Math.cos(time / 1700 + n.id * 2.3)) > 0.1) wk.flip = Math.cos(time / 1700 + n.id * 2.3) < 0;
      }
      sp.setPosition(wk.x + ox, wk.y + oy);
      sp.setFlipX(wk.flip);
      sp.setDepth(20 + wk.y / 1000);
      // 頭上圖示
      const visible = wk.x > view.x - 20 && wk.x < view.right + 20 && wk.y > view.y - 20 && wk.y < view.bottom + 20 && cam.zoom >= 1;
      let icon = '';
      if (n.hunger > 70) icon = '🍞';
      else if (time > wk.emoteAt && time < wk.emoteAt + 1500) icon = wk.state === 7 ? '💤' : wk.state === 5 ? toolOf(n) : wk.path.length ? '' : n.mood < 35 ? '💧' : n.mood > 75 ? '♪' : '';
      if (time > wk.emoteAt + 1500) wk.emoteAt = time + 3500 + ((n.id * 613 + Math.floor(time / 1000)) % 7000);
      let t = this.emotes[n.id];
      if (icon && visible) {
        if (!t) {
          t = this.add.text(0, 0, icon, { fontSize: '9px' }).setOrigin(0.5, 1).setDepth(30);
          this.emotes[n.id] = t;
        }
        const rise = n.hunger > 70 ? Math.sin(time / 300) * 1.5 : ((time - wk.emoteAt) / 1500) * 5;
        if (t.text !== icon) t.setText(icon);
        t.setVisible(true).setPosition(sp.x, sp.y - 11 - rise);
      } else if (t) t.setVisible(false);
    }
    // --- 晝夜（45 秒一個循環，純顯示） ---
    const phase = (time / 45000) % 1;
    const dark = Math.max(0, Math.sin(phase * Math.PI * 2 - Math.PI / 2) * 0.5 + 0.5 - 0.45) / 0.55; // 0..1，夜晚為 1
    const dusk = Math.max(0, 1 - Math.abs(dark - 0.35) * 4) * (phase > 0.5 ? 1 : 0.6);
    this.night.setPosition(cam.width / 2, cam.height / 2);
    this.night.setFillStyle(dark > 0.2 ? 0x0b1a3a : 0xff9a3c, Math.max(dark * 0.34, dusk * 0.12));
    // 窗戶燈光
    if (dark > 0.25) {
      for (const b of s.buildings) {
        if (b.state !== 'active' || (b.type !== 'home' && b.type !== 'publichome')) continue;
        fx.fillStyle(0xffd27a, Math.min(0.9, dark));
        fx.fillRect(b.x * T + 4, b.y * T + b.h * T * 0.5, 3, 3);
        fx.fillRect(b.x * T + b.w * T - 8, b.y * T + b.h * T * 0.5, 3, 3);
        fx.fillStyle(0xffd27a, 0.14 * dark);
        fx.fillCircle(b.x * T + (b.w * T) / 2, b.y * T + b.h * T, 20);
      }
    }
    // --- 粒子：煙、揚塵 ---
    this.spawnAcc += delta;
    if (this.spawnAcc > 380) {
      this.spawnAcc = 0;
      for (const b of s.buildings) {
        const bx = b.x * T;
        const by = b.y * T;
        const inView = bx > view.x - 40 && bx < view.right + 40 && by > view.y - 40 && by < view.bottom + 40;
        if (!inView) continue;
        if (b.state === 'active' && (b.type === 'home' || b.type === 'toolshop' || b.type === 'furnshop') && (b.id + Math.floor(time / 380)) % 3 === 0) {
          this.particles.push({ x: bx + b.w * T - 6, y: by + 2, vx: 3 + (s.weather ? -1 : 0), vy: -9, age: 0, life: 2400, r: 2, color: 0xdddddd, alpha: 0.5 });
        } else if (b.state !== 'active' && (b.id + Math.floor(time / 380)) % 2 === 0) {
          this.particles.push({ x: bx + Math.random() * b.w * T, y: by + b.h * T - 2, vx: (Math.random() - 0.5) * 8, vy: -5, age: 0, life: 900, r: 2.5, color: 0xc2a574, alpha: 0.6 });
        }
      }
      if (this.particles.length > 160) this.particles.splice(0, this.particles.length - 160);
    }
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i]!;
      p.age += delta;
      if (p.age >= p.life) {
        this.particles.splice(i, 1);
        continue;
      }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      const k = p.age / p.life;
      fx.fillStyle(p.color, p.alpha * (1 - k));
      fx.fillCircle(p.x, p.y, p.r * (1 + k * 1.4));
    }
    // --- 雲影 ---
    const W = (this.map?.w ?? 96) * T;
    for (let i = 0; i < 4; i++) {
      const cx = ((time / 1000) * (5 + i * 1.5) + i * 520) % (W + 400) - 200;
      const cy = 180 + i * 340 + Math.sin(time / 9000 + i) * 20;
      fx.fillStyle(0x000000, s.weather ? 0.12 : 0.06);
      fx.fillEllipse(cx, cy, 190 + i * 30, 70 + i * 10);
    }
    // --- 水面閃光 ---
    if (this.waterTiles.length) {
      const base = Math.floor(time / 450);
      for (let k = 0; k < 14; k++) {
        const idx = this.waterTiles[(base * 31 + k * 977) % this.waterTiles.length]!;
        const m = this.map!;
        const x = (idx % m.w) * T;
        const y = Math.floor(idx / m.w) * T;
        if (x < view.x - 16 || x > view.right || y < view.y - 16 || y > view.bottom) continue;
        const a = Math.max(0, Math.sin(((time % 450) / 450) * Math.PI));
        fx.fillStyle(0xffffff, 0.55 * a);
        fx.fillRect(x + ((idx * 7) % 11), y + ((idx * 5) % 11), 3, 1);
      }
    }
    // --- 飛鳥 ---
    for (let i = 0; i < 4; i++) {
      const bx = ((time / 1000) * (24 + i * 4) + i * 330) % (W + 200) - 100;
      const by = 260 + i * 260 + Math.sin(time / 1300 + i * 2) * 26;
      const flap = Math.sin(time / 90 + i * 3) * 2.5;
      fx.lineStyle(1, 0x2b2b2b, 0.7);
      fx.lineBetween(bx - 4, by - flap, bx, by);
      fx.lineBetween(bx, by, bx + 4, by - flap);
    }
  }

  private drawWeather(): void {
    const g = this.rain;
    g.clear();
    if (!this.snap || !this.snap.weather || this.reduceMotion) return;
    const cam = this.cameras.main;
    g.lineStyle(1, 0xcfe3ff, 0.5);
    for (let i = 0; i < 70; i++) {
      const x = cam.scrollX + Math.random() * cam.width / cam.zoom;
      const y = cam.scrollY + Math.random() * cam.height / cam.zoom;
      g.lineBetween(x, y, x - 2, y + 6);
    }
  }

  private drawOverlay(): void {
    const g = this.overlay;
    g.clear();
    const s = this.snap;
    const m = this.map;
    if (m) {
      // 可建區以外壓暗，邊界畫線：看得到村子能長到哪
      const a = m.zmin * T;
      const b = m.zmax * T;
      const full = m.w * T;
      g.fillStyle(0x000000, 0.16);
      g.fillRect(0, 0, full, a);
      g.fillRect(0, b, full, full - b);
      g.fillRect(0, a, a, b - a);
      g.fillRect(b, a, full - b, b - a);
      g.lineStyle(2, 0xffe08a, 0.55);
      g.strokeRect(a, a, b - a, b - a);
    }
    if (s) {
      for (const z of s.zones) {
        g.fillStyle(z.kind === 0 ? 0x2e7d32 : 0xfbc02d, 0.18);
        g.fillRect(z.x * T, z.y * T, z.w * T, z.h * T);
        g.lineStyle(1, z.kind === 0 ? 0x2e7d32 : 0xfbc02d, 0.8);
        g.strokeRect(z.x * T, z.y * T, z.w * T, z.h * T);
      }
      // 施工中的道路
      for (const wk of s.works) if (wk.kind === 'road') for (const t of wk.tiles) {
        g.fillStyle(0xffffff, 0.35);
        g.fillRect(t.x * T + 2, t.y * T + 2, T - 4, T - 4);
      }
    }
    if (this.selected && s) {
      g.lineStyle(2, 0xffeb3b, 1);
      if (this.selected.kind === 'building') {
        const b = s.buildings.find((q) => q.id === this.selected!.id);
        if (b) g.strokeRect(b.x * T - 1, b.y * T - 1, b.w * T + 2, b.h * T + 2);
      } else {
        const sp = this.npcSprites[this.selected.id];
        if (sp) g.strokeCircle(sp.x, sp.y, 8);
      }
    }
    for (const t of this.roadPreview) {
      g.fillStyle(0x80d8ff, 0.6);
      g.fillRect(t.x * T + 2, t.y * T + 2, T - 4, T - 4);
    }
    if (this.ghost) {
      const gh = this.ghost;
      g.fillStyle(gh.ok ? 0x66bb6a : 0xef5350, 0.5);
      g.fillRect(gh.x * T, gh.y * T, gh.w * T, gh.h * T);
      g.lineStyle(2, gh.ok ? 0xa5d6a7 : 0xffcdd2, 1);
      g.strokeRect(gh.x * T, gh.y * T, gh.w * T, gh.h * T);
      g.fillStyle(0xfff59d, 1);
      g.fillRect((gh.x + Math.floor(gh.w / 2)) * T + 5, (gh.y + gh.h) * T + 1, 6, 4);
    }
  }
}

export function startGame(parent: HTMLElement, hooks: SceneHooks): Promise<MapScene> {
  return new Promise((resolve) => {
    const scene = new MapScene();
    scene.hooks = hooks;
    const game = new Phaser.Game({
      type: Phaser.AUTO,
      parent,
      backgroundColor: '#1f261c',
      scale: { mode: Phaser.Scale.RESIZE, width: '100%', height: '100%' },
      render: { pixelArt: true, antialias: false, roundPixels: true },
      scene,
      audio: { noAudio: true },
    });
    game.events.once('ready', () => resolve(scene));
  });
}

import { ECON, GOALS } from '@ss/content';
import { findPath, footprintOf as _fp, validatePlacement, type BuildingType, type MapState } from '@ss/sim';
import type { Ghost, MapScene } from './game/MapScene.js';
import { BUILDING_ICON, BUILDING_LABEL, COMMODITIES, COM_ICON, FAMILIES, GROUPS, GROUP_ICON, more, tag, POLICY_LABEL, POLICY_RANGE, PROPOSAL_ICON, PROPOSAL_LABEL, SEASONS, STATE_LABEL, TRAIT_LABEL, esc, reasonText } from './i18n.js';
import type { NpcView, Snapshot, Speed } from './protocol.js';
import type { Store } from './store.js';

void _fp;
type Mode = { kind: 'select' } | { kind: 'place'; type: string } | { kind: 'road'; mode: string } | { kind: 'zone'; zone: number };

const BUILD_OPTIONS: { id: string; label: string; mode: Mode; note: string }[] = [
  { id: 'road', label: '土路', mode: { kind: 'road', mode: 'dirt' }, note: '點兩個地點，沿最短路線鋪路。降低通勤成本。' },
  { id: 'stone', label: '石路', mode: { kind: 'road', mode: 'stone' }, note: '把既有土路升級為石路（成本 1），點兩個地點。需要石材。' },
  { id: 'bridge', label: '木橋', mode: { kind: 'road', mode: 'bridge' }, note: '在水面鋪木橋，點兩個地點。' },
  { id: 'stonebridge', label: '石橋', mode: { kind: 'road', mode: 'stonebridge' }, note: '把木橋升級為石橋。' },
  { id: 'publichome', label: '公共住宅', mode: { kind: 'place', type: 'publichome' }, note: '容納 5 人；家庭可入住並繳租（V1 免租）。' },
  { id: 'field', label: '農田', mode: { kind: 'place', type: 'field' }, note: '下次收成才增產；耕作會逐年消耗肥力。' },
  { id: 'lumber', label: '林場', mode: { kind: 'place', type: 'lumber' }, note: '提供木材與燃料；會減少周圍森林。' },
  { id: 'quarry', label: '採石場', mode: { kind: 'place', type: 'quarry' }, note: '需貼近礦藏（東北方）。' },
  { id: 'toolshop', label: '工具工坊', mode: { kind: 'place', type: 'toolshop' }, note: '生產工具，需要木材與石材。' },
  { id: 'furnshop', label: '家具工坊', mode: { kind: 'place', type: 'furnshop' }, note: '收入上升後家具需求才會成長。' },
  { id: 'school', label: '學堂', mode: { kind: 'place', type: 'school' }, note: '學齡兒童技能成長；需另設教育預算才運作。' },
  { id: 'clinic', label: '診所', mode: { kind: 'place', type: 'clinic' }, note: '縮短病程、降低死亡率；需另設醫療預算才運作。' },
  { id: 'zone1', label: '商業用地', mode: { kind: 'zone', zone: 1 }, note: '劃設後，有足夠資金的家庭會依序開設工坊。點兩個對角。' },
  { id: 'zone0', label: '保育區', mode: { kind: 'zone', zone: 0 }, note: '劃定後林場不會砍伐此範圍。點兩個對角。' },
  { id: 'zone2', label: '植林', mode: { kind: 'zone', zone: 2 }, note: '在可建區外的空地植樹，每格 2 文。點兩個對角。' },
];

const BUILD_ICON: Record<string, string> = { road: '🟫', stone: '🪨', bridge: '🌉', stonebridge: '🏛', publichome: '🏘', field: '🌾', lumber: '🪓', quarry: '⛏', toolshop: '🔧', furnshop: '🪑', school: '🏫', clinic: '⚕', zone1: '💼', zone0: '🌳', zone2: '🌱' };

const BUILD_WHY: Record<string, { groups: string; short: string; risk: string }> = {
  school: { groups: '學齡兒童與其家庭', short: '施工後設定教育預算才有效果', risk: '每季教育經費；孩子成年後才見成果' },
  clinic: { groups: '全體居民，特別是老人', short: '疫病時病程縮短、死亡率下降', risk: '每季醫療經費' },
  stone: { groups: '常走該路線的居民', short: '通行成本再降一半', risk: '消耗石材，與工坊競爭' },
  bridge: { groups: '兩岸居民', short: '打通對岸', risk: '洪水可能沖毀木橋' },
  stonebridge: { groups: '兩岸居民', short: '不怕洪水', risk: '石材與人日較高' },
  zone1: { groups: '有資金的家庭與其雇工', short: '新工坊提供就業與商品', risk: '市場小，可能虧損後結業' },
  road: { groups: '路線沿線的住戶與農田', short: '通勤成本下降，產量上升', risk: '偏袒判定：只惠及自家會被察覺' },
  publichome: { groups: '無屋或擁擠的家庭', short: '住房餘裕提高，聚落吸引力上升', risk: '佔用公共資金與木石' },
  field: { groups: '業主家庭與受雇農工', short: '施工期間不增糧', risk: '下次收成才增產；肥力下降、需輪作' },
  lumber: { groups: '燃料與建材使用者', short: '木材供給增加', risk: '森林減少；可用保育區與植林平衡' },
  quarry: { groups: '工坊與公共工程', short: '石材供給增加', risk: '礦藏有限' },
  toolshop: { groups: '全體工作者', short: '工具供給改善，產量係數回升', risk: '原料需求推高木石價格' },
  furnshop: { groups: '富裕家庭', short: '舒適度提升', risk: '需求有飽和點，可能虧損' },
};

export class Ui {
  tab: string | null = null;
  sub: Record<string, string> = { world: 'goals', history: 'events' };
  mode: Mode = { kind: 'select' };
  anchor: { x: number; y: number } | null = null;
  rect: { x: number; y: number } | null = null;
  roadTiles: { x: number; y: number }[] = [];
  card: { kind: 'npc' | 'building'; id: number } | null = null;
  draft: Record<string, number> = {};
  priceHist: { week: number; prices: number[] }[] = [];
  settings = { fs: 15, reduce: false };
  private lastSheetKey = '';
  private dragging = false;
  private tutStep = 0;
  private tutSeen = false;
  private order = { node: 1, item: 0, qty: 50 };

  constructor(private store: Store, private scene: MapScene) {
    const q = <T extends HTMLElement>(s: string): T => document.querySelector(s) as T;
    q('#bottom').addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest('button[data-tab]') as HTMLElement | null;
      if (b) this.toggleTab(b.dataset.tab!);
    });
    q('#speed').addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest('button[data-speed]') as HTMLElement | null;
      if (b) store.send({ kind: 'speed', speed: b.dataset.speed as Speed });
    });
    q('#zoom').addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest('button[data-zoom]') as HTMLElement | null;
      if (b) scene.zoomBy(b.dataset.zoom === 'in' ? 1.25 : 0.8);
    });
    q('#stats').addEventListener('click', (e) => {
      const c = (e.target as HTMLElement).closest('[data-go]') as HTMLElement | null;
      if (!c) return;
      if (c.dataset.go === 'goals') {
        this.sub.world = 'goals';
        this.openTab('world');
      } else this.openTab(c.dataset.go!);
    });
    for (const sel of ['#sheet', '#card', '#modal']) q(sel).addEventListener('click', (e) => this.onClick(e));
    this.bindSwipe(q('#sheet'));
    q('#sheet').addEventListener('input', (e) => this.onInput(e));
    q('#sheet').addEventListener('change', (e) => this.onInput(e));
    store.subscribe(() => this.onSnapshot());
    try {
      const v = localStorage.getItem('ss-tutorial');
      this.tutStep = v === 'done' ? 99 : Number(v ?? 0) || 0;
    } catch { /* 無法讀取時從頭開始 */ }
    q('#hint').addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest('[data-tut]') as HTMLElement | null;
      if (!b) return;
      if (b.dataset.tut === 'skip') this.setTut(99);
      else this.setTut(this.tutStep + 1);
    });
  }

  /** 提案卡左右滑：右＝核准、左＝拒絕；滑動距離不足則彈回。 */
  private bindSwipe(sheet: HTMLElement): void {
    let card: HTMLElement | null = null;
    let x0 = 0;
    let y0 = 0;
    let dx = 0;
    let moved = false;
    const TH = 90;
    sheet.addEventListener('pointerdown', (e) => {
      const c = (e.target as HTMLElement).closest('.pcard') as HTMLElement | null;
      if (!c || (e.target as HTMLElement).closest('button,summary,select,input')) return;
      card = c;
      x0 = e.clientX;
      y0 = e.clientY;
      dx = 0;
      moved = false;
    });
    sheet.addEventListener('pointermove', (e) => {
      if (!card) return;
      const mx = e.clientX - x0;
      const my = e.clientY - y0;
      if (!moved && Math.abs(mx) < 8) return;
      if (!moved && Math.abs(my) > Math.abs(mx)) {
        card = null; // 垂直捲動
        return;
      }
      moved = true;
      this.dragging = true;
      dx = mx;
      card.style.transition = 'none';
      card.style.transform = `translateX(${dx}px) rotate(${dx / 25}deg)`;
      card.classList.toggle('dr', dx > 24);
      card.classList.toggle('dl', dx < -24);
      card.classList.toggle('go', Math.abs(dx) >= TH);
      if (card.dataset.perm !== '1') card.classList.add('noperm');
    });
    const end = (): void => {
      const c = card;
      card = null;
      if (!c || !moved) {
        this.dragging = false;
        return;
      }
      const pid = c.dataset.pid;
      const act = dx >= TH ? 'approve' : dx <= -TH ? 'reject' : '';
      if (act && c.dataset.perm === '1') {
        c.style.transition = 'transform .18s ease-out, opacity .18s';
        c.style.transform = `translateX(${dx > 0 ? 500 : -500}px) rotate(${dx > 0 ? 20 : -20}deg)`;
        c.style.opacity = '0';
        this.dragging = false;
        void this.cmd('RespondProposal', { proposalId: Number(pid), response: act }, act === 'approve' ? '✔ 已核准' : '✖ 已拒絕');
      } else {
        c.style.transition = 'transform .18s ease-out';
        c.style.transform = '';
        c.classList.remove('dr', 'dl', 'go');
        this.dragging = false;
        if (act) this.store.toast('🔒 目前不是領袖', 'warn');
      }
    };
    sheet.addEventListener('pointerup', end);
    sheet.addEventListener('pointercancel', end);
  }

  private setTut(n: number): void {
    this.tutStep = n;
    try {
      localStorage.setItem('ss-tutorial', n >= 99 ? 'done' : String(n));
    } catch { /* 忽略 */ }
    this.updateHint();
  }

  restartTutorial(): void {
    this.setTut(0);
  }

  /** 簡短教學：依玩家進度一步步提示，隨時可略過（GDD 15 C1）。 */
  private tutorialText(): string {
    const s = this.store.snap;
    if (!s || this.tutStep >= 99) return '';
    const open = s.proposals.filter((p) => p.status === 0).length;
    const steps: { when: boolean; text: string }[] = [
      { when: true, text: '▶ 開始；⏸ 暫停。🎯 完成 2 項目標，村子就會成長。' },
      { when: open > 0, text: '📜 有提案了：右滑核准、左滑拒絕，卡片會列出要花什麼。' },
      { when: s.works.some((w) => w.kind !== 'maintenance') || s.stats.pop > 0 && s.tick > 150, text: '🏗 工程要人手與材料；冬天最好招人。' },
      { when: s.seasonSummary.length >= 1, text: '季末結算 👥 支持度；到 🏠 看原因。' },
      { when: s.tick > 270, text: '🌾 存糧是春荒關鍵；🌍 可調政策、買糧。' },
    ];
    const cur = steps[this.tutStep];
    if (!cur) {
      this.setTut(99);
      return '';
    }
    return cur.when ? cur.text : '';
  }

  // ---------- 遊戲內互動 ----------
  onTapTile(x: number, y: number): void {
    const s = this.store.snap;
    const map = this.store.map;
    if (!s || !map) return;
    if (this.mode.kind === 'place') {
      const fp = _fp(this.mode.type as BuildingType)!;
      const ax = x - Math.floor(fp.w / 2);
      const ay = y - Math.floor(fp.h / 2);
      this.anchor = { x: ax, y: ay };
      this.refreshGhost();
    } else if (this.mode.kind === 'road') {
      if (!this.anchor || this.roadTiles.length > 0) {
        this.anchor = { x, y };
        this.roadTiles = [];
        this.scene.setRoadPreview([{ x, y }]);
      } else {
        const rm = this.mode.kind === 'road' ? this.mode.mode : 'dirt';
        const idx = (t: { x: number; y: number }): number => t.y * map.w + t.x;
        let tiles: { x: number; y: number }[];
        if (rm === 'bridge' || rm === 'stonebridge') {
          // 橋：兩點之間的直線格（水面或既有木橋）
          tiles = [];
          const dx = Math.sign(x - this.anchor.x);
          const dy = Math.sign(y - this.anchor.y);
          let cx = this.anchor.x;
          let cy = this.anchor.y;
          for (let k = 0; k < 60; k++) {
            tiles.push({ x: cx, y: cy });
            if (cx === x && cy === y) break;
            if (cx !== x) cx += dx;
            else cy += dy;
          }
        } else {
          const p = findPath(map as unknown as MapState, this.anchor.x, this.anchor.y, x, y);
          tiles = p ? p.steps.map((i) => ({ x: i % map.w, y: Math.floor(i / map.w) })) : [];
          if (!p) this.store.toast('⛔ 無路徑', 'warn');
        }
        this.roadTiles = tiles
          .filter((t) => {
            const i = idx(t);
            if (map.occ[i] !== 0) return false;
            if (rm === 'dirt') return map.road[i] === 0 && map.water[i] === 0 && t.x >= map.zmin && t.x < map.zmax && t.y >= map.zmin && t.y < map.zmax;
            if (rm === 'stone') return map.road[i] === 1;
            if (rm === 'bridge') return map.water[i] !== 0 && map.road[i] === 0;
            return map.road[i] === 3;
          })
          .slice(0, 60);
        this.scene.setRoadPreview(this.roadTiles);
      }
    } else if (this.mode.kind === 'zone') {
      if (!this.anchor) this.anchor = { x, y };
      else {
        this.rect = { x, y };
        const a = this.anchor;
        this.scene.setGhost({ x: Math.min(a.x, x), y: Math.min(a.y, y), w: Math.abs(x - a.x) + 1, h: Math.abs(y - a.y) + 1, ok: true });
      }
    }
    this.renderSheet(true);
    this.updateHint();
  }

  onSelectNpc(id: number): void {
    if (this.mode.kind !== 'select') return;
    this.card = { kind: 'npc', id };
    this.scene.select({ kind: 'npc', id });
    this.renderCard();
  }
  onSelectBuilding(id: number): void {
    if (this.mode.kind !== 'select') return;
    this.card = { kind: 'building', id };
    this.scene.select({ kind: 'building', id });
    this.renderCard();
  }

  private refreshGhost(): void {
    const map = this.store.map;
    const s = this.store.snap;
    if (!map || !s || this.mode.kind !== 'place' || !this.anchor) {
      this.scene.setGhost(null);
      return;
    }
    const t = this.mode.type as BuildingType;
    const fp = _fp(t)!;
    const err = validatePlacement(map as unknown as MapState, s.buildings, t, this.anchor.x, this.anchor.y);
    const g: Ghost = { x: this.anchor.x, y: this.anchor.y, w: fp.w, h: fp.h, ok: !err };
    this.scene.setGhost(g);
  }

  setMode(m: Mode): void {
    this.mode = m;
    this.anchor = null;
    this.rect = null;
    this.roadTiles = [];
    this.scene.setGhost(null);
    this.scene.setRoadPreview([]);
    if (m.kind !== 'select') {
      this.card = null;
      this.scene.select(null);
      this.renderCard();
    }
    this.updateHint();
  }

  private updateHint(): void {
    const el = document.querySelector('#hint') as HTMLElement;
    let t = '';
    if (this.mode.kind === 'place') t = this.anchor ? '👆 已選位置，可再點改位置' : `👆 點地圖選 ${BUILDING_ICON[this.mode.type] ?? ''}${BUILDING_LABEL[this.mode.type] ?? ''} 的位置`;
    else if (this.mode.kind === 'road') t = this.roadTiles.length ? `🟫 ${this.roadTiles.length} 格，下方確認` : this.anchor ? '👆 點終點' : '👆 點起點';
    else if (this.mode.kind === 'zone') t = this.rect ? '下方確認' : this.anchor ? '👆 點對角' : '👆 點範圍一角';
    const tut = t ? '' : this.tutorialText();
    el.hidden = !t && !tut;
    if (t) el.textContent = t;
    else if (tut) el.innerHTML = `${esc(tut)}<div class="row"><button class="btn" data-tut="next">OK</button><button class="btn" data-tut="skip">略過</button></div>`;
  }

  // ---------- 面板 ----------
  toggleTab(t: string): void {
    if (this.tab === t) this.closeSheet();
    else this.openTab(t);
  }
  openTab(t: string): void {
    this.tab = t;
    this.lastSheetKey = '';
    this.renderSheet(true);
    this.syncNav();
  }
  closeSheet(): void {
    this.tab = null;
    (document.querySelector('#sheet') as HTMLElement).hidden = true;
    this.syncNav();
  }
  private syncNav(): void {
    for (const b of document.querySelectorAll<HTMLButtonElement>('#bottom button[data-tab]')) b.setAttribute('aria-pressed', String(b.dataset.tab === this.tab));
  }

  onSnapshot(): void {
    const s = this.store.snap;
    if (!s) return;
    const week = Math.floor(s.tick / 6);
    if (!this.priceHist.length || this.priceHist[this.priceHist.length - 1]!.week !== week) {
      this.priceHist.push({ week, prices: [...s.prices] });
      if (this.priceHist.length > 30) this.priceHist.shift();
    }
    this.renderTop(s);
    this.updateHint();
    this.renderToasts();
    this.renderSheet(false);
    if (this.card) this.renderCard();
  }

  private renderTop(s: Snapshot): void {
    (document.querySelector('#dt') as HTMLElement).textContent = `${s.date}${s.weather ? ' 🌧' : ''}`;
    this.scene.paused = this.store.speed === 'pause';
    for (const b of document.querySelectorAll<HTMLButtonElement>('#speed button')) b.setAttribute('aria-pressed', String(b.dataset.speed === this.store.speed));
    const last = s.supportLog[s.supportLog.length - 1];
    const prev = s.supportLog[s.supportLog.length - 2];
    const arrow = last && prev ? (last.support > prev.support ? '▲' : last.support < prev.support ? '▼' : '＝') : '';
    const sup = s.leadership.support;
    const supCls = sup >= 60 ? 'good' : sup < 40 ? 'bad' : '';
    const food = s.stats.foodDays;
    const foodCls = food < 30 ? 'bad' : food > 90 ? 'good' : '';
    // 主畫面最多 3 個摘要狀態，其一固定為支持度（GDD 10）
    (document.querySelector('#stats') as HTMLElement).innerHTML =
      `<span class="chip ${supCls}" data-go="family" aria-label="支持度">👥<b>${sup}</b>${arrow}</span>` +
      `<span class="chip ${foodCls}" data-go="world" aria-label="存糧天數">🌾<b>${food}</b><small>日</small></span>` +
      `<span class="chip" data-go="world" aria-label="公庫">💰<b>${s.pub.cash}</b></span>` +
      `<span class="chip goal" data-go="goals" aria-label="目標">${s.progress.icon}<b>${s.progress.goals.filter((g) => g.done).length}/${s.progress.needed}</b></span>`;
    const open = s.proposals.filter((p) => p.status === 0).length;
    const badge = document.querySelector('#badge') as HTMLElement;
    badge.hidden = open === 0;
    badge.textContent = String(open);
  }

  private renderToasts(): void {
    const now = Date.now();
    const el = document.querySelector('#toasts') as HTMLElement;
    this.store.toasts = this.store.toasts.filter((t) => now - t.at < 9000);
    el.innerHTML = this.store.toasts.map((t) => `<div class="toast ${t.kind}">${esc(t.text)}</div>`).join('');
  }

  private renderSheet(force: boolean): void {
    const sheet = document.querySelector('#sheet') as HTMLElement;
    const s = this.store.snap;
    if (!this.tab || !s) {
      sheet.hidden = true;
      return;
    }
    // 暫停時 tick 不變，因此把提案與工程狀態也納入，命令生效後才會重畫
    const sig = `${s.proposals.map((p) => `${p.id}.${p.status}`).join(',')}|${s.works.length}|${s.pub.cash}`;
    const key = `${this.tab}|${this.sub[this.tab] ?? ''}|${s.tick}|${sig}|${this.mode.kind}|${this.anchor?.x},${this.anchor?.y}|${this.roadTiles.length}`;
    if (!force && key === this.lastSheetKey) return;
    if (!force && this.dragging) return; // 滑動提案時不重畫，避免打斷手勢
    // 滑桿或輸入框操作中不重繪，避免打斷
    if (!force && document.activeElement && sheet.contains(document.activeElement) && (document.activeElement as HTMLElement).tagName === 'INPUT') return;
    this.lastSheetKey = key;
    const scroll = sheet.scrollTop;
    sheet.hidden = false;
    let html = '';
    switch (this.tab) {
      case 'build': html = this.buildPanel(s); break;
      case 'proposals': html = this.proposalPanel(s); break;
      case 'family': html = this.familyPanel(s); break;
      case 'world': html = this.worldPanel(s); break;
      case 'history': html = this.historyPanel(s); break;
    }
    sheet.classList.toggle('compact', this.tab === 'build' && this.mode.kind !== 'select');
    sheet.innerHTML = html;
    sheet.scrollTop = scroll;
    if (this.tab === 'history' && this.sub.history === 'maps') this.drawSnaps(s);
  }

  private drawSnaps(s: Snapshot): void {
    const colors = ['#3b78b5', '#6fae52', '#2f6b2f', '#b08d57', '#c0392b'];
    for (const cv of document.querySelectorAll<HTMLCanvasElement>('canvas[data-snap]')) {
      const m = s.mapSnaps.slice(-4)[Number(cv.dataset.snap)];
      const c = cv.getContext('2d');
      if (!m || !c) continue;
      m.grid.forEach((v, i) => {
        c.fillStyle = colors[v] ?? '#000';
        c.fillRect((i % 24) * 4, Math.floor(i / 24) * 4, 4, 4);
      });
    }
  }

  private tabs(name: string, items: [string, string][]): string {
    return `<div class="tabs">${items.map(([id, l]) => `<button data-act="sub:${name}:${id}" aria-pressed="${this.sub[name] === id}">${l}</button>`).join('')}</div>`;
  }

  // 建設 ----------------------------------------------------------
  private buildPanel(s: Snapshot): string {
    const perm = s.leadership.playerIsLeader && s.leadership.mode === 0;
    let h = '';
    if (!perm) h += `<p class="muted">🔒 目前不是領袖</p>`;
    const opt = BUILD_OPTIONS.find((o) => this.isMode(o));
    // 選好類型後收合選單，只留預覽與確認，讓地圖空出來點選位置
    if (!opt) h += `<div class="grid icons">${BUILD_OPTIONS.map((o) => {
      const lock = this.isLocked(s, o.id);
      return `<button class="btn ib ${lock ? 'locked' : ''}" data-act="${lock ? 'locked:' + o.id : 'mode:' + o.id}" ${perm ? '' : 'disabled'}><span class="ic">${lock ? '🔒' : BUILD_ICON[o.id] ?? ''}</span><small>${o.label}</small></button>`;
    }).join('')}</div>`;
    if (opt) {
      h += `<div class="card"><b>${BUILD_ICON[opt.id] ?? ''} ${opt.label}</b>`;
      h += this.buildPreview(s, opt);
      h += `</div>`;
    }
    const works = s.works.filter((w) => w.kind !== 'maintenance');
    if (works.length) {
      for (const w of works) {
        const pct = Math.min(100, Math.floor((w.progressFx * 100) / Math.max(1, w.requiredPDFx)));
        const type = s.buildings.find((b) => b.id === w.buildingId)?.type ?? '';
        const label = w.kind === 'road' ? `🟫 ${w.tiles.length}` : `${BUILDING_ICON[type] ?? '🏗'} ${BUILDING_LABEL[type] ?? '工程'}`;
        h += `<div class="card"><div class="row"><b>${label}</b>${w.state === 0 ? '<span class="pill">⏳ 等材料</span>' : `<span class="pill">🔨 ${pct}%</span>`}<button class="btn danger" data-act="cancel:${w.id}" aria-label="撤銷">✖</button></div><div class="bar"><i style="width:${pct}%"></i></div></div>`;
      }
    }
    return h;
  }

  private isMode(o: { mode: Mode }): boolean {
    const a = this.mode;
    const b = o.mode;
    return a.kind === b.kind && (a.kind !== 'place' || (b.kind === 'place' && a.type === b.type)) && (a.kind !== 'zone' || (b.kind === 'zone' && a.zone === b.zone));
  }

  private buildPreview(s: Snapshot, opt: { id: string; mode: Mode }): string {
    const wage = s.wages[5]!;
    const why = BUILD_WHY[opt.id];
    const note = BUILD_OPTIONS.find((o) => o.id === opt.id)?.note ?? '';
    let status = '';
    let cost = '';
    let ok = false;
    let btn = '';
    if (opt.mode.kind === 'road') {
      const n = this.roadTiles.length;
      const rm = opt.mode.mode;
      const U = ECON.upgrade;
      const wood = n * (rm === 'dirt' ? ECON.road.dirtWood : rm === 'bridge' ? U.bridge.wood : 0);
      const stone = n * (rm === 'stone' ? U.stoneRoad.stone : rm === 'stonebridge' ? U.bridge.stoneStone : 0);
      const pd = n * (rm === 'dirt' ? ECON.road.dirtPersonDays : rm === 'stone' ? U.stoneRoad.personDays : rm === 'bridge' ? U.bridge.personDays : U.bridge.stonePersonDays);
      status = n ? tag('🟫', n) : '<span class="muted">👆 點起點與終點</span>';
      cost = tag('🪙', pd * wage + wood * s.prices[1]! + stone * s.prices[2]!) + (wood ? tag('🪵', wood) : '') + (stone ? tag('🪨', stone) : '') + tag('👷', pd);
      ok = n > 0 && s.pub.cash >= pd * wage;
      btn = `data-act="do:road"`;
    } else if (opt.mode.kind === 'place') {
      const cfg = (ECON.build as Record<string, { wood: number; stone: number; personDays: number }>)[opt.mode.type === 'publichome' ? 'home' : opt.mode.type]!;
      const map = this.store.map;
      const err = this.anchor && map ? validatePlacement(map as unknown as MapState, s.buildings, opt.mode.type as BuildingType, this.anchor.x, this.anchor.y) : 'none';
      status = this.anchor ? (err ? `<span class="down">⛔ ${reasonText('invalid_target:' + err)}</span>` : '<span class="up">✔ 可建</span>') : '<span class="muted">👆 點地圖選位置</span>';
      cost = tag('🪙', cfg.personDays * wage + cfg.wood * s.prices[1]! + cfg.stone * s.prices[2]!) + (cfg.wood ? tag('🪵', cfg.wood) : '') + (cfg.stone ? tag('🪨', cfg.stone) : '') + tag('👷', cfg.personDays);
      ok = !!this.anchor && !err && s.pub.cash >= cfg.personDays * wage;
      btn = `data-act="do:place"`;
    } else if (opt.mode.kind === 'zone') {
      const r = this.anchor && this.rect ? { w: Math.abs(this.rect.x - this.anchor.x) + 1, h: Math.abs(this.rect.y - this.anchor.y) + 1 } : null;
      status = r ? tag('▦', `${r.w}×${r.h}`) : '<span class="muted">👆 點兩個對角</span>';
      if (opt.mode.zone === 2 && r) cost = tag('🪙', r.w * r.h * 2);
      ok = !!r;
      btn = `data-act="do:zone"`;
    }
    const stock = tag('🪵', s.pub.stock[1] ?? 0) + tag('🪨', s.pub.stock[2] ?? 0);
    let detail = `<p>${note}</p>`;
    if (why) detail += `<div class="kv"><span>影響</span><span>${why.groups}</span><span>短期</span><span>${why.short}</span><span>風險</span><span>${why.risk}</span></div>`;
    detail += `<p class="muted">庫存 ${stock}&emsp;確認前不扣款，居民不一定配合。</p>`;
    return `<div class="row">${status}${cost}</div><div class="row"><button class="btn primary" ${btn} ${ok ? '' : 'disabled'}>✔ 興建</button><button class="btn" data-act="mode:none" aria-label="取消">✖</button>${more(detail)}</div>`;
  }

  // 提案 ----------------------------------------------------------
  private proposalPanel(s: Snapshot): string {
    if (!s.proposals.length) return `<p class="muted">📭 沒有提案&emsp;${tag('👥', s.leadership.support)}${tag('🌾', s.stats.foodDays)}</p>`;
    const perm = s.leadership.playerIsLeader && s.leadership.mode === 0;
    // 一次一張：待決優先、高優先在前、快到期的在前；延後過的排最後
    const list = [...s.proposals].sort((a, b) => (a.status === 2 ? 1 : 0) - (b.status === 2 ? 1 : 0) || b.priority - a.priority || a.expiry - b.expiry);
    const p = list[0]!;
    const who = s.npcs.find((n) => n.id === p.proposerId);
    const hh = who ? s.households.find((x) => x.id === who.householdId) : undefined;
    const left = Math.max(0, p.expiry - s.tick);
    const cashAfter = s.pub.cash - p.cost;
    const cost = tag('🪙', `−${p.cost}`, cashAfter < 0 ? 'bad' : '') + `<span class="muted">公庫 ${s.pub.cash} → <b class="${cashAfter < 0 ? 'down' : ''}">${cashAfter}</b></span>`;
    let mats = '';
    p.materials.forEach((m, i) => {
      if (!m) return;
      const have = s.pub.stock[i] ?? 0;
      mats += tag(COM_ICON[i]!, `−${m}`, have < m ? 'bad' : '') + `<span class="muted">庫存 ${have}${have < m ? `，缺 ${m - have}，工程會等材料` : ''}</span>`;
    });
    const trust = esc(hh?.name ?? '提案家庭');
    return `<div class="pcount">${list.map((x, i) => `<i class="${i === 0 ? 'on' : ''}"></i>`).join('')}<span class="muted">${list.length > 1 ? `還有 ${list.length - 1} 件` : '最後一件'}</span></div>
    <div class="pstack"><div class="pcard" data-pid="${p.id}" data-perm="${perm ? 1 : 0}">
      <div class="swipe-tag l">✖ 拒絕</div><div class="swipe-tag r">核准 ✔</div>
      <div class="row"><b class="big">${PROPOSAL_ICON[p.kind] ?? '📜'} ${PROPOSAL_LABEL[p.kind] ?? p.kind}</b>${p.priority ? '<span class="pill">❗ 急</span>' : ''}${p.status === 2 ? '<span class="pill">⏳ 已延後</span>' : ''}${tag('⌛', left + ' 日')}</div>
      <div class="muted">${who ? esc(who.name) + '：' : ''}${esc(p.expectedEffects)}</div>
      <div class="cost"><h5>✔ 核准會消耗</h5><div class="row">${cost}</div>${mats ? `<div class="row">${mats}</div>` : ''}<div class="row"><span class="muted">另需村民人手施工，${trust} 信任 +8</span></div></div>
      <div class="cost bad"><h5>✖ 拒絕的代價</h5><div class="row"><span class="muted">${trust} 信任 −8；不花公庫</span></div></div>
      <div class="swipehint">◀ 左滑拒絕&emsp;右滑核准 ▶</div>
    </div>
    <div class="row act3"><button class="btn danger" aria-label="拒絕" data-act="prop:${p.id}:reject" ${perm ? '' : 'disabled'}>✖</button><button class="btn" aria-label="延後（信任 −2）" data-act="prop:${p.id}:defer" ${perm ? '' : 'disabled'}>⏳</button><button class="btn primary" aria-label="核准" data-act="prop:${p.id}:approve" ${perm ? '' : 'disabled'}>✔</button></div>
    ${more(`<div class="kv"><span>證據</span><span>${p.evidence}</span><span>延後</span><span>${trust} 信任 −2，期限不變</span></div>`)}</div>`;
  }

  // 家族 ----------------------------------------------------------
  private familyPanel(s: Snapshot): string {
    const L = s.leadership;
    const hh = s.households.find((x) => x.id === L.playerHouseholdId);
    let h = '';
    if (L.mode === 2) {
      return `<div class="card"><b>💀 家族斷絕</b><div class="muted">選一個家族接手</div><div class="grid">${s.households.filter((x) => x.memberIds.length).map((x) => `<button class="btn" data-act="switch:${x.id}">${esc(x.name)}</button>`).join('')}</div></div>`;
    }
    const leader = s.npcs.find((n) => n.id === L.leaderId);
    const last = s.supportLog[s.supportLog.length - 1];
    const prev = s.supportLog[s.supportLog.length - 2];
    const sup = L.support;
    h += `<div class="gauge ${sup >= 60 ? 'good' : sup < 40 ? 'bad' : ''}"><span>👥</span><div class="bar big"><i style="width:${Math.min(100, sup)}%"></i></div><b>${sup}</b></div>`;
    h += `<div class="row">${tag('👑', esc(leader?.name ?? '—') + (L.playerIsLeader ? ' ★' : ' 🤖'))}${L.lowSupportSeasons ? tag('⚠', L.lowSupportSeasons + '季', 'bad') : ''}${more(`<div class="kv"><span>任期起</span><span>第 ${Math.floor(L.termStartTick / 360) + 1} 年</span><span>門檻</span><span>≥60 正常；40–59 新政策延後；&lt;30 連兩季改選</span></div>`)}</div>`;
    if (L.mode === 1) {
      const can = L.nextElectionTick > 0 && s.tick >= L.nextElectionTick;
      h += `<div class="card">🙋 你已卸任 ${can ? '' : tag('⌛', Math.max(0, L.nextElectionTick - s.tick))}<button class="btn primary" data-act="stand" ${can ? '' : 'disabled'}>參選領袖</button></div>`;
    }
    if (last) {
      // 只列最差 3 項因子，其餘收進摺疊
      const idx = last.factors.map((f, i) => ({ f, i })).sort((a, b) => a.f.value - b.f.value);
      const row = ({ f, i }: { f: { name: string; value: number }; i: number }): string => {
        const d = prev ? f.value - prev.factors[i]!.value : 0;
        return `<div class="frow"><span>${f.name}</span><div class="bar ${f.value < 500 ? 'bad' : ''}"><i style="width:${Math.min(100, f.value / 10)}%"></i></div><span class="${d >= 0 ? 'up' : 'down'}">${prev ? (d >= 0 ? '▲' : '▼') + Math.abs(d) : ''}</span></div>`;
      };
      h += idx.slice(0, 3).map(row).join('');
      h += more(`${idx.slice(3).map(row).join('')}<div class="row">${GROUPS.map((g, i) => tag(GROUP_ICON[i]!, last.groups[i] ?? 0)).join('')}</div>`, '… 其他因子');
    } else h += `<p class="muted">⌛ 季末第一次結算</p>`;
    if (hh) {
      h += `<h4>🏠 ${esc(hh.name)}</h4><div class="row">${tag('🪙', hh.cash)}${tag('🌾', hh.stock[0] ?? 0)}${tag('🪑', hh.stock[4] ?? 0)}</div>`;
      const members = s.npcs.filter((n) => n.householdId === hh.id);
      h += `<table>${members.map((n) => `<tr><td>${esc(n.name)}${n.id === L.leaderId ? ' ★' : ''}</td><td>${n.age}</td><td>${this.jobText(s, n)}</td><td><button class="btn" data-act="npc:${n.id}" aria-label="查看">👁</button></td></tr>`).join('')}</table>`;
      const bios = members.map((n) => {
        const spouse = s.npcs.find((p) => p.id === n.spouseId);
        return `<details class="card"><summary>${esc(n.name)}（${n.age}）${spouse ? ' ♥ ' + esc(spouse.name) : ''}</summary>${n.bio.length ? `<ul class="timeline">${n.bio.map((b) => `<li>${esc(b)}</li>`).join('')}</ul>` : '<div class="muted">—</div>'}</details>`;
      }).join('');
      h += `<details class="more"><summary>📖 傳記</summary>${bios}</details>`;
      const adults = members.filter((n) => n.age >= 18);
      if (L.playerIsLeader && adults.length) {
        h += `<div class="row">🧭 繼承人 <select data-act="heir">${adults.map((n) => `<option value="${n.id}" ${n.id === L.heirId ? 'selected' : ''}>${esc(n.name)}（${n.age}）</option>`).join('')}</select><button class="btn" data-act="heir-set">指定</button>${more('領袖死亡且支持度 ≥ 50 時由繼承人繼任；否則改選。')}</div>`;
      }
      const own = s.enterprises.filter((e) => e.ownerHouseholdId === hh.id);
      if (own.length) h += `<div class="row">${own.map((e) => `<button class="btn" data-act="invest:${e.id}:200">${BUILDING_ICON[s.buildings.find((b) => b.id === e.buildingId)?.type ?? ''] ?? ''} 注資 200</button>`).join('')}</div>`;
    }
    return h;
  }

  private jobText(s: Snapshot, n: NpcView): string {
    if (n.jobKind === 1) {
      const e = s.enterprises.find((x) => x.id === n.jobId);
      return e ? BUILDING_ICON[s.buildings.find((b) => b.id === e.buildingId)?.type ?? ''] ?? '💼' : '💼';
    }
    if (n.jobKind === 2) return '🏗';
    return n.age < 16 ? '🧒' : n.age > 55 ? '🧓' : n.reason.includes('休閒') ? '🎣' : '🚶';
  }

  // 世界 ----------------------------------------------------------
  private worldPanel(s: Snapshot): string {
    const tabs = this.tabs('world', [['goals', '🎯'], ['eco', '📊'], ['policy', '📜'], ['trade', '🚚'], ['sys', '⚙']]);
    switch (this.sub.world) {
      case 'goals': return `${tabs}${this.goalsBody(s)}`;
      case 'policy': return `${tabs}${this.policyBody(s)}`;
      case 'trade': return `${tabs}${this.tradeBody(s)}`;
      case 'sys': return `${tabs}${this.systemBody()}`;
      default: return `${tabs}${this.ecoBody(s)}`;
    }
  }

  private goalsBody(s: Snapshot): string {
    const P = s.progress;
    const done = P.goals.filter((g) => g.done).length;
    let h = `<div class="stagehead"><span class="big">${P.icon}</span><div><b class="big">${P.name}</b><div class="muted">${P.stage >= P.max ? '已成為繁榮之鎮' : `完成任意 ${P.needed} 項，成長為${GOALS.stages[P.stage + 1]?.name ?? '繁榮之鎮'}`}</div></div><b class="big">${Math.min(done, P.needed)}/${P.needed}</b></div>`;
    for (const g of P.goals) {
      const pct = Math.floor((g.cur * 100) / Math.max(1, g.target));
      h += `<div class="goal ${g.done ? 'ok' : ''}"><span class="gi">${g.done ? '✔' : g.icon}</span><div class="gt"><div>${g.text}</div><div class="bar"><i style="width:${g.done ? 100 : pct}%"></i></div></div>${g.target > 1 ? `<span class="gn">${g.cur}/${g.target}</span>` : ''}</div>`;
    }
    if (P.stage < P.max) {
      const nextStage = P.stage + 1;
      const locks = Object.entries(GOALS.locks as Record<string, number>).filter(([, need]) => need === nextStage).map(([k]) => this.lockLabel(k));
      const zone = GOALS.stages[P.stage + 1]?.zone ?? GOALS.stages[P.max - 1]!.zone + 12;
      h += `<div class="row">${tag('🗺', `${zone}×${zone}`)}${locks.map((l) => tag('🔓', l)).join('')}</div>`;
    }
    return h;
  }

  private lockLabel(key: string): string {
    return BUILD_OPTIONS.find((o) => o.id === key)?.label ?? BUILDING_LABEL[key] ?? key;
  }

  private isLocked(s: Snapshot, id: string): boolean {
    const need = (GOALS.locks as Record<string, number>)[id];
    return need !== undefined && s.progress.stage < need;
  }

  private ecoBody(s: Snapshot): string {
    const old = this.priceHist.length > 4 ? this.priceHist[this.priceHist.length - 5]!.prices : s.prices;
    const cash = s.households.map((h) => h.cash).sort((a, b) => a - b);
    const top = cash[cash.length - 1] ?? 0;
    const un = Math.floor((s.stats.unemployed * 100) / Math.max(1, s.stats.workforce));
    let h = `<table><tr><th></th><th>價</th><th></th><th>庫</th></tr>${COMMODITIES.map((c, i) => {
      const d = s.prices[i]! - old[i]!;
      return `<tr><td aria-label="${c}">${COM_ICON[i]}</td><td><b>${s.prices[i]}</b></td><td class="${d > 0 ? 'up' : d < 0 ? 'down' : ''}">${d > 0 ? '▲' : d < 0 ? '▼' : '＝'}${d ? Math.abs(d) : ''}</td><td>${s.pub.stock[i]}</td></tr>`;
    }).join('')}</table>`;
    h += `<div class="row">${tag('🧑', s.stats.pop)}${tag('🚶', un + '%', un > 20 ? 'bad' : '')}${tag('💰', s.pub.cash)}${tag('🌾', s.stats.harvest)}</div>`;
    if (s.warnings.length) h += s.warnings.map((w) => `<div class="pill">⚠ ${w.tick - s.tick}日 ${esc(w.text)}</div>`).join('');
    if (s.effects.length) h += s.effects.map((e) => `<div class="pill">${esc(e.type)} ⌛${Math.max(0, e.untilTick - s.tick)}</div>`).join('');
    h += more(`<div class="kv"><span>工資</span><span>農${s.wages[0]} 林${s.wages[1]} 石${s.wages[2]} 具${s.wages[3]} 家${s.wages[4]} 公${s.wages[5]}</span><span>失業</span><span>${s.stats.unemployed}/${s.stats.workforce}</span><span>吸引力</span><span>${s.attractiveness}</span><span>貨幣量</span><span>${s.moneySupply}</span></div><h4>分配</h4>${s.households.map((x) => `<div class="frow"><span>${esc(x.name)}</span><div class="bar"><i style="width:${Math.min(100, (x.cash * 100) / Math.max(1, top))}%"></i></div><span>${x.cash}</span></div>`).join('')}`, 'ⓘ 工資與分配');
    return h;
  }

  private policyBody(s: Snapshot): string {
    const perm = s.leadership.playerIsLeader && s.leadership.mode === 0;
    const keys = Object.keys(POLICY_RANGE);
    const pol = s.policies as unknown as Record<string, number>;
    let h = `<div class="muted">⌛ 下一季初生效${s.leadership.support < 60 && s.leadership.support >= 40 ? '（再延後一季）' : ''}</div>`;
    for (const k of keys) {
      const [lo, hi, st] = POLICY_RANGE[k]!;
      const cur = pol[k]!;
      const val = this.draft[k] ?? cur;
      const pend = s.policies.pending.find((p) => p.key === k);
      h += `<div class="card"><div class="row">${POLICY_LABEL[k]} <b>${val}</b>${val !== cur ? `<span class="muted">（現 ${cur}）</span>` : ''}${pend ? tag('⌛', Math.max(0, pend.effectiveTick - s.tick)) : ''}${more(this.policyPreview(s, k, val, cur))}</div><input type="range" min="${lo}" max="${hi}" step="${st}" value="${val}" data-act="policy-range" data-key="${k}" ${perm ? '' : 'disabled'} />${val !== cur ? `<button class="btn primary" data-act="policy:${k}" ${perm ? '' : 'disabled'}>✔ 套用</button>` : ''}</div>`;
    }
    return h;
  }

  private policyPreview(s: Snapshot, k: string, val: number, cur: number): string {
    const d = val - cur;
    switch (k) {
      case 'harvestTaxPermille': return `財政：每年約 ${d > 0 ? '+' : ''}${Math.floor((d * 8000) / 1000)} 糧；農戶稅後報酬${d > 0 ? '下降' : '上升'}，加稅造成的不滿大於減稅帶來的好感（損失趨避 ×2）。`;
      case 'commerceTaxPermille': return `財政：成交額 ${d > 0 ? '+' : ''}${d / 10}% 的稅；交易可能減少，稅收不一定增加。`;
      case 'agriSubsidy': return `每季每塊農田 ${val} 文，年支出約 ${val * 3 * s.enterprises.filter((e) => e.kind === 'farm').length} 文；取消補助的不滿會大於當初給予的好感。`;
      case 'mintPerSeason': return `每季發行 ${val} 文。貨幣增加快於產出會使物價上漲。`;
      case 'leaderSalaryMonthly': return val > 60 ? `高於基準 60 的 ${val - 60} 文會降低支持度。` : '不高於基準。';
      case 'educationBudget': return val ? `每季 ${val} 文付給學堂教師；需先蓋學堂。孩子成年後才見成果（技能成長）。` : '停止後學堂不運作。';
      case 'healthBudget': return val ? `每季 ${val} 文付給診所人員；需先蓋診所。疫病時病程減半、死亡率下降。` : '停止後診所不運作。';
      case 'workRelief': return val ? '公共帳戶有餘裕時雇用無業者做公共雜役（工資取最低生活費）。' : '關閉後無業者只能自行覓食或靠救濟。';
      default: return '';
    }
  }

  private tradeBody(s: Snapshot): string {
    const perm = s.leadership.playerIsLeader && s.leadership.mode === 0;
    const node = s.nodes.find((n) => n.id === this.order.node) ?? s.nodes[0]!;
    const unit = Math.max(1, Math.floor((node.basePrice[this.order.item]! * (1000 + node.drift[this.order.item]!)) / 1000));
    let h = `<table><tr><th></th>${COM_ICON.map((c) => `<th>${c}</th>`).join('')}<th>⌛</th></tr>${s.nodes.map((n) => `<tr><td>${esc(n.name)}</td>${n.basePrice.map((b, i) => `<td>${Math.floor((b * (1000 + n.drift[i]!)) / 1000)}</td>`).join('')}<td>${n.transitDays}</td></tr>`).join('')}</table>`;
    h += `<div class="row"><select data-act="o-node">${s.nodes.map((n) => `<option value="${n.id}" ${n.id === node.id ? 'selected' : ''}>${esc(n.name)}</option>`).join('')}</select><select data-act="o-item">${COMMODITIES.map((c, i) => `<option value="${i}" ${i === this.order.item ? 'selected' : ''}>${COM_ICON[i]} ${c}</option>`).join('')}</select><input type="number" min="1" max="${node.capacity}" value="${this.order.qty}" data-act="o-qty" style="width:6em;min-height:44px" /></div>`;
    h += `<div class="row">${tag('🪙', unit * this.order.qty)}${tag('⌛', node.transitDays)}${more(`單價 ${unit}；運量上限 ${node.capacity}。貨物在途，運抵日才入庫，運輸有損耗，價格隨成交量變動。`)}<button class="btn primary" data-act="order" ${perm && s.pub.cash >= unit * this.order.qty ? '' : 'disabled'}>🚚 採購</button></div>`;
    if (s.shipments.length) h += s.shipments.map((x) => `<div class="pill">🚚 ${esc(s.nodes.find((n) => n.id === x.nodeId)?.name ?? '')} ${x.contents.map((c, i) => (c ? `${COM_ICON[i]}${c}` : '')).join('')} ⌛${Math.max(0, x.arriveTick - s.tick)}</div>`).join('');
    return h;
  }

  private systemBody(): string {
    return `<div class="row"><button class="btn" data-act="save">💾 存檔</button><button class="btn" data-act="export">📤 匯出</button><label class="btn">📥 匯入<input type="file" accept=".json,application/json" data-act="import" hidden /></label></div>
    <div class="card"><div class="row">🔠 <b>${this.settings.fs}</b><input type="range" min="13" max="22" value="${this.settings.fs}" data-act="fs" style="flex:1" /></div><label><input type="checkbox" data-act="reduce" ${this.settings.reduce ? 'checked' : ''} /> 🚫 動畫</label></div>
    <div class="row"><button class="btn" data-act="tutorial">❓ 教學</button><button class="btn danger" data-act="newgame">🔄 新遊戲</button>${more('自動存檔：每季結束與切到背景時。關閉 App 即暫停，不做離線追趕。')}</div>`;
  }

  // 歷史 ----------------------------------------------------------
  private historyPanel(s: Snapshot): string {
    const tabs = this.tabs('history', [['events', '📜'], ['leaders', '👑'], ['people', '🪦'], ['firms', '🏭'], ['maps', '🗺'], ['seasons', '📅']]);
    let h = tabs;
    const sub = this.sub.history;
    if (sub === 'leaders') {
      const ch = s.events.filter((e) => e.type === 'LeaderChanged' || e.type === 'ElectionHeld');
      h += ch.length ? `<ul class="timeline">${[...ch].reverse().map((e) => `<li class="imp3">${this.when(e.tick)}&emsp;${esc(e.summary)}</li>`).join('')}</ul>` : '<p class="muted">—</p>';
      const l = s.npcs.find((n) => n.id === s.leadership.leaderId);
      h += `<div class="card">👑 ${esc(l?.name ?? '—')}&emsp;${tag('📅', '第' + (Math.floor(s.leadership.termStartTick / 360) + 1) + '年')}</div>`;
    } else if (sub === 'people') {
      h += s.tombstones.length ? [...s.tombstones].reverse().map((t) => `<details class="card"><summary>${esc(t.name)}&emsp;${Math.floor(t.birthTick / 360) + 1}–${Math.floor(t.deathTick / 360) + 1} 年&emsp;${esc(s.households.find((x) => x.id === t.householdId)?.name ?? '')}</summary>${t.bio.length ? `<ul class="timeline">${t.bio.map((b) => `<li>${esc(b)}</li>`).join('')}</ul>` : '<div class="muted">沒有記錄的生平。</div>'}</details>`).join('') : '<p class="muted">—</p>';
    } else if (sub === 'firms') {
      const fe = s.events.filter((e) => /^Enterprise|^Strategy/.test(e.type));
      h += fe.length ? `<ul class="timeline">${[...fe].reverse().map((e) => `<li class="imp${e.importance}">${this.when(e.tick)}&emsp;${esc(e.summary)}</li>`).join('')}</ul>` : '<p class="muted">—</p>';
      h += `<table>${s.enterprises.map((e) => `<tr><td>${BUILDING_ICON[s.buildings.find((b) => b.id === e.buildingId)?.type ?? ''] ?? ''}</td><td>${esc(s.households.find((x) => x.id === e.ownerHouseholdId)?.name ?? '公有')}</td><td>👷${e.employeeIds.length}</td><td>${e.active ? '✔' : '⏸'}</td></tr>`).join('')}</table>`;
    } else if (sub === 'maps') {
      h += s.mapSnaps.length ? `<div class="row">${s.mapSnaps.slice(-4).map((m, i) => `<div><canvas data-snap="${i}" width="96" height="96" style="width:120px;height:120px;image-rendering:pixelated;border:1px solid var(--line)"></canvas><div class="muted">第 ${Math.floor(m.tick / 360) + 1} 年</div></div>`).join('')}</div>${more('每 5 年一張：藍＝水、綠＝草地、深綠＝森林、褐＝道路、紅＝建築。')}` : '<p class="muted">⌛ 第 5 年</p>';
    } else if (sub === 'seasons') {
      h += s.seasonSummary.length ? `<ul class="timeline">${[...s.seasonSummary].reverse().map((x) => `<li>${esc(x.text)}</li>`).join('')}</ul>` : '<p class="muted">⌛ 季末</p>';
    } else {
      h += s.events.length ? `<ul class="timeline">${[...s.events].reverse().map((e) => `<li class="imp${e.importance}">${this.when(e.tick)}&emsp;${esc(e.summary)}</li>`).join('')}</ul>` : '<p class="muted">—</p>';
    }
    return h;
  }

  private when(tick: number): string {
    return `第${Math.floor(tick / 360) + 1}年${SEASONS[Math.floor((tick % 360) / 90)]}${(tick % 90) + 1}日`;
  }

  // 卡片 ----------------------------------------------------------
  private renderCard(): void {
    const el = document.querySelector('#card') as HTMLElement;
    const s = this.store.snap;
    if (!this.card || !s) {
      el.hidden = true;
      return;
    }
    el.hidden = false;
    if (this.card.kind === 'npc') {
      const n = s.npcs.find((x) => x.id === this.card!.id);
      if (!n) {
        el.hidden = true;
        this.card = null;
        return;
      }
      const bar = (v: number, bad = false): string => `<div class="bar ${bad ? 'bad' : ''}"><i style="width:${Math.max(0, Math.min(100, v))}%"></i></div>`;
      const sk = n.skills;
      el.innerHTML = `<div class="row"><b class="big">${esc(n.name)}</b><span class="muted">${n.age}&emsp;${this.jobText(s, n)}&emsp;${GROUP_ICON[n.interestGroup] ?? ''}</span><button class="btn" data-act="follow:${n.id}" aria-label="追蹤">🎯</button><button class="btn" data-act="card-close" aria-label="關閉">✖</button></div>
      <div class="meters"><span>🍞</span>${bar(100 - n.hunger, n.hunger > 50)}<span>❤</span>${bar(n.health, n.health < 40)}<span>😊</span>${bar(n.mood)}</div>
      <div class="muted">💭 ${esc(n.reason || '一切如常')}</div>
      ${more(`<div class="kv"><span>狀態</span><span>${STATE_LABEL[n.state]}${n.commute > 0 ? ` 通勤${n.commute}` : ''}</span><span>滿意</span><span>${n.satisfaction}</span><span>技能</span><span>🌾${sk[0]} 🔨${sk[1]} 💼${sk[2]} 🤝${sk[3]}</span><span>傾向</span><span>${n.traits.map((t) => `<span class="pill">${TRAIT_LABEL[t]}</span>`).join('')}</span><span>經歷</span><span>${n.tags.length ? n.tags.map((t) => `<span class="pill">${esc(t)}</span>`).join('') : '—'}</span></div>`)}`;
    } else {
      const b = s.buildings.find((x) => x.id === this.card!.id);
      if (!b) {
        el.hidden = true;
        this.card = null;
        return;
      }
      const e = s.enterprises.find((x) => x.buildingId === b.id);
      const owner = s.households.find((x) => x.id === b.ownerHouseholdId);
      const emps = e ? s.npcs.filter((n) => e.employeeIds.includes(n.id)) : [];
      el.innerHTML = `<div class="row"><b class="big">${BUILDING_ICON[b.type] ?? ''} ${BUILDING_LABEL[b.type] ?? b.type}</b><span class="muted">${b.state === 'active' ? '' : '🔨 '}${owner ? esc(owner.name) : '公有'}</span><button class="btn" data-act="card-close" aria-label="關閉">✖</button></div>
      ${e ? `<div class="row">${tag('👷', emps.length)}${tag('🪙', e.cash)}${e.stock.map((v, i) => (v ? tag(COM_ICON[i]!, v) : '')).join('')}${b.type === 'field' ? tag('🌱', e.fertility + (e.fallow ? ' 休耕' : '')) : ''}${emps.length ? more(emps.map((n) => esc(n.name)).join('、')) : ''}</div>` : ''}
      ${b.type === 'home' || b.type === 'publichome' ? `<div class="row">🏠 ${esc(s.households.find((x) => x.homeId === b.id)?.name ?? '空屋')}</div>` : ''}
      ${this.upgradeRow(s, b)}`;
    }
  }

  private upgradeRow(s: Snapshot, b: Snapshot['buildings'][number]): string {
    const list = b.type === 'field' ? ECON.upgrade.field : b.type === 'home' || b.type === 'publichome' ? ECON.upgrade.home : null;
    if (!list || b.state !== 'active') return '';
    const cfg = list[b.stage] as { wood: number; stone: number; personDays: number } | undefined;
    const names = b.type === 'field' ? ['荒地→耕作', '耕作→灌溉'] : ['茅屋→木屋', '木屋→街屋'];
    if (!cfg) return `<div class="muted">⭐ 已最高階</div>`;
    const busy = s.works.some((w) => w.kind === 'upgrade' && w.buildingId === b.id);
    const perm = s.leadership.playerIsLeader && s.leadership.mode === 0;
    return `<div class="row"><button class="btn primary" data-act="upgrade:${b.id}" ${perm && !busy ? '' : 'disabled'} title="${names[b.stage]}">⬆ 升級</button>${tag('🪙', cfg.personDays * s.wages[5]! + cfg.wood * s.prices[1]! + cfg.stone * s.prices[2]!)}${cfg.wood ? tag('🪵', cfg.wood) : ''}${cfg.stone ? tag('🪨', cfg.stone) : ''}${tag('👷', cfg.personDays)}${busy ? '🔨' : ''}</div>`;
  }

  // ---------- 事件處理 ----------
  private onInput(e: Event): void {
    const t = e.target as HTMLInputElement | HTMLSelectElement;
    const act = t.dataset.act;
    if (!act) return;
    if (act === 'policy-range') {
      this.draft[t.dataset.key!] = Number(t.value);
      if (e.type === 'change') this.renderSheet(true);
      else (t.closest('.card')!.querySelector('b') as HTMLElement).textContent = t.value;
    } else if (act === 'fs') {
      this.settings.fs = Number(t.value);
      document.documentElement.style.setProperty('--fs', `${this.settings.fs}px`);
      this.saveSettings();
      if (e.type === 'change') this.renderSheet(true);
    } else if (act === 'reduce') {
      this.settings.reduce = (t as HTMLInputElement).checked;
      this.applySettings();
      this.saveSettings();
    } else if (act === 'o-node') {
      this.order.node = Number(t.value);
      this.renderSheet(true);
    } else if (act === 'o-item') {
      this.order.item = Number(t.value);
      this.renderSheet(true);
    } else if (act === 'o-qty') {
      this.order.qty = Math.max(1, Math.floor(Number(t.value) || 1));
      if (e.type === 'change') this.renderSheet(true);
    } else if (act === 'import' && e.type === 'change') {
      const f = (t as HTMLInputElement).files?.[0];
      if (f) {
        if (f.size > 20 * 1024 * 1024) this.store.toast('檔案太大', 'warn');
        else void f.text().then((txt) => this.onImport(txt));
      }
    }
  }

  onImport: (text: string) => void = () => {};
  onNewGame: () => void = () => {};

  private async cmd(type: string, payload: Record<string, unknown>, okText: string): Promise<boolean> {
    const r = await this.store.command(type, payload);
    if (r.status === 'rejected') {
      this.store.toast(`⛔ ${reasonText(r.reason)}`, 'warn');
      return false;
    }
    this.store.toast(okText, 'good');
    return true;
  }

  private onClick(ev: Event): void {
    const el = (ev.target as HTMLElement).closest('[data-act]') as HTMLElement | null;
    if (!el) return;
    const act = el.dataset.act!;
    const [a, p1, p2, p3] = act.split(':');
    switch (a) {
      case 'sub': this.sub[p1!] = p2!; this.renderSheet(true); break;
      case 'mode': {
        if (p1 === 'none') this.setMode({ kind: 'select' });
        else this.setMode(BUILD_OPTIONS.find((o) => o.id === p1)!.mode);
        this.renderSheet(true);
        break;
      }
      case 'locked': this.store.toast(`🔒 ${this.lockLabel(p1!)}：村子成長後解鎖（🎯）`, 'warn'); break;
      case 'do': void this.doBuild(p1!); break;
      case 'cancel': void this.cmd('CancelWork', { workId: Number(p1) }, '↩ 已撤銷'); break;
      case 'prop': void this.cmd('RespondProposal', { proposalId: Number(p1), response: p2 }, p2 === 'approve' ? '✔ 已核准' : p2 === 'defer' ? '⏳ 已延後' : '✖ 已拒絕'); break;
      case 'policy': {
        const k = p1!;
        void this.cmd('SetPolicy', { key: k, value: this.draft[k] }, '⌛ 下季生效').then((ok) => {
          if (ok) delete this.draft[k];
        });
        break;
      }
      case 'heir-set': {
        const sel = document.querySelector('select[data-act="heir"]') as HTMLSelectElement | null;
        if (sel) void this.cmd('NominateHeir', { npcId: Number(sel.value) }, '已指定繼承人');
        break;
      }
      case 'stand': void this.cmd('StandForElection', {}, '已參選'); break;
      case 'switch': void this.cmd('SwitchFamily', { householdId: Number(p1) }, '已接手新家族'); break;
      case 'invest': void this.cmd('SetPersonalChoice', { kind: 'invest', enterpriseId: Number(p1), amount: Number(p2) }, '已注資'); break;
      case 'upgrade': void this.cmd('UpgradeBuilding', { buildingId: Number(p1) }, '🔨 排入施工'); break;
      case 'order': void this.cmd('OrderImport', { nodeId: this.order.node, item: this.order.item, qty: this.order.qty }, '🚚 已下單'); break;
      case 'npc': this.openNpc(Number(p1)); break;
      case 'follow': this.scene.follow(Number(p1)); this.store.toast('🎯 追蹤中'); break;
      case 'card-close': this.card = null; this.scene.select(null); this.renderCard(); break;
      case 'save': this.store.send({ kind: 'save' }); this.store.toast('💾 已存檔', 'good'); break;
      case 'export': this.store.send({ kind: 'exportSave' }); break;
      case 'newgame': this.onNewGame(); break;
      case 'tutorial': this.restartTutorial(); this.closeSheet(); break;
      default: break;
    }
    void p3;
  }

  private openNpc(id: number): void {
    this.card = { kind: 'npc', id };
    this.scene.select({ kind: 'npc', id });
    this.renderCard();
    this.closeSheet();
  }

  private async doBuild(kind: string): Promise<void> {
    const s = this.store.snap;
    if (!s) return;
    let ok = false;
    if (kind === 'road') ok = await this.cmd('BuildRoad', { tiles: this.roadTiles, mode: this.mode.kind === 'road' ? this.mode.mode : 'dirt' }, '🔨 排入施工');
    else if (kind === 'place' && this.mode.kind === 'place' && this.anchor) ok = await this.cmd('PlaceBuilding', { type: this.mode.type, x: this.anchor.x, y: this.anchor.y }, '🔨 排入施工');
    else if (kind === 'zone' && this.mode.kind === 'zone' && this.anchor && this.rect) {
      const a = this.anchor;
      const b = this.rect;
      ok = await this.cmd('ZoneLand', { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x) + 1, h: Math.abs(a.y - b.y) + 1, kind: this.mode.zone }, '已劃設');
    }
    if (ok) {
      this.setMode({ kind: 'select' });
      this.renderSheet(true);
    }
  }

  // ---------- 設定 ----------
  loadSettings(): void {
    try {
      const raw = localStorage.getItem('ss-settings');
      if (raw) Object.assign(this.settings, JSON.parse(raw));
    } catch { /* 無法讀取時採預設 */ }
    this.applySettings();
  }
  private saveSettings(): void {
    try {
      localStorage.setItem('ss-settings', JSON.stringify(this.settings));
    } catch { /* 忽略 */ }
  }
  private applySettings(): void {
    document.documentElement.style.setProperty('--fs', `${this.settings.fs}px`);
    document.body.classList.toggle('no-motion', this.settings.reduce);
    this.scene.reduceMotion = this.settings.reduce;
  }

  showFamilySelect(canContinue: boolean, onPick: (family: number) => void, onContinue: () => void): void {
    const m = document.querySelector('#modal') as HTMLElement;
    m.hidden = false;
    m.innerHTML = `<div class="box"><div class="big">生生之境</div><p class="muted">👑 選一個家族，開始當領袖</p>${FAMILIES.map((f, i) => `<div class="card"><b>${f.name}</b><div class="muted">${f.desc}</div><button class="btn primary" data-pick="${i}">✔</button></div>`).join('')}${canContinue ? `<button class="btn" data-continue="1">▶ 繼續</button>` : ''}</div>`;
    m.onclick = (e) => {
      const t = e.target as HTMLElement;
      const pick = t.closest('[data-pick]') as HTMLElement | null;
      if (pick) {
        m.hidden = true;
        onPick(Number(pick.dataset.pick));
      } else if (t.closest('[data-continue]')) {
        m.hidden = true;
        onContinue();
      }
    };
  }
}

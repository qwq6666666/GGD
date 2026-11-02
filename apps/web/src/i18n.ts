export const SEASONS = ['春', '夏', '秋', '冬'];
export const COMMODITIES = ['糧食', '木材', '石材', '工具', '家具'];
export const GROUPS = ['農戶', '工匠', '商人', '無業'];
export const FAMILIES = [
  { name: '農耕世家', desc: '農業技能高，與農戶關係深；家中三位成年人皆務農。', hh: 1 },
  { name: '工匠家族', desc: '工藝技能高；家中兩位工匠，現金較少，需靠公共工程與工資過活。', hh: 4 },
  { name: '商旅家族', desc: '商業技能高、現金較多，與貿易節點有往來；較不依賴農田。', hh: 6 },
];

export const BUILDING_LABEL: Record<string, string> = {
  home: '住宅', field: '農田', lumber: '林場', quarry: '採石場', toolshop: '工具工坊', furnshop: '家具工坊', market: '市場', storage: '倉庫', school: '學堂', clinic: '診所', publichome: '公共住宅',
};

export const REASON: Record<string, string> = {
  stale_world_version: '世界狀態剛變動，請重試',
  late_command: '命令過期',
  not_implemented: '尚未開放',
  invalid_target: '目標無效',
  insufficient_budget: '公共資金不足',
  insufficient_funds: '家庭資金不足',
  no_permission: '目前不是領袖，沒有這項權限',
  nothing_to_build: '沒有需要興建的地方',
  unknown_policy: '未知政策',
  out_of_range: '數值超出範圍',
  unknown_project: '找不到工程',
  unknown_proposal: '找不到提案',
  not_open: '提案已處理',
  no_space: '找不到合適的空地',
  not_allowed: '現在不能這麼做',
  node_capacity: '超過貿易節點運量',
  unknown_node: '未知貿易節點',
  unknown_household: '找不到家庭',
  no_adult: '該家庭沒有成年人',
  'invalid_target:out_of_bounds': '超出地圖',
  'invalid_target:not_buildable': '這裡不能蓋（水、森林、坡地或可建區外）',
  'invalid_target:overlap': '與其他建築重疊',
  'invalid_target:entrance_blocked': '出入口被擋住',
  'invalid_target:bad_type': '無法興建此類型',
};
export const reasonText = (r: string): string => REASON[r] ?? r;

export const POLICY_LABEL: Record<string, string> = {
  harvestTaxPermille: '收成稅（‰）',
  commerceTaxPermille: '商業稅（‰）',
  agriSubsidy: '農業補助（文／農田／季）',
  housingSubsidy: '住宅補助',
  mintPerSeason: '鑄幣發行（文／季）',
  leaderSalaryMonthly: '領袖俸給（文／月，基準 60）',
  roadPriority: '道路優先',
  workRelief: '以工代賑（0 關／1 開）',
  educationBudget: '教育預算（文／季）',
  healthBudget: '醫療預算（文／季）',
};

export const POLICY_RANGE: Record<string, [number, number, number]> = {
  harvestTaxPermille: [0, 200, 10],
  commerceTaxPermille: [0, 100, 5],
  agriSubsidy: [0, 200, 10],
  mintPerSeason: [0, 5000, 100],
  leaderSalaryMonthly: [0, 400, 10],
  workRelief: [0, 1, 1],
  educationBudget: [0, 200, 10],
  healthBudget: [0, 200, 10],
};

export const PROPOSAL_LABEL: Record<string, string> = { road: '修路', food_crisis: '糧食告急', housing: '住房不足', tools: '工具短缺', clinic: '診療不足' };

export function esc(s: unknown): string {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export function fmtDays(tick: number, now: number): string {
  const d = tick - now;
  if (d <= 0) return '現在';
  return `${d} 日後`;
}

export const STATE_LABEL = ['閒置', '評估', '規劃', '預約', '通勤', '工作', '結算', '休息'];
export const TRAIT_LABEL = ['保守', '冒險', '重家庭', '勤勞', '巧手', '合群'];

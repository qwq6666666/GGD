# ADR-0003：V1 世界狀態採純 JSON 物件（AoS），SoA 延後

- 狀態：提議（待開發者確認；與 GDD 11.2「NPC 熱資料以 SoA 儲存」有偏差）

## 背景
V1 顯示規模為 24 人，壓測 200–500 人。SoA（TypedArray）在此規模的效益有限，卻增加序列化、除錯與比對成本。

## 決策
A1–A3 以純 JSON 物件陣列儲存實體（依 ID 排序），禁止 Map/Set/class 實例。
當 headless 壓測顯示 500 人單日步進 p95 > 30ms 時，再把 NPC 熱欄位改為 SoA，並以相同 hash 測試保護。

## 影響
- 存檔與 hash 可直接使用 `canonicalize`。
- 若改 SoA，需在序列化層轉回陣列以維持存檔格式。

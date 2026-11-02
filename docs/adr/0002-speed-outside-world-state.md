# ADR-0002：速度與自動降速不屬於世界狀態

- 狀態：已採用（A0）
- 依據：GDD 3（速度不改變規則）、8.3（重大事件自動降速）、14（速度一致性）

## 決策
`SetSpeed`、`Pause` 與自動降速只由 Web Worker 的排程層處理：Worker 依速度決定每秒呼叫幾次 `step()`。
這些操作不進入世界狀態、不寫入命令日誌，因此不影響狀態 hash 與回放。

## 影響
- `packages/schema` 的命令清單不含 SetSpeed/Pause/Save/Load（它們是 Worker 協定訊息，見 `apps/web/src/protocol.ts`）。
- Worker 以 `issuedTick = world.tick` 為命令蓋章；sim 拒絕 `issuedTick < tick` 的過期命令，保證回放時套用日相同。

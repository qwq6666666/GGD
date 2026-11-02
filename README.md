# 生生之境

自主社會演化與歷史生成的輕鬆觀察型建設模擬（Web PWA）。規格見 [`docs/GDD_v3.1.md`](docs/GDD_v3.1.md)，
規劃建議見 [`docs/planning/v1-plan-review.md`](docs/planning/v1-plan-review.md)。

```sh
pnpm install
pnpm verify                                   # lint + typecheck + test + headless + build
pnpm headless --scenario all --years 10   # 無畫面驗收
pnpm dev                                  # Web 殼（除錯畫面）
```

目前進度：**A0 工程底座**。開發守則見 [`CLAUDE.md`](CLAUDE.md)。

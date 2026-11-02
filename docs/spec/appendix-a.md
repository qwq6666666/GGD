> 來源：docs/GDD_v3.1.md（唯一有效規格）。本檔為依章節拆分的副本，供任務只載入相關章節。

## 附錄 A：核心資料契約（最小欄位）

所有引用使用穩定
ID；刪除的角色保留墓碑；命令須驗證世界版本與前置條件；事件日誌只記錄已提交的權威結果。所有數值欄位為整數或定點數。

  -----------------------------------------------------------------------
  實體             欄位
  ---------------- ------------------------------------------------------
  World            id, seed, prngState, tick, version,
                   leadership{leaderId, playerHouseholdId, support,
                   termStartTick, nextElectionTick}

  NPC              id, householdId, homeId, jobId, location, needs,
                   skills, traits, plan, experienceTags, relations,
                   memoryRefs, controller（player \| ai）

  Household        id, memberIds, accountId, inventoryId, homeId

  Building         id, type, footprint, ownerId, stage, inventoryId

  Enterprise       id, ownerId, employeeIds, accountId, inventoryId,
                   strategy

  PublicWork       id, buildingId, requiredPersonDays, progress, wage,
                   reservedMaterials

  Account          id, ownerId, balance

  Inventory        id, ownerId, stacks

  Transaction      id, tick, lines, causeId

  Proposal         id, proposerId, target, evidence, cost,
                   expectedEffects, expiry, status

  Policy           id, scope, effectiveTick, parameters

  Event            id, tick, type, actorIds, placeId, causeIds,
                   stateDeltas, importance, visibility

  TradeNode        id, accountId, inventoryId, priceTable, transitDays,
                   capacity

  Shipment         id, origin, destination, contents, departTick,
                   arriveTick, status

  Tombstone        id, name, birthTick, deathTick, householdId,
                   keyEventIds
  -----------------------------------------------------------------------

新增欄位：Household.reciprocity\[\]{targetHouseholdId, balance,
lastTick}（人情債，非貨幣）；NPC.interestGroup、satisfaction、satisfactionBaseline；Settlement.moneySupply、priceIndex、attractiveness；Enterprise.wageOffer；Market.expectedPrice\[商品
× 季節\]。

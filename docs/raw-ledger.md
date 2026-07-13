# RAW Compliance Ledger

Maps every automated mechanic to its rules-as-written source. Book = *Force and Destiny
Core Rulebook* (the three FFG core books share these mechanics chapter-for-chapter);
page numbers are the book's printed footer numbers (PDF page = book page + 3 in the
owned scan). Update the relevant row whenever `modules/helpers/healing.js`,
`modules/swffg-main.js` (chat-hook block), or `modules/groupmanager-ffg.js` change.

`scripts/verify-static.mjs` (`npm test`) asserts the pure-math invariants below at node
level; the rest need the in-Foundry checklist at the bottom.

Status: VERIFIED (checked against the PDF) / DEVIATION (works, but documented house
rule) / TODO-VERIFY / BLOCKED (source not owned). `verified-by` records who checked and
when — a row without it is code-only inference.

| Rule (book) | Page | Code | Status |
|---|---|---|---|
| Table 6-10 Critical Injury Result — 29 bands, names, d100 edges, 151+ Dead | p.225 | `HealingHelpers.critTable` | VERIFIED (agent+orchestrator image-read, 2026-07-13) |
| +10 to crit roll per existing Critical Injury | p.226 | `rollCritical` (`existing * 10`) | VERIFIED 2026-07-13 |
| Exceeding wound threshold → incapacitated + Critical Injury | p.220-221 | `applyDamage` over-threshold branch | VERIFIED 2026-07-13 |
| Table 6-11 Medicine difficulty (≤half Easy / >half Average / >threshold Hard) | p.123 & p.226 | `medicineDifficulty` | VERIFIED 2026-07-13 |
| Medicine heals wounds = successes, strain = advantage | p.226 | heal button in `swffg-main.js` chat hook | VERIFIED 2026-07-13 |
| Stimpack heals 5,4,3,2,1 then 0 per day | p.227 | `useMedicalItem` (medicalType 1) | VERIFIED 2026-07-13 |
| Emergency repair patch: flat 3 wounds, shares the five-per-day limit | p.227 | `useMedicalItem` (medicalType 2) | VERIFIED + FIXED 2026-07-13 (cap was missing) |
| Minions never suffer strain; strain damage deals wounds instead | p.400 | `applyDamage` minion redirect | VERIFIED + FIXED 2026-07-13 (was writing to strain) |
| Minion kill accounting: a minion dies when group wounds *exceed* each per-minion threshold multiple | p.400 | `reportMinionKills` | VERIFIED 2026-07-13 (worked example) |
| Critical Injury vs minion group: kills one minion outright, no d100 | p.400 | `rollCritical` minion branch → `minionCritWounds` | VERIFIED + FIXED 2026-07-13 (off-by-one killed 2 at exact-multiple wounds) |
| Pierce: ignore 1 soak per rank (capped at target's soak) | p.164 | `qualityRanks(/^pierce/i)` in chat hook | VERIFIED 2026-07-13 |
| Breach: ignore 1 armor / 10 soak per rank | p.162 | `qualityRanks(/^breach/i) * 10` | VERIFIED 2026-07-13 |
| Stun Damage: deals strain instead of wounds, still reduced by soak | p.164 | `stunDamage` flag in chat hook | VERIFIED 2026-07-13 |
| Vicious: +10 × rank to Critical Injury rolls | p.164 | `critBonus` in chat hook | VERIFIED 2026-07-13 |
| Durable talent: −10 per rank on Critical Injury results, min 1 | p.142 | `talentRanks(/^durable/i)` in `rollCritical` | VERIFIED 2026-07-13 |
| End-of-encounter strain recovery: Simple Discipline **or** Cool check, 1 strain per success | p.229 | `_endOfEncounter` in groupmanager | DEVIATION — auto mode picks the better skill for the player (disclosed in code comment) |
| Stimpack uses reset per in-game day | p.227/229 | `_endOfSession` zeroes `medical.uses` | DEVIATION — resets per session, not per day (disclosed in code comment) |
| Adversary talent: upgrade difficulty of all combat checks against the target once per rank | p.404 | `DiceHelpers.getAdversaryUpgrades` (weapon rolls only, max across targets) | VERIFIED 2026-07-13 |
| Obligation triggered: party strain threshold −2 (−1 for the rolled PC's player... table variant) | EotE Core Obligation chapter | groupmanager obligation effects | BLOCKED — EotE Core not owned; memory-sourced values, flagged. Re-trigger: user provides the book/table |
| Natural rest: 1 wound per full night's rest | p.226 | `_nightsRest` (Group Manager "Night's Rest" button) | VERIFIED + BUILT 2026-07-13 |
| Weekly Resilience check vs crit severity; bacta tank / oil bath rates | p.226 | not automated | NOT BUILT — manual GM rolls; no in-game calendar to automate "per week"/"per hour" |

## Deliberately not built (re-trigger conditions)

- Vehicle-scale damage (armor = 10 soak, hull trauma; p.231) — `applyDamage` warns and
  bails. Re-trigger: user asks after vehicle rules review.
- Advantage/threat spend automation; Auto-fire/Linked extra hits — GM judgment, prior rejection stands.
- Crit-status ↔ `criticalinjury` item sync — two sources of truth, rejected.
- Bacta tank / oil bath timed recovery — no in-game clock to hang it on.
- Encumbrance automation — untouched by this layer; separate effort if ever wanted.
- Live-world self-test harness — rejected (spams chat/canvas, leaks actors on crash);
  `verify-static.mjs` + the checklist below instead.
- `renderChatMessage` → `renderChatMessageHTML` migration — deprecated-but-working in
  v13. Re-trigger: first Foundry v14+ bump.

## In-Foundry smoke-test checklist (riskiest first — none of this code has run yet)

1. Two clients (GM + player): player targets a minion group, attacks with a Stun Damage
   weapon, clicks Apply — wounds (not strain) drop, applied via the GM socket.
2. Close the GM client; player clicks Apply — "No GM is logged in" warning, no silent loss.
3. Delete a targeted token before clicking Apply — no console error.
4. Double-click Apply — damage lands once (button disables).
5. Roll Critical, then heal below threshold — Defeated clears, crit status stays.
6. End of Encounter with 3+ mixed characters — Simple check math, strain floors at 0.
7. Minion group at exactly one full unit of wounds takes a crit — exactly one dies.
8. Repair patch on a droid 6× — 6th heals 0. Stimpack ramp 5..1 then 0.
9. Obligation trigger → party strain-threshold effects appear; End of Session clears them.
10. Reload (F5) an old attack message — Apply buttons still render and work.

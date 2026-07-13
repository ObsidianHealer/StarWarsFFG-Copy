/**
 * Node-level static verifier for the automation layer — no Foundry, no deps.
 * Run: node scripts/verify-static.js  (also wired to `npm test`)
 * Asserts the pure-math invariants that the RAW ledger (docs/raw-ledger.md)
 * relies on, so drift surfaces as a failing check instead of silent staleness.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const { default: HealingHelpers } = await import("../modules/helpers/healing.js");

// --- critTable matches Table 6-10 (F&D Core p.225): 29 bands, ascending, ends open-ended
const table = HealingHelpers.critTable;
assert.equal(table.length, 29, "crit table must have 29 bands");
for (let i = 1; i < table.length; i++) assert.ok(table[i][0] > table[i - 1][0], `crit bands ascending at ${i}`);
assert.equal(table[0][0], 5, "first band ends at 5");
assert.equal(table.at(-2)[0], 150, "the-end-is-nigh band ends at 150");
assert.equal(table.at(-1)[0], Infinity, "last band is open-ended (151+ dead)");
assert.equal(table.at(-1)[1], "dead");

// --- medicine difficulty matches Table 6-11 (p.226): ≤half Easy, >half Average, >threshold Hard
const patient = (value, max) => ({ system: { stats: { wounds: { value, max } } } });
assert.equal(HealingHelpers.medicineDifficulty(patient(5, 10)), 1, "half or less = Easy");
assert.equal(HealingHelpers.medicineDifficulty(patient(6, 10)), 2, "over half = Average");
assert.equal(HealingHelpers.medicineDifficulty(patient(11, 10)), 3, "over threshold = Hard");

// --- minion crit kills exactly one minion at every starting wound total (p.400)
const kills = (wounds, unit) => Math.floor((wounds - 1) / unit); // mirrors reportMinionKills
for (const [current, unit] of [[0, 5], [4, 5], [5, 5], [6, 5], [10, 5], [7, 12]]) {
  const before = current > 0 ? kills(current, unit) : 0;
  const after = kills(HealingHelpers.minionCritWounds(current, unit), unit);
  assert.equal(after, before + 1, `crit at wounds=${current} unit=${unit} kills exactly one`);
}

// --- qualityRanks / talentRanks work on plain data shapes
const weapon = { system: { itemmodifier: [{ name: "Pierce 2", system: { rank: 2 } }], itemattachment: [{ system: { itemmodifier: [{ name: "Pierce", system: { active: true, rank: 1 } }] } }] } };
assert.equal(HealingHelpers.qualityRanks(weapon, /^pierce/i), 3, "pierce ranks incl. active attachment mods");
const owner = { items: [{ type: "talent", name: "Durable", system: { ranks: { current: 2 } } }] };
assert.equal(HealingHelpers.talentRanks(owner, /^durable/i), 2, "durable talent ranks");

// --- every socket event emitted in modules/ has a listener case somewhere in modules/
const jsFiles = [];
(function walk(dir) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p);
    else if (f.endsWith(".js")) jsFiles.push(p);
  }
})(join(repo, "modules"));
const source = jsFiles.map((f) => readFileSync(f, "utf8")).join("\n");
const emitted = [...source.matchAll(/game\.socket\.emit\("system\.starwarsffg",\s*\{\s*event:\s*"([^"]+)"/g)].map((m) => m[1]);
for (const ev of new Set(emitted)) {
  assert.ok(new RegExp(`(?:event\\w*\\s*[!=]==?\\s*|case\\s+)"${ev}"`).test(source), `socket event "${ev}" has a listener case`);
}

console.log("verify-static: all checks passed");

/**
 * Automated damage/healing application helpers.
 * Players can't update actors they don't own, so all stat writes route through
 * updateActorStats, which falls back to a socket event handled by the active GM.
 */
export default class HealingHelpers {
  static registerSocketListener() {
    game.socket.on("system.starwarsffg", async (data) => {
      if (data?.event !== "applyStatChange") return;
      if (game.user.id !== game.users.activeGM?.id) return;
      const actor = await this.resolveTargetActor(data.actorUuid);
      if (!actor) return;
      if (data.statusId) await actor.toggleStatusEffect(data.statusId, { active: data.active ?? true });
      else await actor.update(data.updates);
    });
  }

  static async updateActorStats(actor, updates) {
    if (actor.canUserModify(game.user, "update")) {
      return actor.update(updates);
    }
    game.socket.emit("system.starwarsffg", { event: "applyStatChange", actorUuid: actor.uuid, updates });
  }

  // accepts token or actor uuids
  static async resolveTargetActor(uuid) {
    const doc = await fromUuid(uuid);
    return doc?.actor ?? doc;
  }

  static async applyStatus(actor, statusId, active = true) {
    if (actor.canUserModify(game.user, "update")) {
      return actor.toggleStatusEffect(statusId, { active });
    }
    game.socket.emit("system.starwarsffg", { event: "applyStatChange", actorUuid: actor.uuid, statusId, active });
  }

  // total ranks of a weapon quality (own mods + active attachment mods) whose name matches pattern
  static qualityRanks(item, pattern) {
    let ranks = 0;
    for (const mod of item.system?.itemmodifier ?? []) {
      if (pattern.test(mod?.name ?? "")) ranks += parseInt(mod.system?.rank, 10) || 1;
    }
    for (const attachment of item.system?.itemattachment ?? []) {
      for (const mod of attachment.system?.itemmodifier ?? []) {
        if (mod.system?.active && pattern.test(mod?.name ?? "")) ranks += parseInt(mod.system?.rank, 10) || 1;
      }
    }
    return ranks;
  }

  // total ranks of an actor's talents whose name matches pattern
  static talentRanks(actor, pattern) {
    return (actor?.items ?? [])
      .filter((i) => i.type === "talent" && pattern.test(i.name))
      .reduce((sum, t) => sum + (parseInt(t.system?.ranks?.current, 10) || 1), 0);
  }

  // clear the Defeated status once wounds are back at or under the threshold
  static async clearDefeatedIfRecovered(actor, newWounds) {
    const max = actor.system.stats?.wounds?.max ?? 0;
    if (max > 0 && newWounds <= max && actor.statuses?.has("starwarsffg-defeated")) {
      await this.applyStatus(actor, "starwarsffg-defeated", false);
    }
  }

  static async applyDamage(uuid, damage, asStrain = false, soakReduction = 0, critBonus = 0) {
    const actor = await this.resolveTargetActor(uuid);
    if (!actor) return;
    if (actor.type === "vehicle") {
      // ponytail: personal scale only; vehicle armor/hull rules differ enough to stay manual
      return ui.notifications.warn(game.i18n.localize("SWFFG.AutoApply.NoVehicles"));
    }
    const soak = Math.max((actor.system.stats?.soak?.value ?? 0) - soakReduction, 0);
    const suffered = Math.max(damage - soak, 0);
    const stat = asStrain ? "strain" : "wounds";
    const current = actor.system.stats?.[stat]?.value ?? 0;
    const max = actor.system.stats?.[stat]?.max ?? 0;
    const newValue = current + suffered;
    const minionsBefore = actor.system.quantity?.value; // capture before the update recalculates it
    await this.updateActorStats(actor, { [`system.stats.${stat}.value`]: newValue });
    await ChatMessage.create({
      content: `<i>${game.i18n.format(asStrain ? "SWFFG.AutoApply.StrainResult" : "SWFFG.AutoApply.DamageResult", { name: actor.name, wounds: suffered, strain: suffered, damage, soak })}</i>`,
    });
    if (!asStrain && actor.type === "minion") {
      return this.reportMinionKills(actor, newValue, minionsBefore);
    }
    if (newValue > max && max > 0) {
      await this.applyStatus(actor, "starwarsffg-defeated");
      await ChatMessage.create({ content: `<i>${game.i18n.format("SWFFG.AutoApply.Incapacitated", { name: actor.name })}</i>` });
      if (!asStrain) {
        // RAW: exceeding the wound threshold also inflicts a critical injury
        await this.rollCritical(uuid, critBonus);
      }
    }
  }

  // announce minion deaths from a group's new wound total (mirrors the quantity formula in actor-ffg.js)
  static async reportMinionKills(actor, newWounds, before) {
    const unit = actor.system.unit_wounds?.value ?? 0;
    const qmax = actor.system.quantity?.max ?? 0;
    if (unit <= 0 || qmax <= 0) return;
    before = before ?? qmax;
    const after = Math.max(Math.min(qmax, qmax - Math.floor((newWounds - 1) / unit)), 0);
    if (after >= before) return;
    await ChatMessage.create({
      content: `<i>${game.i18n.format("SWFFG.AutoApply.MinionKills", { name: actor.name, killed: before - after, remaining: after })}</i>`,
    });
    if (after === 0) {
      await this.applyStatus(actor, "starwarsffg-defeated");
    }
  }

  // core rulebook critical injury table: [max d100 total, crit status suffix]
  static critTable = [
    [5, "minor-nick"], [10, "slowed-down"], [15, "sudden-jolt"], [20, "distracted"],
    [25, "off-balance"], [30, "discouraging-wound"], [35, "stunned"], [40, "stinger"],
    [45, "bowled-over"], [50, "head-ringer"], [55, "fearsome-wound"], [60, "agonizing-wound"],
    [65, "slightly-dazed"], [70, "scattered-senses"], [75, "hamstrung"], [80, "overpowered"],
    [85, "winded"], [90, "compromised"], [95, "at-the-brink"], [100, "crippled"],
    [105, "maimed"], [110, "horrific-injury"], [115, "temporarily-lame"], [120, "blinded"],
    [125, "knocked-senseless"], [130, "gruesome-injury"], [140, "bleeding-out"],
    [150, "the-end-is-nigh"], [Infinity, "dead"],
  ];

  static async rollCritical(uuid, critBonus = 0) {
    const actor = await this.resolveTargetActor(uuid);
    if (!actor || actor.type === "vehicle") return;
    if (actor.type === "minion") {
      // RAW: a critical injury against a minion group kills one minion outright
      const unit = actor.system.unit_wounds?.value ?? 0;
      if (unit <= 0) return;
      const current = actor.system.stats?.wounds?.value ?? 0;
      const newWounds = current + (unit - (current % unit)) + 1;
      const minionsBefore = actor.system.quantity?.value;
      await this.updateActorStats(actor, { "system.stats.wounds.value": newWounds });
      await ChatMessage.create({ content: `<i>${game.i18n.format("SWFFG.AutoApply.MinionCrit", { name: actor.name })}</i>` });
      return this.reportMinionKills(actor, newWounds, minionsBefore);
    }
    // RAW: +10 to the roll for each critical injury the target already has,
    // +10 per rank of the weapon's Vicious (critBonus), -10 per rank of the target's Durable (min 1)
    const existing = actor.effects.filter((e) => [...(e.statuses ?? [])].some((s) => s.startsWith("starwarsffg-crit-"))).length;
    const bonus = existing * 10 + critBonus - 10 * this.talentRanks(actor, /^durable/i);
    const roll = new Roll("1d100");
    await roll.evaluate();
    const total = Math.max(roll.total + bonus, 1);
    const [, critId] = this.critTable.find(([max]) => total <= max);
    const statusId = `starwarsffg-crit-${critId}`;
    const statusName = game.i18n.localize(CONFIG.statusEffects.find((s) => s.id === statusId)?.name ?? statusId);
    await this.applyStatus(actor, statusId);
    await roll.toMessage({
      flavor: game.i18n.format("SWFFG.AutoApply.CritResult", { name: actor.name, injury: statusName, roll: roll.total, bonus, total }),
    });
  }

  static async applyHealing(uuid, wounds, strain = 0) {
    const actor = await this.resolveTargetActor(uuid);
    if (!actor || actor.type === "vehicle") return;
    const newWounds = Math.max((actor.system.stats?.wounds?.value ?? 0) - wounds, 0);
    const updates = { "system.stats.wounds.value": newWounds };
    if (strain && actor.system.stats?.strain) {
      updates["system.stats.strain.value"] = Math.max((actor.system.stats.strain?.value ?? 0) - strain, 0);
    }
    await this.updateActorStats(actor, updates);
    await this.clearDefeatedIfRecovered(actor, newWounds);
    await ChatMessage.create({
      content: `<i>${game.i18n.format("SWFFG.AutoApply.HealResult", { name: actor.name, wounds, strain })}</i>`,
    });
  }

  // RAW medicine check difficulty from the patient's current wounds
  static medicineDifficulty(actor) {
    const wounds = actor.system.stats?.wounds?.value ?? 0;
    const max = actor.system.stats?.wounds?.max ?? 0;
    if (wounds > max) return 3;
    if (wounds > max / 2) return 2;
    return 1;
  }

  // Use a stimpack/repair patch, on a targeted character if one is targeted, otherwise on self.
  static async useMedicalItem(user, item) {
    const consume = game.settings.get("starwarsffg", "consumeHealingItem");
    if (!item || (item.system.quantity.value <= 0 && consume)) return;

    const targets = [...game.user.targets];
    const useTargeting = game.settings.get("starwarsffg", "enableAutoApply") && targets.length === 1 && targets[0].actor;
    const recipient = useTargeting ? targets[0].actor : user;
    if (recipient.type === "vehicle") return;

    // RAW: the diminishing 5/4/3... stimpack cap belongs to the patient, not the medic
    const prevUses = recipient.system?.stats?.medical?.uses ?? 0;
    if (consume) {
      await item.update({ "system.quantity.value": item.system.quantity.value - 1 });
    }
    const newUses = prevUses + 1;
    const currentWounds = recipient.system?.stats?.wounds?.value ?? 0;
    let woundsHealing = 0;
    if (item.flags.starwarsffg.config.medicalType == 1) { // stimpack
      woundsHealing = Math.max(5 - prevUses, 0);
    } else if (item.flags.starwarsffg.config.medicalType == 2) { // emergency droid patch
      woundsHealing = 3;
    }
    const newWounds = Math.max(currentWounds - woundsHealing, 0);
    await this.updateActorStats(recipient, {
      "system.stats.medical.uses": newUses,
      "system.stats.wounds.value": newWounds,
    });
    await this.clearDefeatedIfRecovered(recipient, newWounds);

    const itemName = recipient?.flags?.starwarsffg?.config?.medicalItemName || game.i18n.localize("SWFFG.DefaultMedicalItemName");
    const content = recipient.id === user.id
      ? `<i>${game.i18n.localize("SWFFG.MedicalItemUse")} ${itemName} #${newUses}</i>`
      : `<i>${game.i18n.format("SWFFG.MedicalItemUseOn", { user: user.name, item: itemName, uses: newUses, target: recipient.name, wounds: woundsHealing })}</i>`;
    await ChatMessage.create({ speaker: { alias: user.name }, content });
  }
}

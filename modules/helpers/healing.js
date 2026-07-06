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
      if (data.statusId) await actor.toggleStatusEffect(data.statusId, { active: true });
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

  static async applyStatus(actor, statusId) {
    if (actor.canUserModify(game.user, "update")) {
      return actor.toggleStatusEffect(statusId, { active: true });
    }
    game.socket.emit("system.starwarsffg", { event: "applyStatChange", actorUuid: actor.uuid, statusId });
  }

  static async applyDamage(uuid, damage, asStrain = false) {
    const actor = await this.resolveTargetActor(uuid);
    if (!actor) return;
    if (actor.type === "vehicle") {
      // ponytail: personal scale only; vehicle armor/hull rules differ enough to stay manual
      return ui.notifications.warn(game.i18n.localize("SWFFG.AutoApply.NoVehicles"));
    }
    const soak = actor.system.stats?.soak?.value ?? 0;
    const suffered = Math.max(damage - soak, 0);
    const stat = asStrain ? "strain" : "wounds";
    const current = actor.system.stats?.[stat]?.value ?? 0;
    const max = actor.system.stats?.[stat]?.max ?? 0;
    const newValue = current + suffered;
    await this.updateActorStats(actor, { [`system.stats.${stat}.value`]: newValue });
    await ChatMessage.create({
      content: `<i>${game.i18n.format(asStrain ? "SWFFG.AutoApply.StrainResult" : "SWFFG.AutoApply.DamageResult", { name: actor.name, wounds: suffered, strain: suffered, damage, soak })}</i>`,
    });
    if (newValue > max && max > 0) {
      await this.applyStatus(actor, "starwarsffg-defeated");
      await ChatMessage.create({ content: `<i>${game.i18n.format("SWFFG.AutoApply.Incapacitated", { name: actor.name })}</i>` });
      if (!asStrain) {
        // RAW: exceeding the wound threshold also inflicts a critical injury
        await this.rollCritical(uuid);
      }
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

  static async rollCritical(uuid) {
    const actor = await this.resolveTargetActor(uuid);
    if (!actor || actor.type === "vehicle") return;
    // RAW: +10 to the roll for each critical injury the target already has
    const existing = actor.effects.filter((e) => [...(e.statuses ?? [])].some((s) => s.startsWith("starwarsffg-crit-"))).length;
    const bonus = existing * 10;
    const roll = new Roll("1d100");
    await roll.evaluate();
    const total = roll.total + bonus;
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
    const updates = { "system.stats.wounds.value": Math.max((actor.system.stats?.wounds?.value ?? 0) - wounds, 0) };
    if (strain && actor.system.stats?.strain) {
      updates["system.stats.strain.value"] = Math.max((actor.system.stats.strain?.value ?? 0) - strain, 0);
    }
    await this.updateActorStats(actor, updates);
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
    await this.updateActorStats(recipient, {
      "system.stats.medical.uses": newUses,
      "system.stats.wounds.value": Math.max(currentWounds - woundsHealing, 0),
    });

    const itemName = recipient?.flags?.starwarsffg?.config?.medicalItemName || game.i18n.localize("SWFFG.DefaultMedicalItemName");
    const content = recipient.id === user.id
      ? `<i>${game.i18n.localize("SWFFG.MedicalItemUse")} ${itemName} #${newUses}</i>`
      : `<i>${game.i18n.format("SWFFG.MedicalItemUseOn", { user: user.name, item: itemName, uses: newUses, target: recipient.name, wounds: woundsHealing })}</i>`;
    await ChatMessage.create({ speaker: { alias: user.name }, content });
  }
}

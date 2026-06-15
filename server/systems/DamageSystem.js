const { defineQuery } = require('bitecs');
const {
    Position,
    Velocity,
    Health,
    Armor,
    Shield,
    Bullet,
    Player,
    Bot,
    KillStreak,
    Score,
    HeroClass,
    Weapon,
    Team,
} = require('../../shared/components');
const { BULLET_DAMAGE, RESPAWN_DELAY, ARMOR_ABSORPTION, WEAPONS, MODES_CONFIG, ACTIVE_GAME_MODE, TICK_RATE, DAMAGE_TYPES } = require('../../shared/constants');

// Query for entities that can take damage
const damageableQuery = defineQuery([Position, Health]);
const bulletQuery = defineQuery([Position, Bullet]);

/**
 * DamageSystem - Handles damage calculation and health management
 */
class DamageSystem {
    constructor(ecsWorld, collisionSystem, botSystem, io, respawnSystem, modifiers) {
        this.ecsWorld = ecsWorld;
        this.collisionSystem = collisionSystem;
        this.botSystem = botSystem;
        this.io = io;
        /** @type {import('./RespawnSystem')} */
        this.respawnSystem = respawnSystem;
        this.killFeed = []; // Track recent kills
        this._msgCounter = 0; // Monotonic counter for message IDs
        /** @type {import('./HeroSystem') | null} Injected after HeroSystem is created */
        this.heroSystem = null;
        /** @type {import('./ModifiersSystem')} */
        this.modifiers = modifiers;
        this.gameState = null;
        this.firstBloodOccurred = false;

        const modeConfig = (MODES_CONFIG.modes && MODES_CONFIG.modes[ACTIVE_GAME_MODE]) || {};
        this.friendlyFire = modeConfig.friendlyFire === true;
    }

    isFriendlyFireBlocked(targetEid, attackerEid) {
        const attackerTeam = Number(Team.id[attackerEid] ?? 0);
        const targetTeam = Number(Team.id[targetEid] ?? 0);
        if (attackerTeam <= 0 || targetTeam <= 0) return false;
        return !this.friendlyFire && attackerTeam === targetTeam;
    }

    /**
     * Process all bullet collisions and apply damage.
     * Also ticks shield regeneration for all damageable entities.
     */
    update(world) {
        const bullets = bulletQuery(world);
        const damageables = damageableQuery(world);
        const bulletsToRemove = [];

        // ── Bullet collision ─────────────────────────────────────────────────
        const dt = 1 / TICK_RATE;
        const physicsWorld = this.collisionSystem.physicsWorld;

        for (const bulletEid of bullets) {
            if (Bullet.type[bulletEid] !== 0) continue;
            //console.log(Bullet.type[bulletEid])
            const ownerEid = Bullet.owner[bulletEid];
            const bulletRadius = 0.4;

            const bx = Position.x[bulletEid];
            const by = Position.y[bulletEid];
            const bz = Position.z[bulletEid];

            const prevBx = bx - Velocity.vx[bulletEid] * dt;
            const prevBy = by - Velocity.vy[bulletEid] * dt;
            const prevBz = bz - Velocity.vz[bulletEid] * dt;

            const sdx = bx - prevBx;
            const sdy = by - prevBy;
            const sdz = bz - prevBz;
            const segLenSq = sdx*sdx + sdy*sdy + sdz*sdz;

            let worldHit = null;
            let worldHitFraction = null;

            if (segLenSq >= 1e-10) {
                const segLen = Math.sqrt(segLenSq);
                const dir = { x: sdx / segLen, y: sdy / segLen, z: sdz / segLen };
                worldHit = physicsWorld?.raycastWorld(
                    { x: prevBx, y: prevBy, z: prevBz },
                    dir,
                    segLen
                );
                if (worldHit) {
                    worldHitFraction = worldHit.toi / segLen;
                }
            }

            const maxPlayerFraction = worldHitFraction != null ? worldHitFraction : 1;
            let bestTarget = null;
            let bestFraction = null;

            for (const targetEid of damageables) {
                if (targetEid === ownerEid) continue;

                const hitT = this.collisionSystem.getBulletHitFraction(
                    bulletEid,
                    targetEid,
                    bulletRadius,
                    maxPlayerFraction
                );
                if (hitT !== null && (bestFraction === null || hitT < bestFraction)) {
                    bestFraction = hitT;
                    bestTarget = targetEid;
                }
            }

            if (bestTarget !== null && (worldHitFraction == null || bestFraction < worldHitFraction)) {
                // Use per-weapon damage; modifiers are applied in applyDamage
                const weaponId = Weapon.id[ownerEid];
                const baseDmg = WEAPONS[weaponId]?.damage ?? BULLET_DAMAGE;
                this.applyDamage(bestTarget, ownerEid, baseDmg, { damageType: DAMAGE_TYPES.WEAPON });
                bulletsToRemove.push(bulletEid);
                continue;
            }

            if (worldHit) { // Do not trigger for physics objects
                this.io.emit('bulletImpact', {
                    x: worldHit.x,
                    y: worldHit.y,
                    z: worldHit.z,
                });
                bulletsToRemove.push(bulletEid);
            }
        }

        for (const bulletEid of bulletsToRemove) {
            this.ecsWorld.removeBulletEntity(bulletEid);
        }

        return bulletsToRemove.length;
    }

    /**
     * Apply damage to an entity, passing through shield → armor → health layers.
     * Emits playerDamaged with updated shield, armor and health values.
     */
    applyDamage(targetEid, attackerEid, damage, options = {}) {
        let ignoreArmor = false;
        let damageType = DAMAGE_TYPES.OTHER;
        if (typeof options === 'boolean') {
            ignoreArmor = options;
        } else if (options && typeof options === 'object') {
            ignoreArmor = options.ignoreArmor === true;
            damageType = options.damageType ?? DAMAGE_TYPES.OTHER;
        }

        if (Health.current[targetEid] <= 0) return;
        if (this.ecsWorld.isPlayer(targetEid) && !Player.isReady[targetEid]) return; // Don't damage players who haven't finished hero select
        if (this.isFriendlyFireBlocked(targetEid, attackerEid)) return;

        const outgoingMult = this.modifiers.getOutgoingDamageMultiplier(attackerEid, damageType);
        const incomingMult = this.modifiers.getIncomingDamageMultiplier(targetEid, damageType);
        
        const effectiveDamage = Math.max(0, Math.round(damage * outgoingMult * incomingMult));
        
        if (effectiveDamage <= 0) return;

        // Iron Stand shield-phase hook: convert a portion of incoming raw damage to shield.
        this.heroSystem?.onDamageTaken(targetEid, effectiveDamage);

        // Invulnerable entities (Iron Stand, Shadow Realm) cannot be damaged.
        if (this.heroSystem?.isInvulnerable(targetEid)) return;

        let remaining = effectiveDamage;

        // ── Layer 1: Shield ──────────────────────────────────────────────────
        if (Shield.current[targetEid] > 0) {
            const absorbed = Math.min(Shield.current[targetEid], remaining);
            Shield.current[targetEid] -= absorbed;
            remaining -= absorbed;
            // Reset regen delay whenever shield takes a hit
            Shield.regenDelay[targetEid] = Shield.max[targetEid] > 0
                ? Math.max(Shield.regenDelay[targetEid], 180) // 3 s at 60 tps
                : 0;
        }

        // ── Layer 2: Armor ───────────────────────────────────────────────────
        if (remaining > 0 && Armor.current[targetEid] > 0 && !ignoreArmor) {
            // Armor absorbs ARMOR_ABSORPTION fraction of the hit, costs 1 armor per fraction absorbed
            const armorAbsorb = Math.min(Armor.current[targetEid], remaining * ARMOR_ABSORPTION);
            const healthMitigated = armorAbsorb / ARMOR_ABSORPTION * ARMOR_ABSORPTION; // = armorAbsorb
            Armor.current[targetEid] -= armorAbsorb;
            remaining -= healthMitigated;
        }

        if (remaining > 0) {
            Health.current[targetEid] = Math.max(0, Health.current[targetEid] - remaining);
            const lifestealMult = this.modifiers.getLifestealMultiplier(attackerEid, damageType);
            if (lifestealMult > 0) {
                const healAmount = Math.round(effectiveDamage * lifestealMult);
                if (healAmount > 0) {
                    this.heal(attackerEid, healAmount);
                }
            }
        }

        const targetId   = this.ecsWorld.getEntityId(targetEid);
        const attackerId = this.ecsWorld.getEntityId(attackerEid);

        this.io.emit('playerDamaged', {
            targetId:  targetId,
            attackerId: attackerId,
            damage:    effectiveDamage,
            damageType: damageType,
            newHealth: Health.current[targetEid],
            maxHealth: Health.max[targetEid],
            newArmor:  Armor.current[targetEid],
            maxArmor:  Armor.max[targetEid],
            newShield: Shield.current[targetEid],
            maxShield: Shield.max[targetEid]
        });

        if (Health.current[targetEid] <= 0) {
            this.handleDeath(targetEid, attackerEid);
        }

    }

    heal(targetEid, amount) {
        if (Health.current[targetEid] <= 0) return;

        const prevHealth = Health.current[targetEid];
        Health.current[targetEid] = Math.min(Health.max[targetEid], Health.current[targetEid] + amount);

        const targetId = this.ecsWorld.getEntityId(targetEid);
        this.io.emit('playerHealed', {
            targetId: targetId,
            amount: Health.current[targetEid] - prevHealth,
            newHealth: Health.current[targetEid],
            maxHealth: Health.max[targetEid],
        });
    }

    reset() {
        this.firstBloodOccurred = false;
    }

    /**
     * Handle entity death
     */
    handleDeath(victimEid, killerEid) {
        const victimId = this.ecsWorld.getEntityId(victimEid);
        const killerId = this.ecsWorld.getEntityId(killerEid);
        const victimName = this.ecsWorld.getEntityName(victimEid);
        const killerName = this.ecsWorld.getEntityName(killerEid);

        console.log(`${victimName} (${victimId}) was killed by ${killerName} (${killerId})`);

        // Track deaths
        if (Score.deaths[victimEid] !== undefined) {
            Score.deaths[victimEid]++;
        }

        // Reset victim's kill streak
        if (KillStreak.kills[victimEid] !== undefined) {
            const victimStreak = KillStreak.kills[victimEid];
            if (victimStreak > 0) {
                console.log(`${victimName} lost their ${victimStreak} kill streak`);
            }
            KillStreak.kills[victimEid] = 0;
        }

        // Update killer's kill streak and total score
        this.updateKillStreak(killerEid);
        if (Score.kills[killerEid] !== undefined) {
            Score.kills[killerEid]++;
        }

        // Register scoring with the mode-agnostic match system.
        this.gameState?.registerKill?.(killerEid, victimEid);
        if (this.firstBloodOccurred === false) {
            this.firstBloodOccurred = true;
            this.io.emit('firstBlood', {
                killerId: killerId,
                killerName: killerName,
                victimId: victimId,
                victimName: victimName,
            });
        }

        // Emit death event (include respawn delay and world position for spatial audio)
        this.io.emit('playerDied', {
            victimId: victimId,
            killerId: killerId,
            victimName: victimName,
            killerName: killerName,
            victimHeroClass: HeroClass.id[victimEid],
            killerHeroClass: HeroClass.id[killerEid],
            respawnIn: RESPAWN_DELAY,
            x: Position.x[victimEid],
            y: Position.y[victimEid],
            z: Position.z[victimEid],
            killerX: Position.x[killerEid],
            killerY: Position.y[killerEid],
            killerZ: Position.z[killerEid],
        });

        this.heroSystem?.handleDeath(victimEid);
        this.modifiers?.onDeath(victimEid);

        // Delegate respawn scheduling to RespawnSystem
        this.respawnSystem.scheduleRespawn(victimEid, RESPAWN_DELAY);
    }

    /**
     * Update kill streak for killer
     */
    updateKillStreak(killerEid) {

        KillStreak.kills[killerEid]++;
        KillStreak.lastKillTime[killerEid] = Date.now();

        const kills = KillStreak.kills[killerEid];
        const killerId = this.ecsWorld.getEntityId(killerEid);
        const killerName = this.ecsWorld.getEntityName(killerEid);

        // Determine kill streak announcement
        let streakName = null;
        switch (kills) {
            case 2: streakName = 'Double Kill'; break;
            case 3: streakName = 'Triple Kill'; break;
            case 4: streakName = 'Mega Kill'; break;
            case 5: streakName = 'Killing Spree'; break;
            case 6: streakName = 'Ultra Kill'; break;
            case 7: streakName = 'Ownage'; break;
            case 8: streakName = 'Monster Kill'; break;
            case 9: streakName = 'Wicked Sick'; break;
            case 10: streakName = 'Godlike'; break;
            case 11: streakName = 'Holy Shit'; break;
        }
        if (kills >= 12) {
            streakName = 'Unstoppable';
        }

        if (streakName) {
            this.io.emit('killStreak', {
                playerId: killerId,
                playerName: killerName,
                kills: kills,
                streakName: streakName
            });
        }
    }

}

module.exports = DamageSystem;

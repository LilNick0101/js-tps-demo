const { defineQuery } = require('bitecs');
const {
    Position,
    Velocity,
    Rotation,
    Health,
    Jump,
    Dash,
    HeroClass,
    AbilityCooldowns,
    Bot,
    Controller,
    Player,
    Team,
} = require('../../shared/components');
const { BOT_DETECTION_RANGE, BOT_CHASE_RANGE, BOT_ATTACK_RANGE,
        BOT_SHOOT_COOLDOWN, BOT_AIM_ACCURACY, BOT_AIM_SPREAD,
        BOT_WANDER_TIME_MIN, BOT_WANDER_TIME_MAX, BOT_STRAFE_CHANCE,
    BOT_JUMP_FREQUENCY, BOT_DASH_FREQUENCY,
    BOT_ABILITY1_HP_THRESHOLD, BOT_ABILITY2_HP_THRESHOLD,
    BOT_ULT_ENEMIES_THRESHOLD, BOT_GROUP_RADIUS, BOT_RUSH_RANGE,
    HEROES } = require('../../shared/constants');
const SpatialGrid = require('../../shared/utils/SpatialGrid');

// Pre-compute squared range thresholds to avoid Math.sqrt in hot loops
const BOT_DETECTION_RANGE_SQ = BOT_DETECTION_RANGE * BOT_DETECTION_RANGE;
const BOT_CHASE_RANGE_SQ     = BOT_CHASE_RANGE     * BOT_CHASE_RANGE;
const BOT_ATTACK_RANGE_SQ    = BOT_ATTACK_RANGE     * BOT_ATTACK_RANGE;

// Query for all bot entities
const botQuery = defineQuery([Position, Rotation, Health, Bot, Controller]);
const playerQuery = defineQuery([Position, Health, Player]);

/**
 * BotSystem - Handles AI bot behavior (movement, targeting, shooting)
 */
class BotSystem {
    constructor(ecsWorld, physicsWorld, movementSystem, combatSystem) {
        /** @type {import('../world/World')} */
        this.ecsWorld = ecsWorld;
        this.physicsWorld = physicsWorld;
        this.movementSystem = movementSystem;
        this.combatSystem = combatSystem;
        /** @type {import('./HeroSystem') | null} Injected after HeroSystem is created */
        this.heroSystem = null;

        // Cell size = half the detection range keeps each query touching at most
        // a 2×2 block of cells, giving near-O(1) target lookups.
        this.spatialGrid = new SpatialGrid(BOT_DETECTION_RANGE / 2);
    }

    /**
     * Update all bots.
     * @param {object} world - bitECS world
     * @param {Function} [emitFn] - optional (event, data) => void for broadcasting events
     */
    update(world) {
        const bots    = botQuery(world);
        const players = playerQuery(world);

        // ── Rebuild spatial grid once per tick ───────────────────────────────
        // All living entities (players + bots) are inserted so each bot can
        // query its neighbourhood in O(cells) rather than O(n+m).
        this.spatialGrid.clear();
        for (const eid of players) {
            if (Health.current[eid] > 0)
                this.spatialGrid.add(eid, Position.x[eid], Position.z[eid]);
        }
        for (const eid of bots) {
            if (Health.current[eid] > 0)
                this.spatialGrid.add(eid, Position.x[eid], Position.z[eid]);
        }
        // ─────────────────────────────────────────────────────────────────────

        for (const botEid of bots) {
            // Skip if dead
            if (Health.current[botEid] <= 0) continue;

            // Skip if frozen (Iron Stand / Shadow Realm)
            if (this.heroSystem?.isFrozen(botEid)) continue;

            // Find nearest target using spatial grid (sub-linear lookup)
            const target = this.findNearestTarget(botEid);

            if (target && (!this.ecsWorld.isPlayer(target.eid) || Player.isReady[target.eid])) {
                const distSq = target.distSq;
                const nearbyAllies = this.countNearbyAllies(botEid, BOT_GROUP_RADIUS);
                const nearbyEnemies = this.countNearbyEnemies(botEid, BOT_GROUP_RADIUS * 1.2);
                const healthPct = Health.current[botEid] / Math.max(1, Health.max[botEid]);

                // Tactical regroup: if isolated and pressured, stick with teammates.
                if (nearbyAllies === 0 && nearbyEnemies >= 2) {
                    this.groupBehavior(botEid);
                    this.applyMovement(botEid, 'group');
                    if (Bot.wanderTimer[botEid] > 0) Bot.wanderTimer[botEid]--;
                    continue;
                }

                // Update bot state based on pre-computed squared thresholds
                if (distSq < BOT_ATTACK_RANGE_SQ) {
                    Bot.state[botEid] = 2; // Attack
                    this.attackBehavior(botEid, target, world, nearbyEnemies, nearbyAllies, healthPct);
                } else if (distSq < BOT_CHASE_RANGE_SQ || distSq < BOT_DETECTION_RANGE_SQ) {
                    Bot.state[botEid] = 1; // Chase
                    const shouldRush = nearbyAllies > nearbyEnemies && target.distance < BOT_RUSH_RANGE;
                    this.chaseBehavior(botEid, target, shouldRush);
                } else {
                    Bot.state[botEid] = 0; // Wander
                    this.wanderBehavior(botEid);
                }
            } else {
                Bot.state[botEid] = 0; // Wander
                this.wanderBehavior(botEid);
            }

            // Apply movement forces
            this.applyMovement(botEid);

            // Decrement wander timer
            if (Bot.wanderTimer[botEid] > 0) {
                Bot.wanderTimer[botEid]--;
            }
        }
    }

    /**
     * Find the nearest living target within BOT_DETECTION_RANGE using the
     * pre-built spatial grid.  Only the cells that overlap the query circle
     * are inspected, so this runs in sub-linear time on average.
     *
     * Squared distances are used for all comparisons; Math.sqrt is called
     * only once, for the single winning candidate.
     *
     * @param {number} botEid
     * @returns {{ eid: number, x: number, y: number, z: number, distSq: number, distance: number } | null}
     */
    findNearestTarget(botEid) {
        const bx = Position.x[botEid];
        const by = Position.y[botEid];
        const bz = Position.z[botEid];
        const botTeam = Number(Team.id[botEid] ?? 0);

        const candidates = this.spatialGrid.getNearby(bx, bz, BOT_DETECTION_RANGE);

        let nearestEid   = -1;
        let nearestDistSq = BOT_DETECTION_RANGE_SQ;

        for (let i = 0; i < candidates.length; i++) {
            const targetEid = candidates[i];
            const botId = this.ecsWorld.getEntityId(botEid);
            const targetId = this.ecsWorld.getEntityId(targetEid);
            if (targetEid === botEid) continue;
            if (!this.physicsWorld.checkLineOfSight(botId, targetId)) continue;// TODO: check LOS against physics world before targeting
            if (Health.current[targetEid] <= 0) continue; // skip dead

            // Team modes: bots should only target enemies.
            const targetTeam = Number(Team.id[targetEid] ?? 0);
            if (botTeam > 0 && targetTeam > 0 && botTeam === targetTeam) continue;

            const dx = Position.x[targetEid] - bx;
            const dy = Position.y[targetEid] - by;
            const dz = Position.z[targetEid] - bz;
            const distSq = dx * dx + dy * dy + dz * dz;

            if (distSq < nearestDistSq) {
                nearestDistSq = distSq;
                nearestEid    = targetEid;
            }
        }

        if (nearestEid === -1) return null;

        return {
            eid:      nearestEid,
            x:        Position.x[nearestEid],
            y:        Position.y[nearestEid],
            z:        Position.z[nearestEid],
            distSq:   nearestDistSq,
            distance: Math.sqrt(nearestDistSq), // computed once for the winner
        };
    }

    /**
     * Wander behavior - random movement
     */
    wanderBehavior(botEid) {
        // Change direction periodically using configurable timers
        if (Bot.wanderTimer[botEid] <= 0) {
            const wanderDuration = BOT_WANDER_TIME_MIN + Math.floor(Math.random() * (BOT_WANDER_TIME_MAX - BOT_WANDER_TIME_MIN));
            Bot.wanderTimer[botEid] = wanderDuration;

            // Random movement inputs - always move forward, sometimes strafe
            Controller.forward[botEid] = 1; // Always move forward when wandering
            Controller.backward[botEid] = 0;
            
            // Random strafe direction (or no strafe)
            const strafeChoice = Math.random();
            if (strafeChoice < 0.3) {
                Controller.left[botEid] = 1;
                Controller.right[botEid] = 0;
            } else if (strafeChoice < 0.6) {
                Controller.left[botEid] = 0;
                Controller.right[botEid] = 1;
            } else {
                Controller.left[botEid] = 0;
                Controller.right[botEid] = 0;
            }

            // Random rotation - bigger turns
            Rotation.yaw[botEid] += (Math.random() - 0.5) * Math.PI / 2;
        }
    }

    /**
     * Chase behavior - move towards target
     */
    chaseBehavior(botEid, target, rush = false) {
        const bx = Position.x[botEid];
        const bz = Position.z[botEid];

        // Calculate direction to target
        const dx = target.x - bx;
        const dz = target.z - bz;
        const targetYaw = Math.atan2(-dx, -dz);

        // Smoothly rotate towards target with configurable accuracy
        Rotation.yaw[botEid] = this.lerpAngle(Rotation.yaw[botEid], targetYaw, BOT_AIM_ACCURACY * (rush ? 1.2 : 1.0));

        // Move forward
        Controller.forward[botEid] = 1;
        Controller.backward[botEid] = 0;
        Controller.left[botEid] = 0;
        Controller.right[botEid] = 0;

        if (target.distSq < BOT_CHASE_RANGE_SQ) {
            const canAct = this.combatSystem.isAlive(botEid) && !this.heroSystem.isFrozen(botEid);
            if (canAct && !this.heroSystem?.isInFlight(botEid) && !this.heroSystem?.isChargingLunarEclipse(botEid)) {
                this.combatSystem.shootBullet(this.ecsWorld.getBotIdString(botEid), BOT_AIM_SPREAD);
            }
        }
    }

    groupBehavior(botEid) {
        const nearestAlly = this.findNearestAlly(botEid, BOT_DETECTION_RANGE);
        if (!nearestAlly) {
            this.wanderBehavior(botEid);
            return;
        }

        const dx = nearestAlly.x - Position.x[botEid];
        const dz = nearestAlly.z - Position.z[botEid];
        const targetYaw = Math.atan2(-dx, -dz);
        Rotation.yaw[botEid] = this.lerpAngle(Rotation.yaw[botEid], targetYaw, BOT_AIM_ACCURACY * 0.9);
        Controller.forward[botEid] = 1;
        Controller.backward[botEid] = 0;
        Controller.left[botEid] = 0;
        Controller.right[botEid] = 0;
    }

    /**
     * Attack behavior - face target and shoot
     * @param {Function} [emitFn] - optional (event, data) => void
     */
    attackBehavior(botEid, target, world, nearbyEnemies = 1, nearbyAllies = 0, healthPct = 1) {
        const bx = Position.x[botEid];
        const by = Position.y[botEid];
        const bz = Position.z[botEid];

        // Calculate direction to target
        const dx = target.x - bx;
        const dy = target.y - by;
        const dz = target.z - bz;

        const aimJitterYaw = (Math.random() - 0.5) * 0.045;
        const aimJitterPitch = (Math.random() - 0.5) * 0.02;
        const targetYaw = Math.atan2(-dx, -dz) + aimJitterYaw;
        const targetPitch = Math.atan2(dy, Math.sqrt(dx * dx + dz * dz)) + aimJitterPitch;

        // Aim at target with configurable accuracy
        Rotation.yaw[botEid] = this.lerpAngle(Rotation.yaw[botEid], targetYaw, BOT_AIM_ACCURACY * 0.9);
        Rotation.pitch[botEid] = this.lerpAngle(Rotation.pitch[botEid], targetPitch, BOT_AIM_ACCURACY * 0.8);

        // Strafe while shooting (configurable chance)
        if (Math.random() < BOT_STRAFE_CHANCE) {
            if (Math.random() > 0.5) {
                Controller.left[botEid] = 1;
                Controller.right[botEid] = 0;
            } else {
                Controller.left[botEid] = 0;
                Controller.right[botEid] = 1;
            }
        } else {
            Controller.left[botEid] = 0;
            Controller.right[botEid] = 0;
        }
        Controller.forward[botEid] = 0;
        Controller.backward[botEid] = 0;

        // Shoot if in attack range – weapon fireCooldown handles the rate limit
        if (target.distSq < BOT_ATTACK_RANGE_SQ) {
            const canAct = this.combatSystem.isAlive(botEid) && !this.heroSystem.isFrozen(botEid);
            if (canAct && !this.heroSystem?.isInFlight(botEid) && !this.heroSystem?.isChargingLunarEclipse(botEid)) {
                this.combatSystem.shootBullet(this.ecsWorld.getBotIdString(botEid), BOT_AIM_SPREAD);
            }
            if (canAct) {
                this.decideAbilityUsage(botEid, target, nearbyEnemies, nearbyAllies, healthPct);
            }
        }
    }

    /**
     * Apply movement forces based on controller state
     */
    applyMovement(botEid, mode = 'default') {
        const botId = this.ecsWorld.getBotIdString(botEid);
        const body = this.physicsWorld.getBody(botId);
        if (!body) {
            console.log(`Bot ${botEid} has no physics body`);
            return;
        }

        this.movementSystem.moveEntity(botEid, botId);

        const grounded = Jump.isGrounded[botEid] === 1;
        const canDash = Dash.canDash[botEid] === 1;

        // Jump only in combat/chase contexts and only while grounded.
        if (grounded && (Bot.state[botEid] === 1 || Bot.state[botEid] === 2) && Math.random() > BOT_JUMP_FREQUENCY + 0.001) {
            this.movementSystem.jumpEntity(botId);
        }

        // Dash to engage/reposition, not as constant noise.
        if (canDash && Math.random() > BOT_DASH_FREQUENCY + (mode === 'group' ? 0.18 : 0.10)) {
            const forward = Controller.forward[botEid] - Controller.backward[botEid];
            const right = Controller.right[botEid] - Controller.left[botEid];
            this.movementSystem.dashEntity(botEid, forward, right, botId);
        }
    }

    decideAbilityUsage(botEid, target, nearbyEnemies, nearbyAllies, healthPct) {
        const heroId = HeroClass.id[botEid];
        const canA1 = AbilityCooldowns.ability1[botEid] === 0;
        const canA2 = AbilityCooldowns.ability2[botEid] === 0;
        const canUlt = AbilityCooldowns.ultimate[botEid] === 0 && AbilityCooldowns.ultimateActive[botEid] === 0;

        if (heroId === HEROES.KYOUKAN) {
            if (canA1 && healthPct < BOT_ABILITY1_HP_THRESHOLD) {
                this.heroSystem?.setSelfCast(botEid, true);
                Controller.ability1[botEid] = 1;
            } else if (canA1 && this.hasNearbyLowHealthAlly(botEid, 22, 0.7)) {
                this.heroSystem?.setSelfCast(botEid, false);
                Controller.ability1[botEid] = 1;
            }

            if (canA2 && (target.distance > BOT_ATTACK_RANGE || healthPct < BOT_ABILITY2_HP_THRESHOLD)) {
                Controller.ability2[botEid] = 1;
            }

            if (canUlt && nearbyAllies > 0 && nearbyEnemies >= BOT_ULT_ENEMIES_THRESHOLD) {
                Controller.ultimate[botEid] = 1;
            }
            return;
        }

        if (heroId === HEROES.TEMPLAR) {
            if (canA1 && nearbyAllies > 0 && nearbyEnemies >= BOT_ULT_ENEMIES_THRESHOLD) {
                let nearestAlly = this.findNearestAlly(botEid, 22);
                if (nearestAlly) {
                    Rotation.yaw[botEid] = Math.atan2(nearestAlly.x - Position.x[botEid], nearestAlly.z - Position.z[botEid]);
                    Controller.ability1[botEid] = 1;
                }
            }
            if (canA2 && healthPct < BOT_ABILITY1_HP_THRESHOLD) {
                this.heroSystem?.setSelfCast(botEid, true);
                Controller.ability2[botEid] = 1;
            } else if (canA2 && this.hasNearbyLowHealthAlly(botEid, 22, 0.7)) {
                this.heroSystem?.setSelfCast(botEid, false);
                Controller.ability2[botEid] = 1;
            }
            if (canUlt && nearbyAllies > 0 && nearbyEnemies >= BOT_ULT_ENEMIES_THRESHOLD) {
                Controller.ultimate[botEid] = 1;
            }
            return;
    
        }

        if (canA1 && (target.distance < BOT_ATTACK_RANGE * 0.9 || healthPct < BOT_ABILITY1_HP_THRESHOLD)) {
            Controller.ability1[botEid] = 1;
        }
        if (canA2 && (healthPct < BOT_ABILITY2_HP_THRESHOLD || target.distance > BOT_ATTACK_RANGE * 1.35)) {
            Controller.ability2[botEid] = 1;
        }
        if (canUlt && nearbyEnemies >= BOT_ULT_ENEMIES_THRESHOLD) {
            Controller.ultimate[botEid] = 1;
        }
    }

    countNearbyAllies(botEid, radius) {
        const team = Number(Team.id[botEid] ?? 0);
        const nearby = this.spatialGrid.getNearby(Position.x[botEid], Position.z[botEid], radius);
        let count = 0;
        for (const eid of nearby) {
            if (eid === botEid || Health.current[eid] <= 0) continue;
            const otherTeam = Number(Team.id[eid] ?? 0);
            if (team > 0 && otherTeam > 0 && team === otherTeam) count++;
        }
        return count;
    }

    countNearbyEnemies(botEid, radius) {
        const team = Number(Team.id[botEid] ?? 0);
        const nearby = this.spatialGrid.getNearby(Position.x[botEid], Position.z[botEid], radius);
        let count = 0;
        for (const eid of nearby) {
            if (eid === botEid || Health.current[eid] <= 0) continue;
            const otherTeam = Number(Team.id[eid] ?? 0);
            if (team > 0 && otherTeam > 0 && team !== otherTeam) count++;
        }
        return count;
    }

    findNearestAlly(botEid, radius) {
        const bx = Position.x[botEid];
        const by = Position.y[botEid];
        const bz = Position.z[botEid];
        const team = Number(Team.id[botEid] ?? 0);
        const nearby = this.spatialGrid.getNearby(bx, bz, radius);
        let best = null;
        let bestDistSq = radius * radius;

        for (const eid of nearby) {
            if (eid === botEid || Health.current[eid] <= 0) continue;
            const otherTeam = Number(Team.id[eid] ?? 0);
            if (!(team > 0 && otherTeam > 0 && team === otherTeam)) continue;
            const dx = Position.x[eid] - bx;
            const dy = Position.y[eid] - by;
            const dz = Position.z[eid] - bz;
            const distSq = dx * dx + dy * dy + dz * dz;
            if (distSq >= bestDistSq) continue;
            bestDistSq = distSq;
            best = { eid, x: Position.x[eid], y: Position.y[eid], z: Position.z[eid] };
        }
        return best;
    }

    hasNearbyLowHealthAlly(botEid, radius, hpThreshold) {
        const team = Number(Team.id[botEid] ?? 0);
        const nearby = this.spatialGrid.getNearby(Position.x[botEid], Position.z[botEid], radius);
        for (const eid of nearby) {
            if (eid === botEid || Health.current[eid] <= 0) continue;
            const otherTeam = Number(Team.id[eid] ?? 0);
            if (!(team > 0 && otherTeam > 0 && team === otherTeam)) continue;
            const hpPct = Health.current[eid] / Math.max(1, Health.max[eid]);
            if (hpPct < hpThreshold) return true;
        }
        return false;
    }

    /**
     * Interpolate between two angles (handles wraparound)
     */
    lerpAngle(from, to, t) {
        let delta = to - from;
        // Normalize to [-PI, PI]
        while (delta > Math.PI) delta -= 2 * Math.PI;
        while (delta < -Math.PI) delta += 2 * Math.PI;
        return from + delta * t;
    }
}

module.exports = BotSystem;

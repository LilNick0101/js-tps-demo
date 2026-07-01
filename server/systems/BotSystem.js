const { defineQuery } = require('bitecs');
const {
    Position,
    Velocity,
    Rotation,
    Health,
    Armor,
    Jump,
    Dash,
    HeroClass,
    AbilityCooldowns,
    Bot,
    Controller,
    Player,
    Team,
    Pickup,
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

const BOT_STATE_WANDER = 0;
const BOT_STATE_CHASE = 1;
const BOT_STATE_ATTACK = 2;
const BOT_STATE_PATROL = 3;
const BOT_STATE_RETREAT = 4;
const BOT_STATE_SEEK_PICKUP = 5;

const BOT_TARGET_MEMORY_TICKS = 150;
const BOT_RETREAT_HEALTH_PCT = 0.25;
const BOT_LOW_ARMOR_PCT = 0.2;
const BOT_JUMP_ASSIST_HEIGHT = 1.05;
const BOT_DOUBLE_JUMP_ASSIST_HEIGHT = 2.1;
const BOT_PICKUP_SCAN_RANGE = BOT_DETECTION_RANGE * 0.75;

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

        /** @type {Map<number, { eid: number, x: number, y: number, z: number, expiresAt: number }>} */
        this.targetMemory = new Map();
        /** @type {Map<number, { x: number, y: number, z: number }>} */
        this.patrolTargets = new Map();
        /** @type {Map<number, { key: string, waypoints: Array<{ x: number, y: number, z: number }>, expiresAt: number }>} */
        this.routePlans = new Map();
        /** @type {Map<number, { role: string, preferredRange: number, keepDistanceMin: number, aggression: number, chaseRange: number, attackRange: number }>} */
        this.heroProfiles = new Map([
            [HEROES.DUMMY, { role: 'balanced', preferredRange: 16, keepDistanceMin: 8, aggression: 1.0, chaseRange: BOT_CHASE_RANGE, attackRange: BOT_ATTACK_RANGE }],
            [HEROES.SVEN, { role: 'skirmisher', preferredRange: 14, keepDistanceMin: 6, aggression: 1.15, chaseRange: BOT_CHASE_RANGE, attackRange: BOT_ATTACK_RANGE * 0.95 }],
            [HEROES.TAMERLANE, { role: 'brawler', preferredRange: 10, keepDistanceMin: 4, aggression: 1.25, chaseRange: BOT_CHASE_RANGE * 0.9, attackRange: BOT_ATTACK_RANGE * 0.95 }],
            [HEROES.FATHER_CALLAS, { role: 'sustain', preferredRange: 14, keepDistanceMin: 6, aggression: 0.95, chaseRange: BOT_CHASE_RANGE, attackRange: BOT_ATTACK_RANGE }],
            [HEROES.SELENE, { role: 'ranged', preferredRange: 28, keepDistanceMin: 16, aggression: 0.85, chaseRange: BOT_CHASE_RANGE * 1.1, attackRange: BOT_ATTACK_RANGE * 0.9 }],
            [HEROES.FAT_JEROME, { role: 'bruiser', preferredRange: 12, keepDistanceMin: 5, aggression: 1.1, chaseRange: BOT_CHASE_RANGE, attackRange: BOT_ATTACK_RANGE }],
            [HEROES.KYOUKAN, { role: 'sniper', preferredRange: 36, keepDistanceMin: 24, aggression: 0.75, chaseRange: BOT_CHASE_RANGE * 1.15, attackRange: BOT_ATTACK_RANGE * 0.8 }],
            [HEROES.TEMPLAR, { role: 'support', preferredRange: 18, keepDistanceMin: 10, aggression: 0.9, chaseRange: BOT_CHASE_RANGE, attackRange: BOT_ATTACK_RANGE }],
        ]);
        this.tickCount = 0;
    }

    /**
     * Update all bots.
     * @param {object} world - bitECS world
     * @param {Function} [emitFn] - optional (event, data) => void for broadcasting events
     */
    update(world) {
        this.tickCount++;
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

            const heroProfile = this.getHeroProfile(HeroClass.id[botEid]);

            const nearbyAllies = this.countNearbyAllies(botEid, BOT_GROUP_RADIUS);
            const nearbyEnemies = this.countNearbyEnemies(botEid, BOT_GROUP_RADIUS * 1.2);
            const healthPct = Health.current[botEid] / Math.max(1, Health.max[botEid]);
            const armorPct = Armor.max[botEid] > 0 ? Armor.current[botEid] / Armor.max[botEid] : 0;
            const tacticalTarget = this.selectTacticalTarget(botEid);
            const pickupTarget = this.findBestPickupTarget(botEid, healthPct, armorPct);

            // Tactical regroup: if isolated and pressured, stick with teammates.
            if (nearbyAllies === 0 && nearbyEnemies >= 2) {
                Bot.state[botEid] = BOT_STATE_RETREAT;
                this.groupBehavior(botEid);
                this.applyMovement(botEid, 'group');
                if (Bot.wanderTimer[botEid] > 0) Bot.wanderTimer[botEid]--;
                Bot.targetId[botEid] = tacticalTarget ? tacticalTarget.eid : 0;
                continue;
            }

            if (pickupTarget && (healthPct < BOT_RETREAT_HEALTH_PCT || armorPct < BOT_LOW_ARMOR_PCT)) {
                Bot.state[botEid] = BOT_STATE_SEEK_PICKUP;
                this.pickupBehavior(botEid, pickupTarget);
            } else if (tacticalTarget && (!this.ecsWorld.isPlayer(tacticalTarget.eid) || Player.isReady[tacticalTarget.eid])) {
                const distSq = tacticalTarget.distSq;
                const shouldRetreat = this.shouldRetreat(tacticalTarget, nearbyEnemies, nearbyAllies, healthPct, armorPct, heroProfile);
                const preferredRangeSq = heroProfile.preferredRange * heroProfile.preferredRange;
                const attackRangeSq = heroProfile.attackRange * heroProfile.attackRange;
                const chaseRangeSq = heroProfile.chaseRange * heroProfile.chaseRange;

                if (shouldRetreat || (heroProfile.keepDistanceMin > 0 && distSq < heroProfile.keepDistanceMin * heroProfile.keepDistanceMin)) {
                    Bot.state[botEid] = BOT_STATE_RETREAT;
                    this.retreatBehavior(botEid, tacticalTarget, nearbyEnemies);
                } else if (distSq < attackRangeSq || (distSq < preferredRangeSq && heroProfile.aggression >= 1)) {
                    Bot.state[botEid] = BOT_STATE_ATTACK;
                    this.attackBehavior(botEid, tacticalTarget, world, nearbyEnemies, nearbyAllies, healthPct);
                } else if (distSq < chaseRangeSq || distSq < BOT_DETECTION_RANGE_SQ || tacticalTarget.remembered) {
                    Bot.state[botEid] = BOT_STATE_CHASE;
                    const shouldRush = nearbyAllies > nearbyEnemies && tacticalTarget.distance < BOT_RUSH_RANGE * heroProfile.aggression;
                    this.chaseBehavior(botEid, tacticalTarget, shouldRush);
                } else {
                    Bot.state[botEid] = BOT_STATE_PATROL;
                    this.patrolBehavior(botEid);
                }
            } else {
                Bot.state[botEid] = BOT_STATE_PATROL;
                this.patrolBehavior(botEid);
            }

            this.pruneTargetMemory(botEid);
            Bot.targetId[botEid] = tacticalTarget ? tacticalTarget.eid : 0;

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

        let nearestEid = -1;
        let nearestDistSq = BOT_DETECTION_RANGE_SQ;
        let bestScore = Number.POSITIVE_INFINITY;

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
            const distance = Math.sqrt(distSq);
            const healthPct = Health.current[targetEid] / Math.max(1, Health.max[targetEid]);
            const score = (distance / Math.max(1, BOT_DETECTION_RANGE)) * 0.65 + healthPct * 0.35;

            if (score < bestScore || (score === bestScore && distSq < nearestDistSq)) {
                bestScore = score;
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
            visible:  true,
        };
    }

    selectTacticalTarget(botEid) {
        const visibleTarget = this.findNearestTarget(botEid);
        if (visibleTarget) {
            this.rememberTarget(botEid, visibleTarget);
            return visibleTarget;
        }

        const memory = this.targetMemory.get(botEid);
        if (!memory) return null;
        if (this.tickCount > memory.expiresAt) {
            this.targetMemory.delete(botEid);
            return null;
        }
        if (Health.current[memory.eid] <= 0) {
            this.targetMemory.delete(botEid);
            return null;
        }

        const dx = memory.x - Position.x[botEid];
        const dy = memory.y - Position.y[botEid];
        const dz = memory.z - Position.z[botEid];
        const distSq = dx * dx + dy * dy + dz * dz;

        return {
            eid: memory.eid,
            x: memory.x,
            y: memory.y,
            z: memory.z,
            distSq,
            distance: Math.sqrt(distSq),
            visible: false,
            remembered: true,
        };
    }

    rememberTarget(botEid, target) {
        this.targetMemory.set(botEid, {
            eid: target.eid,
            x: target.x,
            y: target.y,
            z: target.z,
            expiresAt: this.tickCount + BOT_TARGET_MEMORY_TICKS,
        });
    }

    pruneTargetMemory(botEid) {
        const memory = this.targetMemory.get(botEid);
        if (!memory) return;
        if (this.tickCount <= memory.expiresAt) return;
        this.targetMemory.delete(botEid);
    }

    shouldRetreat(target, nearbyEnemies, nearbyAllies, healthPct, armorPct, heroProfile) {
        if (!target) return false;

        const outnumbered = nearbyEnemies >= Math.max(2, nearbyAllies + 2);
        const vulnerable = healthPct < BOT_RETREAT_HEALTH_PCT || armorPct < BOT_LOW_ARMOR_PCT;
        const targetPressure = target.distance < BOT_ATTACK_RANGE * 1.15;
        const cautionBias = heroProfile?.role === 'ranged' || heroProfile?.role === 'support' ? 0.9 : 1;

        return vulnerable && (outnumbered || targetPressure * cautionBias > 0.75);
    }

    patrolBehavior(botEid) {
        let patrolTarget = this.patrolTargets.get(botEid);
        if (!patrolTarget || Bot.wanderTimer[botEid] <= 0) {
            const radius = BOT_DETECTION_RANGE * 0.35;
            patrolTarget = {
                x: Position.x[botEid] + (Math.random() - 0.5) * radius * 2,
                y: Position.y[botEid],
                z: Position.z[botEid] + (Math.random() - 0.5) * radius * 2,
            };
            this.patrolTargets.set(botEid, patrolTarget);
            Bot.wanderTimer[botEid] = BOT_WANDER_TIME_MIN + Math.floor(Math.random() * (BOT_WANDER_TIME_MAX - BOT_WANDER_TIME_MIN));
        }

        const dx = patrolTarget.x - Position.x[botEid];
        const dy = patrolTarget.y - Position.y[botEid];
        const dz = patrolTarget.z - Position.z[botEid];
        const distSq = dx * dx + dy * dy + dz * dz;

        if (distSq < 16) {
            Bot.wanderTimer[botEid] = 0;
            this.wanderBehavior(botEid);
            return;
        }

        const targetYaw = Math.atan2(-dx, -dz);
        Rotation.yaw[botEid] = this.lerpAngle(Rotation.yaw[botEid], targetYaw, BOT_AIM_ACCURACY * 0.55);

        this.followRoute(botEid, patrolTarget, {
            step: 5,
            padding: 10,
            ttl: 18,
            turnRate: 0.6,
        });
    }

    retreatBehavior(botEid, target, nearbyEnemies) {
        const bx = Position.x[botEid];
        const by = Position.y[botEid];
        const bz = Position.z[botEid];

        const dx = target.x - bx;
        const dy = target.y - by;
        const dz = target.z - bz;

        const awayYaw = Math.atan2(dx, dz);
        Rotation.yaw[botEid] = this.lerpAngle(Rotation.yaw[botEid], awayYaw, BOT_AIM_ACCURACY * 0.75);
        Rotation.pitch[botEid] = this.lerpAngle(Rotation.pitch[botEid], Math.atan2(-dy, Math.sqrt(dx * dx + dz * dz)), BOT_AIM_ACCURACY * 0.35);

        const retreatGoal = {
            x: bx - dx * 1.5,
            y: by,
            z: bz - dz * 1.5,
        };
        this.followRoute(botEid, retreatGoal, {
            step: 5,
            padding: 18,
            ttl: 14,
            turnRate: 0.85,
        });
    }

    pickupBehavior(botEid, pickupTarget) {
        const dx = pickupTarget.x - Position.x[botEid];
        const dy = pickupTarget.y - Position.y[botEid];
        const dz = pickupTarget.z - Position.z[botEid];
        const targetYaw = Math.atan2(-dx, -dz);

        Rotation.yaw[botEid] = this.lerpAngle(Rotation.yaw[botEid], targetYaw, BOT_AIM_ACCURACY * 0.75);
        Rotation.pitch[botEid] = this.lerpAngle(Rotation.pitch[botEid], Math.atan2(dy, Math.sqrt(dx * dx + dz * dz)), BOT_AIM_ACCURACY * 0.3);

        this.followRoute(botEid, pickupTarget, {
            step: 4,
            padding: 12,
            ttl: 16,
            turnRate: 0.8,
        });
    }

    findBestPickupTarget(botEid, healthPct, armorPct) {
        const pickups = this.ecsWorld.getPickups?.() ?? [];
        if (pickups.length === 0) return null;

        let best = null;
        let bestScore = Number.POSITIVE_INFINITY;

        for (const pickupEid of pickups) {
            if (Pickup.active[pickupEid] !== 1) continue;

            const type = Pickup.type[pickupEid];
            const isHealthPickup = type === 0 || type === 2;
            const isArmorPickup = type === 1;
            if (!isHealthPickup && !isArmorPickup) continue;

            const px = Position.x[pickupEid];
            const py = Position.y[pickupEid];
            const pz = Position.z[pickupEid];
            const dx = px - Position.x[botEid];
            const dy = py - Position.y[botEid];
            const dz = pz - Position.z[botEid];
            const distSq = dx * dx + dy * dy + dz * dz;
            if (distSq > BOT_PICKUP_SCAN_RANGE * BOT_PICKUP_SCAN_RANGE) continue;

            const distanceScore = Math.sqrt(distSq) / Math.max(1, BOT_PICKUP_SCAN_RANGE);
            const urgency = isHealthPickup ? (1 - healthPct) : (1 - armorPct);
            const score = distanceScore * 0.7 - urgency * 0.3;

            if (score < bestScore) {
                bestScore = score;
                best = {
                    eid: pickupEid,
                    x: px,
                    y: py,
                    z: pz,
                    distSq,
                    distance: Math.sqrt(distSq),
                    type,
                };
            }
        }

        return best;
    }

    clearRoute(botEid) {
        this.routePlans.delete(botEid);
    }

    isPointWalkable(x, y, z) {
        return this.physicsWorld.checkGroundDetectionAt(x, y + 0.35, z, 3.5);
    }

    isSegmentClear(from, to) {
        if (!this.physicsWorld) return true;

        const dx = to.x - from.x;
        const dy = to.y - from.y;
        const dz = to.z - from.z;
        const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (distance < 1e-4) return true;

        const origin = {
            x: from.x,
            y: Math.max(from.y, to.y) + 0.8,
            z: from.z,
        };
        const hit = this.physicsWorld.raycastWorld(origin, { x: dx, y: 0, z: dz }, Math.sqrt(dx * dx + dz * dz));
        return !hit || hit.toi >= Math.sqrt(dx * dx + dz * dz) - 0.15;
    }

    findNearestWalkableNode(nodes, point) {
        let bestNode = null;
        let bestDistSq = Number.POSITIVE_INFINITY;
        for (const node of nodes.values()) {
            const dx = node.x - point.x;
            const dy = node.y - point.y;
            const dz = node.z - point.z;
            const distSq = dx * dx + dy * dy + dz * dz;
            if (distSq < bestDistSq) {
                bestDistSq = distSq;
                bestNode = node;
            }
        }
        return bestNode;
    }

    smoothRoute(points) {
        if (points.length <= 2) return points;

        const smoothed = [points[0]];
        for (let i = 1; i < points.length - 1; i++) {
            const prev = smoothed[smoothed.length - 1];
            const cur = points[i];
            const next = points[i + 1];
            const vx1 = cur.x - prev.x;
            const vz1 = cur.z - prev.z;
            const vx2 = next.x - cur.x;
            const vz2 = next.z - cur.z;
            const cross = vx1 * vz2 - vz1 * vx2;
            if (Math.abs(cross) > 0.001) smoothed.push(cur);
        }
        smoothed.push(points[points.length - 1]);
        return smoothed;
    }

    planRoute(botEid, goal, options = {}) {
        const start = {
            x: Position.x[botEid],
            y: Position.y[botEid],
            z: Position.z[botEid],
        };

        if (!goal || !this.physicsWorld) return null;
        if (this.isSegmentClear(start, goal)) return [goal];

        const step = options.step ?? 4;
        const padding = options.padding ?? 16;
        const maxNodes = options.maxNodes ?? 225;

        const minX = Math.min(start.x, goal.x) - padding;
        const maxX = Math.max(start.x, goal.x) + padding;
        const minZ = Math.min(start.z, goal.z) - padding;
        const maxZ = Math.max(start.z, goal.z) + padding;

        const cols = Math.max(3, Math.ceil((maxX - minX) / step) + 1);
        const rows = Math.max(3, Math.ceil((maxZ - minZ) / step) + 1);

        if (cols * rows > maxNodes) return [goal];

        const nodes = new Map();
        const startY = start.y;

        for (let row = 0; row < rows; row++) {
            for (let col = 0; col < cols; col++) {
                const x = minX + col * step;
                const z = minZ + row * step;
                if (!this.isPointWalkable(x, startY, z)) continue;
                const key = `${col}:${row}`;
                nodes.set(key, { key, col, row, x, y: startY, z });
            }
        }

        if (nodes.size === 0) return [goal];

        const startNode = this.findNearestWalkableNode(nodes, start);
        const goalNode = this.findNearestWalkableNode(nodes, goal);
        if (!startNode || !goalNode) return [goal];

        const openSet = [startNode.key];
        const cameFrom = new Map();
        const gScore = new Map([[startNode.key, 0]]);
        const fScore = new Map([[startNode.key, this.distanceBetween(startNode, goalNode)]]);
        const closed = new Set();

        const getLowest = () => {
            let bestKey = openSet[0];
            let bestScore = fScore.get(bestKey) ?? Number.POSITIVE_INFINITY;
            for (let i = 1; i < openSet.length; i++) {
                const key = openSet[i];
                const score = fScore.get(key) ?? Number.POSITIVE_INFINITY;
                if (score < bestScore) {
                    bestScore = score;
                    bestKey = key;
                }
            }
            return bestKey;
        };

        const neighborOffsets = [
            [-1, -1], [0, -1], [1, -1],
            [-1,  0],           [1,  0],
            [-1,  1], [0,  1], [1,  1],
        ];

        while (openSet.length > 0) {
            const currentKey = getLowest();
            const currentNode = nodes.get(currentKey);
            if (!currentNode) break;

            if (currentKey === goalNode.key) {
                const path = this.reconstructRoute(nodes, cameFrom, currentKey);
                return this.smoothRoute(path);
            }

            openSet.splice(openSet.indexOf(currentKey), 1);
            closed.add(currentKey);

            for (const [dCol, dRow] of neighborOffsets) {
                const neighborKey = `${currentNode.col + dCol}:${currentNode.row + dRow}`;
                const neighbor = nodes.get(neighborKey);
                if (!neighbor || closed.has(neighborKey)) continue;
                if (!this.isSegmentClear(currentNode, neighbor)) continue;

                const tentativeG = (gScore.get(currentKey) ?? Number.POSITIVE_INFINITY) + this.distanceBetween(currentNode, neighbor);
                if (tentativeG >= (gScore.get(neighborKey) ?? Number.POSITIVE_INFINITY)) continue;

                cameFrom.set(neighborKey, currentKey);
                gScore.set(neighborKey, tentativeG);
                fScore.set(neighborKey, tentativeG + this.distanceBetween(neighbor, goalNode));
                if (!openSet.includes(neighborKey)) openSet.push(neighborKey);
            }
        }

        return [goal];
    }

    reconstructRoute(nodes, cameFrom, currentKey) {
        const route = [];
        let key = currentKey;
        while (key) {
            const node = nodes.get(key);
            if (node) {
                route.push({ x: node.x, y: node.y, z: node.z });
            }
            key = cameFrom.get(key);
        }
        route.reverse();
        return route;
    }

    distanceBetween(a, b) {
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dz = b.z - a.z;
        return Math.sqrt(dx * dx + dy * dy + dz * dz);
    }

    getHeroProfile(heroId) {
        return this.heroProfiles.get(heroId) ?? this.heroProfiles.get(HEROES.DUMMY);
    }

    followRoute(botEid, goal, options = {}) {
        if (!goal) {
            this.clearRoute(botEid);
            return false;
        }

        const routeKey = `${goal.x.toFixed(1)}:${goal.y.toFixed(1)}:${goal.z.toFixed(1)}`;
        let routePlan = this.routePlans.get(botEid);

        if (!routePlan || routePlan.key !== routeKey || routePlan.expiresAt <= this.tickCount) {
            const waypoints = this.planRoute(botEid, goal, options);
            routePlan = {
                key: routeKey,
                waypoints: waypoints ?? [goal],
                expiresAt: this.tickCount + (options.ttl ?? 20),
            };
            this.routePlans.set(botEid, routePlan);
        }

        let currentWaypoint = routePlan.waypoints[0] ?? goal;
        const botPos = {
            x: Position.x[botEid],
            y: Position.y[botEid],
            z: Position.z[botEid],
        };

        while (routePlan.waypoints.length > 1) {
            const dx = currentWaypoint.x - botPos.x;
            const dy = currentWaypoint.y - botPos.y;
            const dz = currentWaypoint.z - botPos.z;
            const distSq = dx * dx + dy * dy + dz * dz;
            if (distSq > 12) break;
            routePlan.waypoints.shift();
            currentWaypoint = routePlan.waypoints[0] ?? goal;
        }

        const dx = currentWaypoint.x - botPos.x;
        const dy = currentWaypoint.y - botPos.y;
        const dz = currentWaypoint.z - botPos.z;
        const targetYaw = Math.atan2(-dx, -dz);

        Rotation.yaw[botEid] = this.lerpAngle(Rotation.yaw[botEid], targetYaw, BOT_AIM_ACCURACY * (options.turnRate ?? 0.7));
        Rotation.pitch[botEid] = this.lerpAngle(Rotation.pitch[botEid], Math.atan2(dy, Math.sqrt(dx * dx + dz * dz)), BOT_AIM_ACCURACY * 0.25);

        Controller.forward[botEid] = 1;
        Controller.backward[botEid] = 0;

        const botId = this.ecsWorld.getBotIdString(botEid);
        const verticalGap = currentWaypoint.y - botPos.y;
        if (verticalGap > BOT_JUMP_ASSIST_HEIGHT) {
            if (Jump.isGrounded[botEid] === 1 && Jump.jumpsRemaining[botEid] > 0) {
                this.movementSystem.jumpEntity(botId);
            } else if (verticalGap > BOT_DOUBLE_JUMP_ASSIST_HEIGHT && Jump.jumpsRemaining[botEid] > 0 && Jump.jumpTimer[botEid] <= 0) {
                this.movementSystem.jumpEntity(botId);
            }
        }

        if (options.allowStrafe) {
            Controller.left[botEid] = dx > dz ? 1 : 0;
            Controller.right[botEid] = dx < -dz ? 1 : 0;
        } else {
            Controller.left[botEid] = 0;
            Controller.right[botEid] = 0;
        }

        return true;
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

        this.followRoute(botEid, target, {
            step: 4,
            padding: 16,
            ttl: target.visible ? 10 : 20,
            turnRate: rush ? 0.9 : 0.75,
        });

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

        this.followRoute(botEid, nearestAlly, {
            step: 4,
            padding: 12,
            ttl: 12,
            turnRate: 0.75,
        });
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

        if (!target.visible) {
            this.followRoute(botEid, target, {
                step: 4,
                padding: 14,
                ttl: 18,
                turnRate: 0.7,
                allowStrafe: true,
            });
        }

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

        // Jump only in combat-like contexts and only while grounded.
        if (grounded && (
            Bot.state[botEid] === BOT_STATE_CHASE ||
            Bot.state[botEid] === BOT_STATE_ATTACK ||
            Bot.state[botEid] === BOT_STATE_RETREAT ||
            Bot.state[botEid] === BOT_STATE_SEEK_PICKUP ||
            Bot.state[botEid] === BOT_STATE_PATROL
        ) && Math.random() > BOT_JUMP_FREQUENCY + 0.001) {
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
        const heroProfile = this.getHeroProfile(heroId);
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

            if (canA2 && (target.distance > heroProfile.preferredRange || healthPct < BOT_ABILITY2_HP_THRESHOLD)) {
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

        if (canA1 && (target.distance < heroProfile.preferredRange * 0.9 || healthPct < BOT_ABILITY1_HP_THRESHOLD)) {
            Controller.ability1[botEid] = 1;
        }
        if (canA2 && (healthPct < BOT_ABILITY2_HP_THRESHOLD || target.distance > heroProfile.preferredRange * 1.35)) {
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

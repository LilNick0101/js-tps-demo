const {
    Position,
    Health,
    Armor,
    Pickup,
} = require('../../shared/components');
const { PICKUP_TYPES, PICKUP_CONFIGS, PICKUP_RADIUS, RESPAWN_MAP } = require('../../shared/constants');
const spawns = require('../../shared/config/spawns.json');

/**
 * PickupSystem – spawns and manages collectible health vials and armor shards.
 *
 * Usage:
 *   const ps = new PickupSystem(ecsWorld, io, mapKey);
 *   ps.initPickups();     // call once after physics is ready
 *   ps.update();          // call each game tick
 */
class PickupSystem {
    /**
     * @param {import('../world/World')} ecsWorld
     * @param {object} io  - geckos server instance
     * @param {import('./HeroSystem')} heroSystem - reference to HeroSystem for applying quad damage
     * @param {string} [mapKey]
     */
    constructor(ecsWorld, io, statusEffectsSystem, mapKey = RESPAWN_MAP) {
        this.ecsWorld = ecsWorld;
        this.io       = io;
        this.statusEffectsSystem = statusEffectsSystem;
        this.mapKey   = mapKey;
    }

    /**
     * Read pickup spawn positions from spawns.json and create entities.
     * Call this once after the physics world is ready.
     */
    initPickups() {
        const mapConfig = spawns[this.mapKey] || spawns['default'];
        const pickupSpawns = mapConfig.pickups || [];

        for (const spawn of pickupSpawns) {
            const type = spawn.type ?? PICKUP_TYPES.HEALTH_VIAL;
            this.ecsWorld.createPickupEntity(type, spawn.x, spawn.y, spawn.z);
        }

        console.log(`PickupSystem: spawned ${pickupSpawns.length} pickups on map "${this.mapKey}"`);
    }

    /**
     * Tick pickup respawn timers and check player / bot collection.
     */
    update() {
        const pickups = this.ecsWorld.getPickups();
        const collectors = this.ecsWorld.getAllPlayerAndBotEntities();

        for (const pEid of pickups) {

            // ── Respawn countdown ────────────────────────────────────────────
            if (Pickup.active[pEid] === 0) {
                if (Pickup.respawnTimer[pEid] > 0) {
                    Pickup.respawnTimer[pEid]--;
                } else {
                    // Re-activate
                    Pickup.active[pEid] = 1;
                    this.io.emit('pickupRespawned', { id: pEid });
                }
                continue;
            }

            // ── Proximity check ──────────────────────────────────────────────
            const px = Position.x[pEid];
            const py = Position.y[pEid];
            const pz = Position.z[pEid];

            for (const cEid of collectors) {
                if (Health.current[cEid] <= 0) continue; // skip dead entities

                const dx = Position.x[cEid] - px;
                const dy = Position.y[cEid] - py;
                const dz = Position.z[cEid] - pz;
                const dist2 = dx * dx + dy * dy + dz * dz;

                if (dist2 > PICKUP_RADIUS * PICKUP_RADIUS) continue;
                if (!this._canCollectPickup(cEid, pEid)) continue;

                this._applyPickup(cEid, pEid);

                // ── Deactivate & start respawn timer ─────────────────────────
                Pickup.active[pEid] = 0;
                const cfg = PICKUP_CONFIGS[Pickup.type[pEid]];
                Pickup.respawnTimer[pEid] = cfg.respawnTicks;

                const collectorId = this.ecsWorld.getEntityId(cEid);
                this.io.emit('pickupCollected', {
                    id:          pEid,
                    type:        Pickup.type[pEid],
                    collectorId: collectorId,
                });

                break; // Only one collector per pickup per tick
            }
        }
    }

    _canCollectPickup(collectorEid, pickupEid) {
        const type = Pickup.type[pickupEid];

        switch (type) {
            case PICKUP_TYPES.HEALTH_VIAL:
                return Health.current[collectorEid] < Health.max[collectorEid];
            case PICKUP_TYPES.ARMOR_SHARD:
                return Armor.current[collectorEid] < Armor.max[collectorEid];
            case PICKUP_TYPES.CRYSTAL_SHARD:
                return Health.current[collectorEid] < Health.max[collectorEid];
            case PICKUP_TYPES.QUAD_DAMAGE:
                // For simplicity, allow collecting quad damage even if already active.
                // More complex logic could check for existing quad status and remaining duration.
                return true;
            default:
                return false;
        }
    }

    _applyPickup(collectorEid, pickupEid) {
        const type  = Pickup.type[pickupEid];
        const value = Pickup.value[pickupEid];

        switch (type) {
            case PICKUP_TYPES.HEALTH_VIAL:
                Health.current[collectorEid] = Math.min(
                    Health.max[collectorEid],
                    Health.current[collectorEid] + value
                );
                break;
            case PICKUP_TYPES.ARMOR_SHARD:
                Armor.current[collectorEid] = Math.min(
                    Armor.max[collectorEid],
                    Armor.current[collectorEid] + value
                );
                break;
            case PICKUP_TYPES.CRYSTAL_SHARD:
                Health.current[collectorEid] = Math.min(
                    Health.max[collectorEid],
                    Health.current[collectorEid] + value
                );
                break; // handled below
            case PICKUP_TYPES.QUAD_DAMAGE:
                console.log(`PickupSystem: applying quad damage to entity ${collectorEid} for 1200 ticks`);
                this.statusEffectsSystem.quadDamage(collectorEid, 1200,value);
                break;
            default:
                console.warn(`PickupSystem: unknown pickup type "${type}" on entity ${pickupEid}`);
                return;
        }
    }
}

module.exports = PickupSystem;

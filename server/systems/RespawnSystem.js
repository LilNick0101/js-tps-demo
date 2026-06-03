const { Health, Velocity, Team, Jump, Dash, Armor, Shield, Weapon, AbilityCooldowns, Score } = require('../../shared/components');
const { WEAPONS } = require('../../shared/constants');
const { RESPAWN_DELAY, RESPAWN_MAP } = require('../../shared/constants');
const spawns = require('../../shared/config/spawns.json');

/**
 * RespawnSystem – owns respawn timers and spawn-point selection.
 *
 * Usage:
 *   const rs = new RespawnSystem(ecsWorld, botSystem, io);
 *   rs.scheduleRespawn(victimEid);          // uses default delay
 *   rs.scheduleRespawn(victimEid, 5000);    // custom delay (ms)
 *   rs.cancelRespawn(eid);                  // e.g. on disconnect
 */
class RespawnSystem {
    /**
     * @param {import('../world/World')} ecsWorld
     * @param {import('./BotSystem')}    botSystem
     * @param {object}                  io          - geckos.io server instance
     * @param {string}                  [mapKey]    - key inside spawns.json to use
     */
    constructor(ecsWorld, botSystem, io, mapKey = RESPAWN_MAP) {
        this.ecsWorld = ecsWorld;
        this.botSystem = botSystem;
        this.io = io;
        this.mapKey = mapKey;

        /** @type {Map<number, NodeJS.Timeout>} eid -> timeout handle */
        this.pending = new Map();
        this._msgCounter = 0;
    }

    /**
     * Schedule a respawn for the given entity.
     * Safe to call multiple times – subsequent calls while a timer is already
     * running are ignored.
     *
     * @param {number} eid         - ECS entity id of the dead entity
     * @param {number} [delayMs]   - override default respawn delay in ms
     */
    scheduleRespawn(eid, delayMs = RESPAWN_DELAY) {
        if (this.pending.has(eid)) return; // already queued

        const isPlayer = this.ecsWorld.playerEntities.has(eid);
        const isBot    = this.ecsWorld.botEntities.has(eid);
        if (!isPlayer && !isBot) {
            console.error(`RespawnSystem: entity ${eid} is neither player nor bot - skipping`);
            return;
        }

        // Notify the specific player about the upcoming respawn delay
        if (isPlayer) {
            const socketId = this.ecsWorld.getSocketByEntity(eid);
            if (socketId) {
                this.io.emit('respawnCountdown', {
                    playerId: socketId,
                    delay: delayMs,
                });
            }
        }

        const handle = setTimeout(() => {
            this.pending.delete(eid);
            this._respawnPlayer(eid);
        }, delayMs);

        this.pending.set(eid, handle);
    }

    /**
     * Cancel a pending respawn (e.g. player disconnected before the timer fired).
     * @param {number} eid
     */
    cancelRespawn(eid) {
        const handle = this.pending.get(eid);
        if (handle !== undefined) {
            clearTimeout(handle);
            this.pending.delete(eid);
            console.log(`RespawnSystem: cancelled pending respawn for eid ${eid}`);
        }
    }

    /**
     * Select a spawn point from spawns.json for the given team.
     * Falls back to a random position on the map if no config is found.
     *
     * @param {string} [mapKey]  - key inside spawns.json  (e.g. 'default', 'arena')
     * @param {number} [teamId]  - 0=neutral, 1=team1, 2=team2
     * @returns {{ x: number, y: number, z: number }}
     */
    selectSpawnPoint(mapKey = this.mapKey, teamId = 0) {
        const mapConfig = spawns[mapKey] || spawns['default'];

        let candidates;
        if (teamId === 1)      candidates = mapConfig.team1;
        else if (teamId === 2) candidates = mapConfig.team2;
        else                   candidates = mapConfig.neutral;

        // Graceful fallback
        if (!candidates || candidates.length === 0) {
            const range = 90;
            return {
                x: (Math.random() - 0.5) * 2 * range,
                y: 4,
                z: (Math.random() - 0.5) * 2 * range,
            };
        }

        return candidates[Math.floor(Math.random() * candidates.length)];
    }


    resetEntity(eid) {
        // Clear pending respawn if any (e.g. from a previous death)
        Score.kills[eid] = 0;
        Score.deaths[eid] = 0;
        AbilityCooldowns.ability1[eid] = 0;
        AbilityCooldowns.ability2[eid] = 0;
        AbilityCooldowns.ultimate[eid] = 0;
        this.cancelRespawn(eid); // clear any pending respawns for this entity
        this.scheduleRespawn(eid, 5); // respawn all players/bots with a short delay; any existing
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Internal helpers
    // ─────────────────────────────────────────────────────────────────────────

    /** Reset health, teleport physics body, zero out velocity. */
    _respawnEntity(eid) {
        const isPlayer = this.ecsWorld.playerEntities.has(eid);
        const isBot    = this.ecsWorld.botEntities.has(eid);

        if (!isPlayer && !isBot) {
            console.error(`RespawnSystem: entity ${eid} no longer exists – aborting respawn`);
            return false;
        }

        const id = isPlayer
            ? this.ecsWorld.getSocketByEntity(eid)
            : this.ecsWorld.getBotIdString(eid);

        if (!id) {
            console.error(`RespawnSystem: could not resolve body id for eid ${eid}`);
            return false;
        }

        // Restore health, armor, and shield
        Health.current[eid] = Health.max[eid];
        Armor.current[eid]  = Armor.max[eid];
        Shield.current[eid] = 0; // Shields start empty; they regen naturally
        Shield.regenDelay[eid] = 0;

        // Refill weapon ammo
        const stats = WEAPONS[Weapon.id[eid]];
        if (stats) {
            Weapon.ammo[eid]        = stats.ammoCapacity;
            Weapon.reserveAmmo[eid] = stats.reserveAmmo;
            Weapon.fireCooldown[eid] = 0;
            Weapon.reloadTimer[eid]  = 0;
        }

        // Teleport physics body to spawn point
        const body = this.ecsWorld.physicsWorld?.getBody(id);
        if (body) {
            const teamId = (Team.id && Team.id[eid]) || 0;
            const { x, y, z } = this.selectSpawnPoint(this.mapKey, teamId);

            this.ecsWorld.physicsWorld.resetForces(id);
            body.setTranslation({ x, y, z }, true);
            body.setLinvel({ x: 0, y: 0, z: 0 }, true);

            // Mirror to ECS
            Velocity.vx[eid] = 0;
            Velocity.vy[eid] = 0;
            Velocity.vz[eid] = 0;

            // Reset jump and dash state so they work immediately after respawn
            Jump.isGrounded[eid] = 0;
            Jump.jumpsRemaining[eid] = 2;
            Jump.jumpTimer[eid] = 0;
            Dash.canDash[eid] = 1;
            Dash.dashTimer[eid] = 0;

            this.io.emit('playerRespawned', {
                playerId:  id,
                health:    Health.current[eid],
                healthMax: Health.max[eid],
                x: x,
                y: y,
                z: z
            });

        } else {
            console.error(`RespawnSystem: no physics body found for id "${id}"`);
        }

        return true;
    }

    _respawnPlayer(eid) {
        // Apply pending hero class selection before resetting stats
        const id = this.ecsWorld.getEntityId(eid);
        const pendingHero = id !== undefined
            ? this.ecsWorld.pendingHeroClass.get(id)
            : undefined;
        if (pendingHero !== undefined) {
            this.ecsWorld.applyHeroClass(eid, pendingHero);
        }

        if (!this._respawnEntity(eid)) return;

    }
}

module.exports = RespawnSystem;

const { defineQuery } = require('bitecs');
const {
    Position,
    Velocity,
    Rotation,
    Health,
    Armor,
    Shield,
    HeroClass,
    Weapon,
    AbilityCooldowns,
    EntityColor,
    Team,
    Player,
    Bot,
    Bullet,
    Score,
    Dash,
    Pickup,
} = require('../../shared/components');

// Queries for different entity types
const playerQuery  = defineQuery([Position, Rotation, Player]);
const botQuery     = defineQuery([Position, Rotation, Bot]);
const bulletQuery  = defineQuery([Position, Velocity, Bullet]);
const pickupQuery  = defineQuery([Position, Pickup]);

class NetworkSystem {
    constructor(ecsWorld) {
        this.ecsWorld = ecsWorld;
        /**
         * Tracks the highest input sequence number that has been fully
         * processed by the server for each connected player.
         * Map<socketId: string, lastProcessedSeq: number>
         */
        this.lastProcessedSeq = new Map();
    }

    /**
     * Record the latest processed input sequence number for a player.
     * Called from the playerInput handler in server/index.js.
     *
     * @param {string} socketId
     * @param {number} seq
     */
    setLastSeq(socketId, seq) {
        const current = this.lastProcessedSeq.get(socketId) ?? -1;
        if (seq > current) {
            this.lastProcessedSeq.set(socketId, seq);
        }
    }

    /**
     * Remove a player's sequence entry when they disconnect.
     * @param {string} socketId
     */
    removePlayer(socketId) {
        this.lastProcessedSeq.delete(socketId);
    }

    /**
     * Serialize all entities into a network-friendly format
     * @param {Object} world - bitECS world
     * @returns {Object} Serialized state with players, bots, and bullets
     */
    serializeState(world, match = null) {
        const players = {};
        const bots    = {};
        const bullets = [];
        const pickups = [];

        // Serialize players
        const playerEntities = playerQuery(world);
        for (const eid of playerEntities) {
            const socketId = this.ecsWorld.getSocketByEntity(eid);
            if (socketId) {
                const colorR = Math.floor(EntityColor.r[eid] * 255);
                const colorG = Math.floor(EntityColor.g[eid] * 255);
                const colorB = Math.floor(EntityColor.b[eid] * 255);
                const color  = (colorR << 16) | (colorG << 8) | colorB;
                
                players[socketId] = {
                    id:               socketId,
                    eid:              eid,
                    x:                Position.x[eid],
                    y:                Position.y[eid],
                    z:                Position.z[eid],
                    yaw:              Rotation.yaw[eid],
                    pitch:            Rotation.pitch[eid],
                    color:            color,
                    health:           Health.current[eid],
                    healthMax:        Health.max[eid],
                    armor:            Armor.current[eid],
                    armorMax:         Armor.max[eid],
                    shield:           Shield.current[eid],
                    heroClass:        HeroClass.id[eid],
                    weaponId:         Weapon.id[eid],
                    ammo:             Weapon.ammo[eid],
                    reserveAmmo:      Weapon.reserveAmmo[eid],
                    ability1Cooldown: AbilityCooldowns.ability1[eid],
                    ability2Cooldown: AbilityCooldowns.ability2[eid],
                    ultimateCooldown: AbilityCooldowns.ultimate[eid],
                    ultimateActive:   AbilityCooldowns.ultimateActive[eid] === 1,
                    name:             this.ecsWorld.getEntityName(eid),
                    team:             Team.id[eid],
                    kills:            Score.kills[eid],
                    deaths:           Score.deaths[eid],
                    canDash:          Dash.canDash[eid] === 1,
                    dashTimer:        Dash.dashTimer[eid],
                    dashDuration:     Dash.dashDuration[eid],
                    lastProcessedSeq: this.lastProcessedSeq.get(socketId) ?? 0,
                };
            }
        }

        // Serialize bots
        const botEntities = botQuery(world);
        for (const eid of botEntities) {
            const botId = `bot_${eid}`;

            const colorR = Math.floor(EntityColor.r[eid] * 255);
            const colorG = Math.floor(EntityColor.g[eid] * 255);
            const colorB = Math.floor(EntityColor.b[eid] * 255);
            const color  = (colorR << 16) | (colorG << 8) | colorB;
            
            bots[botId] = {
                id:        botId,
                eid:       eid,
                x:         Position.x[eid],
                y:         Position.y[eid],
                z:         Position.z[eid],
                yaw:       Rotation.yaw[eid],
                pitch:     Rotation.pitch[eid],
                color:     color,
                health:    Health.current[eid],
                healthMax: Health.max[eid],
                armor:     Armor.current[eid],
                armorMax:  Armor.max[eid],
                shield:    Shield.current[eid],
                heroClass: HeroClass.id[eid],
                team: Team.id[eid],
                name:      this.ecsWorld.getEntityName(eid),
                kills:     Score.kills[eid],
                deaths:    Score.deaths[eid],
            };
        }

        // Serialize bullets
        const bulletEntities = bulletQuery(world);
        for (const eid of bulletEntities) {
            bullets.push({
                id: eid,
                x:  Position.x[eid],
                y:  Position.y[eid],
                z:  Position.z[eid],
                vx: Velocity.vx[eid],
                vy: Velocity.vy[eid],
                vz: Velocity.vz[eid],
                life: Bullet.life[eid],
                type: Bullet.type[eid],
            });
        }

        // Serialize pickups
        const pickupEntities = pickupQuery(world);
        for (const eid of pickupEntities) {
            pickups.push({
                id:     eid,
                type:   Pickup.type[eid],
                x:      Position.x[eid],
                y:      Position.y[eid],
                z:      Position.z[eid],
                active: Pickup.active[eid] === 1,
            });
        }

        return { players, bots, bullets, pickups, match };
    }

    /**
     * Serialize a single player entity (for initial sync)
     * @param {Object} world - bitECS world
     * @param {number} eid - Entity ID
     * @returns {Object} Player data
     */
    serializePlayer(world, eid) {
        const socketId = this.ecsWorld.getSocketByEntity(eid);
        if (!socketId) return null;

        const colorR = Math.floor(EntityColor.r[eid] * 255);
        const colorG = Math.floor(EntityColor.g[eid] * 255);
        const colorB = Math.floor(EntityColor.b[eid] * 255);
        const color = (colorR << 16) | (colorG << 8) | colorB;

        return {
            id: socketId,
            eid: eid,
            x: Position.x[eid],
            y: Position.y[eid],
            z: Position.z[eid],
            yaw: Rotation.yaw[eid],
            pitch: Rotation.pitch[eid],
            color: color,
            team: Team.id[eid],
            name: this.ecsWorld.getEntityName(eid),
            kills: Score.kills[eid],
            deaths: Score.deaths[eid],
        };
    }
}

module.exports = NetworkSystem;

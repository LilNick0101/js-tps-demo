const { createWorld, addEntity, removeEntity, addComponent, defineQuery } = require('bitecs');
const {
    Position,
    Velocity,
    Rotation,
    Health,
    Team,
    EntityColor,
    Player,
    Jump,
    Dash,
    Bullet,
    Controller,
    PhysicsBody,
    Bot,
    KillStreak,
    Score,
    Armor,
    Shield,
    HeroClass,
    Weapon,
    AbilityCooldowns,
    Pickup,
} = require('../../shared/components');
const { HEROES, WEAPONS, PICKUP_CONFIGS } = require('../../shared/constants');
const heroConfigs = require('../../shared/config/heroes.json');

const BOT_NAME_POOL = [
    'xXx_ROFL_NOSCOPER_69_420_xXx', 'Flaming Skull', 'Bob', 'Spicy Boy', 'Tamerlane',
    'Obscure Guy', 'Striker', 'Fat Jerome', 'HIGH ELO OR THROW', 'KyoukanMain', 'Kyoukan',
    'RadioactiveMan', 'BLAZE_OF_GLORY', 'Alfred', 'Sven', 'Father Callas', 'Shadow Stalker', 'IronClad', 'Matrix',
    'Trinity', 'Neo', 'Morpheus', 'Devastation', 'Raptor', 'Cyrax', 'THE_MEMES_CONOISSEUR', 
    'GigaChad', 'Selene Feet Sniffer', 'Selene', 'The Punisher', 'John Wick', "Morbidly Obese Gamer", "ahahahaha", "L'italiano medio", "USE TAMERLANE OR FEED",
    'Bitcoin Miner', 'Jeff Bezos', 'Elon Musk', 'Sonic The Hedgehog', 'EXEerror', 'Jakob', 'The Secret Escape',
    "Goku", "Sussy Baka", "Predator", "THANOS IS COMING", "Doom Slayer", "Low Cortisol Gamer"
];

const physicsQuery = defineQuery([Position, Velocity]);

class World {
    constructor() {
        this.world = createWorld();
        
        // Maps socket IDs to entity IDs for players
        this.socketToEntity = new Map();
        this.entityToSocket = new Map();
        
        // Track all active entities by type
        this.playerEntities = new Set();
        this.bulletEntities = new Set();
        this.botEntities = new Set();
        this.pickupEntities = new Set();
        
        // Bot ID counter
        this.nextBotId = 1;

        // Entity display names (eid -> string)
        this.entityNames = new Map();

        // Track used bot names to avoid duplicates
        this.usedBotNames = new Set();

        // Pending hero class selections for players before first spawn
        // Map<socketId, heroClassId>
        this.pendingHeroClass = new Map();
    }

    createBasePlayerEntity(x = 0, y = 2, z = 0, teamId = 0, color = 0xffffff, heroClassId = HEROES.DUMMY) {
        const eid = addEntity(this.world);
        const heroConfig = heroConfigs[String(heroClassId)] || heroConfigs['0'];
        const weaponId = heroConfig.weaponId;
        const weaponStats = WEAPONS[weaponId];

        addComponent(this.world, Position, eid);
        Position.x[eid] = x;
        Position.y[eid] = y;
        Position.z[eid] = z;
        
        addComponent(this.world, Velocity, eid);
        Velocity.vx[eid] = 0;
        Velocity.vy[eid] = 0;
        Velocity.vz[eid] = 0;
        
        addComponent(this.world, Rotation, eid);
        Rotation.yaw[eid] = 0;
        Rotation.pitch[eid] = 0;
        Rotation.roll[eid] = 0;
        
        addComponent(this.world, Health, eid);
        Health.current[eid] = heroConfig.health;
        Health.max[eid] = heroConfig.health;

        addComponent(this.world, Armor, eid);
        Armor.current[eid] = heroConfig.armor;
        Armor.max[eid] = heroConfig.armorMax;

        addComponent(this.world, Shield, eid);
        Shield.current[eid] = 0;
        Shield.max[eid] = heroConfig.shieldMax;
        Shield.regenRate[eid] = heroConfig.shieldRegenRate;
        Shield.regenDelay[eid] = 0;

        addComponent(this.world, HeroClass, eid);
        HeroClass.id[eid] = heroClassId;

        addComponent(this.world, Weapon, eid);
        Weapon.id[eid] = weaponId;
        Weapon.fireCooldown[eid] = 0;
        Weapon.reloadTimer[eid] = 0;
        Weapon.ammo[eid] = weaponStats.ammoCapacity;
        Weapon.reserveAmmo[eid] = weaponStats.reserveAmmo;

        addComponent(this.world, AbilityCooldowns, eid);
        AbilityCooldowns.ability1[eid] = 0;
        AbilityCooldowns.ability2[eid] = 0;
        AbilityCooldowns.ultimate[eid] = 0;
        AbilityCooldowns.ultimateActive[eid] = 0;
        AbilityCooldowns.ultimateTimer[eid] = 0;

        addComponent(this.world, Team, eid);
        Team.id[eid] = teamId;

        addComponent(this.world, EntityColor, eid);
        EntityColor.r[eid] = ((color >> 16) & 0xFF) / 255;
        EntityColor.g[eid] = ((color >> 8) & 0xFF) / 255;
        EntityColor.b[eid] = (color & 0xFF) / 255;

        addComponent(this.world, Controller, eid);
        Controller.forward[eid] = 0;
        Controller.backward[eid] = 0;
        Controller.left[eid] = 0;
        Controller.right[eid] = 0;
        Controller.jump[eid] = 0;
        Controller.dash[eid] = 0;
        Controller.ability1[eid] = 0;
        Controller.ability2[eid] = 0;
        Controller.ultimate[eid] = 0;

        addComponent(this.world, Jump, eid);
        Jump.isGrounded[eid] = 0;
        Jump.jumpsRemaining[eid] = 2;
        Jump.jumpTimer[eid] = 0;

        addComponent(this.world, Dash, eid);
        Dash.canDash[eid] = 1;
        Dash.dashTimer[eid] = 0;
        Dash.isDashing[eid] = 0;
        
        addComponent(this.world, PhysicsBody, eid);
        PhysicsBody.bodyId[eid] = 0;
        
        addComponent(this.world, KillStreak, eid);
        KillStreak.kills[eid] = 0;
        KillStreak.lastKillTime[eid] = 0;

        addComponent(this.world, Score, eid);
        Score.kills[eid] = 0;
        Score.deaths[eid] = 0;

        return eid;
    }

    /**
     * Create a new player entity
     * @param {string} socketId - Socket.IO connection ID
     * @param {number} x - Initial X position
     * @param {number} y - Initial Y position
     * @param {number} z - Initial Z position
     * @param {number} teamId - Team ID for the player
     * @param {number} color - Player color (as hex number)
     * @param {number} heroClassId - Hero class ID (0=Dummy, 1=Sven, 2=Tamerlane)
     * @returns {number} Entity ID
     */
    createPlayerEntity(socketId, x = 0, y = 2, z = 0, teamId = 0, color = 0xffffff, heroClassId = HEROES.DUMMY) {
        const eid = this.createBasePlayerEntity(x, y, z, teamId, color, heroClassId);
        
        addComponent(this.world, Player, eid);
        // Store color as RGB components (0-1 range)
        Player.colorR[eid] = ((color >> 16) & 0xFF) / 255;
        Player.colorG[eid] = ((color >> 8) & 0xFF) / 255;
        Player.colorB[eid] = (color & 0xFF) / 255;
        Player.isReady[eid] = 0; // Not ready until hero selection is complete
        
        // Track mappings
        this.socketToEntity.set(socketId, eid);
        this.entityToSocket.set(eid, socketId);
        this.playerEntities.add(eid);

        // Assign default player name (overwritten when client sends setUsername)
        this.entityNames.set(eid, 'Player');
        
        return eid;
    }

    /**
     * Create a new bot entity
     * @param {number} x - Initial X position
     * @param {number} y - Initial Y position
     * @param {number} z - Initial Z position
     * @param {number} teamId - Team ID for the bot
     * @param {number} color - Bot color (as hex number)
     * @param {number} heroClassId - Hero class (default random)
     * @returns {number} Entity ID
     */
    createBotEntity(x = 0, y = 2, z = 0, teamId = 1, color = 0xff0000, heroClassId = null) {
        // Assign a random hero class if not specified
        const heroValues = Object.values(HEROES);
        const resolvedClass = heroClassId !== null ? heroClassId
            : heroValues[Math.floor(Math.random() * heroValues.length)];

        const eid = this.createBasePlayerEntity(x, y, z, teamId, color, resolvedClass);
        
        Rotation.yaw[eid] = Math.random() * Math.PI * 2;
        
        addComponent(this.world, Bot, eid);
        Bot.targetId[eid] = 0;
        Bot.shootCooldown[eid] = 0;
        Bot.wanderTimer[eid] = 0;
        Bot.state[eid] = 0; // Start in wander state
        
        // Track bot
        this.botEntities.add(eid);

        // Assign a unique random name from the pool
        const available = BOT_NAME_POOL.filter(n => !this.usedBotNames.has(n));
        const chosen = available.length > 0
            ? available[Math.floor(Math.random() * available.length)]
            : `Bot${eid}`;
        this.usedBotNames.add(chosen);
        this.entityNames.set(eid, chosen);
        
        return eid;
    }

    /**
     * Create a new bullet entity
     * @param {number} ownerEid - Entity ID of the player who shot
     * @param {number} x - Initial X position
     * @param {number} y - Initial Y position
     * @param {number} z - Initial Z position
     * @param {number} vx - X velocity
     * @param {number} vy - Y velocity
     * @param {number} vz - Z velocity
     * @param {number} lifetime - How long bullet exists (ticks)
     * @returns {number} Entity ID
     */
    createBulletEntity(ownerEid, x, y, z, vx, vy, vz, lifetime = 100) {
        const eid = addEntity(this.world);
        
        addComponent(this.world, Position, eid);
        Position.x[eid] = x;
        Position.y[eid] = y;
        Position.z[eid] = z;
        
        addComponent(this.world, Velocity, eid);
        Velocity.vx[eid] = vx;
        Velocity.vy[eid] = vy;
        Velocity.vz[eid] = vz;
        
        addComponent(this.world, Bullet, eid);
        Bullet.life[eid] = lifetime;
        Bullet.owner[eid] = ownerEid;
        
        this.bulletEntities.add(eid);
        
        return eid;
    }

    syncPhysicsToECS(physicsWorld) {
        const physicsEntities = physicsQuery(this.world);
        for (const eid of physicsEntities) {
            const id = this.getEntityId(eid);
            if (!id) continue;
            const body = physicsWorld.getBody(id.toString());
            if (!body) continue;

            const pos = physicsWorld.getTranslation(id.toString());
            Position.x[eid] = pos.x;
            Position.y[eid] = pos.y;
            Position.z[eid] = pos.z;

            const vel = physicsWorld.getLinearVelocity(id.toString());
            Velocity.vx[eid] = vel.x;
            Velocity.vy[eid] = vel.y;
            Velocity.vz[eid] = vel.z;
        }
    }

    /**
     * Remove a player entity
     * @param {string} socketId - Socket ID to remove
     */
    removePlayerEntity(socketId) {
        const eid = this.socketToEntity.get(socketId);
        if (eid !== undefined) {
            this.playerEntities.delete(eid);
            this.socketToEntity.delete(socketId);
            this.entityToSocket.delete(eid);
            this.entityNames.delete(eid);
            removeEntity(this.world, eid);
        }
    }

    /**
     * Remove a bullet entity
     * @param {number} eid - Entity ID to remove
     */
    removeBulletEntity(eid) {
        this.bulletEntities.delete(eid);
        removeEntity(this.world, eid);
    }

    /**
     * Create a pickup entity at the given world position.
     * @param {number} type - 0=health vial, 1=armor shard
     * @param {number} x
     * @param {number} y
     * @param {number} z
     * @returns {number} Entity ID
     */
    createPickupEntity(type, x, y, z) {
        const eid = addEntity(this.world);
        const cfg = PICKUP_CONFIGS[type];

        addComponent(this.world, Position, eid);
        Position.x[eid] = x;
        Position.y[eid] = y;
        Position.z[eid] = z;

        addComponent(this.world, Pickup, eid);
        Pickup.type[eid]         = type;
        Pickup.value[eid]        = cfg.value;
        Pickup.respawnTimer[eid] = 0;
        Pickup.active[eid]       = 1;

        this.pickupEntities.add(eid);
        return eid;
    }

    /**
     * Remove a transient pickup entity (e.g. crystal shard) from the world.
     * @param {number} eid
     */
    removePickupEntity(eid) {
        this.pickupEntities.delete(eid);
        removeEntity(this.world, eid);
    }

    /**
     * Get all pickup entities
     * @returns {number[]}
     */
    getPickups() {
        return Array.from(this.pickupEntities);
    }

    /**
     * Get entity ID from socket ID
     */
    getEntityBySocket(socketId) {
        return this.socketToEntity.get(socketId);
    }

    isPlayer(eid) {
        return this.playerEntities.has(eid);
    }

    /**
     * Get the display name for an entity
     */
    getEntityName(eid) {
        return this.entityNames.get(eid) || `Entity${eid}`;
    }

    /**
     * Set the display name for an entity
     */
    setEntityName(eid, name) {
        this.entityNames.set(eid, name);
    }

    /**
     * Get socket ID from entity ID
     */
    getSocketByEntity(eid) {
        return this.entityToSocket.get(eid);
    }

    /**
     * Get all player entities
     */
    getPlayers() {
        return Array.from(this.playerEntities);
    }

    /**
     * Get all bullet entities
     */
    getBullets() {
        return Array.from(this.bulletEntities);
    }

    /**
     * Get all bot entities
     */
    getBots() {
        return Array.from(this.botEntities);
    }

    getAllPlayerAndBotEntities() {
        return [...this.getPlayers(), ...this.getBots()];
    }

    getEntityId(eid) {
        return this.getSocketByEntity(eid) ?? this.getBotIdString(eid);
    }

    getEntityIds(eids) {
        return eids.map(eid => this.getEntityId(eid));
    }

    /**
     * Apply a hero class to an existing entity in-place.
     * Updates HeroClass, Health, Armor, Shield, and Weapon components.
     * Does NOT reset position — call _respawnEntity for a full reset.
     * @param {number} eid
     * @param {number} heroClassId
     */
    applyHeroClass(eid, heroClassId) {
        const heroConfig  = heroConfigs[String(heroClassId)] || heroConfigs['0'];
        const weaponId    = heroConfig.weaponId;
        const weaponStats = WEAPONS[weaponId];

        HeroClass.id[eid] = heroClassId;

        Health.current[eid] = heroConfig.health;
        Health.max[eid]     = heroConfig.health;

        Armor.current[eid]  = heroConfig.armor    ?? 0;
        Armor.max[eid]      = heroConfig.armorMax  ?? 0;

        Shield.current[eid]    = 0;
        Shield.max[eid]        = heroConfig.shieldMax       ?? 0;
        Shield.regenRate[eid]  = heroConfig.shieldRegenRate ?? 0;
        Shield.regenDelay[eid] = 0;

        Weapon.id[eid]           = weaponId;
        Weapon.ammo[eid]         = weaponStats.ammoCapacity;
        Weapon.fireCooldown[eid] = 0;
        Weapon.reloadTimer[eid]  = 0;

        AbilityCooldowns.ability1[eid]       = 0;
        AbilityCooldowns.ability2[eid]       = 0;
        AbilityCooldowns.ultimate[eid]       = 0;
        AbilityCooldowns.ultimateActive[eid] = 0;
        AbilityCooldowns.ultimateTimer[eid]  = 0;
    }

    getEntityEid(id) {
        return this.getEntityBySocket(id) ?? this.getBotEntityById(id);
    }

    getBotIdString(botEid) {
        return `bot_${botEid}`;
    }

    getBotEntityById(botid) {
        return botid.split('_')[1];
    }
}

module.exports = World;

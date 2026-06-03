// Physics Constants
const MODES_CONFIG = require('./config/modes.json');

const ACTIVE_GAME_MODE = MODES_CONFIG.defaultMode || 'tdm';
const activeModeConfig = (MODES_CONFIG.modes && MODES_CONFIG.modes[ACTIVE_GAME_MODE]) || {};
const POST_MATCH_RESTART_MS = activeModeConfig.postMatchRestartMs !== undefined
    ? activeModeConfig.postMatchRestartMs
    : 8000;

module.exports = {
    // Gravity
    GRAVITY: -9.81,
    PHYSICS_TIMESTEP: 1 / 60,
    
    // Player Physics
    PLAYER_RADIUS: 0.55,
    PLAYER_HEIGHT: 1.1,
    PLAYER_HEAD_OFFSET: 1.1,
    PLAYER_MASS: 80,
    PLAYER_MOVE_FORCE: 200,
    PLAYER_JUMP_FORCE: 500,
    PLAYER_MAX_VELOCITY: 10.0,
    PLAYER_MOVE_SPEED: 12.0,
    PLAYER_DAMPING: 0.9,

    DASH_COOLDOWN_FRAMES: 60, // 60 ticks ≈ 1 second at 60 fps
    AIR_CONTROL_FACTOR: 0.15, 
    
    // Ground/Floor
    GROUND_FRICTION: 0.5,
    GROUND_RESTITUTION: 0.0,
    
    // Game Constants
    BULLET_DAMAGE: 25,   // legacy fallback; weapons use per-weapon damage
    TICK_RATE: 60,
    
    ARMOR_ABSORPTION: 0.4,  // 40% of incoming damage absorbed per armor point consumed

    // Map selection — must match a key in shared/config/maps.json
    CURRENT_MAP: 'arena',

    // Match mode selection / defaults
    MODES_CONFIG,
    ACTIVE_GAME_MODE,
    POST_MATCH_RESTART_MS,
    NUM_BOTS: 9, // default number of bots

    // Respawn
    RESPAWN_DELAY: 4000,   // ms before a dead entity respawns
    RESPAWN_MAP: 'arena', // which spawn config to use (key in spawns.json)
    
    // Bot AI Configuration
    BOT_DETECTION_RANGE: 80.0,
    BOT_CHASE_RANGE: 60.0,
    BOT_ATTACK_RANGE: 36.0,
    BOT_SHOOT_COOLDOWN: 12,
    BOT_AIM_ACCURACY: 0.14,
    BOT_AIM_SPREAD: 0.08,
    BOT_WANDER_TIME_MIN: 60,
    BOT_WANDER_TIME_MAX: 150,
    BOT_STRAFE_CHANCE: 0.7,
    BOT_JUMP_FREQUENCY: 0.998,
    BOT_DASH_FREQUENCY: 0.490,
    BOT_ABILITY1_HP_THRESHOLD: 0.6,
    BOT_ABILITY2_HP_THRESHOLD: 0.45,
    BOT_ULT_ENEMIES_THRESHOLD: 2,
    BOT_GROUP_RADIUS: 18.0,
    BOT_RUSH_RANGE: 28.0,

    // ── Hero IDs ──────────────────────────────────────────────────────────────
    HEROES: {
        DUMMY:         0,
        SVEN:          1,
        TAMERLANE:     2,
        FATHER_CALLAS: 3,
        SELENE:        4,
        FAT_JEROME:    5,
        KYOUKAN:       6,
        TEMPLAR:       7,
    },

    // ── Weapon IDs ────────────────────────────────────────────────────────────
    WEAPON_IDS: {
        ASSAULT_RIFLE:  0,
        SMG:            1,
        SHOTGUN:        2,
        PUMP_SHOTGUN:   3,
        MACHINE_PISTOL: 4,
        SNIPER_RIFLE:   5,
    },

    /**
     * Per-weapon stats.
     * fireCooldown:   ticks between shots  (60 tps)
     * reloadTime:     ticks for a reload
     * ammoCapacity:   rounds per clip
     * reserveAmmo:    initial reserve rounds
     * damage:         damage per bullet / per pellet (shotgun)
     * pellets:        how many projectiles per shot
     * speed:          bullet travel speed (units/s)
     * bulletLifetime: ticks before bullet despawns
     * spread:         aim-inaccuracy added per pellet (radians)
     */
    WEAPONS: {
        0: { // ASSAULT_RIFLE (Dummy)
            name: 'Assault Rifle',
            fireCooldown: 7,       // ~8 rps
            reloadTime: 120,       // 2 s
            ammoCapacity: 30,
            reserveAmmo: 90,
            damage: 21,
            pellets: 1,
            speed: 700,
            bulletLifetime: 100,
            spread: 0.03,
        },
        1: { // SMG (Sven)
            name: 'SMG',
            fireCooldown: 4,       // ~15 rps
            reloadTime: 90,        // 1.5 s
            ammoCapacity: 40,
            reserveAmmo: 120,
            damage: 11,
            pellets: 1,
            speed: 690,
            bulletLifetime: 90,
            spread: 0.05,
        },
        2: { // SHOTGUN (Tamerlane)
            name: 'Shotgun',
            fireCooldown: 16,      // ~4 rps  (semi-auto, fast)
            reloadTime: 150,       // 2.5 s
            ammoCapacity: 9,
            reserveAmmo: 32,
            damage: 14,            // per pellet – 6 pellets = 108 max
            pellets: 6,
            speed: 660,
            bulletLifetime: 60,
            spread: 0.14,          // predictable cone spread
        },
        3: { // PUMP_SHOTGUN (Father Callas)
            name: 'Pump-Action Shotgun',
            fireCooldown: 45,      // ~1.3 rps – deliberately slow pump action
            reloadTime: 180,       // 3 s
            ammoCapacity: 6,
            reserveAmmo: 24,
            damage: 27,            // per pellet – 5 pellets = 140 max
            pellets: 5,
            speed: 650,
            bulletLifetime: 42,    // short range (~110 units)
            spread: 0.13,          // tight-ish cone for close quarters
        },
        4: { // MACHINE_PISTOL (Selene)
            name: 'Machine Pistol',
            fireCooldown: 3,       // 20 rps – very high fire rate
            reloadTime: 75,        // 1.25 s
            ammoCapacity: 25,
            reserveAmmo: 80,
            damage: 13,            // medium per-bullet; DPS from fire rate
            pellets: 1,
            speed: 690,
            bulletLifetime: 80,
            spread: 0.09,          // high spread
        },
        5: { // SNIPER_RIFLE (Kyoukan)
            name: 'Sniper Rifle',
            fireCooldown: 50,
            reloadTime: 130,
            ammoCapacity: 5,
            reserveAmmo: 25,
            damage: 110,
            pellets: 1,
            speed: 840,
            bulletLifetime: 140,
            spread: 0.0006,
        },
    },

    // ── Pickup types ─────────────────────────────────────────────────────────
    PICKUP_TYPES: {
        HEALTH_VIAL:   0,
        ARMOR_SHARD:   1,
        CRYSTAL_SHARD: 2,  // Selene – dropped on Crystal Smash kill; transient
    },
    PICKUP_CONFIGS: {
        0: { value: 30,  respawnTicks: 1200    }, // health vial: +30 hp, 20 s respawn
        1: { value: 20,  respawnTicks: 1800    }, // armor shard: +20 armor, 30 s respawn
        2: { value: 30,  respawnTicks: 9999999 }, // crystal shard: +30 hp, manually removed
    },
    PICKUP_RADIUS: 1.5, // units – how close a player must be to collect

    // ── Ability cooldowns (ticks at 60 tps) ───────────────────────────────────
    ABILITY_COOLDOWNS: {
        // Sven
        SHADOW_LIGHTNING_CD:  480,  // 8 s
        SHADOW_TELEPORT_CD:   360,  // 6 s
        SHADOW_STORM_CD:      2700, // 45 s
        SHADOW_STORM_DURATION: 600, // 10 s
        SHADOW_STORM_TICK_DAMAGE: 4, // per tick during storm

        // Tamerlane
        SHOCK_GRENADE_CD:     600,  // 10 s
        SHOCK_GRENADE_FUSE:   120,  // 2 s
        SHOCK_GRENADE_DAMAGE: 45,
        SHOCK_GRENADE_RADIUS: 7.0,
        SHOCK_GRENADE_SLOW:   180,  // ticks of slow effect
        SHOCK_GRENADE_SLOW_FACTOR: 0.45, // fraction of normal speed while slowed
        WILLPOWER_CD:         720,  // 12 s
        WILLPOWER_SHIELD:     80,   // temporary shield amount
        WILLPOWER_DURATION:   300,  // 5 s
        CLUSTER_STRIKE_CD:    3600, // 60 s
        CLUSTER_STRIKE_BOMBS: 9,
        CLUSTER_STRIKE_DAMAGE: 80,
        CLUSTER_STRIKE_RADIUS: 6.0,
        CLUSTER_STRIKE_INTERVAL: 20, // ticks between bombs

        // Shadow Lightning
        SHADOW_LIGHTNING_DAMAGE: 75,
        SHADOW_LIGHTNING_RADIUS: 7,
        SHADOW_LIGHTNING_INTERVAL: 35, // ticks between bolts during channel
        SHADOW_LIGHTNING_DIST: [6, 13, 20], // distances of the 3 bolts

        // Shadow Teleport
        SHADOW_TELEPORT_DIST: 10.0,

        // Shadow Storm AOE
        SHADOW_STORM_RADIUS: 14.0,

        // Father Callas – Siphon Life
        SIPHON_LIFE_CD:        720,   // 12 s
        SIPHON_LIFE_RANGE:     14.0,   // cone length (units)
        SIPHON_LIFE_HALF_ANGLE: 0.698, // ~40° half-angle (full cone = 80°)
        SIPHON_LIFE_DURATION:  360,   // 6 s channel duration
        SIPHON_LIFE_TICK_INTERVAL: 10, // apply drain every 10 ticks (~6×/s)
        SIPHON_LIFE_DAMAGE:    9,     // per tick per enemy hit (~48 dmg/s)
        SIPHON_LIFE_HEAL_RATIO: 0.30, // 30 % of total damage dealt heals caster

        // Father Callas – Iron Stand
        IRON_STAND_CD:             800,  // 13 s
        IRON_STAND_DURATION:       270,  // 4.5 s invulnerable + frozen
        IRON_STAND_SHIELD_DURATION: 600, // 10 s damage-to-shield phase
        IRON_STAND_SHIELD_RATIO:   0.20, // 20 % of damage received → shield
        IRON_STAND_SHIELD_MAX:     120,  // cap on gained shield

        // Father Callas – Shadow Realm Banish
        SHADOW_REALM_CD:            3600, // 60 s
        SHADOW_REALM_DURATION:       360, // 6 s in shadow realm
        SHADOW_REALM_RETURN_DAMAGE:   40, // damage on return
        SHADOW_REALM_RANGE:          20.0, // max targeting range

        // Selene – Crystal Smash
        CRYSTAL_SMASH_CD:             600,  // 10 s
        CRYSTAL_SMASH_DAMAGE:          55,  // damage on impact
        CRYSTAL_SMASH_STUN_DURATION:   60,  // 1 s stun
        CRYSTAL_SMASH_HIT_RADIUS:       5.0, // collision sphere during dash
        CRYSTAL_SMASH_DASH_DURATION:   40,  // ticks the dash travels (~0.23 s)
        CRYSTAL_SMASH_DASH_SPEED:      32,  // m/s during dash
        CRYSTAL_SHARD_DESPAWN_TICKS:  480,  // 8 s before shard auto-despawns

        // Selene – Astral Elevation
        ASTRAL_ELEVATION_CD:              900, // 15 s
        ASTRAL_ELEVATION_INVULN_DURATION: 200, // 3 s untargetable on activation
        ASTRAL_ELEVATION_FLIGHT_DURATION: 200, // 5 s total flight
        ASTRAL_ELEVATION_WEAPON_BONUS_DURATION: 180, // 3 s damage bonus after landing
        ASTRAL_ELEVATION_WEAPON_BONUS_MULT: 1.3, // +30 % weapon damage
        ASTRAL_ELEVATION_SPEED_MULT:      1.35, // in-flight movement boost
        ASTRAL_ELEVATION_LAUNCH_SPEED:    14,   // upward m/s on activation

        // Selene – Lunar Eclipse
        LUNAR_ECLIPSE_CD:              3600, // 60 s
        LUNAR_ECLIPSE_CHARGE_DURATION:   90, // 1.5 s charge before blast
        LUNAR_ECLIPSE_DAMAGE:            60, // damage per target in AOE
        LUNAR_ECLIPSE_RADIUS:            16.0,
        LUNAR_ECLIPSE_PULSES:             3,  // number of damage pulses during eclipse
        LUNAR_ECLIPSE_PULSE_INTERVAL:    45, // ticks between damage pulses 
        LUNAR_ECLIPSE_SILENCE_DURATION:  240, // 4 s silence
        LUNAR_ECLIPSE_LAUNCH_SPEED:      18,  // upward m/s on activation

        // Fat Jerome – Shoulder Charge
        SHOULDER_CHARGE_CD:              720,  // 12 s
        SHOULDER_CHARGE_DURATION:        90,   // 1.5 s charge duration
        SHOULDER_CHARGE_SPEED:           24,   // m/s during charge
        SHOULDER_CHARGE_DAMAGE:          30,   // damage on impact
        SHOULDER_CHARGE_KNOCKBACK:       12,   // knockback force
        SHOULDER_CHARGE_HIT_RADIUS:      3.5,  // collision detection radius
        SHOULDER_CHARGE_STEER_RATE:      1.9,  // radians/s turning speed
        SHOULDER_CHARGE_STUN_DURATION:   45,   // 0.75 s stun on hit

        // Fat Jerome – Butt Smash
        BUTT_SMASH_CD:                   900,  // 15 s
        BUTT_SMASH_JUMP_SPEED:           16,   // upward m/s on activation
        BUTT_SMASH_DAMAGE_INNER:         90,   // damage in inner radius
        BUTT_SMASH_DAMAGE_OUTER:         50,   // damage in outer radius
        BUTT_SMASH_RADIUS_INNER:         5.0,  // inner impact radius (stun zone)
        BUTT_SMASH_DROP_PHASE_TICK:      74,   // ticks before descending after jump
        BUTT_SMASH_RADIUS_OUTER:         10.0,  // outer impact radius
        BUTT_SMASH_STUN_DURATION:        90,   // 1.5 s stun in inner radius
        BUTT_SMASH_CHARGE_DURATION:      25,   // 0.5 s windup before jump
        BUTT_SMASH_FALL_SPEED:           1.1, // additional downward velocity per tick during descent

        // Fat Jerome – Fatal Flatulence
        FATAL_FLATULENCE_CD:             3600, // 60 s
        FATAL_FLATULENCE_DURATION:       600,  // 10 s
        FATAL_FLATULENCE_FART_INTERVAL:  60,   // 1 s between farts
        FATAL_FLATULENCE_DAMAGE:         8,    // per tick per enemy (non-lethal)
        FATAL_FLATULENCE_RADIUS:         12.0,  // fart cloud radius
        FATAL_FLATULENCE_TICK_INTERVAL:  10,   // damage ticks every 10 ticks

        // Kyoukan – Arrow of Gratitude
        ARROW_OF_GRATITUDE_CD:                540,  // 9 s
        ARROW_OF_GRATITUDE_RANGE:            28.0,
        ARROW_OF_GRATITUDE_HALF_ANGLE:        0.52, // ~30°
        ARROW_OF_GRATITUDE_HEAL_FRAC:         0.20, // 20% max HP

        // Kyoukan – Majestic Leap
        MAJESTIC_LEAP_CD:                     840,  // 14 s
        MAJESTIC_LEAP_SPEED:                  26,
        MAJESTIC_LEAP_UPWARD_SPEED:           18,
        MAJESTIC_LEAP_DURATION:                48,  // 0.8 s

        // Kyoukan – Heroic Aura
        HEROIC_AURA_CD:                      3600, // 60 s
        HEROIC_AURA_DURATION:                 600, // 10 s
        HEROIC_AURA_TICK_INTERVAL:             60, // 1 s
        HEROIC_AURA_RADIUS:                  16.0,
        HEROIC_AURA_ARMOR_GAIN:                6,
        HEROIC_AURA_ULT_REDUCTION:             60, // 1 s per tick

        HEALING_RITE_CD: 960, // 16 s
        HEALING_RITE_TICK_INTERVAL: 60, // 1 s per heal tick
        HEALING_RITE_HEAL_AMOUNT: 10,   // hp healed per tick
        HEALING_RITE_DURATION: 600,      // 10 s total duration
        HEALING_RITE_RANGE : 14.0,       // radius around target ally
        HEALING_RITE_HALF_ANGLE:  0.52, // ~30°

        HOLY_WATER_CD: 720, // 12 s
        HOLY_WATER_DURATION: 300, // 5 s
        HOLY_WATER_HEAL_PER_INTERVAL: 7, // hp healed per tick
        HOLY_WATER_TICK_INTERVAL: 15, // 0.25 s per heal tick
        HOLY_WATER_RADIUS: 12.0,
        HOLY_WATER_THROW_SPEED: 36,

        HAMMER_OF_JUSTICE_CD: 3600, // 60 s 3600
        HAMMER_OF_JUSTICE_DAMAGE: 50,
        HAMMER_OF_JUSTICE_STUN_DURATION: 150,
        HAMMER_OF_JUSTICE_RANGE: 26.0,
        HAMMER_OF_JUSTICE_HALF_ANGLE: 0.72, // ~60°

    },
};

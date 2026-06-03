const { defineComponent, Types } = require('bitecs');

// Position component (x, y, z)
const Position = defineComponent({
    x: Types.f32,
    y: Types.f32,
    z: Types.f32,
});

// Velocity component (vx, vy, vz)
const Velocity = defineComponent({
    vx: Types.f32,
    vy: Types.f32,
    vz: Types.f32,
});

// Rotation component (yaw, pitch, roll)
const Rotation = defineComponent({
    yaw: Types.f32,
    pitch: Types.f32,
    roll: Types.f32,
});

// Health component
const Health = defineComponent({
    current: Types.f32,
    max: Types.f32,
});

// Team component (0 = neutral, 1 = blue team, 2 = red team, 3 = green team, 4 = yellow team)
const Team = defineComponent({
    id: Types.ui8
});

// Used for both player and bot entities to store their color for rendering
const EntityColor = defineComponent({
    r: Types.f32,
    g: Types.f32,
    b: Types.f32,
});

// Player component (marks entity as player, stores socket ID mapping)
const Player = defineComponent({
    colorR: Types.f32,
    colorG: Types.f32,
    colorB: Types.f32,
    isReady: Types.ui8, // 1 if player has selected hero and is ready to play
});

// Jump component (marks entity as being in a jump state)
const Jump = defineComponent({
    isGrounded: Types.i8, // 1 if on ground, 0 if in air
    jumpsRemaining: Types.ui8, // Number of jumps remaining (for double jump logic)
    jumpTimer: Types.f32, // Timer to track jump duration or cooldown
});

const Dash = defineComponent({
    canDash: Types.i8, // 1 if dash is available, 0 if on cooldown
    dashTimer: Types.ui32, // Timer to track dash duration or cooldown
    isDashing: Types.i8, // 1 if currently dashing, 0 otherwise
    dashDuration: Types.f32, // Duration of the dash in seconds
});

// Bullet component (lifetime timer and owner reference)
const Bullet = defineComponent({
    life: Types.ui16,
    owner: Types.ui16, // Entity ID of the owner
});

// Controller component (for input state)
const Controller = defineComponent({
    forward: Types.ui8,
    backward: Types.ui8,
    left: Types.ui8,
    right: Types.ui8,
    jump: Types.ui8,
    dash: Types.ui8,
    ability1: Types.ui8,
    ability2: Types.ui8,
    ultimate: Types.ui8,
});

// PhysicsBody component (stores reference to Rapier body ID)
const PhysicsBody = defineComponent({
    bodyId: Types.ui32, // Reference to physics body
});

// Bot component (marks entity as AI bot)
const Bot = defineComponent({
    targetId: Types.ui16, // Entity ID of current target
    shootCooldown: Types.ui16, // Ticks until can shoot again
    wanderTimer: Types.ui16, // Ticks until change wander direction
    state: Types.ui8, // 0 = wander, 1 = chase, 2 = attack
});

// KillStreak component (tracks kills for announcements)
const KillStreak = defineComponent({
    kills: Types.ui16, // Current kill count
    lastKillTime: Types.f32, // Time of last kill (for streak timeout)
});

// Score component (tracks total kills and deaths for the scoreboard)
const Score = defineComponent({
    kills: Types.ui16,
    deaths: Types.ui16,
});

// Armor component – mitigates damage; depleted before health is affected
const Armor = defineComponent({
    current: Types.f32,
    max: Types.f32,
});

// Shield component – absorbs damage before armor/health; regenerates after a delay
const Shield = defineComponent({
    current: Types.f32,
    max: Types.f32,
    regenRate: Types.f32,   // units per tick
    regenDelay: Types.ui16, // ticks before regen begins after last hit
});

// HeroClass component – which hero this entity is (0=Dummy, 1=Sven, 2=Tamerlane)
const HeroClass = defineComponent({
    id: Types.ui8,
});

// Weapon component – current equipped weapon state
const Weapon = defineComponent({
    id: Types.ui8,       // which weapon (maps to WEAPONS constant)
    fireCooldown: Types.ui16, // ticks remaining until next shot allowed
    reloadTimer: Types.ui16,  // ticks remaining in reload (0 = not reloading)
    ammo: Types.ui16,         // current clip ammo
    reserveAmmo: Types.ui16,  // ammo outside of clip
});

// AbilityCooldowns component – per-hero ability timers
const AbilityCooldowns = defineComponent({
    ability1: Types.ui16,       // ticks until ability1 is ready
    ability2: Types.ui16,       // ticks until ability2 is ready
    ultimate: Types.ui32,       // ticks until ultimate is ready
    ultimateActive: Types.ui8,  // 1 while ultimate is currently running
    ultimateTimer: Types.ui16,  // ticks remaining in active ultimate window
});

// Pickup component – collectible items in the world
const Pickup = defineComponent({
    type: Types.ui8,         // 0=health vial, 1=armor shard
    value: Types.f32,        // how much to restore
    respawnTimer: Types.ui16, // ticks until this pickup re-activates (0 = active)
    active: Types.ui8,       // 1 = can be picked up, 0 = awaiting respawn
});

module.exports = {
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
};

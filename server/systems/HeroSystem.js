const {
    Position,
    Rotation,
    Health,
    Armor,
    Shield,
    Team,
    HeroClass,
    Controller,
    AbilityCooldowns,
    Pickup,
    Dash,
} = require('../../shared/components');

const {
    HEROES,
    TICK_RATE,
    ABILITY_COOLDOWNS: CD,
    PICKUP_TYPES,
    DAMAGE_TYPES,
} = require('../../shared/constants');
const heroConfigs = require('../../shared/config/heroes.json');

/**
 * HeroSystem – ticks ability cooldowns and executes per-hero abilities.
 *
 * Ability input is read from Controller.ability1/2/ultimate flags, which are
 * set by server/index.js when `playerInput` arrives, and by BotSystem for bots.
 *
 * Grenade and bomb projectiles are tracked internally in plain JS arrays, since
 * they are transient and relatively few in number.
 */
class HeroSystem {
    /**
     * @param {import('../world/World')} ecsWorld
     * @param {import('../world/PhysicsWorld')} physicsWorld
     * @param {import('./DamageSystem')} damageSystem
     * @param {object} io   - geckos server
     */
    constructor(ecsWorld, physicsWorld, damageSystem, io) {
        this.ecsWorld    = ecsWorld;
        this.physicsWorld = physicsWorld;
        this.damageSystem = damageSystem;
        this.io          = io;

        this.shadowLightningStrikes = new Map(); // Map<eid, {positions, remainingTicks}>

        this._shadowStormTimers = new Map(); // Map<eid, ticksRemaining>

        /**
         * Grenade tracking: array of grenade objects.
         * { ownerEid, x, y, z, vx, vy, vz, fuse, hasSlow }
         */
        this._grenades = [];

        /**
         * Cluster bomb tracking: array of pending bomb impacts.
         * { ownerEid, targetX, targetZ, delay }
         */
        this._clusterBombs = [];

        /**
         * Willpower expiry: Map<eid, ticksRemaining>
         */
        this._willpowerTimers = new Map();

        /**
         * Iron Stand active phase: Map<eid, ticksRemaining>.
         * Entity is invulnerable and frozen while this has a value.
         */
        this._ironStandTimers = new Map();

        /**
         * Siphon Life channels: Map<eid, ticksRemaining>.
         * Drain ticks every SIPHON_LIFE_TICK_INTERVAL while active.
         */
        this._siphonLifeTimers = new Map();

        /**
         * Iron Stand shield phase: Map<eid, ticksRemaining>.
         * 20% of incoming damage becomes shield during this window.
         */
        this._ironStandShieldPhase = new Map();

        /**
         * Shadow Realm targets: Map<targetEid, { casterEid, remaining }>.
         * Banished entities are invulnerable and frozen.
         */
        this._shadowRealmTargets = new Map();

        // ─── Selene state ──────────────────────────────────────────────────────

        /**
         * Crystal Smash active dashes: Map<eid, { remaining, hit }>.
         */
        this._crystalSmashDashes = new Map();

        /**
         * Transient crystal shard pickup timers: Map<pickupEid, ticksRemaining>.
         * Shards are auto-removed when the timer expires or after collection.
         */
        this._crystalShards = new Map();

        /**
         * Stun timers: Map<eid, ticksRemaining>.
         * Stunned entities cannot move or act (included in isFrozen).
         */
        this._stunTimers = new Map();

        /**
         * Silence timers: Map<eid, ticksRemaining>.
         * Silenced entities cannot use abilities (but can still move/shoot).
         */
        this._silenceTimers = new Map();

        /**
         * Astral Elevation flight state: Map<eid, { remaining, invulnRemaining }>.
         * Entity is in flight; first invulnRemaining ticks are also invulnerable.
         */
        this._astralFlightTimers = new Map();

        this._statModifiers = {
            weaponDamage: new Map(),
            abilityDamage: new Map(),
            moveSpeed: new Map(),
            fireCooldown: new Map(),
            weaponResist: new Map(),
            abilityResist: new Map(),
        };

        /**
         * Lunar Eclipse charge phase: Map<eid, ticksRemaining>.
         * Entity is airborne & invulnerable; blast fires when timer hits zero.
         */
        this._lunarEclipseTimers = new Map();

        this._lunarEclipsePulses = new Map(); // Map<eid, pulsesRemaining> for tracking multi-pulse damage

        // ─── Fat Jerome state ──────────────────────────────────────────────────

        /**
         * Shoulder Charge active dashes: Map<eid, { remaining, hitTargets }>.
         */
        this._shoulderCharges = new Map();

        /**
         * Butt Smash state: Map<eid, { phase, remaining }>.
         * phase: 'charging' | 'airborne'
         */
        this._buttSmashes = new Map();

        /**
         * Fatal Flatulence active: Map<eid, { remaining, nextFart }>.
         */
        this._fatalFlatulenceTimers = new Map();

        /**
         * Fart clouds: array of { ownerEid, x, y, z, remaining }.
         */
        this._fartClouds = [];

        // ─── Kyoukan state ─────────────────────────────────────────────────────

        /**
         * Ability 1 cast mode flag set from latest client input.
         * Map<eid, boolean>
         */
        this._selfCastingEnabled = new Map();

        /**
         * Majestic Leap active state: Map<eid, { remaining }>
         */
        this._majesticLeaps = new Map();

        /**
         * Heroic Aura active state: Map<eid, { remaining, nextTick }>
         */
        this._heroicAuraTimers = new Map();

        this._healingRites = []; // { ownerEid, targetEid, remaining }

       /**
         * Holy Water Bottles tracking: array of  objects.
         * { ownerEid, x, y, z, vx, vy, vz, state (On Air or Lingering), ticksLeft (When On Ground) }
         */
        this._holyWaters = [];

        this._msgCounter = 0;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Main update
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Call every game tick.
     */
    update() {
        const entities = this.ecsWorld.getAllPlayerAndBotEntities();

        for (const eid of entities) {
            if (Health.current[eid] <= 0) {
                // Zero out inputs on dead entities
                Controller.ability1[eid] = 0;
                Controller.ability2[eid] = 0;
                Controller.ultimate[eid] = 0;
                continue;
            }

            this._tickCooldowns(eid);
            this._processAbilities(eid);
        }

        // Tick transient effects
        this._tickGrenades();
        this._tickClusterBombs();
        this._tickWillpowerTimers();
        this._tickShadowLightningStrikes();
        this._tickShadowStorm();
        this._tickShadowStormTimers();
        this._tickSiphonLife();
        this._tickIronStand();
        this._tickIronStandShield();
        this._tickShadowRealm();
        // Selene
        this._tickCrystalSmashDashes();
        this._tickCrystalShards();
        this._tickStuns();
        this._tickSilences();
        this._tickAstralFlight();
        this._tickLunarEclipse();
        // Fat Jerome
        this._tickShoulderCharges();
        this._tickButtSmashes();
        this._tickFatalFlatulence();
        this._tickFartClouds();
        // Kyoukan
        this._tickMajesticLeaps();
        this._tickHeroicAuras();
        this._tickHealingRites();
        this._tickHolyWaters();
        this._tickStatModifiers();

    }

    resetAbilities(eid){
        AbilityCooldowns.ability1[eid] = 0;
        AbilityCooldowns.ability2[eid] = 0;
        AbilityCooldowns.ultimate[eid] = 0;
        AbilityCooldowns.ultimateActive[eid] = 0;
        AbilityCooldowns.ultimateTimer[eid] = 0;
        this.interruptAbilities(eid);

    }

    interruptAbilities(eid) {
        this._terminateHealingRite(eid);
        switch (HeroClass.id[eid]) {
            case HEROES.SVEN: {
                this._endShadowStorm(eid);
                break;
            }
            case HEROES.FATHER_CALLAS:
                this._interruptSiphonLife(eid);
                break;
            case HEROES.SELENE:
                this._interruptLunarEclipse(eid);
                break;
            case HEROES.KYOUKAN: {
                this._majesticLeaps.delete(eid);
                this._heroicAuraTimers.delete(eid);
                AbilityCooldowns.ultimateActive[eid] = 0;
                break;
            }
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Cooldown ticking
    // ─────────────────────────────────────────────────────────────────────────

    _tickCooldowns(eid) {
        if (AbilityCooldowns.ability1[eid] > 0) AbilityCooldowns.ability1[eid]--;
        if (AbilityCooldowns.ability2[eid] > 0) AbilityCooldowns.ability2[eid]--;
        if (AbilityCooldowns.ultimate[eid]  > 0) AbilityCooldowns.ultimate[eid]--;

        // Tick active ultimate window
        if (AbilityCooldowns.ultimateActive[eid] === 1) {
            if (AbilityCooldowns.ultimateTimer[eid] > 0) {
                AbilityCooldowns.ultimateTimer[eid]--;
            } else {
                AbilityCooldowns.ultimateActive[eid] = 0;
                this.io.emit('ultimateEnded', { id: this.ecsWorld.getEntityId(eid) });
            }
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Ability dispatch
    // ─────────────────────────────────────────────────────────────────────────

    _processAbilities(eid) {
        const heroId = HeroClass.id[eid];

        // Frozen entities (Iron Stand active or Shadow Realm target) cannot act.
        if (this.isFrozen(eid)) {
            Controller.ability1[eid] = 0;
            Controller.ability2[eid] = 0;
            Controller.ultimate[eid] = 0;
            return;
        }

        // Silenced entities cannot cast abilities but can still move and shoot.
        if (this._silenceTimers.has(eid)) {
            Controller.ability1[eid] = 0;
            Controller.ability2[eid] = 0;
            Controller.ultimate[eid] = 0;
            return;
        }

        if (Controller.ability1[eid] === 1) {
            Controller.ability1[eid] = 0; // consume flag
            if (AbilityCooldowns.ability1[eid] === 0) {
                this._useAbility1(eid, heroId);
            }
        }

        if (Controller.ability2[eid] === 1) {
            Controller.ability2[eid] = 0;
            if (AbilityCooldowns.ability2[eid] === 0) {
                this._useAbility2(eid, heroId);
            }
        }

        if (Controller.ultimate[eid] === 1) {
            Controller.ultimate[eid] = 0;
            if (AbilityCooldowns.ultimate[eid] === 0 && AbilityCooldowns.ultimateActive[eid] === 0) {
                this._useUltimate(eid, heroId);
            }
        }
    }

    _useAbility1(eid, heroId) {
        switch (heroId) {
            case HEROES.SVEN:          return this._svenShadowLightning(eid);
            case HEROES.TAMERLANE:     return this._tamerlaneShockGrenade(eid);
            case HEROES.FATHER_CALLAS: return this._callasSiphonLife(eid);
            case HEROES.SELENE:        return this._seleneCrystalSmash(eid);
            case HEROES.FAT_JEROME:    return this._fatJeromeShoulderCharge(eid);
            case HEROES.KYOUKAN:       return this._kyoukanArrowOfGratitude(eid);
            case HEROES.TEMPLAR:       return this._templarHolyWater(eid);
            // Dummy: no-op
        }
    }

    _useAbility2(eid, heroId) {
        switch (heroId) {
            case HEROES.SVEN:          return this._svenShadowTeleport(eid);
            case HEROES.TAMERLANE:     return this._tamerlaneWillpower(eid);
            case HEROES.FATHER_CALLAS: return this._callasIronStand(eid);
            case HEROES.SELENE:        return this._seleneAstralElevation(eid);
            case HEROES.FAT_JEROME:    return this._fatJeromeButtSmash(eid);
            case HEROES.KYOUKAN:       return this._kyoukanMajesticLeap(eid);
            case HEROES.TEMPLAR:       return this._templarHealingRite(eid);

        }
    }

    _useUltimate(eid, heroId) {
        switch (heroId) {
            case HEROES.SVEN:          return this._svenShadowStorm(eid);
            case HEROES.TAMERLANE:     return this._tamerlaneClusterStrike(eid);
            case HEROES.FATHER_CALLAS: return this._callasShadowRealmBanish(eid);
            case HEROES.SELENE:        return this._seleneLunarEclipse(eid);
            case HEROES.FAT_JEROME:    return this._fatJeromeFatalFlatulence(eid);
            case HEROES.KYOUKAN:       return this._kyoukanHeroicAura(eid);
            case HEROES.TEMPLAR:       return this._templarHammerOfJustice(eid);
        }
    }

    handleDeath(eid) {
        this.interruptAbilities(eid);
        this.clearAllModifiers(eid);
        if (this._selfCastingEnabled.has(eid)) {
            this._selfCastingEnabled.delete(eid);
        }
    }

    /**
     * Update self-cast intent from latest input packet.
     * @param {number} eid
     * @param {boolean} enabled
     */
    setSelfCast(eid, enabled) {
        this._selfCastingEnabled.set(eid, Boolean(enabled));
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Sven abilities
    // ─────────────────────────────────────────────────────────────────────────

    _svenShadowLightning(eid) {
        AbilityCooldowns.ability1[eid] = CD.SHADOW_LIGHTNING_CD;

        const yaw = Rotation.yaw[eid];
        const ox  = Position.x[eid];
        const oy  = Position.y[eid];
        const oz  = Position.z[eid];

        // Direction Sven is facing
        const dx = -Math.sin(yaw);
        const dz = -Math.cos(yaw);

        const positions = CD.SHADOW_LIGHTNING_DIST.map(dist => ({
            x: ox + dx * dist,
            y: oy,
            z: oz + dz * dist,
        }));

        const id = this.ecsWorld.getEntityId(eid);
        this.shadowLightningStrikes.set(eid, { positions, remaining: CD.SHADOW_LIGHTNING_INTERVAL * 3 });
        this.io.emit('shadowLightning', { shooterId: id, cx: ox, cy: oy, cz: oz, positions });
    }

    _tickShadowLightningStrikes() {
        for (const [eid, state] of this.shadowLightningStrikes.entries()) {
            if (state.remaining <= 0) {
                this.shadowLightningStrikes.delete(eid);
                continue;
            }
            if (state.remaining % CD.SHADOW_LIGHTNING_INTERVAL === 0) {
                let posIndex = 2 - Math.floor(state.remaining / CD.SHADOW_LIGHTNING_INTERVAL) + 1;
                this._applyAOE(eid, state.positions[posIndex].x, state.positions[posIndex].y, state.positions[posIndex].z,
                    CD.SHADOW_LIGHTNING_RADIUS, CD.SHADOW_LIGHTNING_DAMAGE);
                this.io.emit('shadowLightningStrike', {
                    id: this.ecsWorld.getEntityId(eid),
                    x: state.positions[posIndex].x,
                    y: state.positions[posIndex].y,
                    z: state.positions[posIndex].z
                });
            }
            state.remaining--;
        }
    }

    _svenShadowTeleport(eid) {
        AbilityCooldowns.ability2[eid] = CD.SHADOW_TELEPORT_CD;

        const yaw = Rotation.yaw[eid];
        const dx  = -Math.sin(yaw) * CD.SHADOW_TELEPORT_DIST;
        const dz  = -Math.cos(yaw) * CD.SHADOW_TELEPORT_DIST;

        const newX = Position.x[eid] + dx;
        const newY = Position.y[eid];
        const newZ = Position.z[eid] + dz;

        // Teleport physics body
        const bodyId = this.ecsWorld.getEntityId(eid);
        const body   = this.physicsWorld.getBody(bodyId);
        if (body) {
            body.setTranslation({ x: newX, y: newY, z: newZ }, true);
            body.setLinvel({ x: 0, y: 0, z: 0 }, true);
        }

        Position.x[eid] = newX;
        Position.y[eid] = newY;
        Position.z[eid] = newZ;

        const id = this.ecsWorld.getEntityId(eid);
        this.io.emit('shadowTeleport', { id, x: newX, y: newY, z: newZ });
    }

    _svenShadowStorm(eid) {
        AbilityCooldowns.ultimate[eid]   = CD.SHADOW_STORM_CD;
        AbilityCooldowns.ultimateActive[eid] = 1;
        AbilityCooldowns.ultimateTimer[eid]  = CD.SHADOW_STORM_DURATION;

        this._shadowStormTimers.set(eid, CD.SHADOW_STORM_DURATION);

        const id = this.ecsWorld.getEntityId(eid);
        this.io.emit('shadowStormStart', {
            id,
            x: Position.x[eid],
            y: Position.y[eid],
            z: Position.z[eid],
            duration: CD.SHADOW_STORM_DURATION / TICK_RATE,
        });
    }

    _tickShadowStorm() {
        for (const eid of this.ecsWorld.getAllPlayerAndBotEntities()) {
            if (HeroClass.id[eid] !== HEROES.SVEN) continue;
            if (AbilityCooldowns.ultimateActive[eid] !== 1) continue;

            this._applyAOE(eid,
                Position.x[eid], Position.y[eid], Position.z[eid],
                CD.SHADOW_STORM_RADIUS, CD.SHADOW_STORM_TICK_DAMAGE);

            // Broadcast position each tick for persistent VFX
            const id = this.ecsWorld.getEntityId(eid);
            this.io.emit('shadowStormTick', {
                id,
                x: Position.x[eid],
                y: Position.y[eid],
                z: Position.z[eid],
            });
        }
    }

    _tickShadowStormTimers() {
        for (const [eid, remaining] of this._shadowStormTimers.entries()) {
            if (remaining <= 0) {
                this._endShadowStorm(eid);
            } else {
                this._shadowStormTimers.set(eid, remaining - 1);
            }
        }
    }
    
    _endShadowStorm(eid) {
        this._shadowStormTimers.delete(eid);
        AbilityCooldowns.ultimateActive[eid] = 0;
        this.io.emit('shadowStormEnd', { id: this.ecsWorld.getEntityId(eid) });
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Tamerlane abilities
    // ─────────────────────────────────────────────────────────────────────────

    _tamerlaneShockGrenade(eid) {
        AbilityCooldowns.ability1[eid] = CD.SHOCK_GRENADE_CD;

        const yaw   = Rotation.yaw[eid];
        const pitch = Rotation.pitch[eid];
        const speed = 15; // m/s

        const vx =  -Math.sin(yaw) * Math.cos(pitch) * speed;
        const vy =   Math.sin(pitch) * speed + 5; // add upward arc
        const vz =  -Math.cos(yaw)   * Math.cos(pitch) * speed;

        const grenade = {
            ownerEid: eid,
            x: Position.x[eid],
            y: Position.y[eid] + 1,
            z: Position.z[eid],
            vx, vy, vz,
            fuse: CD.SHOCK_GRENADE_FUSE,
        };
        this._grenades.push(grenade);

        const id = this.ecsWorld.getEntityId(eid);
        this.io.emit('grenadeThrown', {
            throwerId: id,
            x: grenade.x, y: grenade.y, z: grenade.z,
            vx, vy, vz,
            fuse: CD.SHOCK_GRENADE_FUSE / TICK_RATE,
        });
    }

    _tickGrenades() {
        const dt      = 1 / TICK_RATE;
        const gravity = -9.81;
        const toRemove = [];

        for (let i = 0; i < this._grenades.length; i++) {
            const g = this._grenades[i];
            g.vy += gravity * dt;
            g.x  += g.vx * dt;
            g.y  += g.vy * dt;
            // TODO: Implement this ability with Rapier
            if (g.y + 0.5 > 0) {
                g.y = 0.5; // simple ground collision
                g.vy = 0;
            }
            g.z  += g.vz * dt;
            g.fuse--;

            if (g.fuse <= 0) {
                // Explode
                this._applyAOE(g.ownerEid, g.x, g.y, g.z,
                    CD.SHOCK_GRENADE_RADIUS, CD.SHOCK_GRENADE_DAMAGE);

                // Slow all nearby entities
                for (const targetEid of this.ecsWorld.getAllPlayerAndBotEntities()) {
                    if (targetEid === g.ownerEid) continue;
                    if (Health.current[targetEid] <= 0) continue;
                    if (this.damageSystem.isFriendlyFireBlocked(targetEid, g.ownerEid)) continue;
                    if (this.damageSystem.collisionSystem.sphereCollisionCheckCoord(
                        Position.x[targetEid], Position.y[targetEid], Position.z[targetEid],
                        g.x, g.y, g.z,
                        CD.SHOCK_GRENADE_RADIUS
                    )) {
                        this.addTimedModifier(
                            targetEid,
                            'moveSpeed',
                            CD.SHOCK_GRENADE_SLOW_FACTOR,
                            CD.SHOCK_GRENADE_SLOW,
                            'slow',
                            { refreshMode: 'max' }
                        );
                    }
                }

                //console.log(`[Heroes] Grenade exploded at (${g.x.toFixed(1)}, ${g.y.toFixed(1)}, ${g.z.toFixed(1)})`);

                this.io.emit('grenadeExploded', {
                    x: g.x, y: g.y, z: g.z,
                    radius: CD.SHOCK_GRENADE_RADIUS,
                });

                toRemove.push(i);
            }
        }

        // Remove exploded grenades (reverse order to preserve indices)
        for (let i = toRemove.length - 1; i >= 0; i--) {
            this._grenades.splice(toRemove[i], 1);
        }
    }

    _tamerlaneWillpower(eid) {
        AbilityCooldowns.ability2[eid] = CD.WILLPOWER_CD;

        // Grant the Willpower shield
        Shield.current[eid] = Math.min(
            Shield.max[eid] > 0 ? Shield.max[eid] : CD.WILLPOWER_SHIELD,
            Math.max(Shield.current[eid], CD.WILLPOWER_SHIELD)
        );
        Shield.max[eid] = Math.max(Shield.max[eid], CD.WILLPOWER_SHIELD);
        // Prevent natural regen from decaying it immediately
        Shield.regenDelay[eid] = CD.WILLPOWER_DURATION;

        // Track so we can clean up after duration
        this._willpowerTimers.set(eid, CD.WILLPOWER_DURATION);

        const id = this.ecsWorld.getEntityId(eid);
        this.io.emit('willpowerActivated', {
            id,
            x: Position.x[eid],
            y: Position.y[eid],
            z: Position.z[eid],
            duration: CD.WILLPOWER_DURATION / TICK_RATE,
            shield: CD.WILLPOWER_SHIELD,
        });
    }

    _tickWillpowerTimers() {
        for (const [eid, remaining] of this._willpowerTimers) {
            if (remaining <= 1) {
                this._willpowerTimers.delete(eid);
                // Zero out the temporary shield if it hasn't been depleted
                Shield.current[eid] = Math.max(0, Shield.current[eid] - CD.WILLPOWER_SHIELD);
                Shield.current[eid] = Math.max(0, Shield.current[eid]);
                const id = this.ecsWorld.getEntityId(eid);
                this.io.emit('willpowerExpired', { id });
            } else {
                this._willpowerTimers.set(eid, remaining - 1);
            }
        }
    }

    _tamerlaneClusterStrike(eid) {
        AbilityCooldowns.ultimate[eid] = CD.CLUSTER_STRIKE_CD;
        AbilityCooldowns.ultimateActive[eid] = 1;
        AbilityCooldowns.ultimateTimer[eid]  = CD.CLUSTER_STRIKE_BOMBS * CD.CLUSTER_STRIKE_INTERVAL + 60;

        // Raycast from player's eye position along look direction to the ground (y=0).
        // Falls back to MAX_RANGE horizontal projection when looking level or upward.
        const MAX_RANGE = 40;
        const px  = Position.x[eid];
        const py  = Position.y[eid];
        const pz  = Position.z[eid];
        const yaw   = Rotation.yaw[eid];
        const pitch = Rotation.pitch[eid];
        const rdx = -Math.sin(yaw) * Math.cos(pitch);
        const rdy =  Math.sin(pitch);
        const rdz = -Math.cos(yaw) * Math.cos(pitch);

        let cx, cz, cy;
        let raycastHit = this.physicsWorld.raytrace(
            { x: px, y: py + 1.5, z: pz }, // ray origin (eye level)
            { x: rdx, y: rdy, z: rdz },    // ray direction
            MAX_RANGE
        );
        if (raycastHit) {
            cx = raycastHit["x"];
            cy = raycastHit["y"];
            cz = raycastHit["z"];
        } else if (rdy < -0.05) {
            // Ray intersects y=0 plane: py + t*rdy = 0 → t = -py/rdy
            const t = Math.min(-py / rdy, MAX_RANGE);
            cx = px + rdx * t;
            cz = pz + rdz * t;
            cy = 0;
        } else {
            // Looking level or upward: project MAX_RANGE horizontally
            cx = px - Math.sin(yaw) * MAX_RANGE;
            cz = pz - Math.cos(yaw) * MAX_RANGE;
            cy = py;
        }

        //console.log(`[Heroes] Cluster Strike targeted at (${cx.toFixed(1)}, ${cz.toFixed(1)}, ${cy.toFixed(1)}) by entity ${this.ecsWorld.getEntityId(eid)}`);

        const id = this.ecsWorld.getEntityId(eid);

        // Schedule bombs at staggered delays within a radius
        for (let i = 0; i < CD.CLUSTER_STRIKE_BOMBS; i++) {
            const angle  = Math.random() * Math.PI * 2;
            const radius = Math.random() * 16;
            const bx = cx + Math.cos(angle) * radius;
            const bz = cz + Math.sin(angle) * radius;
            this._clusterBombs.push({
                ownerEid: eid,
                targetX:  bx,
                targetY:  cy,
                targetZ:  bz,
                delay:    i * CD.CLUSTER_STRIKE_INTERVAL + 30,
            });
        }

        // Warn all clients to show ground markers
        this.io.emit('clusterStrikeBegin', {
            id,
            cx, cy, cz,
            casterX: px, casterY: py, casterZ: pz,
            bombs:   this._clusterBombs
                .filter(b => b.ownerEid === eid)
                .map(b => ({ x: b.targetX, y: b.targetY, z: b.targetZ })),
        });
    }

    _tickClusterBombs() {
        const toRemove = [];
        for (let i = 0; i < this._clusterBombs.length; i++) {
            const bomb = this._clusterBombs[i];
            bomb.delay--;
            if (bomb.delay <= 0) {
                const impactY = bomb.targetY;
                this._applyAOE(bomb.ownerEid, bomb.targetX, impactY, bomb.targetZ,
                    CD.CLUSTER_STRIKE_RADIUS, CD.CLUSTER_STRIKE_DAMAGE);

                this.io.emit('bombImpact', {
                    x: bomb.targetX,
                    y: impactY,
                    z: bomb.targetZ,
                    radius: CD.CLUSTER_STRIKE_RADIUS,
                });

                toRemove.push(i);
            }
        }
        for (let i = toRemove.length - 1; i >= 0; i--) {
            this._clusterBombs.splice(toRemove[i], 1);
        }
    }

    // ─────────────────────────────────────────────────────────────────────────    // Father Callas abilities
    // ───────────────────────────────────────────────────────────────────────────

    /**
     * Ability 1 – Siphon Life
     * Begin a 6-second channel that drains enemies in a facing cone every
     * SIPHON_LIFE_TICK_INTERVAL ticks, healing the caster for a fraction dealt.
     * Re-activating while already channelling is blocked by the cooldown.
     */
    _callasSiphonLife(eid) {
        AbilityCooldowns.ability1[eid] = CD.SIPHON_LIFE_CD;

        this._siphonLifeTimers.set(eid, CD.SIPHON_LIFE_DURATION);

        const id = this.ecsWorld.getEntityId(eid);
        this.io.emit('siphonLifeStart', {
            id,
            x: Position.x[eid], y: Position.y[eid], z: Position.z[eid],
            yaw:       Rotation.yaw[eid],
            range:     CD.SIPHON_LIFE_RANGE,
            halfAngle: CD.SIPHON_LIFE_HALF_ANGLE,
            duration:  CD.SIPHON_LIFE_DURATION / TICK_RATE,
        });
    }

    _tickSiphonLife() {
        for (const [eid, remaining] of this._siphonLifeTimers) {
            if (remaining <= 1) {
                this._interruptSiphonLife(eid);
                continue;
            }
            this._siphonLifeTimers.set(eid, remaining - 1);

            // Apply drain on the tick interval, skip if caster is dead
            if (Health.current[eid] <= 0) continue;
            if ((remaining % CD.SIPHON_LIFE_TICK_INTERVAL) !== 0) continue;

            const yaw  = Rotation.yaw[eid];
            const ox   = Position.x[eid];
            const oy   = Position.y[eid];
            const oz   = Position.z[eid];
            const fx   = -Math.sin(yaw);
            const fz   = -Math.cos(yaw);
            const range2  = CD.SIPHON_LIFE_RANGE ** 2;
            const cosHalf = Math.cos(CD.SIPHON_LIFE_HALF_ANGLE);
            let totalDamage = 0;

            for (const targetEid of this.ecsWorld.getAllPlayerAndBotEntities()) {
                if (targetEid === eid) continue;
                if (Health.current[targetEid] <= 0) continue;
                if (this.isInvulnerable(targetEid)) continue;

                const dx = Position.x[targetEid] - ox;
                const dy = Position.y[targetEid] - oy;
                const dz = Position.z[targetEid] - oz;
                const dist2 = dx*dx + dy*dy + dz*dz;
                if (dist2 > range2) continue;

                const dist = Math.sqrt(dist2);
                if (dist < 0.001) continue;
                const dotXZ = (dx / dist) * fx + (dz / dist) * fz;
                if (dotXZ < cosHalf) continue;

                const preDmg = Health.current[targetEid];
                this.damageSystem.applyDamage(targetEid, eid, CD.SIPHON_LIFE_DAMAGE, {
                    ignoreArmor: true,
                    damageType: DAMAGE_TYPES.ABILITY,
                });
                totalDamage += preDmg - Math.max(0, Health.current[targetEid]);
            }

            // Heal caster proportionally to damage dealt
            if (totalDamage > 0) {
                const heal = totalDamage * CD.SIPHON_LIFE_HEAL_RATIO;
                Health.current[eid] = Math.min(Health.max[eid], Health.current[eid] + heal);
            }

            const id = this.ecsWorld.getEntityId(eid);
            this.io.emit('siphonLifeTick', {
                id,
                x: ox, y: oy, z: oz,
                yaw,
                range:     CD.SIPHON_LIFE_RANGE,
                halfAngle: CD.SIPHON_LIFE_HALF_ANGLE,
            });
        }
    }

    _interruptSiphonLife(eid) {
        if (this._siphonLifeTimers.has(eid)) {
            this._siphonLifeTimers.delete(eid);
            const id = this.ecsWorld.getEntityId(eid);
            this.io.emit('siphonLifeEnd', { id });
        }
    }

    /**
     * Ability 2 – Iron Stand
     * Enter IRON_STAND_DURATION ticks of invulnerability & movement freeze.
     * On expiry, enter IRON_STAND_SHIELD_DURATION ticks where 20% of damage
     * taken is converted to shield (handled via onDamageTaken hook).
     */
    _callasIronStand(eid) {
        AbilityCooldowns.ability2[eid] = CD.IRON_STAND_CD;

        this._ironStandTimers.set(eid, CD.IRON_STAND_DURATION);

        // Zero velocity so the caster stands still instantly
        const bodyKey = this.ecsWorld.getEntityId(eid);
        const body = this.physicsWorld.getBody(bodyKey);
        if (body) body.setLinvel({ x: 0, y: 0, z: 0 }, true);

        const id = this.ecsWorld.getEntityId(eid);
        this.io.emit('ironStandActivated', {
            id,
            x: Position.x[eid], y: Position.y[eid], z: Position.z[eid],
            duration:       CD.IRON_STAND_DURATION       / TICK_RATE,
            shieldDuration: CD.IRON_STAND_SHIELD_DURATION / TICK_RATE,
        });
    }

    _tickIronStand() {
        for (const [eid, remaining] of this._ironStandTimers) {
            if (remaining <= 1) {
                this._ironStandTimers.delete(eid);
                this._ironStandShieldPhase.set(eid, CD.IRON_STAND_SHIELD_DURATION);
                const id = this.ecsWorld.getEntityId(eid);
                this.io.emit('ironStandExpired', {
                    id,
                    shieldDuration: CD.IRON_STAND_SHIELD_DURATION / TICK_RATE,
                });
            } else {
                this._ironStandTimers.set(eid, remaining - 1);
            }
        }
    }


    _tickIronStandShield() {
        for (const [eid, remaining] of this._ironStandShieldPhase) {
            if (remaining <= 1) {
                this._ironStandShieldPhase.delete(eid);
                const id = this.ecsWorld.getEntityId(eid);
                this.io.emit('ironStandShieldExpired', { id });
            } else {
                this._ironStandShieldPhase.set(eid, remaining - 1);
            }
        }
    }

    /**
     * Ultimate – Shadow Realm Banish
     * Banish the nearest enemy within SHADOW_REALM_RANGE to the Shadow Realm.
     * Target is invulnerable and frozen. On return, deals SHADOW_REALM_RETURN_DAMAGE.
     * Cooldown is NOT consumed if no valid target is in range.
     */
    _callasShadowRealmBanish(eid) {
        const range2 = CD.SHADOW_REALM_RANGE ** 2;

        let bestEid   = null;
        let bestDist2 = Infinity;

        for (const targetEid of this.ecsWorld.getAllPlayerAndBotEntities()) {
            if (targetEid === eid) continue;
            if (Health.current[targetEid] <= 0) continue;
            if (this._shadowRealmTargets.has(targetEid)) continue;
            if (this.damageSystem.isFriendlyFireBlocked(targetEid, eid)) continue;
            if (this.isInvulnerable(targetEid)) continue;

            const dx = Position.x[targetEid] - Position.x[eid];
            const dy = Position.y[targetEid] - Position.y[eid];
            const dz = Position.z[targetEid] - Position.z[eid];
            const dist2 = dx*dx + dy*dy + dz*dz;
            if (dist2 <= range2 && dist2 < bestDist2) {
                bestDist2 = dist2;
                bestEid   = targetEid;
            }
        }

        if (bestEid === null) return; // no valid target – cooldown NOT consumed

        AbilityCooldowns.ultimate[eid]        = CD.SHADOW_REALM_CD;
        AbilityCooldowns.ultimateActive[eid]  = 1;
        AbilityCooldowns.ultimateTimer[eid]   = CD.SHADOW_REALM_DURATION + 30;

        this._shadowRealmTargets.set(bestEid, { casterEid: eid, remaining: CD.SHADOW_REALM_DURATION });

        // Zero target velocity
        const targetBodyKey = this.ecsWorld.getEntityId(bestEid);
        const targetBody    = this.physicsWorld.getBody(targetBodyKey);
        if (targetBody) targetBody.setLinvel({ x: 0, y: 0, z: 0 }, true);

        this.interruptAbilities(bestEid);

        const casterId = this.ecsWorld.getEntityId(eid);
        const targetId = this.ecsWorld.getEntityId(bestEid);
        this.io.emit('shadowRealmBanish', {
            casterId,
            targetId,
            duration: CD.SHADOW_REALM_DURATION / TICK_RATE,
            x: Position.x[bestEid],
            y: Position.y[bestEid],
            z: Position.z[bestEid],
        });
    }

    _tickShadowRealm() {
        for (const [targetEid, state] of this._shadowRealmTargets) {
            state.remaining--;
            if (state.remaining <= 0) {
                this._shadowRealmTargets.delete(targetEid);

                if (Health.current[targetEid] > 0) {
                    this.damageSystem.applyDamage(
                        targetEid,
                        state.casterEid,
                        CD.SHADOW_REALM_RETURN_DAMAGE,
                        { ignoreArmor: true, damageType: DAMAGE_TYPES.ABILITY }
                    );
                }

                const targetId = this.ecsWorld.getEntityId(targetEid);
                const casterId = this.ecsWorld.getEntityId(state.casterEid);
                this.io.emit('shadowRealmReturn', {
                    targetId,
                    casterId,
                    damage: CD.SHADOW_REALM_RETURN_DAMAGE,
                    x: Position.x[targetEid],
                    y: Position.y[targetEid],
                    z: Position.z[targetEid],
                });
            }
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Selene abilities
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Ability 1 – Crystal Smash
     * Dash forward at CRYSTAL_SMASH_DASH_SPEED for CRYSTAL_SMASH_DASH_DURATION
     * ticks.  On the first enemy hit: deal damage + apply a stun.  If the hit
     * kills the target, drop a transient crystal shard (+20 HP pickup).
     */
    _seleneCrystalSmash(eid) {
        AbilityCooldowns.ability1[eid] = CD.CRYSTAL_SMASH_CD;

        const yaw    = Rotation.yaw[eid];
        const bodyId = this.ecsWorld.getEntityId(eid);
        const body   = this.physicsWorld.getBody(bodyId);
        if (body) {
            const vx = -Math.sin(yaw) * CD.CRYSTAL_SMASH_DASH_SPEED;
            const vz = -Math.cos(yaw) * CD.CRYSTAL_SMASH_DASH_SPEED;
            body.setLinvel({ x: vx, y: body.linvel().y, z: vz }, true);
        }

        this._crystalSmashDashes.set(eid, { remaining: CD.CRYSTAL_SMASH_DASH_DURATION, hit: false });

        const id = this.ecsWorld.getEntityId(eid);
        this.io.emit('crystalSmashStart', {
            id,
            x: Position.x[eid], y: Position.y[eid], z: Position.z[eid],
            yaw,
            duration: CD.CRYSTAL_SMASH_DASH_DURATION / TICK_RATE,
        });
    }

    _tickCrystalSmashDashes() {
        for (const [eid, state] of this._crystalSmashDashes) {
            if (state.remaining <= 0 || state.hit) {
                this._crystalSmashDashes.delete(eid);
                continue;
            }
            state.remaining--;

            if (Health.current[eid] <= 0) { this._crystalSmashDashes.delete(eid); continue; }

            // Check for collision with any living enemy
            for (const targetEid of this.ecsWorld.getAllPlayerAndBotEntities()) {
                if (targetEid === eid) continue;
                if (Health.current[targetEid] <= 0) continue;
                if (this.isInvulnerable(targetEid)) continue;
                if (this.damageSystem.isFriendlyFireBlocked(targetEid, eid)) continue;

                if (!this.damageSystem.collisionSystem.sphereCollisionCheckCoord(Position.x[eid], Position.y[eid], Position.z[eid], Position.x[targetEid], Position.y[targetEid], Position.z[targetEid], CD.CRYSTAL_SMASH_HIT_RADIUS)) {
                    continue;
                }

                state.hit = true;

                // Stop the dash velocity
                const bodyId = this.ecsWorld.getEntityId(eid);
                const v = this.physicsWorld.getLinearVelocity(bodyId);
                this.physicsWorld.setLinearVelocity(bodyId, 0, v.y, 0);

                // Apply stun first, then damage
                this._stunTimers.set(targetEid, CD.CRYSTAL_SMASH_STUN_DURATION);
                this.damageSystem.applyDamage(targetEid, eid, CD.CRYSTAL_SMASH_DAMAGE, {
                    ignoreArmor: true,
                    damageType: DAMAGE_TYPES.ABILITY,
                });

                const killed = Health.current[targetEid] <= 0;

                const id = this.ecsWorld.getEntityId(eid);
                this.io.emit('crystalSmashHit', {
                    id,
                    targetId:    this.ecsWorld.getEntityId(targetEid),
                    stunDuration: CD.CRYSTAL_SMASH_STUN_DURATION / TICK_RATE,
                    droppedShard: killed,
                    x: Position.x[targetEid],
                    y: Position.y[targetEid],
                    z: Position.z[targetEid],
                });

                // Drop a crystal shard if the smash was the kill shot
                if (killed) {
                    const sx = Position.x[targetEid];
                    const sy = Position.y[targetEid];
                    const sz = Position.z[targetEid];
                    const shardEid = this.ecsWorld.createPickupEntity(
                        PICKUP_TYPES.CRYSTAL_SHARD, sx, sy, sz
                    );
                    this._crystalShards.set(shardEid, CD.CRYSTAL_SHARD_DESPAWN_TICKS);
                    this.io.emit('crystalShardDropped', {
                        pickupId: shardEid,
                        x: sx, y: sy, z: sz,
                        duration: CD.CRYSTAL_SHARD_DESPAWN_TICKS / TICK_RATE,
                    });
                }
                break;
            }
        }
    }

    _tickCrystalShards() {
        for (const [shardEid, remaining] of this._crystalShards) {
            // If PickupSystem already collected it (active flag cleared), remove immediately
            if (Pickup.active[shardEid] === 0) {
                this._crystalShards.delete(shardEid);
                this.ecsWorld.removePickupEntity(shardEid);
                continue;
            }

            if (remaining <= 0) {
                this._crystalShards.delete(shardEid);
                this.ecsWorld.removePickupEntity(shardEid);
                this.io.emit('crystalShardExpired', { pickupId: shardEid });
            } else {
                this._crystalShards.set(shardEid, remaining - 1);
            }
        }
    }

    _tickStuns() {
        for (const [eid, remaining] of this._stunTimers) {
            if (remaining <= 1) {
                this._stunTimers.delete(eid);
            } else {
                this._stunTimers.set(eid, remaining - 1);
            }
        }
    }

    _tickSilences() {
        for (const [eid, remaining] of this._silenceTimers) {
            if (remaining <= 1) {
                this._silenceTimers.delete(eid);
                this.io.emit('silenceExpired', { id: this.ecsWorld.getEntityId(eid) });
            } else {
                this._silenceTimers.set(eid, remaining - 1);
            }
        }
    }

    /**
     * Ability 2 – Astral Elevation
     * Launch skyward.  For the first ASTRAL_ELEVATION_INVULN_DURATION ticks:
     * invulnerable.  For ASTRAL_ELEVATION_FLIGHT_DURATION ticks total: flight
     * (slow fall, speed boost).  On expiry, grant weapon-damage bonus for
     * ASTRAL_ELEVATION_WEAPON_BONUS_DURATION ticks.
     */
    _seleneAstralElevation(eid) {
        // Can't double-stack
        if (this._astralFlightTimers.has(eid)) return;

        AbilityCooldowns.ability2[eid] = CD.ASTRAL_ELEVATION_CD;

        const bodyId = this.ecsWorld.getEntityId(eid);
        const v = this.physicsWorld.getLinearVelocity(bodyId);

        this.physicsWorld.setLinearVelocity(bodyId, v.x, CD.ASTRAL_ELEVATION_LAUNCH_SPEED, v.z);

        this._astralFlightTimers.set(eid, {
            remaining:     CD.ASTRAL_ELEVATION_FLIGHT_DURATION,
            invulnRemaining: CD.ASTRAL_ELEVATION_INVULN_DURATION,
        });

        this.addTimedModifier(
            eid,
            'moveSpeed',
            CD.ASTRAL_ELEVATION_SPEED_MULT,
            CD.ASTRAL_ELEVATION_FLIGHT_DURATION,
            'astralFlightSpeed'
        );

        const id = this.ecsWorld.getEntityId(eid);
        this.io.emit('astralElevationStart', {
            id,
            x: Position.x[eid], y: Position.y[eid], z: Position.z[eid],
            invulnDuration:    CD.ASTRAL_ELEVATION_INVULN_DURATION    / TICK_RATE,
            flightDuration:    CD.ASTRAL_ELEVATION_FLIGHT_DURATION    / TICK_RATE,
            bonusDuration:     CD.ASTRAL_ELEVATION_WEAPON_BONUS_DURATION / TICK_RATE,
        });
    }

    _tickAstralFlight() {
        for (const [eid, state] of this._astralFlightTimers) {
            if (state.invulnRemaining > 0) state.invulnRemaining--;

            if (state.remaining <= 0) {
                this._astralFlightTimers.delete(eid);

                // Grant post-landing weapon bonus
                this.addTimedModifier(
                    eid,
                    'weaponDamage',
                    CD.ASTRAL_ELEVATION_WEAPON_BONUS_MULT,
                    CD.ASTRAL_ELEVATION_WEAPON_BONUS_DURATION,
                    'astralWeaponBonus'
                );

                const id = this.ecsWorld.getEntityId(eid);
                this.io.emit('astralElevationEnd', {
                    id,
                    weaponBonusDuration: CD.ASTRAL_ELEVATION_WEAPON_BONUS_DURATION / TICK_RATE,
                    bonusMult:           CD.ASTRAL_ELEVATION_WEAPON_BONUS_MULT,
                });
                continue;
            }
            state.remaining--;

            // Slow-fall: cap downward speed during flight so Selene floats
            const bodyId = this.ecsWorld.getEntityId(eid);
            const v = this.physicsWorld.getLinearVelocity(bodyId);
            if (v) {
                if (v.y < -1.0) {
                    this.physicsWorld.setLinearVelocity(bodyId, v.x, Math.max(v.y, 0), v.z);
                }
            }
        }
    }

    _tickAstralWeaponBonus() {
        // Deprecated in favor of _tickStatModifiers()
    }

    /**
     * Ultimate – Lunar Eclipse
     * Launch skyward, become invulnerable during LUNAR_ECLIPSE_CHARGE_DURATION
     * ticks, then fire a massive AOE blast that damages + silences all enemies
     * within LUNAR_ECLIPSE_RADIUS.
     */
    _seleneLunarEclipse(eid) {
        AbilityCooldowns.ultimate[eid]        = CD.LUNAR_ECLIPSE_CD;
        AbilityCooldowns.ultimateActive[eid]  = 1;
        AbilityCooldowns.ultimateTimer[eid]   = CD.LUNAR_ECLIPSE_CHARGE_DURATION + 30;

        const bodyId = this.ecsWorld.getEntityId(eid);
        const body   = this.physicsWorld.getBody(bodyId);
        const astralTimer = this._astralFlightTimers.get(eid);
        if (body && !astralTimer) {
            body.setLinvel({ x: 0, y: CD.LUNAR_ECLIPSE_LAUNCH_SPEED, z: 0 }, true);
        }

        this._lunarEclipseTimers.set(eid, CD.LUNAR_ECLIPSE_CHARGE_DURATION);
        this._lunarEclipsePulses.set(eid, CD.LUNAR_ECLIPSE_PULSES);

        const id = this.ecsWorld.getEntityId(eid);
        this.io.emit('lunarEclipseCharge', {
            id,
            x: Position.x[eid], y: Position.y[eid], z: Position.z[eid],
            chargeDuration: CD.LUNAR_ECLIPSE_CHARGE_DURATION / TICK_RATE,
            radius:         CD.LUNAR_ECLIPSE_RADIUS,
        });
    }

    _tickLunarEclipse() {
        for (const [eid, remaining] of this._lunarEclipseTimers) {
            // Slow-fall during charge so Selene hangs in the air briefly
            const bodyId = this.ecsWorld.getEntityId(eid);
            const pulseCount = this._lunarEclipsePulses.get(eid) || 0;
            const v = this.physicsWorld.getLinearVelocity(bodyId);
            if (v) {
                if (v.y < 0) {
                    this.physicsWorld.setLinearVelocity(bodyId, v.x, Math.max(v.y, 0), v.z);
                }
            }

            if (remaining <= 0) {
                if (pulseCount > 0 && Health.current[eid] > 0) {
                    this._firelunarEclipseBlast(eid);
                    this._lunarEclipsePulses.set(eid, pulseCount - 1);
                    this._lunarEclipseTimers.set(eid, CD.LUNAR_ECLIPSE_PULSE_INTERVAL);
                }else {
                    this._interruptLunarEclipse(eid);
                }
                continue;
            }
            this._lunarEclipseTimers.set(eid, remaining - 1);
        }
    }

    _interruptLunarEclipse(eid) {
        if (this._lunarEclipseTimers.has(eid)) {
            this._lunarEclipseTimers.delete(eid);
            this._lunarEclipsePulses.delete(eid);
            AbilityCooldowns.ultimateActive[eid] = 0;
        }
    }

    _firelunarEclipseBlast(eid) {
        const cx = Position.x[eid];
        const cy = Position.y[eid];
        const cz = Position.z[eid];
        const r2 = CD.LUNAR_ECLIPSE_RADIUS ** 2;
        const hitTargetIds = [];

        

        for (const targetEid of this.ecsWorld.getAllPlayerAndBotEntities()) {
            if (targetEid === eid) continue;
            if (Health.current[targetEid] <= 0) continue;
            if (this.isInvulnerable(targetEid)) continue;
            if (this.damageSystem.isFriendlyFireBlocked(targetEid, eid)) continue;

            const dx = Position.x[targetEid] - cx;
            const dy = Position.y[targetEid] - cy;
            const dz = Position.z[targetEid] - cz;

            // Cylinder check: horizontal distance (XZ plane) within radius
            const horizDist2 = dx*dx + dz*dz;
            if (horizDist2 > r2) continue;
            // Also require target to be within a reasonable vertical band
            if (Math.abs(dy) > CD.LUNAR_ECLIPSE_RADIUS + 16) continue;

            this.damageSystem.applyDamage(targetEid, eid, CD.LUNAR_ECLIPSE_DAMAGE, {
                ignoreArmor: true,
                damageType: DAMAGE_TYPES.ABILITY,
            });
            this._silenceTimers.set(targetEid, CD.LUNAR_ECLIPSE_SILENCE_DURATION);
            hitTargetIds.push(this.ecsWorld.getEntityId(targetEid));
        }

        const id = this.ecsWorld.getEntityId(eid);
        this.io.emit('lunarEclipseBlast', {
            id,
            x: cx, y: cy, z: cz,
            radius:          CD.LUNAR_ECLIPSE_RADIUS,
            damage:          CD.LUNAR_ECLIPSE_DAMAGE,
            silenceDuration: CD.LUNAR_ECLIPSE_SILENCE_DURATION / TICK_RATE,
            hitTargetIds,
        });
    }

    // ───────────────────────────────────────────────────────────────────────────    // Shared helpers
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Apply area damage to all living entities within `radius` of (cx, cy, cz),
     * excluding the caster.
     */
    _applyAOE(casterEid, cx, cy, cz, radius, damage, options = {}) {
        const { ignoreArmor = true, damageType = DAMAGE_TYPES.ABILITY } = options;
        const r2 = radius * radius;
        for (const targetEid of this.ecsWorld.getAllPlayerAndBotEntities()) {
            if (targetEid === casterEid) continue;
            if (Health.current[targetEid] <= 0) continue;

            if (!this.damageSystem.collisionSystem.sphereCollisionCheckCoord(cx, cy, cz, Position.x[targetEid], Position.y[targetEid], Position.z[targetEid], radius)) {
                continue;
            }

            this.damageSystem.applyDamage(targetEid, casterEid, damage, { ignoreArmor, damageType });
        }
    }

    _tickStatModifiers() {
        for (const bucket of Object.values(this._statModifiers)) {
            for (const [eid, entries] of bucket) {
                for (let i = entries.length - 1; i >= 0; i--) {
                    const entry = entries[i];
                    if (entry.remaining <= 1) {
                        entries.splice(i, 1);
                        this._emitModifierExpired(eid, entry);
                    } else {
                        entry.remaining -= 1;
                    }
                }
                if (entries.length === 0) bucket.delete(eid);
            }
        }
    }

    _getModifierList(statKey, eid) {
        const bucket = this._statModifiers[statKey];
        if (!bucket) return null;
        return bucket.get(eid) || null;
    }

    _getModifierMultiplier(statKey, eid) {
        const list = this._getModifierList(statKey, eid);
        if (!list || list.length === 0) return 1.0;
        let mult = 1.0;
        for (const entry of list) {
            if (entry.mult > 0) mult *= entry.mult;
        }
        return mult;
    }

    _hasModifierSource(statKey, eid, source) {
        const list = this._getModifierList(statKey, eid);
        if (!list) return false;
        return list.some((entry) => entry.source === source);
    }

    addTimedModifier(eid, statKey, mult, durationTicks, source, options = {}) {
        const bucket = this._statModifiers[statKey];
        if (!bucket) return false;
        const duration = Math.max(0, Math.floor(durationTicks));
        if (duration <= 0) return false;

        const key = source || statKey;
        const list = bucket.get(eid) || [];
        const existing = list.find((entry) => entry.source === key);

        if (existing) {
            existing.mult = mult;
            if (options.refreshMode === 'max') {
                existing.remaining = Math.max(existing.remaining, duration);
            } else {
                existing.remaining = duration;
            }
            bucket.set(eid, list);
            return true;
        }

        list.push({ mult, remaining: duration, source: key });
        bucket.set(eid, list);
        return false;
    }

    clearAllModifiers(eid) {
        for (const bucket of Object.values(this._statModifiers)) {
            const entries = bucket.get(eid);
            if (!entries) continue;
            for (const entry of entries) {
                this._emitModifierExpired(eid, entry);
            }
            bucket.delete(eid);
        }
    }

    _emitModifierExpired(eid, entry) {
        const id = this.ecsWorld.getEntityId(eid);
        if (entry.source === 'quadDamage') {
            this.io.emit('quadDamageEnded', { id });
        }
        if (entry.source === 'astralWeaponBonus') {
            this.io.emit('astralWeaponBonusExpired', { id });
        }
    }

    activateQuadDamage(eid, durationTicks, mult) {
        const refreshed = this.addTimedModifier(
            eid,
            'weaponDamage',
            mult,
            durationTicks,
            'quadDamage'
        );
        const id = this.ecsWorld.getEntityId(eid);
        this.io.emit('quadDamageStarted', {
            id,
            duration: durationTicks / TICK_RATE,
            multiplier: mult,
            refreshed,
        });
    }

    getOutgoingDamageMultiplier(eid, damageType) {
        if (damageType === DAMAGE_TYPES.WEAPON) {
            return this._getModifierMultiplier('weaponDamage', eid);
        }
        if (damageType === DAMAGE_TYPES.ABILITY) {
            return this._getModifierMultiplier('abilityDamage', eid);
        }
        return 1.0;
    }

    getIncomingDamageMultiplier(eid, damageType) {
        if (damageType === DAMAGE_TYPES.WEAPON) {
            return this._getModifierMultiplier('weaponResist', eid);
        }
        if (damageType === DAMAGE_TYPES.ABILITY) {
            return this._getModifierMultiplier('abilityResist', eid);
        }
        return 1.0;
    }

    getFireCooldownMultiplier(eid) {
        return this._getModifierMultiplier('fireCooldown', eid);
    }

    /**
     * Returns true if a slow modifier is active on the entity.
     * @param {number} eid
     */
    isSlowed(eid) {
        return this._hasModifierSource('moveSpeed', eid, 'slow');
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Fat Jerome abilities
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Ability 1 – Shoulder Charge
     * Charge forward for SHOULDER_CHARGE_DURATION ticks, damaging and knocking
     * back all enemies hit. Can steer left/right during the charge.
     */
    _fatJeromeShoulderCharge(eid) {
        AbilityCooldowns.ability1[eid] = CD.SHOULDER_CHARGE_CD;

        const yaw    = Rotation.yaw[eid];
        const bodyId = this.ecsWorld.getEntityId(eid);
        const body   = this.physicsWorld.getBody(bodyId);
        Dash.isDashing[eid] = 0;
        const v = this.physicsWorld.getLinearVelocity(bodyId);
        const vx = -Math.sin(yaw) * CD.SHOULDER_CHARGE_SPEED;
        const vz = -Math.cos(yaw) * CD.SHOULDER_CHARGE_SPEED;;
        this.physicsWorld.setLinearVelocity(bodyId, vx, v.y, vz);

        this._shoulderCharges.set(eid, { 
            remaining: CD.SHOULDER_CHARGE_DURATION, 
            hitTargets: new Set() 
        });

        const id = this.ecsWorld.getEntityId(eid);
        this.io.emit('shoulderChargeStart', {
            id,
            x: Position.x[eid], y: Position.y[eid], z: Position.z[eid],
            yaw,
            duration: CD.SHOULDER_CHARGE_DURATION / TICK_RATE,
        });
    }

    _tickShoulderCharges() {
        for (const [eid, state] of this._shoulderCharges) {
            if (state.remaining <= 0 || Health.current[eid] <= 0) {
                this._shoulderCharges.delete(eid);
                // Reset velocity
                const bodyId = this.ecsWorld.getEntityId(eid);
                const body   = this.physicsWorld.getBody(bodyId);
                const v = this.physicsWorld.getLinearVelocity(bodyId);
                this.physicsWorld.setLinearVelocity(bodyId, 0, v.y, 0);
                
                // Notify client that charge ended
                const id = this.ecsWorld.getEntityId(eid);
                this.io.emit('shoulderChargeEnd', {
                    id,
                });
                continue;
            }
            state.remaining--;
            Controller.forward[eid] = 1;

            // Allow steering during charge
            const bodyId = this.ecsWorld.getEntityId(eid);
            if (Controller.left[eid] !== Controller.right[eid]) {
                const steerDelta = (Controller.right[eid] ? 1 : -1) * 
                                   CD.SHOULDER_CHARGE_STEER_RATE / TICK_RATE;
                Rotation.yaw[eid] += steerDelta;
                
                // Update velocity to match new direction
                const yaw = Rotation.yaw[eid];
                const vx = -Math.sin(yaw) * CD.SHOULDER_CHARGE_SPEED;
                const vz = -Math.cos(yaw) * CD.SHOULDER_CHARGE_SPEED;
                const v = this.physicsWorld.getLinearVelocity(bodyId);
                this.physicsWorld.setLinearVelocity(bodyId, vx, v.y, vz);
            }

            // Check for collisions with enemies
            const cx = Position.x[eid];
            const cy = Position.y[eid];
            const cz = Position.z[eid];

            for (const targetEid of this.ecsWorld.getAllPlayerAndBotEntities()) {
                if (targetEid === eid) continue;
                if (Health.current[targetEid] <= 0) continue;
                if (this.isInvulnerable(targetEid)) continue;
                if (this.damageSystem.isFriendlyFireBlocked(targetEid, eid)) continue;
                if (state.hitTargets.has(targetEid)){
                    const victimBodyId = this.ecsWorld.getEntityId(targetEid);
                    const casterBodyId = this.ecsWorld.getEntityId(eid);
                    const victimBody = this.physicsWorld.getBody(victimBodyId);
                    const casterBody = this.physicsWorld.getBody(casterBodyId);

                    this._stunTimers.set(targetEid, CD.SHOULDER_CHARGE_STUN_DURATION);

                    if (victimBody && casterBody) {
                        victimBody.setTranslation({ x: casterBody.translation().x, y: casterBody.translation().y+3, z: casterBody.translation().z }, true);
                        Position.x[targetEid] = Position.x[eid];
                        Position.y[targetEid] = Position.y[eid];
                        Position.z[targetEid] = Position.z[eid];
                    }
                    continue;
                }

                const dx = Position.x[targetEid] - cx;
                const dy = Position.y[targetEid] - cy;
                const dz = Position.z[targetEid] - cz;
                const dist = dx*dx + dy*dy + dz*dz;

                if (dist > CD.SHOULDER_CHARGE_HIT_RADIUS * CD.SHOULDER_CHARGE_HIT_RADIUS) continue;

                state.hitTargets.add(targetEid);

                // Apply damage
                this.damageSystem.applyDamage(targetEid, eid, CD.SHOULDER_CHARGE_DAMAGE, {
                    ignoreArmor: false,
                    damageType: DAMAGE_TYPES.ABILITY,
                });

                // Apply knockback
                const targetBodyId = this.ecsWorld.getEntityId(targetEid);
                const targetBody   = this.physicsWorld.getBody(targetBodyId);
                if (targetBody) {
                    const knockbackDir = dist > 0.1 ? { x: dx/dist, y: 0.3, z: dz/dist } : 
                                                       { x: -Math.sin(Rotation.yaw[eid]), y: 0.3, z: -Math.cos(Rotation.yaw[eid]) };
                    const v = this.physicsWorld.getLinearVelocity(targetBodyId);
                    this.physicsWorld.setLinearVelocity(targetBodyId, v.x + knockbackDir.x * CD.SHOULDER_CHARGE_KNOCKBACK, v.y + knockbackDir.y * CD.SHOULDER_CHARGE_KNOCKBACK, v.z + knockbackDir.z * CD.SHOULDER_CHARGE_KNOCKBACK, true);
                }

                const id = this.ecsWorld.getEntityId(eid);
                this.io.emit('shoulderChargeHit', {
                    id,
                    targetId: this.ecsWorld.getEntityId(targetEid),
                    x: Position.x[targetEid],
                    y: Position.y[targetEid],
                    z: Position.z[targetEid],
                });
            }
        }
    }

    /**
     * Ability 2 – Butt Smash
     * Two phases: charging (windup), then jump + slam down.
     */
    _fatJeromeButtSmash(eid) {
        AbilityCooldowns.ability2[eid] = CD.BUTT_SMASH_CD;

        this._buttSmashes.set(eid, { 
            phase: 0,
            remaining: CD.BUTT_SMASH_CHARGE_DURATION
        });

        const id = this.ecsWorld.getEntityId(eid);
        this.io.emit('buttSmashCharging', {
            id,
            duration: CD.BUTT_SMASH_CHARGE_DURATION / TICK_RATE,
        });
    }

    _tickButtSmashes() {
        for (const [eid, state] of this._buttSmashes) {
            if (Health.current[eid] <= 0) {
                this._buttSmashes.delete(eid);
                continue;
            }
            state.phase = typeof state.phase === 'number' ? state.phase + 1 : state.phase;
            if (state.phase <= CD.BUTT_SMASH_CHARGE_DURATION) {
                state.remaining--;
                if (state.remaining <= 0) {
                    // Launch into air
                    const bodyId = this.ecsWorld.getEntityId(eid);
                    this.physicsWorld.setVerticalVelocity(bodyId, CD.BUTT_SMASH_JUMP_SPEED);

                    const id = this.ecsWorld.getEntityId(eid);
                    this.io.emit('buttSmashLaunch', {
                        id,
                        x: Position.x[eid],
                        y: Position.y[eid],
                        z: Position.z[eid],
                    });
                }
            } else {
                // Check if grounded
                const bodyId = this.ecsWorld.getEntityId(eid);
                const isGrounded = this.physicsWorld.checkGroundDetection(bodyId);
                const body   = this.physicsWorld.getBody(bodyId);
                if (state.phase >= CD.BUTT_SMASH_DROP_PHASE_TICK) {
                    const v = this.physicsWorld.getLinearVelocity(bodyId);
                    if (v.y > 0) {
                        this.physicsWorld.setLinearVelocity(bodyId, v.x, 0, v.z);
                    }
                    this.physicsWorld.setLinearVelocity(bodyId, v.x, v.y - CD.BUTT_SMASH_FALL_SPEED, v.z);
                }
                
                if (isGrounded) {
                    this._buttSmashes.delete(eid);

                    // Apply AOE damage
                    const cx = Position.x[eid];
                    const cy = Position.y[eid];
                    const cz = Position.z[eid];

                    const hitTargets = [];
                    for (const targetEid of this.ecsWorld.getAllPlayerAndBotEntities()) {
                        if (targetEid === eid) continue;
                        if (Health.current[targetEid] <= 0) continue;
                        if (this.isInvulnerable(targetEid)) continue;
                        if (this.damageSystem.isFriendlyFireBlocked(targetEid, eid)) continue;

                        const dx = Position.x[targetEid] - cx;
                        const dy = Position.y[targetEid] - cy;
                        const dz = Position.z[targetEid] - cz;
                        const horizDist = Math.sqrt(dx*dx + dz*dz);

                        let damage = 0;
                        let stunned = false;

                        if (horizDist <= CD.BUTT_SMASH_RADIUS_INNER && Math.abs(dy) < 4.0) {
                            damage = CD.BUTT_SMASH_DAMAGE_INNER;
                            stunned = true;
                            this._stunTimers.set(targetEid, CD.BUTT_SMASH_STUN_DURATION);
                        } else if (horizDist <= CD.BUTT_SMASH_RADIUS_OUTER && Math.abs(dy) < 4.0) {
                            damage = CD.BUTT_SMASH_DAMAGE_OUTER;
                        }

                        if (damage > 0) {
                            this.damageSystem.applyDamage(targetEid, eid, damage, {
                                ignoreArmor: false,
                                damageType: DAMAGE_TYPES.ABILITY,
                            });
                            hitTargets.push({
                                id: this.ecsWorld.getEntityId(targetEid),
                                stunned,
                            });
                        }
                    }

                    const id = this.ecsWorld.getEntityId(eid);
                    this.io.emit('buttSmashImpact', {
                        id,
                        x: cx, y: cy, z: cz,
                        targets: hitTargets,
                    });
                }
            }
        }
    }

    /**
     * Ultimate – Fatal Flatulence
     * Emit fart clouds every second for 10 seconds that damage and slow enemies.
     */
    _fatJeromeFatalFlatulence(eid) {
        AbilityCooldowns.ultimate[eid]   = CD.FATAL_FLATULENCE_CD;
        AbilityCooldowns.ultimateActive[eid] = 1;
        AbilityCooldowns.ultimateTimer[eid]  = CD.FATAL_FLATULENCE_DURATION;

        this._fatalFlatulenceTimers.set(eid, { 
            remaining: CD.FATAL_FLATULENCE_DURATION, 
            nextFart: 0 
        });

        const id = this.ecsWorld.getEntityId(eid);
        this.io.emit('fatalFlatulenceStart', {
            id,
            x: Position.x[eid],
            y: Position.y[eid],
            z: Position.z[eid],
            duration: CD.FATAL_FLATULENCE_DURATION / TICK_RATE,
        });
    }

    _tickFatalFlatulence() {
        for (const [eid, state] of this._fatalFlatulenceTimers) {
            if (state.remaining <= 0 || Health.current[eid] <= 0) {
                this._fatalFlatulenceTimers.delete(eid);
                continue;
            }

            state.remaining--;
            state.nextFart--;

            if (state.nextFart <= 0) {
                state.nextFart = CD.FATAL_FLATULENCE_FART_INTERVAL;

                // Spawn a fart cloud at Jerome's position
                this._fartClouds.push({
                    ownerEid: eid,
                    x: Position.x[eid],
                    y: Position.y[eid],
                    z: Position.z[eid],
                    remaining: CD.FATAL_FLATULENCE_FART_INTERVAL * 5, // Cloud lasts ~5 seconds
                });

                const id = this.ecsWorld.getEntityId(eid);
                this.io.emit('fartCloudSpawned', {
                    id,
                    x: Position.x[eid],
                    y: Position.y[eid],
                    z: Position.z[eid],
                });
            }
        }
    }

    _tickFartClouds() {
        for (let i = this._fartClouds.length - 1; i >= 0; i--) {
            const cloud = this._fartClouds[i];
            cloud.remaining--;

            if (cloud.remaining <= 0) {
                this._fartClouds.splice(i, 1);
                continue;
            }

            // Apply damage and slow every FATAL_FLATULENCE_TICK_INTERVAL ticks
            if (cloud.remaining % CD.FATAL_FLATULENCE_TICK_INTERVAL === 0) {
                for (const targetEid of this.ecsWorld.getAllPlayerAndBotEntities()) {
                    if (targetEid === cloud.ownerEid) continue;
                    if (Health.current[targetEid] <= 0) continue;
                    if (this.damageSystem.isFriendlyFireBlocked(targetEid, cloud.ownerEid)) continue;

                    const dx = Position.x[targetEid] - cloud.x;
                    const dy = Position.y[targetEid] - cloud.y;
                    const dz = Position.z[targetEid] - cloud.z;
                    const dist = dx*dx + dy*dy + dz*dz;

                    if(dist > CD.FATAL_FLATULENCE_RADIUS * CD.FATAL_FLATULENCE_RADIUS) continue;

                    // Non-lethal damage (can't reduce below 1 HP)
                    const currentHealth = Health.current[targetEid];
                    if (currentHealth > 1) {
                        const damage = Math.min(CD.FATAL_FLATULENCE_DAMAGE, currentHealth - 1);
                        this.damageSystem.applyDamage(targetEid, cloud.ownerEid, damage, {
                            ignoreArmor: false,
                            damageType: DAMAGE_TYPES.ABILITY,
                        });
                    }

                    // Apply slow
                    const slowDuration = CD.FATAL_FLATULENCE_TICK_INTERVAL * 2;
                    this.addTimedModifier(
                        targetEid,
                        'moveSpeed',
                        CD.SHOCK_GRENADE_SLOW_FACTOR,
                        slowDuration,
                        'slow',
                        { refreshMode: 'max' }
                    );
            
                }
            }
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Kyoukan abilities
    // ─────────────────────────────────────────────────────────────────────────

    _kyoukanArrowOfGratitude(eid) {
        const selfCast = this._selfCastingEnabled.get(eid) === true;
        let targetEid = eid;

        if (!selfCast) {
            targetEid = this._findClosestAlliedTargetInCone(eid, CD.ARROW_OF_GRATITUDE_RANGE, CD.ARROW_OF_GRATITUDE_HALF_ANGLE);
            if (targetEid === null) return;
        }

        AbilityCooldowns.ability1[eid] = CD.ARROW_OF_GRATITUDE_CD;
        const healAmount = Health.max[targetEid] * CD.ARROW_OF_GRATITUDE_HEAL_FRAC;
        Health.current[targetEid] = Math.min(Health.max[targetEid], Health.current[targetEid] + healAmount);

        this.io.emit('arrowOfGratitudeCast', {
            casterId: this.ecsWorld.getEntityId(eid),
            targetId: this.ecsWorld.getEntityId(targetEid),
            selfCast,
            healAmount,
            x: Position.x[targetEid],
            y: Position.y[targetEid],
            z: Position.z[targetEid],
        });
    }

    _kyoukanMajesticLeap(eid) {
        if (this._majesticLeaps.has(eid)) return;

        AbilityCooldowns.ability2[eid] = CD.MAJESTIC_LEAP_CD;

        const yaw = Rotation.yaw[eid];
        const pitch = Rotation.pitch[eid];
        const bodyId = this.ecsWorld.getEntityId(eid);
        const pitchFactor = Math.max(0.2, Math.cos(pitch));
        const vx = -Math.sin(yaw) * CD.MAJESTIC_LEAP_SPEED * pitchFactor;
        const vz = -Math.cos(yaw) * CD.MAJESTIC_LEAP_SPEED * pitchFactor;
        const vy = CD.MAJESTIC_LEAP_UPWARD_SPEED + Math.max(0, Math.sin(pitch)) * 8;
        Dash.isDashing[eid] = 0;
        this.physicsWorld.setLinearVelocity(bodyId, vx, vy, vz);

        this._majesticLeaps.set(eid, { remaining: CD.MAJESTIC_LEAP_DURATION });

        this.io.emit('majesticLeapStart', {
            id: this.ecsWorld.getEntityId(eid),
            x: Position.x[eid],
            y: Position.y[eid],
            z: Position.z[eid],
            duration: CD.MAJESTIC_LEAP_DURATION / TICK_RATE,
        });
    }

    _tickMajesticLeaps() {
        for (const [eid, state] of this._majesticLeaps) {
            if (Health.current[eid] <= 0) {
                this._majesticLeaps.delete(eid);
                continue;
            }

            state.remaining--;
            const bodyId = this.ecsWorld.getEntityId(eid);
            const v = this.physicsWorld.getLinearVelocity(bodyId);
            const grounded = this.physicsWorld.checkGroundDetection(bodyId);
            const shouldEnd = state.remaining <= 0 || (grounded && v && v.y <= 0.1);
            if (!shouldEnd) continue;

            this._majesticLeaps.delete(eid);
            this.io.emit('majesticLeapEnd', {
                id: this.ecsWorld.getEntityId(eid),
                x: Position.x[eid],
                y: Position.y[eid],
                z: Position.z[eid],
            });
        }
    }

    _kyoukanHeroicAura(eid) {
        AbilityCooldowns.ultimate[eid] = CD.HEROIC_AURA_CD;
        AbilityCooldowns.ultimateActive[eid] = 1;
        AbilityCooldowns.ultimateTimer[eid] = CD.HEROIC_AURA_DURATION;
        this._heroicAuraTimers.set(eid, {
            remaining: CD.HEROIC_AURA_DURATION,
            nextTick: 0,
        });

        this.io.emit('heroicAuraStart', {
            id: this.ecsWorld.getEntityId(eid),
            x: Position.x[eid],
            y: Position.y[eid],
            z: Position.z[eid],
            radius: CD.HEROIC_AURA_RADIUS,
            duration: CD.HEROIC_AURA_DURATION / TICK_RATE,
        });
    }

    _tickHeroicAuras() {
        if (this._heroicAuraTimers.size === 0) return;

        const strongestByTarget = new Map();

        for (const [eid, state] of this._heroicAuraTimers) {
            if (state.remaining <= 0 || Health.current[eid] <= 0) {
                this._heroicAuraTimers.delete(eid);
                AbilityCooldowns.ultimateActive[eid] = 0;
                this.io.emit('heroicAuraEnd', { id: this.ecsWorld.getEntityId(eid) });
                continue;
            }

            state.remaining--;
            state.nextTick--;
            if (state.nextTick > 0) continue;
            state.nextTick = CD.HEROIC_AURA_TICK_INTERVAL;

            const casterTeam = Number(Team.id[eid] ?? 0);
            const cx = Position.x[eid];
            const cy = Position.y[eid];
            const cz = Position.z[eid];

            for (const targetEid of this.ecsWorld.getAllPlayerAndBotEntities()) {
                if (Health.current[targetEid] <= 0) continue;
                const targetTeam = Number(Team.id[targetEid] ?? 0);
                if (casterTeam > 0 && targetTeam > 0 && casterTeam !== targetTeam) continue;

                if (!this.damageSystem.collisionSystem.sphereCollisionCheckCoord(
                    cx,
                    cy,
                    cz,
                    Position.x[targetEid],
                    Position.y[targetEid],
                    Position.z[targetEid],
                    CD.HEROIC_AURA_RADIUS
                )) {
                    continue;
                }

                const prev = strongestByTarget.get(targetEid);
                if (!prev || prev.armorGain < CD.HEROIC_AURA_ARMOR_GAIN) {
                    strongestByTarget.set(targetEid, {
                        armorGain: CD.HEROIC_AURA_ARMOR_GAIN,
                        ultReduction: CD.HEROIC_AURA_ULT_REDUCTION,
                    });
                }
            }

            this.io.emit('heroicAuraTick', {
                id: this.ecsWorld.getEntityId(eid),
                x: cx,
                y: cy,
                z: cz,
                radius: CD.HEROIC_AURA_RADIUS,
            });
        }

        for (const [targetEid, effect] of strongestByTarget) {
            Armor.current[targetEid] = Math.min(Armor.max[targetEid], Armor.current[targetEid] + effect.armorGain);
            if (AbilityCooldowns.ultimate[targetEid] > 0) {
                AbilityCooldowns.ultimate[targetEid] = Math.max(0, AbilityCooldowns.ultimate[targetEid] - effect.ultReduction);
            }
        }
    }

    _templarHolyWater(eid) {
        AbilityCooldowns.ability1[eid] = CD.HOLY_WATER_CD;
        const yaw = Rotation.yaw[eid];
        const pitch = Rotation.pitch[eid];
        for (let i = 0; i < 4; i++) {
            let randomYaw = yaw + (Math.random() - 0.5) * 0.4; // Slight random spread
            let randomPitch = pitch + (Math.random() - 0.5) * 0.1;
            const vx = -Math.sin(randomYaw) * Math.cos(randomPitch) * CD.HOLY_WATER_THROW_SPEED;
            const vz = -Math.cos(randomYaw) * Math.cos(randomPitch) * CD.HOLY_WATER_THROW_SPEED;
            const vy = Math.sin(randomPitch) * CD.HOLY_WATER_THROW_SPEED + 2.0; // Add slight upward arc

            this._holyWaters.push({
                ownerEid: eid,
                x: Position.x[eid],
                y: Position.y[eid] + 1.5, // Start slightly above caster's position
                z: Position.z[eid],
                vx,
                vy,
                vz,
                state: 'airborne',
                remaining: 0,
            });
        } 
        const id = this.ecsWorld.getEntityId(eid);
        this.io.emit('holyWaterThrown', {
            id,
            x: Position.x[eid],
            y: Position.y[eid] + 1.5,
            z: Position.z[eid],
        }); 
    }

    _tickHolyWaters() {
        const dt      = 1 / TICK_RATE;
        const gravity = -9.81;
        let alreadyHealedThisTick = new Set();
        for (let i = 0; i < this._holyWaters.length; i++) {
            const g = this._holyWaters[i];
            if (g.state === "airborne") {
                 // Simple projectile motion with gravity
                g.vy += gravity * dt;
                g.x  += g.vx * dt;
                g.y  += g.vy * dt;
                g.z  += g.vz * dt;
                if (this.physicsWorld.checkGroundDetectionAt(g.x, g.y, g.z) || g.y <= -100) {
                    g.state = "grounded";
                    g.remaining = CD.HOLY_WATER_DURATION;
                    let casterTeam = Number(Team.id[g.ownerEid] ?? 0);

                    //{ ownerEid, x, y, z, vx, vy, vz, state (On Air or Lingering), ticksLeft (When On Ground) }
    
                    let healedTargets = this._applyHolyWaterHeal(casterTeam, g, alreadyHealedThisTick);
                    alreadyHealedThisTick = healedTargets;

                    this.io.emit('holyWaterImpact', {
                        id: this.ecsWorld.getEntityId(g.ownerEid),
                        x: g.x,
                        y: g.y,
                        z: g.z,
                    });
                }
            }else if (g.state === "grounded") {
                g.remaining--;
                if (g.remaining <= 0) {
                    this._holyWaters.splice(i, 1);
                    i--;
                    continue;
                }

                let casterTeam = Number(Team.id[g.ownerEid] ?? 0);

                //{ ownerEid, x, y, z, vx, vy, vz, state (On Air or Lingering), ticksLeft (When On Ground) }
                if (g.remaining % CD.HOLY_WATER_TICK_INTERVAL === 0) {
                    let healedTargets = this._applyHolyWaterHeal(casterTeam, g, alreadyHealedThisTick);
                    alreadyHealedThisTick = healedTargets;
                }

                this.io.emit('holyWaterTick', {
                    id: this.ecsWorld.getEntityId(g.ownerEid),
                    x: g.x,
                    y: g.y,
                    z: g.z,
                });
            }
        }

        
    }

    _applyHolyWaterHeal(casterTeam, g,alreadyHealedTargets = new Set()) {
        for (const targetEid of this.ecsWorld.getAllPlayerAndBotEntities()) {
            if (alreadyHealedTargets.has(targetEid)) continue;
            if (Health.current[targetEid] <= 0) continue;
            if (this.isInvulnerable(targetEid)) continue;
            const targetTeam = Number(Team.id[targetEid] ?? 0);
            if (casterTeam > 0 && targetTeam > 0 && casterTeam !== targetTeam) continue;

            const dx = g.x - Position.x[targetEid];
            const dy = g.y - Position.y[targetEid];
            const dz = g.z - Position.z[targetEid];

            let r2 = CD.HOLY_WATER_RADIUS * CD.HOLY_WATER_RADIUS;
            const horizDist2 = dx * dx + dz * dz + dy * dy;
            if (horizDist2 > r2) continue;

            const healAmount = CD.HOLY_WATER_HEAL_PER_INTERVAL;
            Health.current[targetEid] = Math.min(Health.max[targetEid], Health.current[targetEid] + healAmount);
            alreadyHealedTargets.add(targetEid);
        }
        return alreadyHealedTargets;
    }

    _templarHealingRite(eid) {
        const selfCast = this._selfCastingEnabled.get(eid) === true;
        let targetEid = eid;

        if (!selfCast) {
            targetEid = this._findClosestAlliedTargetInCone(eid, CD.HEALING_RITE_RANGE, CD.HEALING_RITE_HALF_ANGLE);
            if (targetEid === null) return;
        }

        AbilityCooldowns.ability2[eid] = CD.HEALING_RITE_CD;
        // // { ownerEid, targetEid, remaining }
        this._healingRites.push({
            ownerEid: eid,
            targetEid: targetEid,
            remaining: CD.HEALING_RITE_DURATION,
        });

        this.io.emit('healingRiteCast', {
            casterId: this.ecsWorld.getEntityId(eid),
            targetId: this.ecsWorld.getEntityId(targetEid),
            selfCast,
            x: Position.x[targetEid],
            y: Position.y[targetEid],
            z: Position.z[targetEid],
        });

    }

    _tickHealingRites() {
        for (const healingRite of this._healingRites) {
            let targetEid = healingRite.targetEid;
            if (healingRite.remaining <= 0 || Health.current[targetEid] <= 0) {
                this._healingRites = this._healingRites.filter(rite => rite !== healingRite);
                this.io.emit('healingRiteEnd', {
                    id: this.ecsWorld.getEntityId(targetEid),
                    finished: true,
                });
                continue;
            }

            healingRite.remaining--;
            if (healingRite.remaining % CD.HEALING_RITE_TICK_INTERVAL === 0) {
                const healAmount = CD.HEALING_RITE_HEAL_AMOUNT;
                Health.current[targetEid] = Math.min(Health.max[targetEid], Health.current[targetEid] + healAmount);

                this.io.emit('healingRiteTick', {
                    id: this.ecsWorld.getEntityId(targetEid),
                    healAmount,
                    x: Position.x[targetEid],
                    y: Position.y[targetEid],
                    z: Position.z[targetEid],
                });
            }
        }
    }

    _templarHammerOfJustice(eid) {
        AbilityCooldowns.ultimate[eid] = CD.HAMMER_OF_JUSTICE_CD;
        const yaw = Rotation.yaw[eid];
        const pitch = Rotation.pitch[eid];
        const bodyId = this.ecsWorld.getEntityId(eid);
        const body = this.physicsWorld.getBody(bodyId);
        if (body) {
            // Smash a Hammer on the ground, hitting all enemies in front and stunning them briefly
            const range = CD.HAMMER_OF_JUSTICE_RANGE;
            const halfAngle = CD.HAMMER_OF_JUSTICE_HALF_ANGLE;
            const ox = Position.x[eid];
            const oy = Position.y[eid];
            const oz = Position.z[eid];
            const fx = -Math.sin(yaw);
            const fz = -Math.cos(yaw);
            const cosHalf = Math.cos(halfAngle);

            for (const targetEid of this.ecsWorld.getAllPlayerAndBotEntities()) {
                if (targetEid === eid) continue;
                if (Health.current[targetEid] <= 0) continue;
                if (this.isInvulnerable(targetEid)) continue;
                if (this.damageSystem.isFriendlyFireBlocked(targetEid, eid)) continue;

                const dx = Position.x[targetEid] - ox;
                const dy = Position.y[targetEid] - oy;
                const dz = Position.z[targetEid] - oz;
                const dist2 = dx * dx + dy * dy + dz * dz;
                if (dist2 > range * range) continue;

                const dist = Math.sqrt(dist2);
                if (dist < 0.001) continue;
                const dotXZ = (dx / dist) * fx + (dz / dist) * fz;
                if (dotXZ < cosHalf) continue;

                // Hit target
                this.damageSystem.applyDamage(targetEid, eid, CD.HAMMER_OF_JUSTICE_DAMAGE, {
                    ignoreArmor: false,
                    damageType: DAMAGE_TYPES.ABILITY,
                });
                this._stunTimers.set(targetEid, CD.HAMMER_OF_JUSTICE_STUN_DURATION);

                const id = this.ecsWorld.getEntityId(eid);
                this.io.emit('hammerOfJusticeHit', {
                    id,
                    targetId: this.ecsWorld.getEntityId(targetEid),
                    x: Position.x[targetEid],
                    y: Position.y[targetEid],
                    z: Position.z[targetEid],
                });
            }
        }
        this.io.emit('hammerOfJusticeCast', {
            id: this.ecsWorld.getEntityId(eid),
            x: Position.x[eid],
            y: Position.y[eid],
            z: Position.z[eid],
            yaw: yaw,
            pitch: pitch,
        });
    }

    _findClosestAlliedTargetInCone(eid, range, halfAngle) {
        const yaw = Rotation.yaw[eid];
        const ox = Position.x[eid];
        const oy = Position.y[eid];
        const oz = Position.z[eid];
        const fx = -Math.sin(yaw);
        const fz = -Math.cos(yaw);
        const range2 = range * range;
        const cosHalf = Math.cos(halfAngle);
        const casterTeam = Number(Team.id[eid] ?? 0);

        let bestEid = null;
        let bestDist2 = range2;

        for (const targetEid of this.ecsWorld.getAllPlayerAndBotEntities()) {
            if (targetEid === eid) continue;
            if (Health.current[targetEid] <= 0) continue;

            const targetTeam = Number(Team.id[targetEid] ?? 0);
            if (casterTeam > 0 && targetTeam > 0 && casterTeam !== targetTeam) continue;

            const dx = Position.x[targetEid] - ox;
            const dy = Position.y[targetEid] - oy;
            const dz = Position.z[targetEid] - oz;
            const dist2 = dx * dx + dy * dy + dz * dz;
            if (dist2 > range2 || dist2 >= bestDist2) continue;

            const dist = Math.sqrt(dist2);
            if (dist < 0.001) continue;
            const dotXZ = (dx / dist) * fx + (dz / dist) * fz;
            if (dotXZ < cosHalf) continue;

            bestDist2 = dist2;
            bestEid = targetEid;
        }

        return bestEid;
    }

    // ───────────────────────────────────────────────────────────────────────────
    // Father Callas – public state queries used by other systems
    // ───────────────────────────────────────────────────────────────────────────

    /**
     * Returns true while the entity cannot take damage.
     * Checked by DamageSystem.applyDamage before any calculation.
     * @param {number} eid
     */
    isInvulnerable(eid) {
        if (this._ironStandTimers.has(eid) || this._shadowRealmTargets.has(eid)) return true;
        // Selene: untargetable during first 2 s of Astral Elevation
        const astral = this._astralFlightTimers.get(eid);
        if (astral && astral.invulnRemaining > 0) return true;
        // Selene: untargetable during Lunar Eclipse charge
        return false;
    }

    /**
     * Returns true while the entity is unable to move or act.
     * Checked by server/index.js (playerInput + shoot handler) and BotSystem.
     * @param {number} eid
     */
    isFrozen(eid) {
        return this._ironStandTimers.has(eid)
            || this._shadowRealmTargets.has(eid)
            || this._stunTimers.has(eid)   // Crystal Smash stun + Butt Smash stun
            || this._crystalSmashDashes.has(eid)  // Selene Crystal Smash dash lock
            || this._shoulderCharges.has(eid)     // Fat Jerome Shoulder Charge
            || this._buttSmashes.has(eid)      // Fat Jerome Butt Smash
            || this._majesticLeaps.has(eid)    // Kyoukan Majestic Leap
    }

    /**
     * Returns true if the entity is currently silenced (cannot use abilities).
     * Checked in _processAbilities.
     * @param {number} eid
     */
    isSilenced(eid) {
        return this._silenceTimers.has(eid) && this._silenceTimers.get(eid) > 0;
    }

    /**
     * Returns true if the entity is currently in Selene's Astral Elevation flight.
     * Used by MovementSystem to apply speed multiplier and slow-fall.
     * @param {number} eid
     */
    isInFlight(eid) {
        return this._astralFlightTimers.has(eid);
    }

    /**
     * Returns true while Selene is charging Lunar Eclipse (cannot shoot or act).
     * @param {number} eid
     */
    isChargingLunarEclipse(eid) {
        return this._lunarEclipseTimers.has(eid);
    }

    /**
     * Returns the movement-speed multiplier for an entity.
     * Accounts for Selene's hero-stat boost and in-flight bonus.
     * @param {number} eid
     * @returns {number}
     */
    getMovementSpeedMult(eid) {
        const cfg = heroConfigs[String(HeroClass.id[eid])];
        let mult = cfg?.moveSpeedMult ?? 1.0;
        mult *= this._getModifierMultiplier('moveSpeed', eid);
        return mult;
    }

    /**
     * Returns the weapon-damage multiplier for an entity.
     * Returns > 1 while Selene's post-landing bonus is active.
     * @param {number} eid
     * @returns {number}
     */
    getWeaponDamageMultiplier(eid) {
        return this.getOutgoingDamageMultiplier(eid, DAMAGE_TYPES.WEAPON);
    }

    /**
     * Called by DamageSystem after damage is resolved on `eid`.
     * During Iron Stand’s shield phase, IRON_STAND_SHIELD_RATIO of the damage
     * dealt is added as shield.
     * @param {number} eid
     * @param {number} damage  – effective damage that was applied
     */
    onDamageTaken(eid, damage) {
        
        this._terminateHealingRite(eid);
        if (!this._ironStandTimers.has(eid)) return;
        if (damage <= 0) return;

        const gain = damage * CD.IRON_STAND_SHIELD_RATIO;
        if (Shield.max[eid] < CD.IRON_STAND_SHIELD_MAX) {
            Shield.max[eid] = CD.IRON_STAND_SHIELD_MAX;
        }
        Shield.current[eid] = Math.min(Shield.max[eid], Shield.current[eid] + gain);
        // Delay natural regen so freshly-gained shield isn’t immediately eroded
        Shield.regenDelay[eid] = Math.max(Shield.regenDelay[eid], 300);
    }

    _terminateHealingRite(eid) {
        for (let i = 0; i < this._healingRites.length; i++) {
            const healingEid = this._healingRites[i];
            if (healingEid === null || healingEid.targetEid == null) continue;
            if (healingEid.targetEid === eid) {
                this._healingRites.splice(i, 1);
                this.io.emit('healingRiteEnd', {
                    id: this.ecsWorld.getEntityId(healingEid.targetEid),
                    finished: true,
                });
                i--;
            }
        }
    }
}

module.exports = HeroSystem;

const {
    Position,
    Velocity,
    Rotation,
    Controller,
    Bullet
} = require('../shared/components');
const { 
    PLAYER_RADIUS, 
    PLAYER_MASS, 
    TICK_RATE,
    CURRENT_MAP,
    MODES_CONFIG,
    ACTIVE_GAME_MODE,
    POST_MATCH_RESTART_MS,
    NUM_BOTS
} = require('../shared/constants');
const MapLoader = require('./world/MapLoader');
const TeamSystem = require('./systems/TeamSystem');
const MatchSystem = require('./systems/MatchSystem');

// server/GameState.js
class GameState {
    constructor(ecsWorld, physicsWorld, metworkGameStateFacade, respawnSystem, botSystem, movementSystem, damageSystem, combatSystem, pickupSystem, modifiers ,heroSystem) {
        /** @type {import('./world/World')} */
        this.ecsWorld = ecsWorld;
        /** @type {import('./world/PhysicsWorld')} */
        this.physicsWorld = physicsWorld;
        /** @type {import('./facades/NetworkGameStateFacade')} */
        this.networkGameStateFacade = metworkGameStateFacade;
        /** @type {import('./systems/RespawnSystem')} */
        this.respawnSystem = respawnSystem;
        /** @type {import('./systems/BotSystem')} */
        this.botSystem = botSystem;
        /** @type {import('./systems/MovementSystem')} */
        this.movementSystem = movementSystem;
        /** @type {import('./systems/DamageSystem')} */
        this.damageSystem = damageSystem;
        /** @type {import('./systems/CombatSystem')} */
        this.combatSystem = combatSystem;
        /** @type {import('./systems/PickupSystem')} */
        this.pickupSystem = pickupSystem;
        /** @type {import('./systems/ModifiersSystem')} */
        this.modifiers  = modifiers;
        /** @type {import('./systems/HeroSystem')} */
        this.heroSystem = heroSystem;
        this.turn = 0; // Game tick counter
        this.status = 'running'; // running, paused, overtime, finished

        const modeConfig = (MODES_CONFIG.modes && MODES_CONFIG.modes[ACTIVE_GAME_MODE]) || {};
        const teamCount = Number.isInteger(modeConfig.teamCount) && modeConfig.teamCount > 0
            ? modeConfig.teamCount
            : 2;

        this.teamSystem = new TeamSystem(this.ecsWorld, { teamCount });
        this.matchSystem = new MatchSystem({
            modeKey: ACTIVE_GAME_MODE,
            modeConfig,
            availableModeKeys: Object.keys(MODES_CONFIG.modes || {}),
            teamSystem: this.teamSystem,
            postMatchRestartMs: POST_MATCH_RESTART_MS,
            world: this.ecsWorld,
            respawnSystem: this.respawnSystem,
        });
        this.matchState = this.matchSystem.getSnapshot();
    }

    async initMap() {
        try {
            const mapLoader = new MapLoader();
            this.mapConfig = await mapLoader.load(CURRENT_MAP, this.physicsWorld);
            console.log(`Map '${this.mapConfig.name}' loaded successfully`);
        } catch (error) {
            console.error('Failed to initialize map:', error);
            process.exit(1); // Fail fast
        }
        // Spawn AI bots
        const N_BOTS = NUM_BOTS;
        for (let i = 0; i < N_BOTS; i++) {
            const x = (Math.random() - 0.5) * 80; // Spawn within 80x80 area
            const z = (Math.random() - 0.5) * 80;
            const color = Math.floor(Math.random() * 0xffffff);
            this.addNewBot(x, 2, z, color);
            
        }
        
        console.log(`Physics initialized, ${N_BOTS} bots spawned, ready for connections`);

        // Spawn pickups from map config
        if (this.pickupSystem) {
            this.pickupSystem.initPickups();
        }

        this.matchSystem.startMatch(this.ecsWorld.world);

        this.emitMatchEvent('matchStarted', this.buildMatchEventPayload('matchStarted'));
    }
    
    addNewBot(x,y,z,color) {
        const teamId = this.teamSystem.assignTeamForNewPlayer();
        const botEid = this.ecsWorld.createBotEntity(x, y, z, teamId, color);
            
            // Create physics body for bot
        const botBody = this.physicsWorld.createPlayerBody(x, y, z, PLAYER_RADIUS, PLAYER_MASS);
        this.physicsWorld.addBody(this.ecsWorld.getBotIdString(botEid), botBody);
    }

    ensureEntityTeams() {
        for (const eid of this.ecsWorld.getAllPlayerAndBotEntities()) {
            if (this.teamSystem.getEntityTeam(eid) === 0) {
                this.teamSystem.setEntityTeam(eid, this.teamSystem.assignTeamForNewPlayer());
            }
        }
    }

    resetOutOfBoundsEntity(eid) {
        const id = this.ecsWorld.getEntityId(eid);
        this.physicsWorld.resetForces(id);
        this.physicsWorld.setTranslation(id, { x: 0, y: 13, z: 0 });
        
        Velocity.vx[eid] = 0;
        Velocity.vy[eid] = 0;
        Velocity.vz[eid] = 0;
            
    }

    update() {
        this.turn++;
        if (!this.physicsWorld.world) return; // Wait for physics to initialize

        // Tick weapon fire/reload timers (must run before bot shoot logic)
        if (this.combatSystem) {
            this.combatSystem.tickWeapons();
        }

        // Keep all active entities on valid teams for team-based modes.
        this.ensureEntityTeams();

        // Update AI bots (pass emit helper so bots can broadcast weaponFired events)
        this.botSystem.update(this.ecsWorld.world);

        this.movementSystem.update();

        const DELTA_TIME = 1 / TICK_RATE;

        // Step physics simulation
        this.physicsWorld.step(DELTA_TIME);
        
        // Check out-of-bounds for players and teleport back to center
        const BOUNDARY = 300; // MAP_SIZE / 2
        this.ecsWorld.syncPhysicsToECS(this.physicsWorld);
        
        for (const eid of this.ecsWorld.getAllPlayerAndBotEntities()) {
            const x = Position.x[eid];
            const y = Position.y[eid];
            const z = Position.z[eid];

            const bodyId = this.ecsWorld.getSocketByEntity(eid) || this.ecsWorld.getBotIdString(eid);
            const hasInput = Controller.forward[eid] || Controller.backward[eid] ||
                        Controller.left[eid]    || Controller.right[eid];

            if (!hasInput && this.movementSystem.isPlayerOnGround(eid)) {
                this.physicsWorld.applyGroundFriction(bodyId, 0.70);
            }
            
            if (Math.abs(x) > BOUNDARY || Math.abs(z) > BOUNDARY || y < -BOUNDARY) {
                this.resetOutOfBoundsEntity(eid);
            }
        }

        // Update bullets
        const bulletsToRemove = [];
        const deltaTime = 1 / TICK_RATE; // Time per tick in seconds
        for (const eid of this.ecsWorld.getBullets()) {
            // Update position based on velocity (velocity is in units/second, so multiply by deltaTime)
            Position.x[eid] += Velocity.vx[eid] * deltaTime;
            Position.y[eid] += Velocity.vy[eid] * deltaTime;
            Position.z[eid] += Velocity.vz[eid] * deltaTime;
            
            // Decrement life
            Bullet.life[eid]--;

            // Mark for removal if dead
            if (Bullet.life[eid] <= 0) {
                bulletsToRemove.push(eid);
            }
        }

        // Remove dead bullets
        for (const eid of bulletsToRemove) {
            this.ecsWorld.removeBulletEntity(eid);
        }

        if (this.modifiers) {
            this.modifiers.update();
        }

        // Process hero abilities
        if (this.heroSystem) {
            this.heroSystem.update();
        }

        // Tick pickups (proximity collection + respawn timers)
        if (this.pickupSystem) {
            this.pickupSystem.update();
        }

        // Check bullet collisions and apply damage
        this.damageSystem.update(this.ecsWorld.world);

        const matchUpdate = this.matchSystem.update();
        this.matchState = matchUpdate.snapshot;
        this.status = this.matchState.status;

        if (matchUpdate.transition === 'finished') {
            this.emitMatchEvent('matchEnded', this.buildMatchEventPayload('matchEnded'));
        } else if (matchUpdate.transition === 'reset') {
            this.emitMatchEvent('matchReset', this.buildMatchEventPayload('matchReset'));
            this.emitMatchEvent('matchStarted', this.buildMatchEventPayload('matchStarted'));
            this.damageSystem.reset(); // Reset any match-specific state in the damage system (e.g. first blood tracking)
        }

        this.networkGameStateFacade.emitGameState(this.ecsWorld.world, this.matchState);
        
    }

    getCurrentState() {
        return {
            turn: this.turn,
            status: this.status,
            entities: this.ecsWorld.playerEntities.size + this.ecsWorld.botEntities.size,
            match: this.getMatchState(),
        };
    }

    getMatchState() {
        return this.matchSystem.getSnapshot();
    }

    registerKill(killerEid, victimEid) {
        const result = this.matchSystem.registerKill(killerEid, victimEid);
        this.matchState = result.snapshot || this.matchSystem.getSnapshot();
        this.status = this.matchState.status;

        if (result.ended) {
            this.emitMatchEvent('matchEnded', this.buildMatchEventPayload('matchEnded'));
        }

        return result;
    }

    emitMatchEvent(eventName, payload) {
        this.networkGameStateFacade.emitMatchEvent(eventName, payload);
    }

    buildMatchEventPayload(eventName) {
        const match = this.getMatchState();
        return {
            event: eventName,
            mode: match.mode,
            status: match.status,
            teamScores: match.teamScores,
            targetScore: match.targetScore,
            winnerTeam: match.winnerTeam,
            reason: match.reason,
            matchEndAt: match.matchEndAt,
            restartInMs: match.restartInMs,
            currentMatchTick: match.currentMatchTick || 0
        };
    }
}

module.exports = GameState;
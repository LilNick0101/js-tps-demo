const express = require('express');
const http = require('http');
const geckos = require('@geckos.io/server').default;
const path = require('path');
const PhysicsWorld = require('./world/PhysicsWorld');
const CollisionSystem = require('./systems/CollisionSystem');
const DamageSystem = require('./systems/DamageSystem');
const BotSystem = require('./systems/BotSystem');
const RespawnSystem = require('./systems/RespawnSystem');
const World = require('./world/World');
const StateHistory = require('./world/StateHistory');
const MovementSystem = require('./systems/MovementSystem');
const NetworkSystem = require('./systems/NetworkSystem');
const CombatSystem = require('./systems/CombatSystem');
const PickupSystem = require('./systems/PickupSystem');
const HeroSystem   = require('./systems/HeroSystem');
const { decode } = require('../shared/utils/Codec');
const GameState = require('./GameState');
const NetworkGameStateFacade = require('./facades/NetworkGameStateFacade');
const {
    Rotation,
    Controller,
    Player,
} = require('../shared/components');
const { 
    PLAYER_RADIUS, 
    PLAYER_MASS, 
    TICK_RATE
} = require('../shared/constants');

const app = express();
const server = http.createServer(app);
const io = geckos({
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
    ],
    cors: { origin: "http://localhost:5173" } // Add the specific origin you serve index.html from
});
io.addServer(server);

// Serve static files from the React app
app.use("/",express.static(path.join(__dirname, '../client')));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '../index.html'));
});

// --- ECS & PHYSICS INITIALIZATION ---
const ecsWorld = new World();
const physicsWorld = new PhysicsWorld();
const combatSystem = new CombatSystem(ecsWorld, physicsWorld,io);
const collisionSystem = new CollisionSystem(physicsWorld, io);

const movementSystem = new MovementSystem(ecsWorld,physicsWorld);
const botSystem = new BotSystem(ecsWorld, physicsWorld, movementSystem, combatSystem);
const respawnSystem = new RespawnSystem(ecsWorld, botSystem, io);
const damageSystem = new DamageSystem(ecsWorld, collisionSystem, botSystem, io, respawnSystem);

const networkSystem = new NetworkSystem(ecsWorld);
const pickupSystem  = new PickupSystem(ecsWorld, io);
const heroSystem    = new HeroSystem(ecsWorld, physicsWorld, damageSystem, io);
// Give MovementSystem access to HeroSystem so it can apply slow effects
movementSystem.heroSystem = heroSystem;
// Give DamageSystem access to HeroSystem for invulnerability and Iron Stand shield callbacks
damageSystem.heroSystem = heroSystem;
// Give BotSystem access to HeroSystem so frozen bots don’t move or shoot
botSystem.heroSystem = heroSystem;
// Circular buffer of the last 500 ms of world snapshots
const stateHistory = new StateHistory(500, TICK_RATE);

// Per-player last-accepted-input timestamp, used for flow control.
// Max accepted input rate: 90 Hz (well above the 60 TPS tick rate).
const playerLastInput = new Map();
const INPUT_RATE_LIMIT_MS = 1000 / 90; // ~11 ms minimum gap between inputs

// Store physics world reference in ecsWorld for respawn
ecsWorld.physicsWorld = physicsWorld;

const networkGameStateFacade = new NetworkGameStateFacade(io, networkSystem, stateHistory);

const gameState = new GameState(ecsWorld, physicsWorld, networkGameStateFacade, respawnSystem, botSystem, movementSystem, damageSystem, collisionSystem, combatSystem, pickupSystem, heroSystem);
damageSystem.gameState = gameState;

// Initialize physics world and spawn bots
(async () => {
    gameState.initMap();
})();


io.onConnection((channel) => {
    console.log('Operator joined:', channel.id);

    const criticalEmit = (event, data) =>
        channel.emit(event,data,{reliable: true, interval: 150,runs: 10 });


    channel.on('ping', (data) => {
        channel.emit('pong', data);
    });
    
    const assignedTeamId = gameState.teamSystem.assignTeamForNewPlayer();
    const startingPosition = respawnSystem.selectSpawnPoint(undefined, assignedTeamId);

    // Create player entity
    const playerEid = ecsWorld.createPlayerEntity(
        channel.id,
        startingPosition.x, startingPosition.y, startingPosition.z,
        assignedTeamId,
        Math.floor(Math.random() * 0xffffff)
    );

    // Create player physics body
    const playerBody = physicsWorld.createPlayerBody(startingPosition.x, startingPosition.y, startingPosition.z, PLAYER_RADIUS, PLAYER_MASS);
    physicsWorld.addBody(channel.id, playerBody);

    // Send current players to the new player
    const currentPlayersData = {};
    for (const eid of ecsWorld.getPlayers()) {
        const playerData = networkSystem.serializePlayer(ecsWorld.world, eid);
        if (playerData) {
            currentPlayersData[playerData.id] = playerData;
        }
    }
    criticalEmit('currentPlayers', currentPlayersData);
    criticalEmit('matchStarted', gameState.buildMatchEventPayload('matchStarted'));

    // Broadcast new player to others
    const newPlayerData = networkSystem.serializePlayer(ecsWorld.world, playerEid);
    channel.broadcast.emit('newPlayer', newPlayerData);

    // Handle player input – arrives as raw binary encoded with msgpackr.
    channel.onRaw((rawMsg) => {
        const data = decode(rawMsg);
        if (!data || !data.inputs) return; // guard against non-input raw messages
        // Flow control: drop inputs that arrive faster than INPUT_RATE_LIMIT_MS.
        const nowMs = Date.now();
        const lastInput = playerLastInput.get(channel.id) ?? 0;
        if (nowMs - lastInput < INPUT_RATE_LIMIT_MS) return;
        playerLastInput.set(channel.id, nowMs);

        const eid = ecsWorld.getEntityBySocket(channel.id);
        const body = physicsWorld.getBody(channel.id);
        if (eid === undefined || !body) return;

        // Acknowledge the sequence number so the client can trim its replay buffer
        if (data.seq !== undefined) {
            networkSystem.setLastSeq(channel.id, data.seq);
        }

        // Update rotation from client input
        Rotation.yaw[eid] = data.yaw;
        Rotation.pitch[eid] = data.pitch;

        // Update controller state
        Controller.forward[eid] = data.inputs.forward ? 1 : 0;
        Controller.backward[eid] = data.inputs.backward ? 1 : 0;
        Controller.left[eid] = data.inputs.left ? 1 : 0;
        Controller.right[eid] = data.inputs.right ? 1 : 0;
        Controller.jump[eid] = data.inputs.jump ? 1 : 0;
        Controller.dash[eid]     = data.inputs.dash     ? 1 : 0;
        Controller.ability1[eid] = data.inputs.ability1 ? 1 : 0;
        Controller.ability2[eid] = data.inputs.ability2 ? 1 : 0;
        Controller.ultimate[eid] = data.inputs.ultimate ? 1 : 0;
        heroSystem.setSelfCast(eid, data.inputs.abilitySelf === true);

        // Calculate movement velocity based on facing direction and apply directly
        const canAct = combatSystem.isAlive(eid) && !heroSystem.isFrozen(eid);
        if (canAct) {
            movementSystem.moveEntity(eid, channel.id);
        }

        // Handle jump
        if (data.inputs.jump && canAct) {
            movementSystem.jumpEntity(channel.id);
        }

        if (data.inputs.dash && canAct) {
            var forward = Controller.forward[eid] - Controller.backward[eid];
            var right = Controller.right[eid] - Controller.left[eid];
            movementSystem.dashEntity(eid, forward, right, channel.id);
        }
    });

    // Handle shoot — weapon fireCooldown component gates actual rate
    channel.on('shoot', (data) => {
        const safeData = data || {};

        const eid = ecsWorld.getEntityBySocket(channel.id);
        if (eid === undefined) return;
        if (heroSystem.isFrozen(eid)) return; // Iron Stand / Shadow Realm / stun: can't shoot
        if (heroSystem.isInFlight(eid)) return; // Selene Astral Elevation: can't shoot while airborne
        if (heroSystem.isChargingLunarEclipse(eid)) return; // Selene Lunar Eclipse: can't shoot while charging
        combatSystem.shootBullet(channel.id, 0.0);
    });

    // Manual reload (R key)
    channel.on('reload', () => {
        const eid = ecsWorld.getEntityBySocket(channel.id);
        if (eid === undefined) return;
        combatSystem.startReload(eid);
    });

    // Hero selection — can be sent before or after spawn
    channel.on('setHero', (data) => {
        const heroClassId = parseInt(data?.heroClass ?? 0, 10);
        // Clamp to valid range (0 = Dummy, 1 = Sven, 2 = Tamerlane, 3 = Father Callas, 4 = Selene, 5 = Fat Jerome, 6 = Kyoukan, 7 = Healing Rite)
        const valid = [0, 1, 2, 3, 4, 5, 6, 7];
        if (!valid.includes(heroClassId)) return;

        ecsWorld.pendingHeroClass.set(channel.id, heroClassId);

        // Apply immediately to existing entity (in-place hero morph)
        const eid = ecsWorld.getEntityBySocket(channel.id);
        if (eid !== undefined) {
            ecsWorld.applyHeroClass(eid, heroClassId);
            ecsWorld.pendingHeroClass.delete(channel.id);
        }

        console.log(`Player ${channel.id} selected hero class ${heroClassId}`);
        Player.isReady[eid] = 1; // Mark player as ready after hero selection
        channel.emit('heroSet', { heroClass: heroClassId });
    });

    // Handle username setting
    channel.on('setUsername', (data) => {
        const eid = ecsWorld.getEntityBySocket(channel.id);
        if (eid === undefined) return;

        // Sanitize name: strip to 20 chars, strip HTML
        const rawName = String(data.name || '').replace(/[<>]/g, '').trim();
        const name = rawName.slice(0, 20) || 'Player';
        ecsWorld.setEntityName(eid, name);
        console.log(`Player ${channel.id} set username to: ${name}`);
    });

    channel.onDisconnect(() => {
        // Cancel any queued respawn for this player before removing the entity
        const eid = ecsWorld.getEntityBySocket(channel.id);
        if (eid !== undefined) respawnSystem.cancelRespawn(eid);

        physicsWorld.removeBody(channel.id);
        ecsWorld.removePlayerEntity(channel.id);
        networkSystem.removePlayer(channel.id);
        io.emit('playerDisconnected', channel.id);

        playerLastInput.delete(channel.id);
        ecsWorld.pendingHeroClass.delete(channel.id);
    });
});

setInterval(() => {
    gameState.update();
}, 1000 / TICK_RATE);

server.listen(process.env.SERVER_PORT || 3002,() => {
    console.log('Server listening on port ' + (process.env.SERVER_PORT || 3002));
});
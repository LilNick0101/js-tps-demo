import * as THREE from 'three';
import geckos from '@geckos.io/client';
import * as Codec from '../shared/utils/Codec.mjs';
import RenderSystem from './systems/RenderSystem.js';
import HUD from './ui/HUD.js';
import HeroSelect from './ui/HeroSelect.js';
import AudioManager from './systems/AudioManager.js';
import SpecialEffects from './systems/SpecialEffects.js';
import PredictionSystem from './network/PredictionSystem.js';
import InterpolationSystem from './systems/InterpolationSystem.js';
import ClientMapLoader from './world/MapLoader.js';
import MAPS from '../shared/config/maps.json';

// Must match CURRENT_MAP in shared/constants.js
const CURRENT_MAP = 'arena';


// Global channel variable - will be initialized when game starts
let channel = null;
let gameStarted = false;
let connectionTimeout = null;
let currentPing = 0;
let pingInterval = null;

// --- SCENE SETUP ---
const scene = new THREE.Scene();
// Load map visuals (floor geometry, fog, GLTF if applicable)
const _mapConfig = MAPS[CURRENT_MAP];
let mapRoot = null;
new ClientMapLoader().load(_mapConfig, scene).then((root) => {
    mapRoot = root;
});

const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
const DEFAULT_FOV = 75;
const SCOPED_FOV = 32;
const PLAYER_HEAD_OFFSET = 1.1; // Keep in sync with shared/constants.js
const CAMERA_SHOULDER_OFFSET = new THREE.Vector3(1.2, 2.3, 4.5);
const CAMERA_AIM_DISTANCE = 200;
const CAMERA_COLLISION_PUSH = 0.15;
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.domElement.classList.add('game-container');
document.body.appendChild(renderer.domElement);

// Lighting
const light = new THREE.DirectionalLight(0xffffff, 1);
light.position.set(10, 20, 10);
scene.add(light);
scene.add(new THREE.AmbientLight(0xffffff, 0.5));

let defaultFog = scene.fog ? scene.fog.clone() : null;

function changeFog(newFog) {
    if (!newFog){
        scene.fog = defaultFog ? defaultFog.clone() : null;
    }
    else {
        scene.fog = newFog;
    }
}

// --- STATE & SYSTEMS ---
const renderSystem = new RenderSystem(scene);
const audioManager = new AudioManager();
const specialEffects = new SpecialEffects(renderSystem, audioManager);
const predictionSystem   = new PredictionSystem();
const interpolationSystem = new InterpolationSystem();
let myId = null;
let myHealth = 100;
let myMaxHealth = 100;
let myName = 'Player';
let hud = null;
let heroSelect = null;
audioManager.init(camera,scene);

// Maps heroClass id → { a1, a2, ult } cooldown totals (in ticks) for HUD CD display
const HERO_CD_MAXES = {
    0: { a1:   1, a2:   1, ult:    1 }, // Dummy – no abilities
    1: { a1: 480, a2: 360, ult: 2700 }, // Sven
    2: { a1: 600, a2: 720, ult: 3600 }, // Tamerlane
    3: { a1: 720, a2: 800, ult: 3600 }, // Father Callas
    4: { a1: 600, a2: 900, ult: 3600 }, // Selene
    5: { a1: 720, a2: 900, ult: 3600 }, // Fat Jerome
    6: { a1: 540, a2: 840, ult: 3600 }, // Kyoukan
    7: { a1: 720, a2: 960, ult: 3600 }, // Templar
};

// Player name and score cache: id -> { name, kills, deaths }
const playerScores = {};
let currentMatchState = {
    mode: 'tdm',
    status: 'running',
    teamScores: { 1: 0, 2: 0 },
    targetScore: 100,
    winnerTeam: 0,
    reason: '',
    restartInMs: 0,
};

// Maps entity/socket ID → heroClassId for voice line lookups
const heroClassCache = new Map();

// Inputs
const inputs = {
    forward: false,
    backward: false,
    left: false,
    right: false,
    jump: false,
    dash: false,
    scope: false,
    ability1: false,
    abilitySelf: false,
    ability2: false,
    ultimate: false,
};
let yaw = 0;   // Left/Right rotation
let pitch = 0; // Up/Down rotation
let scopeOverlay = null;
let aimYaw = 0;
let aimPitch = 0;
const WORLD_UP = new THREE.Vector3(0, 1, 0);
const cameraOffset = new THREE.Vector3();
const desiredCameraPos = new THREE.Vector3();
const finalCameraPos = new THREE.Vector3();
const headPosition = new THREE.Vector3();
const cameraForward = new THREE.Vector3();
const aimTarget = new THREE.Vector3();
const aimDirection = new THREE.Vector3();
const cameraCollisionRaycaster = new THREE.Raycaster();
const cameraAimRaycaster = new THREE.Raycaster();

// --- CLIENT-SIDE PREDICTION STATE ---
// Monotonically increasing sequence number stamped on every input packet.
let inputSeq = 0;
// Set to true once the predictor has been seeded from the first server position.
let predictionInitialized = false;
// Timestamp of the last processed tick (used to compute per-frame dt).
let lastTickTime = performance.now();
// Timestamp of the last actually-sent input packet (flow-control ceiling).
let lastInputSendTime = 0;
// Max input send rate: 120 Hz (2× the server tick rate of 60 Hz).
const INPUT_SEND_INTERVAL = 1000 / 120; // ~8.3 ms
// Rolling 1-second buffer of sent inputs, discarded once acknowledged by server.
// Each entry: { seq, timestamp, inputs:{}, yaw, pitch, dt }
const inputBuffer = [];


/** Show the connection-error dialog with a custom message. */
function showConnectionError(message) {
    const dialog = document.getElementById('connection-error-dialog');
    const msgEl  = document.getElementById('connection-error-message');
    if (dialog && msgEl) {
        msgEl.textContent = message;
        dialog.classList.remove('hidden');
    }
}

/** Reset all game state and return to the main menu. */
function backToMenu() {
    cleanupEventListeners();
    // Hide error dialog
    const dialog = document.getElementById('connection-error-dialog');
    if (dialog) dialog.classList.add('hidden');

    // Clear connection timeout if still pending
    if (connectionTimeout) {
        clearTimeout(connectionTimeout);
        connectionTimeout = null;
    }

    // Disconnect channel
    if (channel) {
        try { channel.close(); } catch (_) {}
        channel = null;
    }

    // Reset game state
    gameStarted = false;
    myId  = null;
    myHealth = 100;
    myName = 'Player';

    // Clear score cache
    for (const k in playerScores) delete playerScores[k];

    // Clear rendered entities
    renderSystem.clearAll();

    // Reset inputs
    inputs.forward  = false;
    inputs.backward = false;
    inputs.left     = false;
    inputs.right    = false;
    inputs.jump     = false;
    inputs.dash     = false;
    inputs.scope    = false;
    inputs.ability1 = false;
    inputs.abilitySelf = false;
    inputs.ability2 = false;
    inputs.ultimate = false;
    // Reset client-side prediction
    predictionSystem.initialize(0, 1, 0);
    interpolationSystem.clearAll();
    inputSeq            = 0;
    predictionInitialized = false;
    inputBuffer.length  = 0;
    lastInputSendTime   = 0;
    lastTickTime        = performance.now();

    // Destroy HUD
    if (hud) { hud.destroy(); hud = null; }

    // Hide hero select overlay if visible
    if (heroSelect) { heroSelect.hide(); heroSelect = null; }

    setScoped(false);

    // Hide game canvas and show main menu
    renderer.domElement.classList.remove('active');
    const mainMenu = document.getElementById('main-menu');
    if (mainMenu) mainMenu.classList.remove('hidden');
    audioManager.playInterfaceSound("gameBootup");
}

var holdTimer = null;

const HOLD_DURATION = 1; // ms

function shootWeapon() {
  if (document.pointerLockElement === document.body && channel && gameStarted) {
        channel.emit('shoot');
        holdTimer = setTimeout(shootWeapon, HOLD_DURATION);
    }
}

function setScoped(scoped) {
    inputs.scope = scoped;
    camera.fov = scoped ? SCOPED_FOV : DEFAULT_FOV;
    camera.updateProjectionMatrix();
    if (scopeOverlay) {
        scopeOverlay.style.display = scoped ? 'block' : 'none';
    }
}

function enableSelfCasting() {
    inputs.abilitySelf = true;
}

function disableSelfCasting() {
    inputs.abilitySelf = false;
}


// --- INPUT HANDLING (POINTER LOCK) ---
document.body.addEventListener('click', () => {
    if (gameStarted) {
        document.body.requestPointerLock();
    }
});


document.body.addEventListener('mousedown', (mouse) => {
    if (gameStarted && mouse.button === 0) { // Left click
        shootWeapon();
    }
    if (gameStarted && mouse.button === 2) { // Right click
        setScoped(true);
    }
    if (gameStarted && mouse.button === 1) { // Middle click
        enableSelfCasting();
    }
});

document.body.addEventListener('mouseup', (mouse) => {
    if (holdTimer && mouse.button === 0) { // Left click
        clearTimeout(holdTimer); // Cancel the pending hold
        holdTimer = null; // Reset the timer variable
    }
    if (mouse.button === 2) {
        setScoped(false);
    }
    if (gameStarted && mouse.button === 1) {
        disableSelfCasting();
    }
});

function onWindowResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize( window.innerWidth, window.innerHeight );
}

window.addEventListener('contextmenu', (e) => {
    if (gameStarted) e.preventDefault();
});

window.addEventListener( 'resize', onWindowResize, false );

document.addEventListener('mousemove', (event) => {
    if (document.pointerLockElement === document.body) {
        // Sensitivity
        const SENSITIVITY = 0.002;
        yaw -= event.movementX * SENSITIVITY;
        pitch -= event.movementY * SENSITIVITY;

        // Clamp pitch so you can't break your neck
        pitch = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, pitch));
    }
});

// Keys
window.addEventListener('keydown', (e) => {
    if (e.code === 'KeyW') inputs.forward = true;
    if (e.code === 'KeyS') inputs.backward = true;
    if (e.code === 'KeyA') inputs.left = true;
    if (e.code === 'KeyD') inputs.right = true;
    if (e.code === 'Space') inputs.jump = true;
    if (e.shiftKey) inputs.dash = true;
    if (e.code === 'Digit1') inputs.ability1 = true;
    if (e.code === 'Digit2') inputs.ability2 = true;
    if (e.code === 'Digit3') inputs.ultimate = true;
    if (e.code === 'KeyR' && channel && gameStarted) { channel.emit('reload'); }
    if (e.code === 'Tab' && gameStarted) {
        e.preventDefault();
        hud.updateScoreboard(playerScores, myId);
        const sb = document.getElementById('scoreboard');
        if (sb) sb.style.display = 'block';
    }
});
window.addEventListener('keyup', (e) => {
    if (e.code === 'KeyW') inputs.forward = false;
    if (e.code === 'KeyS') inputs.backward = false;
    if (e.code === 'KeyA') inputs.left = false;
    if (e.code === 'KeyD') inputs.right = false;
    if (e.code === 'Space') inputs.jump = false;
    if (!e.shiftKey) inputs.dash = false;
    if (e.code === 'Digit1') inputs.ability1 = false;
    if (e.code === 'Digit2') inputs.ability2 = false;
    if (e.code === 'Digit3') inputs.ultimate = false;
    if (e.code === 'Tab') {
        const sb = document.getElementById('scoreboard');
        if (sb) sb.style.display = 'none';
    }
});

function validatePlayerInput(input) {
    return {
        forward:  Boolean(input.forward),
        backward: Boolean(input.backward),
        left:     Boolean(input.left),
        right:    Boolean(input.right),
        jump:     Boolean(input.jump),
        dash:     Boolean(input.dash),
        scope:    Boolean(input.scope),
        ability1: Boolean(input.ability1),
        abilitySelf: Boolean(input.abilitySelf),
        ability2: Boolean(input.ability2),
        ultimate: Boolean(input.ultimate),
    };
}

function teamOfEntity(id) {
    return Number(playerScores[id]?.team ?? 0);
}

function isLocalPlayer(id) {
    return id === myId;
}

function safePos(data) {
    return {
        x: data?.x ?? 0,
        y: data?.y ?? 0,
        z: data?.z ?? 0,
    };
}

const eventListeners = new Map();

function registerEventListener(event, handler) {
    /**
     * Wrapper that:
     * 1. Deduplicates retried messages (server may resend before ACK arrives).
     * 2. Acknowledges the message so the server removes it from the retry queue.
     */
    const wrappedHandler = (data) => {
        handler(data);
    };
    eventListeners.set(event, wrappedHandler);
    channel.on(event, wrappedHandler);
}

function cleanupEventListeners() {
    if (channel) {
        for (const [event, handler] of eventListeners.entries()) {
            try {
                channel.off(event, handler);
            } catch (_) {
                // Best-effort cleanup when channel state is already closing.
            }
        }
    }
    eventListeners.clear();
}

// --- NETWORK SETUP ---
function setupNetworkHandlers() {
    // --- NETWORK LOOP ---
    channel.onConnect((error) => {
        // Clear the connection timeout regardless of outcome
        if (connectionTimeout) {
            clearTimeout(connectionTimeout);
            connectionTimeout = null;
        }

        if (error) {
            console.error('Connection failed:', error.message);
            showConnectionError(`Could not connect to the server: ${error.message}`);
            return;
        }
        myId = channel.id;
        console.log('Connected with ID:', myId);

        if (pingInterval) clearInterval(pingInterval);
        pingInterval = setInterval(() => {
            channel.emit('ping', { timestamp: Date.now() });
        }, 5000);

        // Send the chosen username to the server
        const usernameInput = document.getElementById('username-input');
        if (usernameInput) {
            myName = usernameInput.value.trim() || 'Player';
            localStorage.setItem('lastUsername', myName);
        } else {
            myName = 'Player';
        }
        channel.emit('setUsername', { name: myName });
    });

    registerEventListener('currentPlayers', (players) => {
        for (const id in players) {
            const player = players[id];
            if (renderSystem.hasMesh(id)) continue; // Already created (e.g. from 'newPlayer' event)
            renderSystem.createPlayerMesh(id, player.eid, player.color);
        }
    });

    registerEventListener('pong', (data) => {
        const now = Date.now();
        currentPing = now - data.timestamp;
    });

    registerEventListener('newPlayer', (player) => {
        if (player.id === myId) {
            // This case is already handled in the 'currentPlayers' event on initial connection,
            // but we include it here for completeness in case of any late join edge cases.
            return;
        }
        renderSystem.createPlayerMesh(player.id, player.eid, player.color);
    });

    registerEventListener('playerDisconnected', (id) => {
        renderSystem.removeMesh(id);
        interpolationSystem.removeEntity(id);
    });

     // Handle damage events
     registerEventListener('playerDamaged', (data) => {
         // If we took damage, update our health
        if (isLocalPlayer(data.targetId)) {
            myHealth = data.newHealth;
            hud.updateHealth(myHealth, myMaxHealth);
            if (data.newArmor  !== undefined) hud.updateArmor(data.newArmor);
            if (data.newShield !== undefined) hud.updateShield(data.newShield);
        }
        
        // If we dealt damage, show hitmarker + enemy health bar
        if (data.attackerId === myId) {
            hud.showHitmarker();
            audioManager.playInterfaceSound("hitmarker")
            renderSystem.updateEnemyHealthBar(data.targetId, data.newHealth, data.maxHealth, data.newArmor, data.maxArmor, data.newShield, data.maxShield);
        }
    });

    // Handle death events
    registerEventListener('playerDied', (data) => {
        const killerDisplay = data.killerName || data.killerId;
        const victimDisplay = data.victimName || data.victimId;
        const killerTeam = teamOfEntity(data.killerId);
        const victimTeam = teamOfEntity(data.victimId);
        if (killerTeam > 0 || victimTeam > 0) {
            hud.addKillFeedEntryTeam(killerDisplay, killerTeam, victimDisplay, victimTeam);
        } else {
            hud.addKillFeedEntry(`${killerDisplay} \u2192 ${victimDisplay}`);
        }

        // Play spatial death/kill voice lines
        if (data.x !== undefined) {
            const victimMesh = renderSystem.getMesh(data.victimId);
            audioManager.playHeroDeathLine(data.victimHeroClass ?? 0, victimMesh);
        }
        if (isLocalPlayer(data.killerId)) {
            const killerMesh = renderSystem.getMesh(data.killerId);
            audioManager.playHeroKillLine(heroClassCache.get(myId)?.hero ?? 0, killerMesh);
        }

        if (isLocalPlayer(data.victimId)) {
            hud.removeAllSelfEffects();
            hud.removeScreenTint();
            if (data.respawnIn) hud.showRespawnCountdown(data.respawnIn, killerDisplay);
        }
        if (isLocalPlayer(data.killerId)) {
            hud.showKillMessage(victimDisplay);
            audioManager.playInterfaceSound("kill")
        }
    });

    // Handle weapon-fire events (spatial audio for all entities)
    registerEventListener('weaponFired', (data) => {
        if (data.x !== undefined) {
            const mesh = renderSystem.getMesh(data.shooterId);
            audioManager.playWeaponShot(data.weaponId, mesh);
        }
    });

    registerEventListener('bulletImpact', (data) => {
        if (data.x !== undefined) {
            //audioManager.playSoundAt('bulletImpact', { x: data.x, y: data.y, z: data.z });
        }
    });

    // Handle kill streak events
    registerEventListener('killStreak', (data) => {
        if (isLocalPlayer(data.playerId)){
            hud.showKillStreak(data.streakName);
            audioManager.playInterfaceSound(data.streakName)
        }
        const nameDisplay = data.playerName || data.playerId;
        hud.addKillFeedEntry(`${nameDisplay}: ${data.streakName}!`);
    });

    registerEventListener('matchStarted', (data) => {
        currentMatchState = {
            ...currentMatchState,
            ...data,
            status: 'running',
        };
        audioManager.playInterfaceSound("matchStart");
        hud.hideMatchEnd();
        hud.updateMatchState(currentMatchState);
    });

    registerEventListener('matchEnded', (data) => {
        currentMatchState = {
            ...currentMatchState,
            ...data,
            status: 'finished',
        };
        hud.updateMatchState(currentMatchState);
        hud.showMatchEnd(currentMatchState,teamOfEntity(myId));
        if (currentMatchState.winnerTeam === teamOfEntity(myId)) {
            audioManager.playInterfaceSound("victory");
        } else if (currentMatchState.winnerTeam !== 0) {
            audioManager.playInterfaceSound("defeat");
        }
    });

    registerEventListener('matchReset', (data) => {
        currentMatchState = {
            ...currentMatchState,
            ...data,
            status: 'running',
            restartInMs: 0,
        };
        hud.hideMatchEnd();
        hud.updateMatchState(currentMatchState);
    });

    registerEventListener('playerRespawned', (data) => {
        audioManager.playSoundAt('regenerate', { x: data.x, y: data.y, z: data.z });
        if (isLocalPlayer(data.playerId)) {
            if (data.healthMax !== undefined) myMaxHealth = data.healthMax;
            myHealth = data.health ?? myMaxHealth;
            hud.updateHealth(myHealth, myMaxHealth);
            hud.updateArmor(0);
            hud.updateShield(0);
            hud.hideRespawnCountdown();
        }
    });

    // Pickups
    registerEventListener('pickupCollected', (data) => {
        renderSystem.hidePickupMesh(data.id);
        if (data.type === 0 || data.type === 2) { // Health vial or crystal shard
            specialEffects.healingEffect(data.collectorId);
        }else if (data.type === 1) { // Armor shard
            specialEffects.armorEffect(data.collectorId);
        }
    });
    registerEventListener('pickupRespawned', (data) => {
        renderSystem.showPickupMesh(data.id);
    });

    // Ability VFX events (client-side sound/flash only — RenderSystem handles geometry)
    registerEventListener('shadowLightning', (data) => {
        const mesh = renderSystem.getMesh(data.shooterId);
        audioManager.playHeroAbilityLine(1, 'ability1', mesh);
    });

    registerEventListener('shadowLightningStrike', (data) => {
        renderSystem.vfxShadowLightningStrike(data);
        audioManager.playSoundAt('thunder', { x: data.x, y: data.y, z: data.z });
        audioManager.playSoundAt('thunderScream', { x: data.x, y: data.y, z: data.z }, { pitch: 0.5 });
    });
    registerEventListener('shadowTeleport', (data) => {
        renderSystem.vfxShadowTeleport(data);
        const mesh = renderSystem.getMesh(data.id);
        audioManager.playHeroAbilityLine(1, 'ability2', mesh);
    });
    registerEventListener('shadowStormStart', (data) => {
        renderSystem.vfxShadowStormStart(data);
        if (isLocalPlayer(data.id)) hud.showSelfEffect('shadowStorm', 'Shadow Storm - Unleashed!', '#690a76');
        if (data.x != null) {
            const mesh = renderSystem.getMesh(data.id);
            audioManager.playHeroAbilityLine(1, 'ultimate', mesh);
            // Start looping electricity sound
            audioManager.startSoundLoop('electricityLoop', mesh);
        }
    });
    registerEventListener('shadowStormTick',  (data) => { renderSystem.vfxShadowStormTick(data);  });
    registerEventListener('shadowStormEnd',   (data) => { 
        if (isLocalPlayer(data.id)) hud.hideSelfEffect('shadowStorm');
        // Stop looping electricity sound
        audioManager.stopSoundLoop('electricityLoop', data.id);
    });
    registerEventListener('grenadeThrown', (data) => {
        renderSystem.vfxGrenadeThrown(data);
        const mesh = renderSystem.getMesh(data.throwerId);
        audioManager.playHeroAbilityLine(2, 'ability1', mesh);
    });
    registerEventListener('grenadeExploded',  (data) => { renderSystem.vfxGrenadeExploded(data);  });
    registerEventListener('willpowerActivated', (data) => {
        if (isLocalPlayer(data.id)) hud.showSelfEffect('willpower', 'Willpower - Empowered', '#1378d1');
        renderSystem.vfxWillpower(data);
        const mesh = renderSystem.getMesh(data.id);
        audioManager.playSoundAt('armor', mesh);
        audioManager.playHeroAbilityLine(2, 'ability2', mesh);
    });
    registerEventListener('willpowerExpired', (data) => {
        if (isLocalPlayer(data.id)) hud.hideSelfEffect('willpower');
        //renderSystem.vfxWillpowerExpired(data);
    });
    registerEventListener('clusterStrikeBegin', (data) => {
        renderSystem.vfxClusterStrikeBegin(data);
        const mesh = renderSystem.getMesh(data.id);
        audioManager.playHeroAbilityLine(2, 'ultimate', mesh);
    });
    registerEventListener('bombImpact',       (data) => { 
        specialEffects.spawnExplosion(data);
    });

    // ── Father Callas ability events ──────────────────────────────────────────

    registerEventListener('siphonLifeStart', (data) => {
        renderSystem.vfxSiphonLifeStart(data);
        if (data.id != null) {
            const mesh = renderSystem.getMesh(data.id);
            audioManager.playHeroAbilityLine(3, 'ability1', mesh);
        }
        if (isLocalPlayer(data.id)) hud.showSelfEffect('siphonLife', '♥ Siphon Life – Draining', '#ff2244');
    });

    registerEventListener('siphonLifeTick', (data) => {
        renderSystem.vfxSiphonLifeTick(data);
    });

    registerEventListener('siphonLifeEnd', (data) => {
        renderSystem.vfxSiphonLifeEnd(data);
        if (isLocalPlayer(data.id)) hud.hideSelfEffect('siphonLife');
    });

    registerEventListener('ironStandActivated', (data) => {
        renderSystem.vfxIronStandActivated(data);
        const mesh = renderSystem.getMesh(data.id);
        audioManager.playHeroAbilityLine(3, 'ability2', mesh);
        if (isLocalPlayer(data.id)) {
            hud.showSelfEffect('ironStandActive', '★ Iron Stand – Invulnerable', '#ffcc00');
            hud.showScreenTint('ironStand', 'rgba(255,180,0,0.08)', '#ffcc00',
                'IRON STAND – INVULNERABLE');
        }
    });

    registerEventListener('ironStandExpired', (data) => {
        renderSystem.vfxIronStandExpired(data);
        if (isLocalPlayer(data.id)) {
            hud.hideSelfEffect('ironStandActive');
            hud.hideScreenTint('ironStand');
            hud.showSelfEffect('ironStandShield', '◆ Shield Phase – 20% dmg → shield', '#3399ff');
        }
    });

    registerEventListener('ironStandShieldExpired', (data) => {
        if (isLocalPlayer(data.id)) {
            hud.hideSelfEffect('ironStandShield');
        }
    });

    registerEventListener('shadowRealmBanish', (data) => {
        renderSystem.vfxShadowRealmBanish(data);
        const mesh = data.casterId ? renderSystem.getMesh(data.casterId) : null;
        audioManager.playHeroAbilityLine(3, 'ultimate', mesh);
        // If I am the banished target, show a full-screen Shadow Realm veil
        if (isLocalPlayer(data.targetId)) {
            hud.showSelfEffect('shadowRealm', '● You Are Banished – Cannot Act', '#cc66ff');
            hud.showScreenTint('shadowRealm',
                'rgba(40,0,60,0.55)', '#cc44ff',
                'SHADOW REALM – CANNOT ACT');
            audioManager.startLoopInterfaceSound('demonWind');
            changeFog(new THREE.FogExp2('rgba(48, 0, 72, 0.5)', 0.35));
        }
        // If I banished someone, add a kill-feed note
        if (isLocalPlayer(data.casterId)) {
            const victimName = data.targetId || '?';
            hud.addKillFeedEntry(`You banished ${victimName} to the Shadow Realm!`);
        }
    });

    registerEventListener('shadowRealmReturn', (data) => {
        renderSystem.vfxShadowRealmReturn(data);
        if (isLocalPlayer(data.targetId)) {
            hud.hideSelfEffect('shadowRealm');
            hud.hideScreenTint('shadowRealm');
            audioManager.stopLoopInterfaceSound('demonWind');
            changeFog(null);
        }
    });

    // ── Selene ability events ──────────────────────────────────────────────────────────

    registerEventListener('crystalSmashStart', (data) => {
        renderSystem.vfxCrystalSmashStart(data);
        if (data.id != null) {
            const mesh = renderSystem.getMesh(data.id);
            audioManager.playHeroAbilityLine(4, 'ability1', mesh);
        }
        if (isLocalPlayer(data.id)) {
            hud.showSelfEffect('crystalSmash', '⚡ Crystal Smash – Dashing!', '#00eedd');
            predictionSystem.startCrystalSmash(data.yaw, data.duration);
        }
    });

    registerEventListener('crystalSmashHit', (data) => {
        renderSystem.vfxCrystalSmashHit(data);
        if (isLocalPlayer(data.id)) {
            hud.hideSelfEffect('crystalSmash');
            predictionSystem.stopCrystalSmash();
        }
    });

    registerEventListener('crystalShardDropped', (data) => {
        renderSystem.vfxCrystalShardDropped(data);
    });

    registerEventListener('crystalShardExpired', (data) => {
        renderSystem.vfxCrystalShardExpired(data);
    });

    registerEventListener('astralElevationStart', (data) => {
        renderSystem.vfxAstralElevationStart(data);
        if (data.id != null) {
            const mesh = renderSystem.getMesh(data.id);
            audioManager.playHeroAbilityLine(4, 'ability2', mesh);
        }
        if (isLocalPlayer(data.id)) {
            hud.showSelfEffect('astralFlight', '▲ Astral Elevation – In Flight', '#88aaff');
            hud.showScreenTint('astralElevation', 'rgba(60,100,200,0.07)', '#88aaff', 'ASTRAL ELEVATION');
        }
    });

    registerEventListener('astralElevationEnd', (data) => {
        renderSystem.vfxAstralElevationEnd(data);
        if (isLocalPlayer(data.id)) {
            hud.hideSelfEffect('astralFlight');
            hud.hideScreenTint('astralElevation');
            hud.showSelfEffect('astralBonus', '⚔ Weapon Bonus – +30% Damage', '#ffcc00');
        }
    });

    registerEventListener('astralWeaponBonusExpired', (data) => {
        renderSystem.vfxAstralWeaponBonusExpired(data);
        if (isLocalPlayer(data.id)) hud.hideSelfEffect('astralBonus');
    });

    registerEventListener('lunarEclipseCharge', (data) => {
        renderSystem.vfxLunarEclipseCharge(data);
        if (data.id != null) {
            const mesh = renderSystem.getMesh(data.id);
            audioManager.playHeroAbilityLine(4, 'ultimate', mesh);
        }
        if (isLocalPlayer(data.id)) {
            hud.showSelfEffect('lunarEclipse', '☉ Lunar Eclipse - Charging…', '#ccddff');
            hud.showScreenTint('lunarEclipse', 'rgba(120,160,255,0.10)', '#ccddff', 'LUNAR ECLIPSE');
        }
    });

    registerEventListener('lunarEclipseBlast', (data) => {
        renderSystem.vfxLunarEclipseBlast(data);
        if (isLocalPlayer(data.id)) {
            hud.hideSelfEffect('lunarEclipse');
            hud.hideScreenTint('lunarEclipse');
        }
        // If local player was caught in the blast, show a silence HUD indicator
        if (data.hitTargetIds && data.hitTargetIds.includes(myId)) {
            hud.showSelfEffect('silenced', '🔇 Silenced - Cannot Use Abilities', '#4466ff');
            hud.showScreenTint('silenced', 'rgba(40,60,180,0.08)', '#4466ff', 'SILENCED');
        }
    });

    registerEventListener('silenceExpired', (data) => {
        if (isLocalPlayer(data.id)) {
            hud.hideSelfEffect('silenced');
            hud.hideScreenTint('silenced');
        }
    });

    // ── Fat Jerome ability events ──────────────────────────────────────────────

    registerEventListener('shoulderChargeStart', (data) => {
        renderSystem.vfxShoulderChargeStart(data);
        if (data.id != null) {
            const mesh = renderSystem.getMesh(data.id);
            audioManager.playHeroAbilityLine(5, 'ability1', mesh);
        }
        if (isLocalPlayer(data.id)) {
            hud.showSelfEffect('shoulderCharge', '💨 Shoulder Charge - CHARGING!', '#a0826d');
        }
    });

    registerEventListener('shoulderChargeHit', (data) => {
        renderSystem.vfxShoulderChargeHit(data);
        if (isLocalPlayer(data.id)) {
            // Show brief hit feedback
            hud.showSelfEffect('shoulderChargeHit', '💥 HIT!', '#ffaa44');
            setTimeout(() => hud.hideSelfEffect('shoulderChargeHit'), 300);
        }
    });

    registerEventListener('shoulderChargeEnd', (data) => {
        if (isLocalPlayer(data.id)) {
            hud.hideSelfEffect('shoulderCharge');
        }
    });

    registerEventListener('buttSmashCharging', (data) => {
        renderSystem.vfxButtSmashCharging(data);
        if (isLocalPlayer(data.id)) {
            hud.showSelfEffect('buttSmash', '🔨 Butt Smash - Charging up...', '#ffcc00');
        }
    });

    registerEventListener('buttSmashLaunch', (data) => {
        renderSystem.vfxButtSmashLaunch(data);
        const mesh = renderSystem.getMesh(data.id);
        audioManager.playSoundAt('buttSmashInit', mesh);
        if (isLocalPlayer(data.id)) {
            hud.hideSelfEffect('buttSmash');
            hud.showSelfEffect('buttSmash', '🚀 Butt Smash - AIRBORNE!', '#ff8811');
        }
    });

    registerEventListener('buttSmashImpact', (data) => {
        renderSystem.vfxButtSmashImpact(data);
        const mesh = renderSystem.getMesh(data.id);
        audioManager.playHeroAbilityLine(5, 'ability2', mesh);
        if (isLocalPlayer(data.id)) {
            hud.hideSelfEffect('buttSmash');
        }
    });

    registerEventListener('fatalFlatulenceStart', (data) => {
        renderSystem.vfxFatalFlatulenceStart(data);
        if (data.id != null) {
            const mesh = renderSystem.getMesh(data.id);
            audioManager.playHeroAbilityLine(5, 'ultimate', mesh);
        }
        if (isLocalPlayer(data.id)) {
            hud.showSelfEffect('fatalFlatulence', '💚 Fatal Flatulence - ACTIVATED!', '#88ff44');
            hud.showScreenTint('fatalFlatulence', 'rgba(100,200,50,0.12)', '#88ff44', 'FATAL FLATULENCE');
        }
    });

    registerEventListener('fartCloudSpawned', (data) => {
        renderSystem.vfxFartCloudSpawned(data);
        // Play random fart sound at the cloud spawn location
        if (data.x != null) {
            audioManager.playRandomSoundAt("farts",{ x: data.x, y: data.y, z: data.z });
        }
    });

    // ── Kyoukan ability events ───────────────────────────────────────────────

    registerEventListener('arrowOfGratitudeCast', (data) => {
        renderSystem.vfxArrowOfGratitudeCast(data);
        const pos = safePos(data);
        const meshTarget = renderSystem.getMesh(data.targetId);
        const mesh = renderSystem.getMesh(data.casterId);
        specialEffects.healingEffect(data.targetId);
        if (data.casterId != null) {
            if (data.casterId === data.targetId && inputs.abilitySelf) {
                audioManager.playHeroAbilityLine(6, 'ability1_self', mesh);
            } else {
                audioManager.playHeroAbilityLine(6, 'ability1', mesh);
            }
        }
        if (isLocalPlayer(data.targetId)) {
            hud.showSelfEffect('kyoukanHeal', `✚ Arrow of Gratitude +${Math.round(data.healAmount ?? 0)} HP`, '#63d1ff');
            setTimeout(() => hud.hideSelfEffect('kyoukanHeal'), 900);
        }
    });

    registerEventListener('healingRiteCast', (data) => {
        renderSystem.vfxHealingRiteCast(data);
        const pos = safePos(data);
        renderSystem.vfxHealingRiteAddGlint({ id: data.targetId }); // Initial tick on cast for instant feedback (server will also trigger this)
        const meshTarget = renderSystem.getMesh(data.targetId);
        const mesh = renderSystem.getMesh(data.casterId);
        audioManager.playSoundAt('regeneration', meshTarget);
        if (data.casterId != null) {
            if (data.casterId === data.targetId && inputs.abilitySelf) {
                audioManager.playHeroAbilityLine(7, 'ability2_self', mesh);
            } else {
                audioManager.playHeroAbilityLine(7, 'ability2', mesh);
            }
        }
        if (isLocalPlayer(data.targetId)) {
            hud.showSelfEffect('healingRite', `✚ Healing Rite`, '#18d049');
            //setTimeout(() => hud.hideSelfEffect('healingRite'), 900);
        }
    });

    registerEventListener('healingRiteTick', (data) => {
        specialEffects.healingEffect(data.id);
        if(!renderSystem.hasGlint(data.id)){
            renderSystem.vfxHealingRiteAddGlint({ id: data.id });
        }
    });

    registerEventListener('healingRiteEnd', (data) => {
        if (data.finished){
            renderSystem.vfxHealingRiteRemoveGlint({ id: data.id });
            hud.hideSelfEffect('healingRite');
        }
    });

    registerEventListener('holyWaterThrown', (data) => {  
        const pos = safePos(data);
        const mesh = renderSystem.getMesh(data.id);
        audioManager.playHeroAbilityLine(7, 'ability1', mesh);
        audioManager.playSoundAt('holyWater', { x: pos.x, y: pos.y, z: pos.z });
    });

    registerEventListener('holyWaterTick', (data) => {
        renderSystem.vfxHolyWaterTick(data);
    });

    registerEventListener('hammerOfJusticeCast', (data) => {
        const pos = safePos(data);
        const mesh = renderSystem.getMesh(data.id);
        audioManager.playHeroAbilityLine(7, 'ultimate', mesh);
        renderSystem.vfxHammerOfJusticeCast(data);
    });

    registerEventListener('hammerOfJusticeHit', (data) => {
        renderSystem.vfxShoulderChargeHit(data);
        const pos = safePos(data);
        audioManager.playSoundAt('hammerHit', { x: pos.x, y: pos.y, z: pos.z });

    });

    registerEventListener('majesticLeapStart', (data) => {
        renderSystem.vfxMajesticLeapStart(data);
        const pos = safePos(data);
        audioManager.playSoundAt('jumppad', { x: pos.x, y: pos.y, z: pos.z });
        if (data.id != null) {
            const mesh = renderSystem.getMesh(data.id);
            audioManager.playHeroAbilityLine(6, 'ability2', mesh);
        }
        if (isLocalPlayer(data.id)) {
            hud.showSelfEffect('majesticLeap', '↟ Majestic Leap', '#63d1ff');
        }
    });

    registerEventListener('majesticLeapEnd', (data) => {
        renderSystem.vfxMajesticLeapEnd(data);
        if (isLocalPlayer(data.id)) {
            hud.hideSelfEffect('majesticLeap');
        }
    });

    registerEventListener('heroicAuraStart', (data) => {
        renderSystem.vfxHeroicAuraStart(data);
        if (data.id != null) {
            const pos = safePos(data);
            const mesh = renderSystem.getMesh(data.id);
            audioManager.playHeroAbilityLine(6, 'ultimate', mesh);
        }
        if (isLocalPlayer(data.id)) {
            hud.showSelfEffect('heroicAura', '✦ Heroic Aura Active', '#81dbff');
            hud.showScreenTint('heroicAura', 'rgba(70, 150, 255, 0.08)', '#81dbff', 'HEROIC AURA');
        }
    });

    registerEventListener('heroicAuraTick', (data) => {
        renderSystem.vfxHeroicAuraTick(data);
    });

    registerEventListener('heroicAuraEnd', (data) => {
        renderSystem.vfxHeroicAuraEnd(data);
        if (isLocalPlayer(data.id)) {
            hud.hideSelfEffect('heroicAura');
            hud.hideScreenTint('heroicAura');
        }
    });

    registerEventListener('ultimateEnded', (data) => {
        if (isLocalPlayer(data.id)) {
            // Hide any ultimate-specific effects
            hud.hideSelfEffect('fatalFlatulence');
            hud.hideScreenTint('fatalFlatulence');
        }
    });

    channel.onRaw((rawMsg) => {
        const now = performance.now();
        const rawDt = (now - lastTickTime) / 1000;
        // Clamp delta time to avoid spiral-of-death on tab re-focus / very long frames
        const dt = Math.max(0.001, Math.min(rawDt, 1 / 20));
        lastTickTime = now;

        const decoded = Codec.decode(rawMsg);
        if (!decoded || typeof decoded !== 'object') {
            return;
        }

        const players = (decoded.players && typeof decoded.players === 'object') ? decoded.players : {};
        const bots = (decoded.bots && typeof decoded.bots === 'object') ? decoded.bots : {};
        const bullets = Array.isArray(decoded.bullets) ? decoded.bullets : [];
        const pickups = Array.isArray(decoded.pickups) ? decoded.pickups : [];
        const match = (decoded.match && typeof decoded.match === 'object') ? decoded.match : null;

        renderSystem.setFrameTime(now);
        if (match) {
            currentMatchState = { ...currentMatchState, ...match };
            hud.updateMatchState(currentMatchState);
        }
        // 1. Update Players
        for (const id in players) {
            const playerData = players[id];
            if (!playerData || typeof playerData !== 'object') continue;
            
            // Create mesh if it doesn't exist
            if (!renderSystem.hasMesh(id)) {
                renderSystem.createPlayerMesh(id, playerData.eid, playerData.color, playerData.team == teamOfEntity(myId));
            }
            
            // Update mesh position and rotation
            if (id === myId) {
                // ── Local player: client-side prediction ────────────────────────
                // Seed the predictor on first appearance in the state stream
                hud.updateDebugInfo(playerData,currentPing)
                if (!predictionInitialized) {
                    predictionSystem.initialize(playerData.x, playerData.y, playerData.z);
                    predictionInitialized = true;
                }
                // Reconcile: if predicted pos diverges > 5 cm from server, rewind
                predictionSystem.reconcile(playerData, inputBuffer);
                // Render at the predicted (lag-free) position
                const pred = predictionSystem.getPosition();
                renderSystem.updatePlayerMesh(id, { ...playerData, ...pred }, true);

                myHealth    = playerData.health;
                myMaxHealth = playerData.healthMax ?? myMaxHealth;
                hud.updateHealth(myHealth, myMaxHealth);
                if (playerData.armor  !== undefined) hud.updateArmor(playerData.armor);
                if (playerData.shield !== undefined) hud.updateShield(playerData.shield);
                if (playerData.ammo   !== undefined) hud.updateAmmo(playerData.ammo);
                const myHeroClass = playerData.heroClass ?? 0;
                const maxCds = HERO_CD_MAXES[myHeroClass] ?? HERO_CD_MAXES[0];
                hud.updateAbilityCooldowns(playerData, maxCds);
            } else {
                // ── Remote players: snapshot interpolation (render 100 ms behind) ──
                interpolationSystem.addSnapshot(id, playerData);
                const interp = interpolationSystem.getInterpolated(id);
                renderSystem.updatePlayerMesh(id, interp ?? playerData, true);
            }

            // Update score + hero class cache
            heroClassCache.set(id, { hero: playerData.heroClass ?? 0,weapon: playerData.weaponId ?? 0 });
            playerScores[id] = {
                id: id,
                name: playerData.name || id,
                hero: playerData.heroClass ?? 0,
                team: playerData.team ?? 0,
                kills: playerData.kills || 0,
                deaths: playerData.deaths || 0,
            };
        }

        // 2. Update Bots
        for (const id in bots) {
            const botData = bots[id];
            if (!botData || typeof botData !== 'object') continue;
            
            // Create mesh if it doesn't exist
            if (!renderSystem.hasMesh(id)) {
                renderSystem.createPlayerMesh(id, botData.eid, botData.color, botData.team == teamOfEntity(myId));
            }

            // Update score + hero class cache
            heroClassCache.set(id, { hero: botData.heroClass ?? 0, weapon: botData.weaponId ?? 0 });
            playerScores[id] = {
                id: id,
                name: botData.name || id,
                hero: botData.heroClass ?? 0,
                team: botData.team ?? 0,
                kills: botData.kills || 0,
                deaths: botData.deaths || 0,
            };
            
            // Remote bots: snapshot interpolation (render 100 ms behind)
            interpolationSystem.addSnapshot(id, botData);
            const botInterp = interpolationSystem.getInterpolated(id);
            renderSystem.updatePlayerMesh(id, botInterp ?? botData, false);
        }

        const serverBulletIds = new Set(bullets.filter((b) => b && typeof b === 'object').map((b) => b.id));
        const currentBullets = new Set();
        
        // Track which bullets we have
        renderSystem.entityMeshes.forEach((mesh, key) => {
            if (typeof key === 'number' && !players[key]) {
                currentBullets.add(key);
            }
        });
        
        for (const bid of currentBullets) {
            if (!serverBulletIds.has(bid)) {
                renderSystem.removeMesh(bid);
            }
        }

        bullets.forEach(b => {
            if (!b || typeof b !== 'object' || b.id == null) return;
            if (!renderSystem.hasMesh(b.id)) {
                renderSystem.createBulletMesh(b.id);
            }
            renderSystem.updateBulletMesh(b.id, b);
        });

        // 4. Sync pickup meshes
        if (pickups.length) {
            for (const pu of pickups) {
                if (!pu || typeof pu !== 'object' || pu.id == null) continue;
                if (!renderSystem.hasPickupMesh(pu.id)) {
                    renderSystem.createPickupMesh(pu.id, pu.type);
                }
                renderSystem.updatePickupMesh(pu.id, pu);
            }
        }

        // 3. Update Camera (Over-the-Shoulder)
        const myMesh = renderSystem.getMesh(myId);
        aimYaw = yaw;
        aimPitch = pitch;
        if (myMesh) {
            const cameraLerpAlpha = 1 - Math.exp(-8 * dt);

            headPosition.copy(myMesh.position);
            headPosition.y += PLAYER_HEAD_OFFSET;

            // Rotate right-shoulder offset by yaw (horizontal rotation)
            cameraOffset.copy(CAMERA_SHOULDER_OFFSET);
            cameraOffset.applyAxisAngle(WORLD_UP, yaw);

            desiredCameraPos.copy(myMesh.position).add(cameraOffset);
            finalCameraPos.copy(desiredCameraPos);

            // Camera collision: slide toward the head if a wall blocks the view
            if (mapRoot) {
                aimDirection.copy(desiredCameraPos).sub(headPosition);
                cameraCollisionRaycaster.set(headPosition, aimDirection.normalize());
                cameraCollisionRaycaster.far = headPosition.distanceTo(desiredCameraPos);
                const hits = cameraCollisionRaycaster.intersectObjects(mapRoot.children, true);
                if (hits.length > 0) {
                    const hit = hits[0];
                    const movement = desiredCameraPos.clone().sub(headPosition);
                    const n = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
                    const slide = movement.sub(n.multiplyScalar(movement.dot(n)));
                    finalCameraPos.copy(headPosition).add(slide);
                    finalCameraPos.add(n.multiplyScalar(CAMERA_COLLISION_PUSH));
                }
            }

            camera.position.lerp(finalCameraPos, cameraLerpAlpha); // Frame-rate independent smoothing

            // Aim ray from camera through crosshair (screen center)
            cameraForward.set(
                -Math.sin(yaw) * Math.cos(pitch),
                Math.sin(pitch),
                -Math.cos(yaw) * Math.cos(pitch)
            ).normalize();

            aimTarget.copy(camera.position).addScaledVector(cameraForward, CAMERA_AIM_DISTANCE);
            if (mapRoot) {
                cameraAimRaycaster.set(camera.position, cameraForward);
                cameraAimRaycaster.far = CAMERA_AIM_DISTANCE;
                cameraAimRaycaster.near = 12; // Don't aim at walls right in front of the camera
                const hits = cameraAimRaycaster.intersectObjects(mapRoot.children, true);
                if (hits.length > 0) {
                    aimTarget.copy(hits[0].point);
                }
            }
            camera.lookAt(aimTarget);

            // Parallax-correct aim: compute yaw/pitch from head to crosshair target
            aimDirection.copy(aimTarget).sub(headPosition);
            const aimFlatLen = Math.hypot(aimDirection.x, aimDirection.z);
            if (aimFlatLen > 1e-6) {
                aimYaw = Math.atan2(-aimDirection.x, -aimDirection.z);
                aimPitch = Math.atan2(aimDirection.y, aimFlatLen);
            }
        }
        
        // Update mini scoreboard every tick
        hud.updateScoreboard(playerScores, myId, currentMatchState);
        // ── Build & send input packet ────────────────────────────────────────────
        const validatedInputs = validatePlayerInput(inputs);
        const validatedPitch = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, aimPitch));

        inputSeq++;
        const inputPacket = {
            seq:    inputSeq,
            inputs: { ...validatedInputs },
            yaw: aimYaw,
            pitch: validatedPitch,
            dt,
        };

        // Store in rolling buffer so reconciliation can replay unacknowledged inputs
        inputBuffer.push({ ...inputPacket, timestamp: now });

        // Prune acknowledged / expired inputs (older than 1 second)
        const cutoff = now - 1000;
        while (inputBuffer.length > 0 && inputBuffer[0].timestamp < cutoff) {
            inputBuffer.shift();
        }

        // Apply prediction locally – instant response before the server round-trip
        if (predictionInitialized) {
            predictionSystem.applyInput(inputPacket, dt);
        }

        // Send inputs to server.
        // Flow-control: enforce a 120 Hz ceiling so a tab un-focus / catch-up
        // burst cannot flood the server with stale inputs.
        if (now - lastInputSendTime >= INPUT_SEND_INTERVAL) {
            lastInputSendTime = now;
            channel.raw.emit(Codec.encode(inputPacket));
        }
    });
}

// --- GAME START ---
function startGame() {
    if (gameStarted) return;
    gameStarted = true;
    
    // Hide main menu
    const mainMenu = document.getElementById('main-menu');
    if (mainMenu) {
        mainMenu.classList.add('hidden');
    }
    
    // Show game canvas
    renderer.domElement.classList.add('active');
    
    // Setup game UI (HUD)
    hud = new HUD();
    hud.init();

    if (!scopeOverlay) {
        scopeOverlay = document.createElement('div');
        scopeOverlay.id = 'scope-overlay';
        scopeOverlay.style.cssText = `
            position: fixed;
            inset: 0;
            display: none;
            pointer-events: none;
            z-index: 40;
            background:
                radial-gradient(circle at center,
                    transparent 0,
                    transparent 19%,
                    rgba(0, 0, 0, 0.65) 34%,
                    rgba(0, 0, 0, 0.92) 62%,
                    rgba(0, 0, 0, 1) 100%);
        `;
        const cross = document.createElement('div');
        cross.style.cssText = `
            position: absolute;
            left: 50%;
            top: 50%;
            width: 14px;
            height: 14px;
            transform: translate(-50%, -50%);
            border: 1px solid rgba(180, 230, 255, 0.95);
            border-radius: 50%;
            box-shadow: 0 0 10px rgba(120, 200, 255, 0.8);
        `;
        scopeOverlay.appendChild(cross);
        document.body.appendChild(scopeOverlay);
    }
    setScoped(false);

    // Connect to server
    channel = geckos({ 
        url: 'http://localhost',
        port: 3002,
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
        ]            
    });

    heroSelect = new HeroSelect(document.body);
    heroSelect.show((heroClassId) => {
        if (channel) channel.emit('setHero', { heroClass: heroClassId });
    });

    connectionTimeout = setTimeout(() => {
        if (!myId) {
            showConnectionError(
                'Could not reach the game server.\nPlease check that the server is running and try again.'
            );
        }
    }, 10000);

    // Setup network event handlers
    setupNetworkHandlers();

    // Hide HeroSelect when server confirms hero selection
    channel.on('heroSet', () => {
        if (heroSelect) heroSelect.hide();
    });
}

// Add Play button event listener
window.addEventListener('DOMContentLoaded', () => {
    audioManager.init();
    audioManager.playInterfaceSound("gameBootup");
    const playButton = document.getElementById('play-button');
    if (playButton) {
        playButton.addEventListener('click', () => {
            startGame();
            audioManager.startLoopInterfaceSound('menuLoop');
        });
    }
    
    const howToPlayButton = document.getElementById('howtoplay-button');
    if (howToPlayButton) {
        howToPlayButton.addEventListener('click', () => openModal('howtoplay-modal'));
    }
    
    const heroesButton = document.getElementById('heroes-button');
    if (heroesButton) {
        heroesButton.addEventListener('click', () => openModal('heroes-modal'));
    }

    const backBtn = document.getElementById('connection-error-back-btn');
    if (backBtn) {
        backBtn.addEventListener('click', backToMenu);
    }
    const usernameInput = document.getElementById('username-input');
    const savedName = localStorage.getItem('lastUsername');
    if (usernameInput && savedName) {
        usernameInput.value = savedName;
    }
});

// Modal functions
function openModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) {
        modal.classList.add('active');
    }
}

window.closeModal = function(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) {
        modal.classList.remove('active');
    }
}

// Close modal when clicking outside content
window.addEventListener('click', (e) => {
    if (e.target.classList.contains('modal')) {
        e.target.classList.remove('active');
    }
});

// --- RENDER ---
function animate() {
    requestAnimationFrame(animate);

    renderer.render(scene, camera);
}
animate();
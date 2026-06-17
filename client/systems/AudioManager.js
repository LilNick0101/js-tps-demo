import * as THREE from 'three';

const HERO_NAMES = {
    0: 'dummy', 1: 'sven', 2: 'tamerlane', 3: 'fcallas',
    4: 'selene', 5: 'fatjerome', 6: 'kyoukan', 7: 'templar',
};

const VOICE_LINE_COUNTS = {
    kills: 10, deaths: 10, ability1: 10, ability1_self: 10,
    ability2: 10, ability2_self: 10, ultimate: 10,
};

class AudioManager {
    constructor() {
        this.enabled = true;
        this.initialized = false;

        // Sound Capping
        this.playHistory = new Map(); 
        this.MAX_CONCURRENT_SOUNDS = 4; 
        this.THROTTLE_WINDOW_MS = 100;

        // Three.js Core Audio Objects
        this.listener = null;
        this.audioLoader = new THREE.AudioLoader();

        // Sound Banks
        this.sounds = {};         // UI / Stereo Non-spatial
        this.weaponSounds = {};   // Spatial Weapons
        this.spatialSounds = {};  // Spatial Abilities
        this.heroVoices = {};     // Spatial Voice Lines Structure: {name: {category: [PositionalAudio]}}

        // Tracking active loops by entityId to let us stop them later
        // Map<entityId, THREE.PositionalAudio>
        this.activeLoopingSounds = new Map();
        this.scene = null; // Store reference to the Three.js scene for dynamic sound attachment

        // Asset Maps
        this.streakSoundFiles = {
            'Double Kill': '/sounds/killstreak/kills2.ogg',
            'Triple Kill': '/sounds/killstreak/kills3.ogg',
            'Mega Kill': '/sounds/killstreak/kills4.ogg',
            'Killing Spree': '/sounds/killstreak/kills1.ogg',
            'Ultra Kill': '/sounds/killstreak/kills5.ogg',
            'Ownage': '/sounds/killstreak/kills6.ogg',
            'Monster Kill': '/sounds/killstreak/kills7.ogg',
            'Wicked Sick': '/sounds/killstreak/kills8.ogg',
            'Godlike': '/sounds/killstreak/kills9.ogg',
            'Holy Shit': '/sounds/killstreak/kills10.ogg',
            'Unstoppable': '/sounds/killstreak/kills11.ogg',
        };

        this.uiSounds = {
            "victory": "/sounds/ui/victory.ogg",
            "defeat": "/sounds/ui/defeat.ogg",
            "matchStart": "/sounds/ui/match_start.ogg",
            "demonWind": "/sounds/ui/demon_wind.ogg",
            "firstBlood": "/sounds/killstreak/firstblood.ogg"
        };
        
        this.menuLoopMusic = null;
    }

    /**
     * @param {THREE.Camera} camera - The local player's camera
     */
    init(camera,scene) {
        if (this.initialized) return;
        console.log('Initializing Three.js Audio System...');

        // 1. Setup the listener and attach it to the camera
        this.listener = new THREE.AudioListener();
        camera.add(this.listener);

        // 2. Load assets
        this._loadSounds();
        this.initialized = true;
        this.scene = scene;
    }

    _loadSounds() {
        // Menu loop setup (Non-spatial)
        this.menuLoopMusic = new THREE.Audio(this.listener);
        this.audioLoader.load('/sounds/ui/house_lo.wav', (buffer) => {
            this.menuLoopMusic.setBuffer(buffer);
            this.menuLoopMusic.setLoop(true);
            this.menuLoopMusic.setVolume(0.5);
        });

        // Load Weapons (Spatial)
        this.loadWeaponSound('/sounds/weapons/assault.ogg', 0);
        this.loadWeaponSound('/sounds/weapons/smg.ogg', 1);
        this.loadWeaponSound('/sounds/weapons/shotgun.ogg', 2);
        this.loadWeaponSound('/sounds/weapons/pump_shotgun.ogg', 3);
        this.loadWeaponSound('/sounds/weapons/mach_pistol.ogg', 4);
        this.loadWeaponSound('/sounds/weapons/sniper.ogg', 5);

        // Load Hero Voice Lines (Spatial)
        for (const [classId, heroName] of Object.entries(HERO_NAMES)) {
            this.heroVoices[heroName] = {};
            for (const [category, count] of Object.entries(VOICE_LINE_COUNTS)) {
                const loadedPool = [];
                this.heroVoices[heroName][category] = loadedPool;
                
                for (let i = 1; i <= count; i++) {
                    const suffix = category === 'kills' ? `kill${i}` :
                                   category === 'deaths' ? `death${i}` :
                                   `${category}_${i}`;
                    const src = `/sounds/heroes/${heroName}/${suffix}.ogg`;

                    const positionalSound = new THREE.PositionalAudio(this.listener);
                    this.audioLoader.load(src, (buffer) => {
                        positionalSound.setBuffer(buffer);
                        positionalSound.setRefDistance(15);
                        positionalSound.setRolloffFactor(1.5);
                        positionalSound.setMaxDistance(35);
                        positionalSound.setDistanceModel('inverse');
                        loadedPool.push(positionalSound);
                    }, undefined, () => { /* Handle error gracefully */ });
                }
            }
        }

        // Load UI Sounds (Non-spatial Stereo)
        this._loadUISound('kill', '/sounds/killstreak/kill.ogg', 0.5);
        this._loadUISound('hitmarker', '/sounds/misc/hitmark.ogg', 0.3);
        
        this._loadUISound('gameBootup', '/sounds/ui/game_bootup.ogg', 0.5, (sound) => {
            sound.play();
        });

        this._loadUISound('victory', this.uiSounds.victory, 0.5);
        this._loadUISound('defeat', this.uiSounds.defeat, 0.5);
        this._loadUISound('matchStart', this.uiSounds.matchStart, 0.5);
        this._loadUISound('firstBlood', this.uiSounds.firstBlood, 0.7);
        this._loadUISound('menuLoop', '/sounds/ui/house_lo.wav', 0.5, (sound) => {
            sound.setLoop(true);
        });
        
        this._loadUISound('demonWind', this.uiSounds.demonWind, 0.55, (sound) => {
            sound.setLoop(true);
        });

        for (const [streakName, path] of Object.entries(this.streakSoundFiles)) {
            this._loadUISound(streakName, path, 0.7);
        }

        // Load Ability SFX (Spatial)
        this._loadSpatialSFX('buttSmashInit', '/sounds/abilities/butt_smash_init.ogg', 0.8, 10, 30, 'inverse');
        this._loadSpatialSFX('regeneration', '/sounds/misc/regeneration.ogg', 0.8, 10, 30, 'inverse');
        this._loadSpatialSFX('holyWater', '/sounds/abilities/holy_water.ogg', 0.7, 5, 70, 'linear');
        this._loadSpatialSFX('hammerHit', '/sounds/abilities/hammer_hit.ogg', 0.8, 5, 70, 'linear');
        this._loadSpatialSFX('bulletImpact', '/sounds/abilities/hammer_hit.ogg', 0.7, 6, 60, 'linear');
        this._loadSpatialSFX('thunder', '/sounds/abilities/thunder.ogg', 0.9, 60, 80, 'inverse');
        this._loadSpatialSFX('thunderScream', '/sounds/abilities/scream.ogg', 0.9, 30, 70, 'inverse');
        this._loadSpatialSFX('armor', '/sounds/gameplay/armor.ogg', 0.7, 10, 30, 'linear');
        this._loadSpatialSFX('health', '/sounds/gameplay/health.ogg', 0.7, 10, 30, 'linear');
        this._loadSpatialSFX('jumppad', '/sounds/gameplay/jumppad.ogg', 0.7, 10, 30, 'linear');
        this._loadSpatialSFX('quadDamagePickup', '/sounds/gameplay/quaddamage.ogg', 0.8, 10, 30, 'inverse');
        this._loadSpatialSFX('quadDamageShot', '/sounds/gameplay/quaddamage_shot.ogg', 0.8, 10, 30, 'inverse');
        this._loadSpatialSFX('powerUpExpired', '/sounds/gameplay/powerup_expired.ogg', 0.8, 10, 30, 'inverse');

        // Looping ability
        this._loadSpatialSFX('electricityLoop', '/sounds/abilities/electricity_loop.ogg', 0.7, 10, 30, 'linear', (sound) => {
            sound.setLoop(true);
        });

        // Random Pool Spatial SFX (Farts)
        this.spatialSounds['farts'] = [];
        for (let i = 1; i <= 5; i++) {
            const sound = new THREE.PositionalAudio(this.listener);
            this.audioLoader.load(`/sounds/abilities/fart${i}.ogg`, (buffer) => {
                sound.setBuffer(buffer);
                sound.setVolume(0.9);
                sound.setRolloffFactor(1.5);
                sound.setRefDistance(10);
                sound.setMaxDistance(30);
                sound.setDistanceModel('linear');
                this.spatialSounds['farts'].push(sound);
            });
        }

        this.spatialSounds['explosions'] = [];
        for (let i = 1; i <= 3; i++) {
            const sound = new THREE.PositionalAudio(this.listener);
            this.audioLoader.load(`/sounds/abilities/explosion${i}.ogg`, (buffer) => {
                sound.setBuffer(buffer);
                sound.setVolume(0.9);
                sound.setRolloffFactor(1.5);
                sound.setRefDistance(10);
                sound.setMaxDistance(50);
                sound.setDistanceModel('inverse');
                this.spatialSounds['explosions'].push(sound);
            });
        }
        
        this._loadSpatialSFX('regenerate', '/sounds/misc/regenerate.ogg', 0.7, 10, 30, 'linear');
    }

    loadWeaponSound(path, index) {
        const sound = new THREE.PositionalAudio(this.listener);
        this.audioLoader.load(path, (buffer) => {
            sound.setBuffer(buffer);
            sound.setRolloffFactor(1.5);
            sound.setVolume(0.8);
            sound.setRefDistance(15);
            sound.setMaxDistance(30);
            sound.setDistanceModel('inverse');
            this.weaponSounds[index] = sound;
        });
    }

    _loadUISound(key, path, volume, callback = null) {
        const sound = new THREE.Audio(this.listener);
        this.audioLoader.load(path, (buffer) => {
            sound.setBuffer(buffer);
            sound.setVolume(volume);
            this.sounds[key] = sound;
            if (callback) callback(sound);
        });
    }

    _loadSpatialSFX(key, path, volume, refDist, maxDist, model, callback = null) {
        const sound = new THREE.PositionalAudio(this.listener);
        this.audioLoader.load(path, (buffer) => {
            sound.setBuffer(buffer);
            sound.setVolume(volume);
            sound.setRefDistance(refDist);
            sound.setMaxDistance(maxDist);
            sound.setDistanceModel(model);
            this.spatialSounds[key] = sound;
            if (callback) callback(sound);
        });
    }

    _canPlaySound(soundKey) {
        const now = Date.now();
        let history = this.playHistory.get(soundKey) || [];
        history = history.filter(time => now - time < this.THROTTLE_WINDOW_MS);
        if (history.length >= this.MAX_CONCURRENT_SOUNDS) return false;
        history.push(now);
        this.playHistory.set(soundKey, history);
        return true;
    }

    // ── Helper to position and play spatial objects ─────────────────────────
    _playSpatial(soundInstance, target) {
        if (!soundInstance || !soundInstance.buffer) return;

        // If it's already playing, stop it to restart cleanly
        if (soundInstance.isPlaying) soundInstance.stop();

        let tempObj = null;

        // Spatial Binding Magic:
        if (target instanceof THREE.Object3D) {
            // Option A: If it's a structural 3D Mesh, attach it directly!
            target.add(soundInstance);
        } else if (target && typeof target === 'object' && 'x' in target) {
            // Option B: If it's a loose vector {x,y,z}, update the sound's position variables manually
            tempObj = new THREE.Object3D();
            tempObj.add(soundInstance);
            this.scene.add(tempObj); // Add to scene to ensure it's processed in the graph

            tempObj.position.set(target.x, target.y, target.z);
        }
        soundInstance.play();
            // Cleanup temp objects after sound finishes
        if (tempObj) {
            const duration = soundInstance.buffer.duration * 1000; // Convert to ms
            setTimeout(() => {
                this.scene.remove(tempObj);
                tempObj = null;
            }, duration + 100);
        }
    }

    // ── Spatial Playbacks ───────────────────────────────────────────────────

    /**
     * @param {THREE.Object3D | {x,y,z}} target - Mesh or raw coordinate vector
     */
    playWeaponShot(weaponId, target) {
        if (!this.enabled || !this.initialized) return;
        if (!this._canPlaySound(`weapon_${weaponId}`)) return;

        this._playSpatial(this.weaponSounds[weaponId], target);
    }

    /**
     * @param {THREE.Object3D | {x,y,z}} target
     */
    playHeroVoiceLine(heroClassId, category, target) {
        if (!this.enabled || !this.initialized) return;
        const heroName = HERO_NAMES[heroClassId] ?? 'dummy';
        const pool = this.heroVoices[heroName]?.[category];
        if (!pool || pool.length === 0) return;

        const sound = pool[Math.floor(Math.random() * pool.length)];
        this._playSpatial(sound, target);
    }

    // Legacy wrappers updated to take explicit spatial target targets
    playHeroDeathLine(heroClassId, target) { this.playHeroVoiceLine(heroClassId, 'deaths', target); }
    playHeroKillLine(heroClassId, target)  { this.playHeroVoiceLine(heroClassId, 'kills', target); }
    playHeroAbilityLine(heroClassId, slot, target) { this.playHeroVoiceLine(heroClassId, slot, target); }
    playDeathSound(target, heroClassId = 0) { this.playHeroDeathLine(heroClassId, target); }

    // ── UI / Non-spatial ────────────────────────────────────────────────────

    playInterfaceSound(name) {
        if (!this.enabled || !this.initialized) return;
        const sound = this.sounds[name];
        if (sound && sound.buffer) {
            if (sound.isPlaying) sound.stop();
            sound.play();
        }
    }

    stopMenuLoop() {
        if (!this.enabled || !this.initialized) return;
        if (this.menuLoopMusic?.isPlaying) this.menuLoopMusic.stop();
        if (this.sounds["gameBootup"]?.isPlaying) this.sounds["gameBootup"].stop();
    }

    startLoopInterfaceSound(name) {
        if (!this.enabled || !this.initialized) return;
        const sound = this.sounds[name];
        if (sound && sound.buffer && !sound.isPlaying) sound.play();
    }

    stopLoopInterfaceSound(name) {
        if (!this.enabled || !this.initialized) return;
        const sound = this.sounds[name];
        if (sound && sound.isPlaying) sound.stop();
    }

    // ── Ability SFX ──────────────────────────────────────────────────────────

    /**
     * @param {THREE.Object3D | {x,y,z}} target
     */
    playSoundAt(name, target, options = {}) {
        if (!this.enabled || !this.initialized) return;
        if (!this._canPlaySound(`spatial_${name}`)) return;

        const sound = this.spatialSounds[name];
        if (!sound) return;
        
        if (options.pitch) sound.setPlaybackRate(options.pitch);
        this._playSpatial(sound, target);
    }

    /**
     * Starts a looping positional sound and keeps track of it by entity ID.
     * @param {THREE.Object3D} meshEntity - Must be an active Three.js Object3D/Mesh
     */
    startSoundLoop(name, meshEntity) {
        if (!this.enabled || !this.initialized || !(meshEntity instanceof THREE.Object3D)) return;
        const sound = this.spatialSounds[name];
        if (!sound) return;

        this.stopSoundLoop(name, meshEntity.uuid);

        meshEntity.add(sound);
        sound.play();
        this.activeLoopingSounds.set(meshEntity.uuid, sound);
    }

    stopSoundLoop(name, entityUuid) {
        if (!this.enabled || !this.initialized) return;
        const sound = this.activeLoopingSounds.get(entityUuid);
        if (sound) {
            if (sound.isPlaying) sound.stop();
            this.activeLoopingSounds.delete(entityUuid);
        }
    }

    /**
     * @param {THREE.Object3D | {x,y,z}} target
     */
    playRandomSoundAt(name, target) {
        if (!this.enabled || !this.initialized) return;
        const sounds = this.spatialSounds[name];
        if (!sounds || sounds.length === 0) return;

        const sound = sounds[Math.floor(Math.random() * sounds.length)];
        this._playSpatial(sound, target);
    }

    // ── Utility ──────────────────────────────────────────────────────────────

    toggle() {
        this.enabled = !this.enabled;
        if (this.listener) {
            this.listener.setMasterVolume(this.enabled ? 1.0 : 0.0);
        }
        return this.enabled;
    }
}

export default AudioManager;
import * as THREE from 'three';

const BULLET_TYPES = {
    STANDARD : 0,
    SHOCK_GRENADE : 1,
    HOLY_WATER : 2,
}
/**
 * RenderSystem - Visual Effects and Mesh Management
 */
class RenderSystem {
    constructor(scene) {
        /**
         * @param {THREE.Scene} scene - The Three.js scene to which meshes will be added
         * @type {THREE.Scene}
         */
        this.scene = scene;

        this.lightningTexture = new THREE.TextureLoader().load('/assets/textures/effects/thunder.png');
        this.glowTexture = new THREE.TextureLoader().load('/assets/textures/effects/glow.png');
        
        // Map entity IDs to Three.js objects
        /** @type {Map<string|number, THREE.Object3D>} */
        this.entityMeshes = new Map();
        
        // Bullet tracer data (stores previous positions)
        this.bulletTracers = new Map();

        // Temp vector reused per-frame to avoid allocations
        this._tempVec = new THREE.Vector3();
        // Enemy health bar sprites keyed by entity ID
        this.enemyHealthBars = new Map();
        // Tracks entities with Iron Stand active aura { mat, origEmissiveHex }
        this._ironStandActive = new Map();
        // Tracks entities currently banished { mat, origEmissiveHex }
        this._shadowRealmActive = new Map();
        // Selene – Astral Elevation flight glow { mat, origEmissiveHex, origIntensity }
        this._seleneFlightActive = new Map();
        // Selene – post-landing weapon bonus golden tint { mat, origEmissiveHex, origIntensity }
        this._seleneWeaponBonusActive = new Map();
        // Selene – Lunar Eclipse charge white glow { mat, origEmissiveHex, origIntensity }
        this._seleneLunarActive = new Map();
        this._siphonLifeCones = new Map(); // Siphon Life cone meshes keyed by entity ID
        // Kyoukan – Heroic Aura active tint state
        this._heroicAuraActive = new Map();
        
        this._attachedMeshes = new Map(); // For meshes attached to entities (e.g. Siphon Life cones), keyed by entity ID

        this._animators = new Map(); // TextureAnimators for healing glints keyed by entity ID

        // VFX timeout tracking prevents orphaned timers on scene teardown.
        this._vfxTimeouts = new Set();
        this._vfxTimeoutsByOwner = new Map();
        this._frameTimeMs = performance.now();
        this._pickupPhase = new Map();
    }

    setFrameTime(frameTimeMs) {
        this._frameTimeMs = frameTimeMs;
    }

    /**
     * Create or update a player mesh for an entity
     * @param {string} socketId - Socket ID (used as key)
     * @param {number} eid - Entity ID
     * @param {number} color - Player color (hex)
     * @returns {THREE.Group} The created mesh group
     */
    createPlayerMesh(socketId, eid, color, sameTeam = false) {
        // Check if mesh already exists
        if (this.entityMeshes.has(socketId)) {
            return this.entityMeshes.get(socketId);
        }

        const group = new THREE.Group();
        
        // Body (capsule)
        const capsuleSize = new THREE.Vector2(0.55, 1.1);
        const body = new THREE.Mesh(
            new THREE.CapsuleGeometry(capsuleSize.x, capsuleSize.y, 4, 8),
            new THREE.MeshStandardMaterial({ color: color })
        );
        const yPos = 1.1;
        body.position.y = yPos; // Raise so feet are at y=0, keep in sync with PLAYER_HEAD_OFFSET
        group.add(body);

        // Gun/Arm (to see direction)
        const gun = new THREE.Mesh(
            new THREE.BoxGeometry(0.2, 0.2, 1),
            new THREE.MeshBasicMaterial({ color: 0x000000 })
        );
        gun.position.set(0.4, 1.2, -0.5);
        group.add(gun);

        // Team outline (optional, only for teammates)
        if (sameTeam) {
            const outline = new THREE.Mesh(
                new THREE.CapsuleGeometry(capsuleSize.x + 0.1, capsuleSize.y + 0.1, 4, 8),
                new THREE.MeshBasicMaterial({ color: 0x00ff00, side: THREE.BackSide }) // Green outline, render back faces only
            );
            outline.position.y = yPos;
            group.add(outline);
        }

        this.scene.add(group);
        this._attachedMeshes.set(socketId, new Map());
        this._animators.set(socketId, new Map());
        this.entityMeshes.set(socketId, group);
        
        return group;
    }

    /**
     * Create or update a bullet mesh for an entity
     * @param {number} eid - Entity ID
     * @param {number} type - Visual type of the bullet
     * @returns {THREE.Mesh} The created mesh
     */
    createBulletMesh(eid,type = 0) {
        if (this.entityMeshes.has(eid)) {
            return this.entityMeshes.get(eid);
        }

        // Create bullet sphere
        let mesh = null;
        let geom, mat;
        switch(type){
            case BULLET_TYPES.STANDARD:
                geom = new THREE.SphereGeometry(0.2, 8, 8);
                mat = new THREE.MeshBasicMaterial({ 
                    color: 0xffff00,
                });
                mesh =  new THREE.Mesh(geom, mat);
                break;
            case BULLET_TYPES.SHOCK_GRENADE:
                geom = new THREE.SphereGeometry(0.5, 8, 8);
                mat = new THREE.MeshBasicMaterial({ 
                    color: 0xff0000,
                });
                mesh =  new THREE.Mesh(geom, mat);
                break;
            case BULLET_TYPES.HOLY_WATER:
                geom = new THREE.SphereGeometry(0.3, 8, 8);
                mat = new THREE.MeshBasicMaterial({ 
                    color: 0x18d049,
                });
                mesh =  new THREE.Mesh(geom, mat);
                break;
        }
        
        this.scene.add(mesh);
        this.entityMeshes.set(eid, mesh);
        
        // Initialize tracer trail (preallocated Float32Array to avoid churn)
        const maxPositions = 10;
        const positionsArray = new Float32Array(maxPositions * 3);
        this.bulletTracers.set(eid, {
            positionsArray,
            renderArray: new Float32Array(maxPositions * 3),
            count: 0,
            max: maxPositions,
            head: 0,
            line: null,
            geometry: null,
            material: null,
        });
        
        return mesh;
    }

    /**
     * Update player mesh position and rotation
     * @param {string} socketId - Socket ID
     * @param {Object} playerData - Player state data
     * @param {boolean} smooth - Whether to use lerp for smooth movement
     */
    updatePlayerMesh(socketId, playerData, smooth = true) {
        const mesh = this.entityMeshes.get(socketId);
        if (!mesh) return;

        if (smooth) {
            // Smooth interpolation
            this._tempVec.set(playerData.x, playerData.y, playerData.z);
            mesh.position.lerp(this._tempVec, 0.3);
        } else {
            // Direct position update
            mesh.position.set(playerData.x, playerData.y, playerData.z);
        }

        // Update rotation
        mesh.rotation.y = playerData.yaw;

        // Update gun pitch (children[1] is the gun)
        const animators = this._animators.get(socketId);
        for (const [key, animator] of animators) {
            animator.update(Date.now());
        }
        if (mesh.children[1]) {
            mesh.children[1].rotation.x = playerData.pitch;
        }
    }

    /**
     * Update bullet mesh position
     * @param {number} eid - Entity ID
     * @param {Object} bulletData - Bullet state data
     */
    updateBulletMesh(eid, bulletData) {
        const mesh = this.entityMeshes.get(eid);
        if (!mesh) return;
        // Reuse temp vector to avoid allocations
        this._tempVec.set(bulletData.x, bulletData.y, bulletData.z);
        mesh.position.copy(this._tempVec);

        // Update tracer trail (use preallocated Float32Array and a single BufferGeometry)
        const tracer = this.bulletTracers.get(eid);
        if (!tracer) return;

        const arr = tracer.positionsArray;
        const renderArr = tracer.renderArray;
        const max = tracer.max;
        const writeIndex = tracer.head * 3;
        arr[writeIndex] = bulletData.x;
        arr[writeIndex + 1] = bulletData.y;
        arr[writeIndex + 2] = bulletData.z;
        tracer.head = (tracer.head + 1) % max;
        if (tracer.count < max) tracer.count++;

        const start = tracer.count === max ? tracer.head : 0;
        for (let i = 0; i < tracer.count; i++) {
            const srcIndex = ((start + i) % max) * 3;
            const dstIndex = i * 3;
            renderArr[dstIndex] = arr[srcIndex];
            renderArr[dstIndex + 1] = arr[srcIndex + 1];
            renderArr[dstIndex + 2] = arr[srcIndex + 2];
        }

        // Create line geometry/material once, then update attribute values
        if (!tracer.line && tracer.count >= 2) {
            const geometry = new THREE.BufferGeometry();
            geometry.setAttribute('position', new THREE.BufferAttribute(renderArr, 3));
            geometry.setDrawRange(0, tracer.count);
            const material = new THREE.LineBasicMaterial({ color: 0xffaa00, opacity: 0.6, transparent: true });
            tracer.geometry = geometry;
            tracer.material = material;
            tracer.line = new THREE.Line(geometry, material);
            this.scene.add(tracer.line);
        } else if (tracer.line) {
            tracer.geometry.attributes.position.needsUpdate = true;
            tracer.geometry.setDrawRange(0, tracer.count);
        }
    }

    /**
     * Remove a mesh from the scene
     * @param {string|number} key - Socket ID or Entity ID
     */
    removeMesh(key) {
        this._clearVfxTimeoutsForOwner(key);

        const mesh = this.entityMeshes.get(key);
        if (mesh) {
            this.scene.remove(mesh);
            this.entityMeshes.delete(key);
        }
        
        // Remove tracer if exists
        const tracer = this.bulletTracers.get(key);
        if (tracer) {
            if (tracer.line) {
                this.scene.remove(tracer.line);
                tracer.line.geometry.dispose();
                tracer.line.material.dispose();
            }
            this.bulletTracers.delete(key);
        }

        // Remove health bar if exists
        const hbData = this.enemyHealthBars.get(key);
        if (hbData) {
            if (hbData.fadeTimer) clearTimeout(hbData.fadeTimer);
            if (hbData.fadeInterval) clearInterval(hbData.fadeInterval);
            this.enemyHealthBars.delete(key);
        }

        this._pickupPhase.delete(key);
    }

    /**
     * Check if a mesh exists
     * @param {string|number} key - Socket ID or Entity ID
     * @returns {boolean}
     */
    hasMesh(key) {
        return this.entityMeshes.has(key);
    }

    /**
     * Get a mesh by key
     * @param {string|number} key - Socket ID or Entity ID
     * @returns {THREE.Object3D|undefined}
     */
    getMesh(key) {
        return this.entityMeshes.get(key);
    }

    // -------------------------------------------------------
    // Enemy Health Bars
    // -------------------------------------------------------

    /**
     * Create a canvas-based sprite for a health bar.
     * @returns {Object} { sprite, canvas, ctx, texture }
     */
    _createHealthBarSprite() {
        // Canvas sized to contain three stacked bars (shield, armor, health)
        const canvas = document.createElement('canvas');
        canvas.width = 64;
        // 3 bars x 6px each + spacing -> 22px gives some padding
        canvas.height = 22;
        const ctx = canvas.getContext('2d');

        const texture = new THREE.CanvasTexture(canvas);
        const material = new THREE.SpriteMaterial({
            map: texture,
            transparent: true,
            depthTest: false,
        });
        const sprite = new THREE.Sprite(material);
        // Scale Y increased to match taller canvas (approx same px -> world units)
        sprite.scale.set(1.6, 0.55, 1);
        sprite.position.y = 3.8; // Float above the player capsule (slightly higher)
        sprite.visible = false;

        return {
            sprite,
            canvas,
            ctx,
            texture,
            lastHealth: null,
            lastMaxHealth: null,
            lastArmor: null,
            lastMaxArmor: null,
            lastShield: null,
            lastMaxShield: null,
        };
    }

    /**
     * Show/update the health bar of an enemy entity.
     * Health bar fades out after 3 seconds of no damage.
     * @param {string|number} socketId - Entity key in entityMeshes
     * @param {number} health - Current health value
     * @param {number} maxHealth - Maximum health value (default 100)
     */
    updateEnemyHealthBar(socketId, health, maxHealth = 100, armor = 0, maxArmor = 100, shield = 0, maxShield = 100) {
        const group = this.entityMeshes.get(socketId);
        if (!group) return;

        let hbData = this.enemyHealthBars.get(socketId);
        if (!hbData) {
            hbData = this._createHealthBarSprite();
            group.add(hbData.sprite);
            this.enemyHealthBars.set(socketId, hbData);
        }

        const hasChanged =
            hbData.lastHealth !== health ||
            hbData.lastMaxHealth !== maxHealth ||
            hbData.lastArmor !== armor ||
            hbData.lastMaxArmor !== maxArmor ||
            hbData.lastShield !== shield ||
            hbData.lastMaxShield !== maxShield;

        // Clear any ongoing fade-out animation
        if (hbData.fadeInterval) {
            clearInterval(hbData.fadeInterval);
            hbData.fadeInterval = null;
        }

        if (hasChanged) {
            // Redraw the stacked bars (shield, armor, health)
            const { canvas, ctx, texture } = hbData;
            ctx.clearRect(0, 0, canvas.width, canvas.height);

            // Dark background
            ctx.fillStyle = 'rgba(20, 20, 20, 0.85)';
            ctx.fillRect(0, 0, canvas.width, canvas.height);

            // Layout: 3 bars stacked with 1px padding
            const barPadding = 1;
            const barHeight = 6; // px per bar
            const innerWidth = canvas.width - 2; // 1px padding left/right

            // Helper to draw a single bar at a given vertical offset
            const drawBar = (yOffset, value, maxValue, color) => {
                const pct = Math.max(0, Math.min(1, (maxValue > 0 ? value / maxValue : 0)));
                // background (darker strip already present by full canvas background)
                ctx.fillStyle = 'rgba(0,0,0,0.4)';
                ctx.fillRect(1, yOffset, innerWidth, barHeight);
                // filled portion
                ctx.fillStyle = color;
                ctx.fillRect(1, yOffset, Math.floor(innerWidth * pct), barHeight);
                // small outline
                ctx.strokeStyle = 'rgba(0,0,0,0.6)';
                ctx.lineWidth = 1;
                ctx.strokeRect(1, yOffset, innerWidth, barHeight);
            };

            // Top: Shield (blue)
            if (shield > 0) {
                drawBar(1, shield, maxShield, '#3399ff');
            }
            // Middle: Armor (gold/yellow)
            if (armor > 0) {
                drawBar(1 + barHeight + barPadding, armor, maxArmor, '#ffaa00');
            }
            // Bottom: Health (green/red gradient by threshold)
            const healthColor = (health / maxHealth) > 0.5 ? '#22dd22' : (health / maxHealth) > 0.25 ? '#ffaa00' : '#dd2222';
            drawBar(1 + (barHeight + barPadding) * 2, health, maxHealth, healthColor);

            texture.needsUpdate = true;

            hbData.lastHealth = health;
            hbData.lastMaxHealth = maxHealth;
            hbData.lastArmor = armor;
            hbData.lastMaxArmor = maxArmor;
            hbData.lastShield = shield;
            hbData.lastMaxShield = maxShield;
        }

        // Make visible and fully opaque
        hbData.sprite.visible = true;
        hbData.sprite.material.opacity = 1;

        // Reset auto-hide timer
        if (hbData.fadeTimer) clearTimeout(hbData.fadeTimer);
        hbData.fadeTimer = setTimeout(() => this._fadeOutHealthBar(socketId), 2500);
    }

    /**
     * Gradually fade out a health bar sprite.
     * @param {string|number} socketId
     */
    _fadeOutHealthBar(socketId) {
        const hbData = this.enemyHealthBars.get(socketId);
        if (!hbData || !hbData.sprite.visible) return;

        let opacity = 1;
        hbData.fadeInterval = setInterval(() => {
            opacity -= 0.05;
            if (opacity <= 0) {
                hbData.sprite.visible = false;
                hbData.sprite.material.opacity = 1;
                clearInterval(hbData.fadeInterval);
                hbData.fadeInterval = null;
            } else {
                hbData.sprite.material.opacity = opacity;
            }
        }, 33);
    }

    /**
     * Remove all meshes, tracers and health bars from the scene.
     * Call this when returning to the main menu.
     */
    clearAll() {
        this._clearAllVfxTimeouts();

        this.entityMeshes.forEach((mesh) => {
            this.scene.remove(mesh);
            if (mesh.geometry) mesh.geometry.dispose();
            if (mesh.material) {
                if (mesh.material.map) mesh.material.map.dispose();
                mesh.material.dispose();
            }
        });
        this.entityMeshes.clear();

        this.bulletTracers.forEach((tracer) => {
            if (tracer.line) {
                this.scene.remove(tracer.line);
                if (tracer.line.geometry) tracer.line.geometry.dispose();
                if (tracer.line.material) tracer.line.material.dispose();
            }
        });
        this.bulletTracers.clear();

        this.enemyHealthBars.forEach((hbData) => {
            if (hbData.fadeTimer) clearTimeout(hbData.fadeTimer);
            if (hbData.fadeInterval) clearInterval(hbData.fadeInterval);
        });
        this.enemyHealthBars.clear();

        // Restore any persistent material tint states before clearing meshes.
        for (const [, state] of this._heroicAuraActive) {
            state.mat.emissive?.setHex(state.origEmissiveHex);
            state.mat.emissiveIntensity = state.origIntensity;
        }
        this._heroicAuraActive.clear();

        // Remove pickup meshes
        this.pickupMeshes.forEach((mesh) => {
            this.scene.remove(mesh);
            if (mesh.geometry) mesh.geometry.dispose();
            if (mesh.material) mesh.material.dispose();
        });
        this.pickupMeshes.clear();
        this._pickupPhase.clear();
    }

    // -------------------------------------------------------
    // Pickups
    // -------------------------------------------------------

    get pickupMeshes() {
        if (!this._pickupMeshes) this._pickupMeshes = new Map();
        return this._pickupMeshes;
    }

    /** type 0 = health vial (green orb), type 1 = armor shard (yellow diamond) */
    createPickupMesh(id, type) {
        if (this.pickupMeshes.has(id)) return;

        let mesh;
        if (type === 0) {
            mesh = new THREE.Group();
            const material = new THREE.MeshStandardMaterial({  color: 0x22ff44, emissive: 0x00ff22, emissiveIntensity: 0.4 });

            // Horizontal bar
            const hBar = new THREE.Mesh(
                new THREE.BoxGeometry(2, 0.5, 0.25),
                material
            );

            // Vertical bar
            const vBar = new THREE.Mesh(
                new THREE.BoxGeometry(0.5, 2, 0.25),
                material
            );

            mesh.add(hBar);
            mesh.add(vBar);
        } else if (type === 1) {
            // Armor shard – yellow diamond (octahedron)
            mesh = new THREE.Mesh(
                new THREE.OctahedronGeometry(0.38),
                new THREE.MeshStandardMaterial({ color: 0xffcc00, emissive: 0xffaa00, emissiveIntensity: 0.4, metalness: 0.5, roughness: 0.2 })
            );
        } else if (type === 2) {
            // Crystal shard – Selene kill drop – cyan tetrahedron with bright emissive
            mesh = new THREE.Mesh(
                new THREE.TetrahedronGeometry(0.44),
                new THREE.MeshStandardMaterial({ color: 0x00ddcc, emissive: 0x00ffee, emissiveIntensity: 0.7, metalness: 0.5, roughness: 0.2 })
            );
        }else if (type === 3) {
            mesh = new THREE.Group();
            const ball = new THREE.Mesh(
                new THREE.SphereGeometry(0.4),
                new THREE.MeshStandardMaterial({ color: 0x00ffff, emissive: 0x00ffff, emissiveIntensity: 0.7, metalness: 0.5, roughness: 0.2 })
            );
            const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.glowTexture, color: 0x00ffff, transparent: true, opacity: 1 }));
            glow.scale.set(3, 3, 3);
            const light = new THREE.PointLight(0x00ffff, 2, 8);
            mesh.add(ball);
            mesh.add(glow);
            mesh.add(light);
        }
        this.scene.add(mesh);
        this.pickupMeshes.set(id, mesh);
    }

    updatePickupMesh(id, pickupData) {
        const mesh = this.pickupMeshes.get(id);
        if (!mesh) return;
        mesh.position.set(pickupData.x, pickupData.y, pickupData.z);
        // Server uses boolean `active` in PICKUP_STATE; accept truthy values here.
        mesh.visible = !!pickupData.active;
        // Gentle rotation for visual interest
        mesh.rotation.y += 0.03;
        
        let phase = this._pickupPhase.get(id);
        if (phase == null) {
            phase = Math.random() * Math.PI * 2;
            this._pickupPhase.set(id, phase);
        }
        mesh.position.y += Math.sin(this._frameTimeMs * 0.002 + phase) * 0.05;
    }

    hidePickupMesh(id) {
        const mesh = this.pickupMeshes.get(id);
        if (mesh) mesh.visible = false;
    }

    showPickupMesh(id) {
        const mesh = this.pickupMeshes.get(id);
        if (mesh) mesh.visible = true;
    }

    hasPickupMesh(id) {
        return this.pickupMeshes.has(id);
    }

    // -------------------------------------------------------
    // Ability VFX helpers
    // -------------------------------------------------------

    /** Spawn short-lived flash spheres at the given positions */
    vfxShadowLightning({ positions = [] } = {}) {
        for (const pos of positions) {
            this._flashSphere(pos.x, pos.y, pos.z, 0x9933ff, 6, 400);
        }
    }

    vfxShadowLightningStrike({ id, x, y, z } = {}) {
        if (x == null) return;
        const material = new THREE.SpriteMaterial({ map: this.lightningTexture, color: 0x9933ff, transparent: true, opacity: 0.8 });
        const sprite = new THREE.Sprite(material);
        sprite.position.set(x, y+5, z);
        sprite.scale.set(10, 15, 3);
        const glintGeom = new THREE.CylinderGeometry(7, 7, 2, 12, 1, true);
        // hide top and bottom faces, leaving only the hexagonal ring
        //glintGeom.faces = glintGeom.faces.filter(face => face.materialIndex === 0);
        const glintText = this._glintMat();
        const glintMat = new THREE.MeshBasicMaterial({
            color: 0x9933ff,
            transparent: true,
            opacity: 0.5,
            depthWrite: false,
            map: glintText,
        });

        const glintMesh = new THREE.Mesh(glintGeom, glintMat);
        glintMesh.position.set(x, y + 0.1, z);
        this.scene.add(sprite);
        this.scene.add(glintMesh);
        this._flashCircle( x, y, z, 7, 0x9933ff, 400, id ?? null);
        this._scheduleOwnedTimeout(() => {
            this.scene.remove(sprite);
            if (sprite.material.map) sprite.material.map.dispose();
            sprite.material.dispose();
            this.scene.remove(glintMesh);
            if (glintMesh.material) glintMesh.material.dispose();
            if (glintMesh.geometry) glintMesh.geometry.dispose();
        }, 500, id ?? null);
        

    }

    vfxShadowTeleport({ id, x, y, z } = {}) {
        if (x == null) return;
        this._flashSphere(x, y, z, 0x6600cc, 1.5, 300, id ?? null);
    }

    vfxShadowStormStart({ id, x, y, z, duration } = {}) {
        if (x == null) return;
        this._flashRing(x, y, z, 12, 0x4400aa, (duration || 10) * 1000, id ?? null);
    }

    vfxShadowStormTick({ x, y, z } = {}) {
        if (x == null) return;
        this._flashRing(x, y, z, 12, 0x4400aa, 200);
        if (Math.random() < 0.3) this._flashSphere(x + (Math.random()-0.5)*8, y, z + (Math.random()-0.5)*8, 0x7722ff, 0.5, 200);
    }

    vfxGrenadeThrown({ x, y, z } = {}) {
        if (x == null) return;
        this._flashSphere(x, y, z, 0xff8800, 0.3, 150);
    }

    vfxGrenadeExploded({ x, y, z, radius = 7 } = {}) {
        if (x == null) return;
        this._flashRing(x, y, z, radius, 0xff6600, 500);
        this._flashSphere(x, y, z, 0xffcc00, radius * 0.6, 350);
    }

    vfxWillpower({ id } = {}) {
        // Glow the player entity mesh briefly
        const mesh = id ? this.entityMeshes.get(id) : null;
        if (mesh) {
            // Temporarily tint – works even if children use MeshStandardMaterial
            const orig = mesh.children[0]?.material?.emissive?.getHex?.() ?? 0;
            if (mesh.children[0]?.material) {
                mesh.children[0].material.emissive.setHex(0x0044ff);
                this._scheduleOwnedTimeout(() => mesh.children[0]?.material?.emissive?.setHex(orig), 4000, id ?? null);
            }
        }
    }

    vfxClusterStrikeBegin({ bombs = [] } = {}) {
        // Place warning decal rings on the ground
        for (const bomb of bombs) {
            this._flashRing(bomb.x, bomb.y, bomb.z, 6, 0xff2200, 1800);
        }
    }

    explosionVfx({ x, y, z, radius = 6 } = {}) {
        if (x == null) return;
        this._flashRing(x, y, z, radius, 0xff4400, 400);
        this._flashSphere(x, y, z, 0xff8800, radius * 0.5, 300);
    }

    // ── Selene VFX ─────────────────────────────────────────────────────────────

    /**
     * Crystal Smash activated: brief teal flash on caster.
     */
    vfxCrystalSmashStart({ id, x, y, z } = {}) {
        if (x == null) return;
        this._flashSphere(x, y + 1, z, 0x00eedd, 1.1, 220);
        this._flashRing(x, y, z, 1.4, 0x00bbbb, 260);
        const mesh    = id ? this.entityMeshes.get(id) : null;
        const bodyMat = mesh?.children[0]?.material;
        if (bodyMat) {
            const origHex = bodyMat.emissive?.getHex?.() ?? 0;
            const origI   = bodyMat.emissiveIntensity ?? 0;
            bodyMat.emissive?.setHex(0x00ffcc);
            bodyMat.emissiveIntensity = 1.3;
            this._scheduleOwnedTimeout(() => {
                bodyMat.emissive?.setHex(origHex);
                bodyMat.emissiveIntensity = origI;
            }, 260, id ?? null);
        }
    }

    /**
     * Crystal Smash hit: impact burst + stun flash on target.
     * If `droppedShard` is true, add a cyan sparkle to hint at the shard.
     */
    vfxCrystalSmashHit({ id, targetId, x, y, z, droppedShard = false } = {}) {
        if (x == null) return;
        this._flashSphere(x, y + 1, z, 0x00ffcc, 2.2, 450);
        this._flashRing(x, y, z, 2.6, 0x00ddbb, 450);
        if (droppedShard) {
            this._flashSphere(x, y + 0.5, z, 0x00ffff, 1.6, 700);
        }
        // Stun indicator on target: brief white flash → yellow stun tint for 1 s
        const targetMesh = targetId ? this.entityMeshes.get(targetId) : null;
        const bodyMat    = targetMesh?.children[0]?.material;
        if (bodyMat) {
            const origHex = bodyMat.emissive?.getHex?.() ?? 0;
            const origI   = bodyMat.emissiveIntensity ?? 0;
            bodyMat.emissive?.setHex(0xffffff);
            bodyMat.emissiveIntensity = 2.0;
            this._scheduleOwnedTimeout(() => {
                bodyMat.emissive?.setHex(0xffff00);
                bodyMat.emissiveIntensity = 0.9;
                // Small star ring above the stunned head
                const p = targetMesh.position;
                this._flashRing(p.x, p.y + 2.6, p.z, 0.55, 0xffff44, 900, targetId ?? null);
            }, 80, targetId ?? null);
            this._scheduleOwnedTimeout(() => {
                bodyMat.emissive?.setHex(origHex);
                bodyMat.emissiveIntensity = origI;
            }, 1050, targetId ?? null); // 1 s stun
        }
    }

    /**
     * Crystal shard dropped on kill: create the pickup mesh immediately.
     * (stateUpdate will also carry it, createPickupMesh guards against duplicates.)
     */
    vfxCrystalShardDropped({ pickupId, x, y, z } = {}) {
        if (x == null) return;
        if (!this.pickupMeshes.has(pickupId)) {
            this.createPickupMesh(pickupId, 2);
        }
        const mesh = this.pickupMeshes.get(pickupId);
        if (mesh) mesh.position.set(x, y, z);
        // Small burst so the shard is noticeable
        this._flashSphere(x, y + 0.5, z, 0x00ffee, 1.0, 400, pickupId ?? null);
    }

    /**
     * Crystal shard auto-despawned without being collected.
     */
    vfxCrystalShardExpired({ pickupId } = {}) {
        const mesh = this.pickupMeshes.get(pickupId);
        if (mesh) {
            this._flashSphere(mesh.position.x, mesh.position.y, mesh.position.z, 0x00ccbb, 0.8, 300, pickupId ?? null);
            this.scene.remove(mesh);
            if (mesh.geometry) mesh.geometry.dispose();
            if (mesh.material) mesh.material.dispose();
            this.pickupMeshes.delete(pickupId);
        }
    }

    /**
     * Astral Elevation activated: launch ring + persistent silver-blue flight glow.
     */
    vfxAstralElevationStart({ id, x, y, z } = {}) {
        if (x == null) return;
        this._flashRing(x, y, z, 2.6, 0x88aaff, 600);
        this._flashSphere(x, y + 1, z, 0xaaccff, 1.4, 400);
        const mesh    = id ? this.entityMeshes.get(id) : null;
        const bodyMat = mesh?.children[0]?.material;
        if (bodyMat) {
            const origEmissiveHex = bodyMat.emissive?.getHex?.() ?? 0;
            const origIntensity   = bodyMat.emissiveIntensity ?? 0;
            bodyMat.emissive?.setHex(0x4488ff);
            bodyMat.emissiveIntensity = 0.9;
            this._seleneFlightActive.set(id, { mat: bodyMat, origEmissiveHex, origIntensity });
        }
    }

    /**
     * Astral Elevation ended (landing): clear flight glow, apply gold weapon-bonus tint.
     */
    vfxAstralElevationEnd({ id } = {}) {
        const flightState = this._seleneFlightActive.get(id);
        if (flightState) {
            // Transition to weapon-bonus gold tint instead of clearing outright
            flightState.mat.emissive?.setHex(0xffcc00);
            flightState.mat.emissiveIntensity = 0.7;
            this._seleneWeaponBonusActive.set(id, {
                mat:            flightState.mat,
                origEmissiveHex: flightState.origEmissiveHex,
                origIntensity:   flightState.origIntensity,
            });
            this._seleneFlightActive.delete(id);
        }
        // Landing shockwave
        const mesh = id ? this.entityMeshes.get(id) : null;
        if (mesh) {
            this._flashRing(mesh.position.x, mesh.position.y, mesh.position.z, 2.2, 0x88aaff, 500);
            this._flashSphere(mesh.position.x, mesh.position.y, mesh.position.z, 0xffdd88, 1.6, 380);
        }
    }

    /**
     * Post-landing weapon damage bonus expired: restore original emissive.
     */
    vfxAstralWeaponBonusExpired({ id } = {}) {
        const state = this._seleneWeaponBonusActive.get(id);
        if (state) {
            state.mat.emissive?.setHex(state.origEmissiveHex);
            state.mat.emissiveIntensity = state.origIntensity;
            this._seleneWeaponBonusActive.delete(id);
        }
    }

    /**
     * Lunar Eclipse charge phase: white-silver charge glow on caster.
     */
    vfxLunarEclipseCharge({ id, x, y, z, chargeDuration = 1.5 } = {}) {
        if (x == null) return;
        this._flashRing(x, y, z, 3.2, 0xccddff, 500);
        this._flashSphere(x, y + 1, z, 0xe8eeff, 1.6, 420);
        const mesh    = id ? this.entityMeshes.get(id) : null;
        const bodyMat = mesh?.children[0]?.material;
        if (bodyMat) {
            const origEmissiveHex = bodyMat.emissive?.getHex?.() ?? 0;
            const origIntensity   = bodyMat.emissiveIntensity ?? 0;
            bodyMat.emissive?.setHex(0xffffff);
            bodyMat.emissiveIntensity = 1.6;
            this._seleneLunarActive.set(id, { mat: bodyMat, origEmissiveHex, origIntensity });
            // Auto-clear when the charge ends (restored by blast event if it fires first)
            this._scheduleOwnedTimeout(() => {
                const cur = this._seleneLunarActive.get(id);
                if (cur) {
                    cur.mat.emissive?.setHex(cur.origEmissiveHex);
                    cur.mat.emissiveIntensity = cur.origIntensity;
                    this._seleneLunarActive.delete(id);
                }
            }, (chargeDuration + 0.4) * 1000, id ?? null);
        }
    }

    /**
     * Lunar Eclipse blast: massive AOE ring + scattered moon-orbs + silence rings on targets.
     */
    vfxLunarEclipseBlast({ id, x, y, z, radius = 16, hitTargetIds = [] } = {}) {
        if (x == null) return;
        // Clear lingering charge glow
        const lunarState = this._seleneLunarActive.get(id);
        if (lunarState) {
            lunarState.mat.emissive?.setHex(lunarState.origEmissiveHex);
            lunarState.mat.emissiveIntensity = lunarState.origIntensity;
            this._seleneLunarActive.delete(id);
        }
        // Massive concentric rings
        this._flashRing(x, y, z, radius,         0xeeeeff, 900);
        this._flashRing(x, y, z, radius * 0.65,  0x99bbff, 700);
        this._flashRing(x, y, z, radius * 0.30,  0x88aaff, 550);
        this._flashCylinder(x, y - (128/2), z, radius * 0.30, 128, 0xccccff, 800);
        // Central dome burst
        this._flashSphere(x, y + 1, z, 0xffffff, radius * 0.18, 600);
        // Scatter 10 moon orbs across the blast zone
        for (let i = 0; i < 10; i++) {
            const angle = (i / 10) * Math.PI * 2;
            const dist  = radius * (0.25 + Math.random() * 0.65);
            this._flashSphere(
                x + Math.cos(angle) * dist, y,
                z + Math.sin(angle) * dist,
                0x99bbff, 0.45 + Math.random() * 0.85, 280 + Math.random() * 500
            );
        }
        // Silence ring above each hit target's head
        for (const targetId of hitTargetIds) {
            const tMesh = this.entityMeshes.get(targetId);
            if (!tMesh) continue;
            this._flashRing(
                tMesh.position.x, tMesh.position.y + 2.7, tMesh.position.z,
                0.65, 0x4466ff, 900, targetId ?? null
            );
        }
    }

    // ── Fat Jerome VFX ──────────────────────────────────────────────────────

    /**
     * Shoulder Charge start: brown/orange charge aura on Fat Jerome.
     */
    vfxShoulderChargeStart({ id, x, y, z } = {}) {
        if (x == null) return;
        this._flashSphere(x, y + 1, z, 0x8b6f47, 1.3, 280);
        this._flashRing(x, y, z, 1.6, 0xa0826d, 300);
        const mesh    = id ? this.entityMeshes.get(id) : null;
        const bodyMat = mesh?.children[0]?.material;
        if (bodyMat) {
            const origHex = bodyMat.emissive?.getHex?.() ?? 0;
            const origI   = bodyMat.emissiveIntensity ?? 0;
            bodyMat.emissive?.setHex(0xff8833);
            bodyMat.emissiveIntensity = 1.2;
            this._scheduleOwnedTimeout(() => {
                bodyMat.emissive?.setHex(origHex);
                bodyMat.emissiveIntensity = origI;
            }, 1500, id ?? null);
        }
    }

    /**
     * Shoulder Charge hit: impact flash on target.
     */
    vfxShoulderChargeHit({ id, targetId, x, y, z } = {}) {
        if (x == null) return;
        this._flashSphere(x, y + 1, z, 0xffaa44, 1.8, 350);
        this._flashRing(x, y, z, 2.2, 0xff8822, 400);
    }

    /**
     * Butt Smash charging: warning glow on Fat Jerome.
     */
    vfxButtSmashCharging({ id } = {}) {
        const mesh = id ? this.entityMeshes.get(id) : null;
        if (mesh) {
            const bodyMat = mesh.children[0]?.material;
            if (bodyMat) {
                const origHex = bodyMat.emissive?.getHex?.() ?? 0;
                const origI   = bodyMat.emissiveIntensity ?? 0;
                bodyMat.emissive?.setHex(0xffcc00);
                bodyMat.emissiveIntensity = 1.5;
                this._scheduleOwnedTimeout(() => {
                    bodyMat.emissive?.setHex(origHex);
                    bodyMat.emissiveIntensity = origI;
                }, 1000, id ?? null);
            }
        }
    }

    /**
     * Butt Smash launch: upward force visual.
     */
    vfxButtSmashLaunch({ id, x, y, z } = {}) {
        if (x == null) return;
        this._flashSphere(x, y, z, 0xffaa33, 1.5, 300);
        this._flashRing(x, y, z, 1.8, 0xff8811, 350);
    }

    /**
     * Butt Smash impact: large ground impact with rings.
     */
    vfxButtSmashImpact({ id, x, y, z, targets = [] } = {}) {
        if (x == null) return;
        // Large impact flash
        this._flashSphere(x, y, z, 0xff8822, 5, 500);
        this._flashRing(x, y, z, 5.0, 0xffaa44, 600);  // inner radius
        this._flashRing(x, y, z, 10.0, 0xff6622, 700);  // outer radius
        // Show stars above stunned targets
        for (const target of targets) {
            if (target.stunned) {
                const tMesh = this.entityMeshes.get(target.id);
                if (tMesh) {
                    for (let i = 0; i < 3; i++) {
                        this._scheduleOwnedTimeout(() => {
                            this._flashSphere(
                                tMesh.position.x + (Math.random()-0.5)*0.8,
                                tMesh.position.y + 2.5 + Math.random()*0.5,
                                tMesh.position.z + (Math.random()-0.5)*0.8,
                                0xffff44, 0.25, 300, target.id ?? null
                            );
                        }, i * 150, target.id ?? null);
                    }
                }
            }
        }
    }

    /**
     * Fatal Flatulence start: green aura on Fat Jerome.
     */
    vfxFatalFlatulenceStart({ id, x, y, z } = {}) {
        if (x == null) return;
        this._flashSphere(x, y + 1, z, 0x88ff44, 2.0, 500);
        this._flashRing(x, y, z, 2.5, 0x66cc22, 600);
        const mesh = id ? this.entityMeshes.get(id) : null;
        if (mesh) {
            const bodyMat = mesh.children[0]?.material;
            if (bodyMat) {
                const origHex = bodyMat.emissive?.getHex?.() ?? 0;
                const origI   = bodyMat.emissiveIntensity ?? 0;
                bodyMat.emissive?.setHex(0x88ff44);
                bodyMat.emissiveIntensity = 1.0;
                this._scheduleOwnedTimeout(() => {
                    bodyMat.emissive?.setHex(origHex);
                    bodyMat.emissiveIntensity = origI;
                }, 10000, id ?? null);
            }
        }
    }

    /**
     * Fart cloud spawned: green toxic-looking cloud.
     */
    vfxFartCloudSpawned({ id, x, y, z } = {}) {
        if (x == null) return;
        // Main cloud puff
        this._flashSphere(x, y + 0.5, z, 0x88ff44, 10, 5000);
        // Smaller toxic particles
        for (let i = 0; i < 5; i++) {
            this._scheduleOwnedTimeout(() => {
                const angle = Math.random() * Math.PI * 2;
                const dist  = Math.random() * 3;
                this._flashSphere(
                    x + Math.cos(angle) * dist,
                    y + 0.3 + Math.random() * 0.8,
                    z + Math.sin(angle) * dist,
                    0x66cc22 + Math.floor(Math.random() * 0x113300),
                    0.8 + Math.random() * 0.7,
                    800 + Math.random() * 1200,
                    id ?? null
                );
            }, i * 100, id ?? null);
        }
    }

    // ── Father Callas VFX ───────────────────────────────────────────────────

    /**
     * Begin the 6-second Siphon Life channel: persistent crimson aura on the caster.
     */
    vfxSiphonLifeStart({ id, x, y, z, yaw = 0, range = 12, halfAngle = 0.698 } = {}) {
        if (x == null) return;
        // Activation burst
        const cone = this.coneForward(range, 0.1, 12, true, -halfAngle, halfAngle * 2);
        const edgeMat  = new THREE.MeshBasicMaterial({
            color: 0xff1133,
            transparent: true, opacity: 0.5, side: THREE.DoubleSide, depthWrite: false
        });
        const edgeMesh = new THREE.Mesh(cone, edgeMat);

        // Parent to the caster if present, otherwise add to scene
        const mesh = id ? this.entityMeshes.get(id) : null;
        if (mesh) {
            mesh.add(edgeMesh);
        } else {
            this.scene.add(edgeMesh);
        }
        edgeMesh.updateMatrixWorld();
        this._siphonLifeCones.set(id, edgeMesh);

        this._flashSphere(x, y + 1, z, 0xff2244, 1.8, 350);
        this._flashRing(x, y, z, range * 0.5, 0xaa0033, 500);
        // Tint the caster deep red for the duration
        const bodyMat = mesh?.children[0]?.material;
        if (bodyMat) {
            const origEmissiveHex = bodyMat.emissive?.getHex?.() ?? 0;
            const origIntensity   = bodyMat.emissiveIntensity ?? 0;
            bodyMat.emissive?.setHex(0xcc0022);
            bodyMat.emissiveIntensity = 1.0;
            // Store so the end event can clean up
            this._siphonLifeActive = this._siphonLifeActive ?? new Map();
            this._siphonLifeActive.set(id, { mat: bodyMat, origEmissiveHex, origIntensity });
        }
    }

    /**
     * Each tick of the channel: small drain orbs sweeping across the cone.
     */
    vfxSiphonLifeTick({ id, x, y, z, yaw = 0, range = 14, halfAngle = 0.698 } = {}) {
        if (x == null) return;
        // Fire 5 small orbs spread across the cone
        const edgeMesh = this._siphonLifeCones.get(id);
        for (let i = 0; i < 5; i++) {
            if (edgeMesh && edgeMesh.geometry) {
                const posAttr = edgeMesh.geometry.attributes?.position;
                if (posAttr) {
                    const idx = Math.floor(Math.random() * posAttr.count);
                    const vx = posAttr.getX(idx);
                    const vy = posAttr.getY(idx);
                    const vz = posAttr.getZ(idx);
                    const v = new THREE.Vector3(vx, vy, vz);
                    edgeMesh.localToWorld(v);
                    this._flashSphere(v.x, v.y, v.z, 0xff6633, 0.4, 400);
                    continue;
                }
            }
            // fallback: simple forward spread using yaw
            const angle = yaw + (Math.random()-0.5) * halfAngle * 2;
            const dist  = Math.random() * range;
            this._flashSphere(
                x + Math.cos(angle) * dist,
                y + 1,
                z + Math.sin(angle) * dist,
                0xff6633, 0.4, 400
            );
        }
    }

    // Build a cone pointing in +Z, tip at origin
    coneForward(radius, height, segs, open, thetaStart, thetaLen) {
        thetaStart = thetaStart ?? 0;
        thetaLen   = thetaLen   ?? Math.PI * 2;
        // CylinderGeometry(rTop=0, rBot, h, ...) → tip at +Y, base at –Y
        const g = new THREE.CylinderGeometry(0, radius, height, segs, 1, open ?? true, thetaStart, thetaLen);
        // rotateX(+PI/2): tip → +Z; then translate -Z to bring tip to origin
        g.applyMatrix4(new THREE.Matrix4().makeRotationX(Math.PI));
        g.applyMatrix4(new THREE.Matrix4().makeTranslation(0, 0, -height / 2));
        return g;
    }

    /**
     * Channel ends: restore the caster's original tint.
     */
    vfxSiphonLifeEnd({ id } = {}) {
        this._siphonLifeActive = this._siphonLifeActive ?? new Map();
        const mesh = this.entityMeshes.get(id);
        const cone = this._siphonLifeCones.get(id);
        if (cone) {
            if (mesh) mesh.remove(cone);
            // Ensure it's removed from scene even if parent was missing
            try { this.scene.remove(cone); } catch (e) { /* ignore */ }
            if (cone.geometry) cone.geometry.dispose();
            if (cone.material) cone.material.dispose();
            this._siphonLifeCones.delete(id);
        }
        const state = this._siphonLifeActive.get(id);
        if (state) {
            state.mat.emissive?.setHex(state.origEmissiveHex);
            state.mat.emissiveIntensity = state.origIntensity;
            this._siphonLifeActive.delete(id);
        }
    }

    /**
     * Golden invulnerability aura — persists until vfxIronStandExpired is called.
     */
    vfxIronStandActivated({ id, x, y, z } = {}) {
        if (x == null) return;
        // Two expanding golden rings to show the activation pulse
        this._flashRing(x, y, z, 1.2, 0xffdd00, 600);
        this._flashRing(x, y, z, 2.2, 0xffaa00, 800);
        // Tint the entity
        const mesh = id ? this.entityMeshes.get(id) : null;
        const bodyMat = mesh?.children[0]?.material;
        if (bodyMat) {
            const origEmissiveHex = bodyMat.emissive?.getHex?.() ?? 0;
            const origIntensity   = bodyMat.emissiveIntensity ?? 0;
            bodyMat.emissive?.setHex(0xffaa00);
            bodyMat.emissiveIntensity = 1.2;
            this._ironStandActive.set(id, { mat: bodyMat, origEmissiveHex, origIntensity });
        }
    }

    /**
     * Remove the Iron Stand golden aura and flash a brief white burst.
     */
    vfxIronStandExpired({ id } = {}) {
        const state = this._ironStandActive.get(id);
        if (state) {
            state.mat.emissive?.setHex(state.origEmissiveHex);
            state.mat.emissiveIntensity = state.origIntensity;
            this._ironStandActive.delete(id);
        }
        const mesh = id ? this.entityMeshes.get(id) : null;
        if (mesh) this._flashSphere(mesh.position.x, mesh.position.y + 1, mesh.position.z, 0xffee88, 1.5, 250);
    }

    /**
     * Brief cyan/gold shield-phase indicator when Iron Stand's conversion window opens.
     */
    vfxIronStandShieldPhase({ id } = {}) {
        const mesh = id ? this.entityMeshes.get(id) : null;
        if (!mesh) return;
        const bodyMat = mesh.children[0]?.material;
        if (bodyMat) {
            bodyMat.emissive?.setHex(0x0066ff);
            bodyMat.emissiveIntensity = 0.7;
            this._scheduleOwnedTimeout(() => {
                bodyMat.emissive?.setHex(0x000000);
                bodyMat.emissiveIntensity = 0;
            }, 10000 * 1000 / 1000, id ?? null); // 10 s then clear
        }
    }

    /**
     * Dark void-portal where the banished entity stood.
     * The target mesh is tinted dark purple to indicate the banishment.
     */
    vfxShadowRealmBanish({ casterId, targetId, x, y, z } = {}) {
        if (x == null) return;
        // Dark void portal at the target's position
        this._flashRing(x, y, z, 1.6, 0x330066, 6200);
        this._flashSphere(x, y + 0.5, z, 0x220044, 2.0, 400);
        this._flashSphere(x, y + 1.5, z, 0x440088, 1.2, 300);
        // Tint the banished entity dark/transparent to suggest they're "gone"
        const targetMesh = targetId ? this.entityMeshes.get(targetId) : null;
        const bodyMat    = targetMesh?.children[0]?.material;
        if (bodyMat) {
            const origEmissiveHex = bodyMat.emissive?.getHex?.() ?? 0;
            const origIntensity   = bodyMat.emissiveIntensity ?? 0;
            const origOpacity     = bodyMat.opacity ?? 1;
            bodyMat.emissive?.setHex(0x330066);
            bodyMat.emissiveIntensity = 1.5;
            bodyMat.transparent = true;
            bodyMat.opacity     = 0.35;
            this._shadowRealmActive.set(targetId, { mat: bodyMat, origEmissiveHex, origIntensity, origOpacity });
        }
        // Purple flash near caster
        const cMesh = casterId ? this.entityMeshes.get(casterId) : null;
        if (cMesh) this._flashSphere(cMesh.position.x, cMesh.position.y + 1, cMesh.position.z, 0x6600cc, 1.8, 350);
    }

    /**
     * Return effect: restore target's mesh and show a dark burst where they materialise.
     */
    vfxShadowRealmReturn({ targetId, x, y, z } = {}) {
        const state = this._shadowRealmActive.get(targetId);
        if (state) {
            state.mat.emissive?.setHex(state.origEmissiveHex);
            state.mat.emissiveIntensity = state.origIntensity;
            state.mat.opacity           = state.origOpacity;
            if (state.origOpacity >= 1) state.mat.transparent = false;
            this._shadowRealmActive.delete(targetId);
        }
        if (x == null) return;
        this._flashSphere(x, y + 1, z, 0x8800cc, 2.5, 400);
        this._flashRing(x, y, z, 2.0, 0x440088, 600);
    }

    // ── Kyoukan VFX ────────────────────────────────────────────────────────

    /**
     * Arrow of Gratitude: bright support beam from caster to target + burst.
     */
    vfxArrowOfGratitudeCast({ casterId, targetId, x, y, z, selfCast = false } = {}) {
        const casterMesh = casterId ? this.entityMeshes.get(casterId) : null;
        const targetMesh = targetId ? this.entityMeshes.get(targetId) : null;
        const from = casterMesh
            ? new THREE.Vector3(casterMesh.position.x, casterMesh.position.y + 1.35, casterMesh.position.z)
            : (x == null ? null : new THREE.Vector3(x, (y ?? 0) + 1.35, z));
        const to = targetMesh
            ? new THREE.Vector3(targetMesh.position.x, targetMesh.position.y + 1.35, targetMesh.position.z)
            : (x == null ? null : new THREE.Vector3(x, (y ?? 0) + 1.35, z));

        if (from && to) {
            this._flashBeam(from, to, selfCast ? 0x9be8ff : 0x63d1ff, selfCast ? 0.22 : 0.16, 260, targetId ?? casterId ?? null);
        }

        if (x != null) {
            this._flashSphere(x, y + 1.0, z, 0x7ee1ff, 1.0, 280);
            this._flashRing(x, y, z, 1.3, 0x63d1ff, 320);
        }
    }

    /**
     * Majestic Leap: launch burst at origin.
     */
    vfxMajesticLeapStart({ id, x, y, z } = {}) {
        if (x == null) return;
        this._flashSphere(x, y + 1.0, z, 0x8de3ff, 1.4, 320);
        this._flashRing(x, y, z, 2.4, 0x63d1ff, 420);
        this._flashCylinder(x, y, z, 0.55, 3.4, 0xa3ecff, 240);

        const mesh = id ? this.entityMeshes.get(id) : null;
        const bodyMat = mesh?.children[0]?.material;
        if (bodyMat) {
            const origHex = bodyMat.emissive?.getHex?.() ?? 0;
            const origI = bodyMat.emissiveIntensity ?? 0;
            bodyMat.emissive?.setHex(0x9be8ff);
            bodyMat.emissiveIntensity = 1.0;
            this._scheduleOwnedTimeout(() => {
                bodyMat.emissive?.setHex(origHex);
                bodyMat.emissiveIntensity = origI;
            }, 420, id ?? null);
        }
    }

    /**
     * Majestic Leap landing pulse.
     */
    vfxMajesticLeapEnd({ x, y, z } = {}) {
        if (x == null) return;
        this._flashRing(x, y, z, 2.8, 0x5bc5f7, 360);
        this._flashSphere(x, y + 0.6, z, 0x79d6ff, 1.2, 240);
    }

    /**
     * Heroic Aura start: persistent team-buff tint + opening aura ring.
     */
    vfxHeroicAuraStart({ id, x, y, z, radius = 16 } = {}) {
        if (x == null) return;
        this._flashRing(x, y, z, radius, 0x6ecbff, 700);
        this._flashSphere(x, y + 1, z, 0x6ecbff, 2.0, 520);

        const mesh = id ? this.entityMeshes.get(id) : null;
        const bodyMat = mesh?.children[0]?.material;
        if (bodyMat && !this._heroicAuraActive.has(id)) {
            const origEmissiveHex = bodyMat.emissive?.getHex?.() ?? 0;
            const origIntensity = bodyMat.emissiveIntensity ?? 0;
            bodyMat.emissive?.setHex(0x63d1ff);
            bodyMat.emissiveIntensity = 0.9;
            this._heroicAuraActive.set(id, { mat: bodyMat, origEmissiveHex, origIntensity });
        }
    }

    /**
     * Heroic Aura tick pulse: recurring ring and ambient motes.
     */
    vfxHeroicAuraTick({ x, y, z, radius = 16 } = {}) {
        if (x == null) return;
        this._flashRing(x, y, z, radius, 0x8bdcff, 420);
        for (let i = 0; i < 5; i++) {
            const angle = (i / 5) * Math.PI * 2 + Math.random() * 0.25;
            const dist = radius * (0.35 + Math.random() * 0.5);
            this._flashSphere(
                x + Math.cos(angle) * dist,
                y + 0.7 + Math.random() * 1.2,
                z + Math.sin(angle) * dist,
                0xaeeeff,
                0.25 + Math.random() * 0.25,
                320 + Math.random() * 260
            );
        }
    }

    /**
     * Heroic Aura end: restore original material and closing pulse.
     */
    vfxHeroicAuraEnd({ id, x, y, z } = {}) {
        const state = this._heroicAuraActive.get(id);
        if (state) {
            state.mat.emissive?.setHex(state.origEmissiveHex);
            state.mat.emissiveIntensity = state.origIntensity;
            this._heroicAuraActive.delete(id);
        }
        if (x != null) {
            this._flashRing(x, y, z, 3.0, 0x63d1ff, 280);
        }
    }

    vfxHealingRiteCast({ casterId, targetId, x, y, z, selfCast = false } = {}) {
        const casterMesh = casterId ? this.entityMeshes.get(casterId) : null;
        const targetMesh = targetId ? this.entityMeshes.get(targetId) : null;
        const from = casterMesh
            ? new THREE.Vector3(casterMesh.position.x, casterMesh.position.y + 1.35, casterMesh.position.z)
            : (x == null ? null : new THREE.Vector3(x, (y ?? 0) + 1.35, z));
        const to = targetMesh
            ? new THREE.Vector3(targetMesh.position.x, targetMesh.position.y + 1.35, targetMesh.position.z)
            : (x == null ? null : new THREE.Vector3(x, (y ?? 0) + 1.35, z));

        if (from && to) {
            this._flashBeam(from, to, 0x18d049, selfCast ? 0.22 : 0.16, 260, targetId ?? casterId ?? null);
        }

        if (x != null) {
            this._flashSphere(x, y + 1.0, z, 0x18d049, 1.0, 280);
            this._flashRing(x, y, z, 1.3, 0x18d049, 320);
        }
    }

    vfxHealingRiteAddGlint({ id } = {}) {
        const mesh = id ? this.entityMeshes.get(id) : null;
        if (!mesh) return;
        
        // Create semitransparent glint texture mesh
        if (this._attachedMeshes.get(id)?.has('healingRiteGlint')) return; // already exists
        const glintGeom = new THREE.CapsuleGeometry(0.8, 1.4, 4, 8);
        const glintMat = this._glintAnimate(id, 'healingRiteGlint', this._glintMat());
        const glintMesh = new THREE.Mesh(glintGeom, glintMat);
        glintMesh.position.y = 1.2;
        this.attachMeshToEntity(glintMesh, id, 'healingRiteGlint');
    }

    _glintMat() {
        const loader = new THREE.TextureLoader();
        const texture = loader.load( '/assets/textures/effects/glint.png' );
        // Distort the UVs to create a vertical scrolling effect
        texture.wrapS = THREE.RepeatWrapping;
        texture.wrapT = THREE.RepeatWrapping;
        texture.repeat.set(1, 4);
        texture.offset.set(0, 0);
        return texture;
        
    }

    _glintAnimate(id, key, texture, color=0x18d049) {
        const animate = new TextureAnimator(texture,20,20); // cols, rows, totalFrames, duration
        const animators = this._animators.get(id) ?? new Map();
        animators.set(key, animate);
        this._animators.set(id, animators);
        return new THREE.MeshBasicMaterial({
            color: color,
            transparent: true,
            opacity: 0.5,
            depthWrite: false,
            map: texture,
        });
    }

    vfxHealingRiteRemoveGlint({ id } = {}) {
        this.detachMeshFromEntity(id, 'healingRiteGlint');
    }

    vfxHealingRiteTick({ id, x, y, z } = {}) {
        if (x == null) return;
        this._flashRing(x, y, z, 1.8, 0x18d049, 420);
        for (let i = 0; i < 5; i++) {
            const angle = (i / 5) * Math.PI * 2 + Math.random() * 0.25;
            const dist = 1.8 * (0.35 + Math.random() * 0.5);
            this._flashSphere(
                x + Math.cos(angle) * dist,
                y + 0.7 + Math.random() * 1.2,
                z + Math.sin(angle) * dist,
                0x18d049,
                0.25 + Math.random() * 0.25,
                320 + Math.random() * 260
            );
        }
    }

    vfxHolyWaterTick({ x, y, z } = {}) {
        if (x == null) return;
        this._flashRing(x, y, z, 3.8, 0x18d049, 320);
        this._flashCircle(
            x,
            y,
            z,
            3,
            0x18d049,
            100
        );
    }

    vfxHammerOfJusticeCast({ id, x, y, z, range = 26, halfAngle = 0.72} = {}) {
        if (x == null) return;
        const cone = this.coneForward(range, 0.1, 12, true, -halfAngle, halfAngle * 2);
        const edgeMat  = new THREE.MeshBasicMaterial({
            color: 0xff1aa33,
            transparent: true, opacity: 0.5, side: THREE.DoubleSide, depthWrite: false
        });
        const edgeMesh = new THREE.Mesh(cone, edgeMat);
        const mesh = id ? this.entityMeshes.get(id) : null;
        edgeMesh.position.set(x, y, z);
        edgeMesh.rotation.y = (mesh ? mesh.rotation.y : 0);
        this.scene.add(edgeMesh);
        this._scheduleOwnedTimeout(() => {
            this.scene.remove(edgeMesh);
            if (edgeMesh.geometry) edgeMesh.geometry.dispose();
            if (edgeMesh.material) edgeMesh.material.dispose();
        }, 420, id ?? null);

    }

    healingVfx(id){
        const mesh = id ? this.entityMeshes.get(id) : null;
        if (!mesh) return;
        const vertices = [];
        for ( let i = 0; i < 10; i ++ ) {
            const x = THREE.MathUtils.randFloatSpread( 3 );
            const y = THREE.MathUtils.randFloatSpread( 5 );
            const z = THREE.MathUtils.randFloatSpread( 3 );
            vertices.push( x, y + 0.5, z );
        }
        if (this._attachedMeshes.get(id)?.has('healingVfx')) return; // already exists
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute( 'position', new THREE.Float32BufferAttribute( vertices, 3 ) );
        const material = new THREE.PointsMaterial( { color: 0x18d049, transparent: true, opacity: 0.75, depthWrite: false } );
        const particles = new THREE.Points( geometry, material );
        this.attachMeshToEntity(particles, id, 'healingVfx');
        this._scheduleOwnedTimeout(() => {
            this.detachMeshFromEntity(id, 'healingVfx');
        }, 800, id ?? null);
    }

    armorVfx(id){
        const mesh = id ? this.entityMeshes.get(id) : null;
        if (!mesh) return;
        
        // Create semitransparent glint texture mesh
        if (this._attachedMeshes.get(id)?.has('armorVfx')) return; // already exists
        const glintGeom = new THREE.CapsuleGeometry(0.8, 1.4, 4, 8);
        const glintMat = this._glintAnimate(id,'armorVfx',this._glintMat(),0xffcc00);
        const glintMesh = new THREE.Mesh(glintGeom, glintMat);
        glintMesh.position.y = 1.2;
        this.attachMeshToEntity(glintMesh, id, 'armorVfx');
        this._scheduleOwnedTimeout(() => {
            this.detachMeshFromEntity(id, 'armorVfx');
        }, 800, id ?? null);
    }

    hasGlint(id){
        return this._attachedMeshes.get(id)?.has('healingRiteGlint') || this._attachedMeshes.get(id)?.has('armorVfx') || false;
    }

    attachMeshToEntity(mesh, id, key){
        const entityMesh = this.entityMeshes.get(id);
        const attached = this._attachedMeshes.get(id) ?? new Map();
        if (entityMesh) {
            entityMesh.add(mesh);
            attached.set(key, mesh);
            this._attachedMeshes.set(id, attached);
            return true;
        }
        return false;
    }
    
    detachMeshFromEntity(id, key){
    const attached = this._attachedMeshes.get(id);
    if (attached) {
        const mesh = attached.get(key);
        if (mesh) {
            // 1. Remove from its actual parent container, wherever it lives
            if (mesh.parent) {
                mesh.parent.remove(mesh);
            }
            // 2. Clean up its texture animator so it stops rendering/updating
            const animators = this._animators.get(id);
            if (animators && animators.has(key)) {
                animators.delete(key);
            }
            // 3. Dispose of geometries and materials to clear GPU memory
            if (mesh.geometry) mesh.geometry.dispose();
            if (mesh.material) {
                if (mesh.material.map) mesh.material.map.dispose();
                mesh.material.dispose();
            }
            attached.delete(key);
            if (attached.size === 0) this._attachedMeshes.delete(id);
            return true;
        }
    }
    return false;
}
    // ── Internal flash helpers ──────────────────────────────────────────────

    _flashBeam(from, to, color, radius, durationMs, ownerKey = null) {
        const dir = new THREE.Vector3().subVectors(to, from);
        const len = dir.length();
        if (len < 0.001) return;

        const mesh = new THREE.Mesh(
            new THREE.CylinderGeometry(radius, radius, len, 10, 1, true),
            new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.75, depthWrite: false })
        );
        const mid = new THREE.Vector3().addVectors(from, to).multiplyScalar(0.5);
        mesh.position.copy(mid);

        // Cylinder points up by default; rotate Y-axis to the beam direction.
        mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
        this.scene.add(mesh);

        this._scheduleVfxDisposal(mesh, durationMs, ownerKey);
    }

    _flashCircle(x, y, z, radius, color, durationMs, ownerKey = null) {
        const mesh = new THREE.Mesh(
            new THREE.CircleGeometry(radius, 32),
            new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.5, side: THREE.DoubleSide, depthWrite: false })
        );
        mesh.rotation.x = -Math.PI / 2;
        mesh.position.set(x, y + 0.05, z);
        this.scene.add(mesh);
        this._scheduleVfxDisposal(mesh, durationMs, ownerKey);
    }

    _flashSphere(x, y, z, color, radius, durationMs, ownerKey = null) {
        const mesh = new THREE.Mesh(
            new THREE.SphereGeometry(radius, 8, 8),
            new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.55, depthWrite: false })
        );
        mesh.position.set(x, y, z);
        this.scene.add(mesh);
        this._scheduleVfxDisposal(mesh, durationMs, ownerKey);
    }

    _flashRing(x, y, z, radius, color, durationMs, ownerKey = null) {
        const mesh = new THREE.Mesh(
            new THREE.RingGeometry(radius - 0.3, radius + 0.3, 32),
            new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.5, side: THREE.DoubleSide, depthWrite: false })
        );
        mesh.rotation.x = -Math.PI / 2;
        mesh.position.set(x, y + 0.05, z);
        this.scene.add(mesh);
        this._scheduleVfxDisposal(mesh, durationMs, ownerKey);
    }

    _flashCylinder(x, y, z, radius, height, color, durationMs, ownerKey = null) {
        const mesh = new THREE.Mesh(
            new THREE.CylinderGeometry(radius, radius, height, 16, 1, true),
            new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.5, side: THREE.DoubleSide, depthWrite: false })
        );
        mesh.position.set(x, y + height / 2, z);
        this.scene.add(mesh);
        this._scheduleVfxDisposal(mesh, durationMs, ownerKey);
    }

    _scheduleOwnedTimeout(callback, durationMs, ownerKey = null) {
        const timeoutId = setTimeout(() => {
            this._vfxTimeouts.delete(timeoutId);
            if (ownerKey != null) {
                const ownerTimers = this._vfxTimeoutsByOwner.get(ownerKey);
                if (ownerTimers) {
                    ownerTimers.delete(timeoutId);
                    if (ownerTimers.size === 0) this._vfxTimeoutsByOwner.delete(ownerKey);
                }
            }
            callback();
        }, durationMs);

        this._vfxTimeouts.add(timeoutId);
        if (ownerKey != null) {
            if (!this._vfxTimeoutsByOwner.has(ownerKey)) {
                this._vfxTimeoutsByOwner.set(ownerKey, new Set());
            }
            this._vfxTimeoutsByOwner.get(ownerKey).add(timeoutId);
        }
        return timeoutId;
    }

    _scheduleVfxDisposal(mesh, durationMs, ownerKey = null) {
        const timeoutId = setTimeout(() => {
            this._vfxTimeouts.delete(timeoutId);
            if (ownerKey != null) {
                const ownerTimers = this._vfxTimeoutsByOwner.get(ownerKey);
                if (ownerTimers) {
                    ownerTimers.delete(timeoutId);
                    if (ownerTimers.size === 0) this._vfxTimeoutsByOwner.delete(ownerKey);
                }
            }
            this.scene.remove(mesh);
            if (mesh.geometry) mesh.geometry.dispose();
            if (mesh.material) {
                if (mesh.material.map) mesh.material.map.dispose();
                mesh.material.dispose();
            }
        }, durationMs);

        this._vfxTimeouts.add(timeoutId);
        if (ownerKey != null) {
            if (!this._vfxTimeoutsByOwner.has(ownerKey)) {
                this._vfxTimeoutsByOwner.set(ownerKey, new Set());
            }
            this._vfxTimeoutsByOwner.get(ownerKey).add(timeoutId);
        }
    }

    _clearAllVfxTimeouts() {
        for (const timeoutId of this._vfxTimeouts) {
            clearTimeout(timeoutId);
        }
        this._vfxTimeouts.clear();
        this._vfxTimeoutsByOwner.clear();
    }

    _clearVfxTimeoutsForOwner(ownerKey) {
        const ownerTimers = this._vfxTimeoutsByOwner.get(ownerKey);
        if (!ownerTimers) return;
        for (const timeoutId of ownerTimers) {
            clearTimeout(timeoutId);
            this._vfxTimeouts.delete(timeoutId);
        }
        this._vfxTimeoutsByOwner.delete(ownerKey);
    }
}

class TextureAnimator {
    /**
     * 
     * @param {THREE.Texture} texture 
     * @param {Number} xSpeed 
     * @param {Number} ySpeed 
     */
    constructor(texture, xSpeed, ySpeed) {
        this.xSpeed = xSpeed;
        this.ySpeed = ySpeed;
        this._lastTime = null;

        // Continuously animate the texture offset using delta time.
        // Speeds are interpreted as UV units per second.

        this.update = function (milliSec) {
            if (this._lastTime == null) {
                this._lastTime = milliSec;
                return;
            }

            const deltaSec = Math.max(0, (milliSec - this._lastTime) / 1000);
            this._lastTime = milliSec;

            texture.offset.x = (texture.offset.x + this.xSpeed * deltaSec) % 1;
            texture.offset.y = (texture.offset.y + this.ySpeed * deltaSec) % 1;
        };
    }
}		

export default RenderSystem;

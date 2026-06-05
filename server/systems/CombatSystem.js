const {
    Position,
    Rotation,
    Health,
    Weapon,
} = require('../../shared/components');
const { WEAPONS, PLAYER_HEAD_OFFSET } = require('../../shared/constants');

/**
 * CombatSystem - Handles combat: shooting, weapon cooldowns/reload.
 */
class CombatSystem {
    constructor(ecsWorld, physicsWorld, io) {
        this.ecsWorld = ecsWorld;
        this.physicsWorld = physicsWorld;
        this.heroSystem = null;
        this.io = io;
    }

    isAlive(eid) {
        return Health.current[eid] > 0;
    }

    /**
     * Attempt to fire the entity's current weapon.
     * Handles per-weapon fire cooldown, ammo, reload, spread, and multiple pellets.
     * @param {string} id     - socket ID or bot ID string
     * @param {number} extraSpread - additional inaccuracy to add (for bots)
     */
    shootBullet(id, extraSpread = 0) {
        const eid = this.ecsWorld.getEntityEid(id);
        if (eid === undefined) {
            console.warn(`[CombatSystem] No entity found for ID ${id}`);
            return;
        }
        if (!this.isAlive(eid)) return;

        // ── Weapon gating ─────────────────────────────────────────────────────
        if (Weapon.fireCooldown[eid] > 0) return; // still cooling down
        if (Weapon.reloadTimer[eid] > 0) return;  // mid-reload

        if (Weapon.ammo[eid] <= 0) {
            // Auto-start reload if there's reserve ammo
            this.startReload(eid);
            return;
        }

        const weaponId = Weapon.id[eid];
        const stats = WEAPONS[weaponId];
        if (!stats) return;

        // Consume one round
        Weapon.ammo[eid]--;
        // Set cooldown for next shot
        Weapon.fireCooldown[eid] = stats.fireCooldown * (this.heroSystem?.getFireCooldownMultiplier(eid) ?? 1.0);

        const px   = Position.x[eid];
        const py   = Position.y[eid] + PLAYER_HEAD_OFFSET;
        const pz   = Position.z[eid];
        const yaw  = Rotation.yaw[eid];
        const pitch = Rotation.pitch[eid];

        // ── Fire pellets ──────────────────────────────────────────────────────
        for (let i = 0; i < stats.pellets; i++) {
            const totalSpread = stats.spread + extraSpread;
            const aimYaw   = yaw   + (Math.random() - 0.5) * totalSpread;
            const aimPitch = pitch + (Math.random() - 0.5) * totalSpread;

            const vx = -Math.sin(aimYaw) * Math.cos(aimPitch) * stats.speed;
            const vy =  Math.sin(aimPitch) * stats.speed;
            const vz = -Math.cos(aimYaw) * Math.cos(aimPitch) * stats.speed;

            this.ecsWorld.createBulletEntity(eid, px, py, pz, vx, vy, vz, stats.bulletLifetime);
        }

        this.io.emit('weaponFired', {
            shooterId: id,
            weaponId:  weaponId,
            x: px, y: py, z: pz,
        });

        // Auto-reload when clip is now empty
        if (Weapon.ammo[eid] <= 0) {
            this.startReload(eid);
        }
    }

    /**
     * Start a reload for the given entity.
     * Ammo is unlimited so there is no reserve check.
     */
    startReload(eid) {
        if (Weapon.reloadTimer[eid] > 0) return; // already reloading
        if (Weapon.ammo[eid] >= (WEAPONS[Weapon.id[eid]]?.ammoCapacity ?? 1)) return; // clip already full

        const stats = WEAPONS[Weapon.id[eid]];
        if (!stats) return;
        Weapon.reloadTimer[eid] = stats.reloadTime;
    }

    /**
     * Tick weapon cooldowns and reload timers. Call once per game tick.
     */
    tickWeapons() {
        for (const eid of this.ecsWorld.getAllPlayerAndBotEntities()) {
            if (Weapon.fireCooldown[eid] > 0) Weapon.fireCooldown[eid]--;

            if (Weapon.reloadTimer[eid] > 0) {
                Weapon.reloadTimer[eid]--;
                if (Weapon.reloadTimer[eid] === 0) {
                    // Reload complete – ammo is unlimited, just refill the clip
                    const stats = WEAPONS[Weapon.id[eid]];
                    if (stats) {
                        Weapon.ammo[eid] = stats.ammoCapacity;
                    }
                }
            }
        }
    }
}

module.exports = CombatSystem;

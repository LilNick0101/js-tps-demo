/**
 * SpecialEffects.js
 * 
 * Wrapper fo common visual effects like explosions, hit impacts, status effect visuals, etc.
 * This is separate from the RenderSystem to keep it focused on core rendering and scene management.
 * SpecialEffects can use the RenderSystem for low-level drawing but provides higher-level, reusable effect functions.
 * 
 * Note: Some effects may also trigger corresponding sounds via the AudioManager, but the visual and audio logic are decoupled.
 */

class SpecialEffects{
    constructor(renderSystem, audioManager) {
        this.renderSystem = renderSystem;
        this.audioManager = audioManager;
    }

    // ── Explosion Effects ────────────────────────────────────────────────────
    spawnExplosion({ x, y, z, radius = 6 } = {}) {
        this.renderSystem.explosionVfx({ x, y, z, radius });
        if (x != null) {
            this.audioManager.playRandomSoundAt('explosions', { x, y, z });
        }
    }

    healingEffect(id) {
        this.renderSystem.healingVfx(id);
        const mesh = this.renderSystem.getMesh(id);
        if (mesh) {
            this.audioManager.playSoundAt('health', mesh);
        }
    }

    armorEffect(id) {
        this.renderSystem.armorVfx(id);
        const mesh = this.renderSystem.getMesh(id);
        if (mesh) {
            this.audioManager.playSoundAt('armor', mesh);
        }
    }
}

export default SpecialEffects;
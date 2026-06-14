const {
    TICK_RATE,
    DAMAGE_TYPES,
} = require('../../shared/constants');
const heroConfigs = require('../../shared/config/heroes.json');

class ModifiersSystem {
    constructor(ecsWorld, io){
        this.io = io;
        this._statModifiers = {
            weaponDamage: new Map(),
            abilityDamage: new Map(),
            moveSpeed: new Map(),
            fireCooldown: new Map(),
            weaponResist: new Map(),
            abilityResist: new Map(),
            weaponLifesteal: new Map(),
            abilityLifesteal: new Map()
        };
        this.ecsWorld = ecsWorld;
    }

    update(){
        this._tickStatModifiers();
    }

    _tickStatModifiers() {
        for (const bucket of Object.values(this._statModifiers)) {
            for (const [eid, entries] of bucket) {
                for (let i = entries.length - 1; i >= 0; i--) {
                    const entry = entries[i];
                    //console.log(`[Mods] Found mod: ${bucket}, ${eid}, ${eid}`)
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

    getModifierMultiplier(statKey, eid, defaultMult = 1.0) {
        const list = this._getModifierList(statKey, eid);
        if (!list || list.length === 0) return defaultMult;
        let mult = defaultMult;
        for (const entry of list) {
            if (entry.mult > 0) mult *= entry.mult;
        }
        return mult;
    }

    hasModifierSource(statKey, eid, source) {
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
            //console.log(`[Mods] Quad-damage expired for ${eid}`)
            this.io.emit('quadDamageEnded', { id });
        }
        if (entry.source === 'astralWeaponBonus') {
            this.io.emit('astralWeaponBonusExpired', { id });
        }
    }

    getOutgoingDamageMultiplier(eid, damageType) {
        if (damageType === DAMAGE_TYPES.WEAPON) {
            return this.getModifierMultiplier('weaponDamage', eid);
        }
        if (damageType === DAMAGE_TYPES.ABILITY) {
            return this.getModifierMultiplier('abilityDamage', eid);
        }
        return 1.0;
    }

    getIncomingDamageMultiplier(eid, damageType) {
        if (damageType === DAMAGE_TYPES.WEAPON) {
            return this.getModifierMultiplier('weaponResist', eid);
        }
        if (damageType === DAMAGE_TYPES.ABILITY) {
            return this.getModifierMultiplier('abilityResist', eid);
        }
        return 1.0;
    }

    getFireCooldownMultiplier(eid) {
        return this.getModifierMultiplier('fireCooldown', eid);
    }

    getLifestealMultiplier(eid, damageType) {
        if (damageType === DAMAGE_TYPES.WEAPON) {
            return this.getModifierMultiplier('weaponLifesteal', eid, 1.0) - 1.0;
        }
        if (damageType === DAMAGE_TYPES.ABILITY) {
            return this.getModifierMultiplier('abilityLifesteal', eid, 1.0) - 1.0; 
        }
        return 0.0;
    }

    /**
     * Returns true if a slow modifier is active on the entity.
     * @param {number} eid
     */
    isSlowed(eid) {
        return this.hasModifierSource('moveSpeed', eid, 'slow');
    }

    onDeath(eid){
        this.clearAllModifiers(eid);
    }
}

module.exports = ModifiersSystem
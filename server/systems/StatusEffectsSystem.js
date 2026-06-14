const {
    TICK_RATE
} = require('../../shared/constants')

class StatusEffectsSystem{
    constructor(ecsWorld, modifiers,io){
        this.ecsWorld = ecsWorld;
        /** @type {import('./ModifiersSystem')} */
        this.modifiers = modifiers;
        this.io = io;
    }

    quadDamage(eid, durationTicks, mult) {
        const refreshed = this.modifiers.addTimedModifier(
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

    slow(eid, durationTicks, mult){
        this.modifiers.addTimedModifier(
            eid,
            'moveSpeed',
            mult,
            durationTicks,
            'slow'
        );
    }
}

module.exports = StatusEffectsSystem
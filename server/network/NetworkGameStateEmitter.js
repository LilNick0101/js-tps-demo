const { encode } = require('../../shared/utils/Codec');
const { SnapshotInterpolation } = require('@geckos.io/snapshot-interpolation')

class NetworkGameStateEmitter {
    constructor(io, networkSystem) {
        this.io = io;
        /**
         * @type {import('../systems/NetworkSystem')} networkSystem
         */
        this.networkSystem = networkSystem;
        this.SI = new SnapshotInterpolation();
    }

    emitGameState(state, matchState = null) {
        const {
            players, bots, bullets, pickups, match
        } = this.networkSystem.serializeState(state, matchState);
        const snapshot = this.SI.snapshot.create({
            players: players,
            bots: bots,
            bullets: bullets,
            pickups: pickups
        });

        this.SI.vault.add(snapshot);
        
        this.io.emit('update',{
            state : snapshot,
            match : match
        });
    }

    emitMatchEvent(eventName, payload) {
        if (eventName) {
            this.io.emit(eventName, payload, {reliable: true,interval: 150,runs: 10});
        } else {
            console.warn('Attempted to emit event with empty name');
        }
    }

}

module.exports = NetworkGameStateEmitter;
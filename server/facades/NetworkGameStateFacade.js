const { encode } = require('../../shared/utils/Codec');

class NetworkGameStateFacade {
    constructor(io, networkSystem, stateHistory) {
        this.io = io;
        /**
         * @type {import('../systems/NetworkSystem')} networkSystem
         */
        this.networkSystem = networkSystem;
        this.stateHistory = stateHistory;
    }

    emitGameState(state, matchState = null) {
        const stateSer = this.networkSystem.serializeState(state, matchState);
        this.stateHistory.push(stateSer);
        // Broadcast as raw binary (msgpackr) instead of JSON text frames.
        this.io.raw.emit(encode(stateSer));
    }

    emitMatchEvent(eventName, payload) {
        if (eventName) {
            this.io.emit(eventName, payload, {reliable: true,interval: 150,runs: 10});
        } else {
            console.warn('Attempted to emit event with empty name');
        }
    }

}

module.exports = NetworkGameStateFacade;
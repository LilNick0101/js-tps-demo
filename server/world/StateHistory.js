/**
 * server/world/StateHistory.js
 *
 * Circular buffer that retains the last N milliseconds of serialised world
 * snapshots.  Used for server-side lag compensation: when a player fires a
 * shot we can rewind the world to the moment the client actually saw it and
 * check the hit against that historical state.
 *
 * Default retention window: 500 ms (≈ 30 frames at 60 TPS).
 */
class StateHistory {
    /**
     * @param {number} durationMs  - How many milliseconds of history to keep.
     * @param {number} tickRate    - Server tick rate (used to size the buffer).
     */
    constructor(durationMs = 500, tickRate = 60) {
        this.maxFrames = Math.ceil((durationMs / 1000) * tickRate); // e.g. 30
        /** @type {Array<{timestamp: number, state: object}>} */
        this.buffer = new Array(this.maxFrames);
        this.head   = 0;   // next write index
        this.size   = 0;   // how many valid entries exist
    }

    // -----------------------------------------------------------------------
    // Write
    // -----------------------------------------------------------------------

    /**
     * Record a snapshot of the current world state.
     * @param {object} state - Serialised world state (from NetworkSystem.serializeState).
     */
    push(state) {
        this.buffer[this.head] = { timestamp: Date.now(), state };
        this.head = (this.head + 1) % this.maxFrames;
        if (this.size < this.maxFrames) this.size++;
    }

    // -----------------------------------------------------------------------
    // Read
    // -----------------------------------------------------------------------

    /**
     * Return the snapshot whose timestamp is closest to (and not greater than)
     * the requested timestamp.  If all stored snapshots are newer, returns the
     * oldest available one.
     *
     * @param {number} timestamp - Target epoch in milliseconds.
     * @returns {object|null} Snapshot state, or null if the buffer is empty.
     */
    getAt(timestamp) {
        if (this.size === 0) return null;

        let best      = null;
        let bestDelta = Infinity;

        for (let i = 0; i < this.size; i++) {
            const entry = this.buffer[i];
            if (!entry) continue;

            // Prefer entries at or before the requested time
            const delta = timestamp - entry.timestamp;
            if (delta >= 0 && delta < bestDelta) {
                bestDelta = delta;
                best      = entry;
            }
        }

        // Fall back to the oldest entry if all are newer
        if (!best) {
            best = this._oldest();
        }

        return best ? best.state : null;
    }

    /**
     * Return the two snapshots that bracket the requested timestamp, suitable
     * for linear interpolation.
     *
     * @param {number} timestamp
     * @returns {{ before: object, after: object, t: number }|null}
     *   - `before` / `after` are snapshot states
     *   - `t`       is the interpolation factor in [0, 1]
     */
    getBracket(timestamp) {
        if (this.size < 2) return null;

        // Collect valid entries sorted by time ascending
        const entries = [];
        for (let i = 0; i < this.size; i++) {
            if (this.buffer[i]) entries.push(this.buffer[i]);
        }
        entries.sort((a, b) => a.timestamp - b.timestamp);

        for (let i = 0; i < entries.length - 1; i++) {
            const a = entries[i];
            const b = entries[i + 1];
            if (timestamp >= a.timestamp && timestamp <= b.timestamp) {
                const span = b.timestamp - a.timestamp;
                const t    = span > 0 ? (timestamp - a.timestamp) / span : 0;
                return { before: a.state, after: b.state, t };
            }
        }

        return null;
    }

    /**
     * Return the most recent snapshot.
     * @returns {object|null}
     */
    getLast() {
        if (this.size === 0) return null;
        const idx = (this.head - 1 + this.maxFrames) % this.maxFrames;
        return this.buffer[idx] ? this.buffer[idx].state : null;
    }

    // -----------------------------------------------------------------------
    // Internals
    // -----------------------------------------------------------------------

    _oldest() {
        for (let i = 0; i < this.maxFrames; i++) {
            if (this.buffer[i]) return this.buffer[i];
        }
        return null;
    }
}

module.exports = StateHistory;

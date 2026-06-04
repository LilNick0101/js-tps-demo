import MathUtils from '../utils/MathUtils.js';

/**
 * client/systems/InterpolationSystem.js
 *
 * Remote-Entity Interpolation
 * ----------------------------
 * Server state updates arrive at TICK_RATE (60 fps), but network jitter can
 * cause them to arrive unevenly.  To prevent jittery remote player movement
 * we render them at a point 100 ms in the past, where we almost certainly
 * have two surrounding snapshots and can smoothly lerp between them.
 *
 * Lag budget:
 *   - Snapshot arrival time: T
 *   - Render time:           T − INTERPOLATION_DELAY
 *   We keep enough snapshots (≈ 20  at 60 fps) to cover the delay window
 *   plus a small safety margin for burst jitter.
 *
 * Usage:
 *   // on every stateUpdate received from the server:
 *   interpSystem.addSnapshot(id, { x, y, z, yaw, pitch });
 *
 *   // inside the render/animation loop:
 *   const pos = interpSystem.getInterpolated(id);
 *   if (pos) mesh.position.set(pos.x, pos.y, pos.z);
 */

/** Render remote players this many milliseconds in the past. */
const INTERPOLATION_DELAY = 100;

/** Maximum snapshots retained per entity (covers ~333 ms at 60 fps). */
const MAX_SNAPSHOTS = 24;

class InterpolationSystem {
    constructor() {
        /**
         * Map<entityId, Array<{timestamp, x, y, z, yaw, pitch}>>
         * Snapshots are stored in arrival order (oldest → newest).
         */
        this.snapshots = new Map();
    }

    // -------------------------------------------------------------------------
    // Write
    // -------------------------------------------------------------------------

    /**
     * Record a fresh server snapshot for `id`.
     * Call this for every remote player / bot on each `stateUpdate`.
     *
     * @param {string|number} id    - Entity identifier (socketId or botId).
     * @param {{ x, y, z, yaw, pitch }} state
     */
    addSnapshot(id, state) {
        if (!this.snapshots.has(id)) {
            this.snapshots.set(id, []);
        }

        const buffer = this.snapshots.get(id);
        buffer.push({
            timestamp: performance.now(),
            x:     state.x,
            y:     state.y,
            z:     state.z,
            yaw:   state.yaw,
            pitch: state.pitch ?? 0,
        });

        // Discard snapshots that are too old to be useful
        while (buffer.length > MAX_SNAPSHOTS) {
            buffer.shift();
        }
    }

    // -------------------------------------------------------------------------
    // Read
    // -------------------------------------------------------------------------

    /**
     * Return the interpolated state for `id` at the render time
     * (i.e. `now − INTERPOLATION_DELAY`).
     *
     * @param {string|number} id
     * @returns {{ x, y, z, yaw, pitch }|null}
     *   Returns `null` if no snapshot data is available yet for this entity.
     */
    getInterpolated(id) {
        const buffer = this.snapshots.get(id);
        if (!buffer || buffer.length === 0) return null;

        // With only one snapshot, return it directly (no lerp possible)
        if (buffer.length === 1) return buffer[0];

        const renderTime = performance.now() - INTERPOLATION_DELAY;

        // Find the pair of snapshots that bracket renderTime
        let older = null;
        let newer = null;

        for (let i = buffer.length - 1; i >= 0; i--) {
            if (buffer[i].timestamp <= renderTime) {
                older = buffer[i];
                newer = buffer[i + 1] ?? buffer[i]; // clamp to latest if past end
                break;
            }
        }

        // renderTime is before all stored snapshots – extrapolate from oldest
        if (!older) {
            return buffer[0];
        }

        // renderTime is at or after the latest snapshot – return latest
        if (older === newer || !newer) {
            return older;
        }

        // Linear interpolation between the two bracketing snapshots
        const span     = newer.timestamp - older.timestamp;
        const raw_t    = span > 0 ? (renderTime - older.timestamp) / span : 0;
        const t        = Math.max(0, Math.min(1, raw_t));

        return {
            x:     MathUtils.lerp(older.x,     newer.x,     t),
            y:     MathUtils.lerp(older.y,     newer.y,     t),
            z:     MathUtils.lerp(older.z,     newer.z,     t),
            yaw:   MathUtils.lerpAngle(older.yaw,   newer.yaw,   t),
            pitch: MathUtils.lerp(older.pitch, newer.pitch, t),
        };
    }

    // -------------------------------------------------------------------------
    // Lifecycle helpers
    // -------------------------------------------------------------------------

    /** Remove all buffered snapshots for a disconnected entity. */
    removeEntity(id) {
        this.snapshots.delete(id);
    }

    /** Wipe all state (call on `backToMenu`). */
    clearAll() {
        this.snapshots.clear();
    }
}

export default InterpolationSystem;

import MathUtils from '../utils/MathUtils.js';
import { SnapshotInterpolation } from '@geckos.io/snapshot-interpolation'

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

const TICK_RATE = 60;

/** Maximum snapshots retained per entity (covers ~333 ms at 60 fps). */
const MAX_SNAPSHOTS = 24;

class InterpolationSystem {
    constructor() {
        /**
         * Map<entityId, Array<{timestamp, x, y, z, yaw, pitch}>>
         * Snapshots are stored in arrival order (oldest → newest).
         */
        this.SI = new SnapshotInterpolation(TICK_RATE);
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
    addSnapshot(state) {
        this.SI.snapshot.add(state)
    }

    // -------------------------------------------------------------------------
    // Read
    // -------------------------------------------------------------------------

    calculateSnapshot(){
        const bots = this.SI.calcInterpolation("x y z yaw(rad) pitch(rad)","bots")
        const players = this.SI.calcInterpolation("x y z yaw(rad) pitch(rad)","players")
        const bullets = this.SI.calcInterpolation("x y z","bullets")
        const pickups = this.SI.calcInterpolation("x y z","pickups")
        return {
            players : players,
            bots : bots,
            bullets : bullets,
            pickups : pickups
        }
    }

    /** Wipe all state (call on `backToMenu`). */
    clearAll() {
        this.SI = new SnapshotInterpolation(TICK_RATE);
    }
}

export default InterpolationSystem;

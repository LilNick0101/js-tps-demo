import { SnapshotInterpolation } from '@geckos.io/snapshot-interpolation'

/** Render remote players this many milliseconds in the past. */
const INTERPOLATION_DELAY = 100;

const TICK_RATE = 60;

/** Maximum snapshots retained per entity (covers ~333 ms at 60 fps). */
const MAX_SNAPSHOTS = 24;

class InterpolationSystem {
    constructor() {
        this.SI = new SnapshotInterpolation(TICK_RATE);
    }

    /**
     * Record a fresh server snapshot.
     */
    addSnapshot(state) {
        this.SI.snapshot.add(state)
    }


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

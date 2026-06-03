const {
    Position,
    Jump,
    Velocity,
} = require('../../shared/components');
const { PLAYER_RADIUS, PLAYER_HEIGHT, TICK_RATE } = require('../../shared/constants');

/**
 * CollisionSystem - Handles collision detection and response
 * Manages player-world, projectile-world, and player-player collisions
 */
class CollisionSystem {
    constructor(physicsWorld, io) {
        this.physicsWorld = physicsWorld;
        this.io = io;
    }

    sphereCollisionCheck(targetEid, otherEid, radius) {
        return sphereCollisionCheckCoord(Position.x[targetEid], Position.y[targetEid], Position.z[targetEid],
                                        Position.x[otherEid], Position.y[otherEid], Position.z[otherEid],
                                        radius);
    }

    sphereCollisionCheckCoord(x1, y1, z1, x2, y2, z2, radius) {
        const dx = x1 - x2;
        const dy = y1 - y2;
        const dz = z1 - z2;
        const distSq = dx*dx + dy*dy + dz*dz;
        return distSq <= radius ** 2;
    }
    /**
     * Check collision between bullet and entities using capsule test.
     * The player is approximated as a vertical capsule of radius PLAYER_RADIUS
     * and half-height PLAYER_HEIGHT/2, centred on the entity's Position.
     * Returns true on hit, false otherwise.
     */
    checkBulletCollisions(bulletEid, targetEid, bulletRadius = 0.1) {
        return this.getBulletHitFraction(bulletEid, targetEid, bulletRadius) !== null;
    }

    /**
     * Return earliest hit fraction t in [0,1] along the swept bullet segment.
     * Returns null when no hit occurs within maxFraction.
     */
    getBulletHitFraction(bulletEid, targetEid, bulletRadius = 0.1, maxFraction = 1) {
        const bx = Position.x[bulletEid];
        const by = Position.y[bulletEid];
        const bz = Position.z[bulletEid];

        // Target capsule centre
        const px = Position.x[targetEid];
        const py = Position.y[targetEid];
        const pz = Position.z[targetEid];

        const hitRadius  = PLAYER_RADIUS + bulletRadius;
        const hitRadiusSq = hitRadius * hitRadius;
        const halfHeight = PLAYER_HEIGHT / 2;
        const clampedMax = Math.min(1, Math.max(0, maxFraction));

        // ── Swept segment: reconstruct bullet start position from velocity ──────
        // GameState advances position BEFORE collision is tested, so we walk back
        // one tick to get the segment [prev → current].
        const dt = 1 / TICK_RATE;

        const prevBx = bx - Velocity.vx[bulletEid] * dt;
        const prevBy = by - Velocity.vy[bulletEid] * dt;
        const prevBz = bz - Velocity.vz[bulletEid] * dt;

        // Segment direction & length
        const sdx = bx - prevBx;
        const sdy = by - prevBy;
        const sdz = bz - prevBz;

        const segLenSq = sdx*sdx + sdy*sdy + sdz*sdz;

        if (segLenSq < 1e-10) {
            // Bullet barely moved — fall back to point test
            const clampedY = Math.max(py - halfHeight, Math.min(py + halfHeight, by));
            const dx = bx - px;
            const dy = by - clampedY;
            const dz = bz - pz;
            const d2 = dx*dx + dy*dy + dz*dz;
            return d2 < hitRadiusSq ? 0 : null;
        }

        // Sample enough steps along the segment so no gap exceeds hitRadius.
        // ceil(segLen / hitRadius) steps guarantees no tunnelling.
        const segLen   = Math.sqrt(segLenSq);
        const steps    = Math.max(2, Math.ceil(segLen / hitRadius));
        const invSteps = 1 / steps;

        for (let i = 0; i <= steps; i++) {
            const t  = i * invSteps;
            if (t > clampedMax) break;
            const sx = prevBx + sdx * t;
            const sy = prevBy + sdy * t;
            const sz = prevBz + sdz * t;

            // Closest point on capsule axis to sample point
            const clampedY = Math.max(py - halfHeight, Math.min(py + halfHeight, sy));
            const dx = sx - px;
            const dy = sy - clampedY;
            const dz = sz - pz;
            const d2 = dx*dx + dy*dy + dz*dz;
            if (d2 < hitRadiusSq) return t;
        }

        return null;
    }
}

module.exports = CollisionSystem;

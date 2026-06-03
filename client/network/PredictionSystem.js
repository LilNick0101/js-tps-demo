/**
 * client/network/PredictionSystem.js
 *
 * Client-Side Prediction + Reconciliation
 * ----------------------------------------
 * Instead of waiting for the server round-trip (≈ one RTT of latency) before
 * moving, the client immediately applies every input locally and renders the
 * predicted position.  When the server's acknowledgement arrives we compare
 * the two positions and, if they differ by more than RECONCILE_THRESHOLD,
 * we snap back to the server position and replay all still-unacknowledged
 * inputs on top of it.
 *
 * Movement mathematics mirror server/systems/MovementSystem.js so the
 * predicted result stays as close to authoritative as possible.  Full Rapier
 * physics is not available on the client, so vertical movement (gravity /
 * jump) uses a simplified Euler integration.
 */

// Match server constants (keep in sync with shared/constants.js)
const PLAYER_MOVE_SPEED   = 12.0;
const GRAVITY             = -9.81;
const PLAYER_JUMP_IMPULSE = 500;
const PLAYER_MASS         = 80;
const GROUND_Y            = 1.0;
const RECONCILE_THRESHOLD = 0.05;
const DASH_COOLDOWN_FRAMES = 30;  // keep in sync with shared/constants.js
const DASH_SPEED_MULTIPLIER = 100; // matches server dashSpeed = PLAYER_MOVE_SPEED * 100

class PredictionSystem {
    constructor() {
        this.x  = 0;
        this.y  = GROUND_Y;
        this.z  = 0;

        this.vy = 0;
        this.vx = 0;  // needed to carry dash horizontal velocity between ticks
        this.vz = 0;

        this.isGrounded = true;

        // Dash state (mirrors server Dash component)
        this.canDash      = true;
        this.dashTimer    = 0;   // frames remaining on cooldown
        this.dashDuration = 0;   // frames remaining for active dash impulse

        this.isCrystalSmashing = false;
        this.crystalSmashLockDuration = 0;

        this.corrections = 0;
    }

    // -------------------------------------------------------------------------
    // Initialisation
    // -------------------------------------------------------------------------

    initialize(x, y, z) {
        this.x  = x;
        this.y  = y;
        this.z  = z;
        this.vy = 0;
        this.vx = 0;
        this.vz = 0;
        this.isGrounded   = y <= GROUND_Y + 0.1;
        this.canDash      = true;
        this.dashTimer    = 0;
        this.dashDuration = 0;
    }

    // -------------------------------------------------------------------------
    // Prediction
    // -------------------------------------------------------------------------

    /**
     * @param {{ inputs: object, yaw: number, dashForward: number, dashRight: number }} input
     * @param {number} dt
     */
    applyInput(input, dt) {
        const { inputs, yaw } = input;

        // ── Crystal Smash movement lock ──────────────────────────────────────
        if (this.isCrystalSmashing) {
            this.crystalSmashLockDuration -= dt;
            if (this.crystalSmashLockDuration <= 0) {
                this.isCrystalSmashing = false;
                this.vx = 0;
                this.vz = 0;
            } else {
                this.x += this.vx * dt;
                this.z += this.vz * dt;
                return; // Early exit: movement locked
            }
        }

        // ── Dash cooldown tick ───────────────────────────────────────────────
        if (this.dashTimer > 0) {
            this.dashTimer--;
            this.dashDuration = Math.max(0, this.dashDuration - 1);
            if (this.dashTimer === 0) {
                this.canDash = true;
            }
        }

        // ── Dash initiation ──────────────────────────────────────────────────
        if (inputs.dash && this.canDash && this.dashTimer === 0) {
            const dashForward = input.dashForward ?? (inputs.forward ? 1 : inputs.backward ? -1 : 0);
            const dashRight   = input.dashRight   ?? (inputs.right  ? 1 : inputs.left    ? -1 : 0);

            const dirX = -Math.sin(yaw) * dashForward + Math.cos(yaw) * dashRight;
            const dirZ = -Math.cos(yaw) * dashForward - Math.sin(yaw) * dashRight;
            const len  = Math.sqrt(dirX * dirX + dirZ * dirZ);

            if (len > 0) {
                const dashSpeed = PLAYER_MOVE_SPEED * DASH_SPEED_MULTIPLIER;
                this.vx = (dirX / len) * dashSpeed;
                this.vz = (dirZ / len) * dashSpeed;

                this.canDash      = false;
                this.dashTimer    = DASH_COOLDOWN_FRAMES;
                this.dashDuration = 16; // frames, matches server
            }
        }

        // ── Horizontal ──────────────────────────────────────────────────────
        if (this.dashDuration > 0) {
            // Carry dash velocity — don't override with normal movement
            this.x += this.vx * dt;
            this.z += this.vz * dt;
        } else {
            let dirX = 0;
            let dirZ = 0;

            if (inputs.forward)  { dirX -= Math.sin(yaw); dirZ -= Math.cos(yaw); }
            if (inputs.backward) { dirX += Math.sin(yaw); dirZ += Math.cos(yaw); }
            if (inputs.left)     { dirX -= Math.cos(yaw); dirZ += Math.sin(yaw); }
            if (inputs.right)    { dirX += Math.cos(yaw); dirZ -= Math.sin(yaw); }

            if (dirX !== 0 || dirZ !== 0) {
                const len = Math.sqrt(dirX * dirX + dirZ * dirZ);
                this.x += (dirX / len) * PLAYER_MOVE_SPEED * dt;
                this.z += (dirZ / len) * PLAYER_MOVE_SPEED * dt;
            }
        }

        // ── Vertical (simplified Euler) ──────────────────────────────────────
        if (this.isGrounded && inputs.jump) {
            this.vy         = PLAYER_JUMP_IMPULSE / PLAYER_MASS;
            this.isGrounded = false;
        }

        if (!this.isGrounded) {
            this.vy += GRAVITY * dt;
            this.y  += this.vy * dt;

            if (this.y <= GROUND_Y) {
                this.y          = GROUND_Y;
                this.vy         = 0;
                this.isGrounded = true;
                this.canDash    = true; // restore dash on landing, mirrors server
            }
        }
    }

    // -------------------------------------------------------------------------
    // Reconciliation
    // -------------------------------------------------------------------------

    reconcile(serverState, inputBuffer) {
        const dx     = this.x - serverState.x;
        const dy     = this.y - serverState.y;
        const dz     = this.z - serverState.z;
        const distSq = dx * dx + dy * dy + dz * dz;

        if (distSq > RECONCILE_THRESHOLD * RECONCILE_THRESHOLD) {
            this.corrections++;

            this.x          = serverState.x;
            this.y          = serverState.y;
            this.z          = serverState.z;
            this.vy         = 0;
            this.vx         = 0;
            this.vz         = 0;
            this.isGrounded = serverState.y <= GROUND_Y + 0.1;

            // Restore dash state from server if provided
            this.canDash      = serverState.canDash      ?? true;
            this.dashTimer    = serverState.dashTimer    ?? 0;
            this.dashDuration = serverState.dashDuration ?? 0;

            const unacked = inputBuffer.filter(
                (inp) => inp.seq > serverState.lastProcessedSeq
            );

            const FALLBACK_DT = 1 / 60;
            for (const inp of unacked) {
                this.applyInput(inp, inp.dt ?? FALLBACK_DT);
            }

            return true;
        }

        return false;
    }

    startCrystalSmash(yaw, duration) {
        this.isCrystalSmashing = true;
        this.crystalSmashLockDuration = duration;
        
        // Match CRYSTAL_SMASH_DASH_SPEED in shared/constants.js
        const DASH_SPEED = 30.0;
        this.vx = -Math.sin(yaw) * DASH_SPEED;
        this.vz = -Math.cos(yaw) * DASH_SPEED;
    }

    stopCrystalSmash() {
        this.isCrystalSmashing = false;
        this.crystalSmashLockDuration = 0;
        this.vx = 0;
        this.vz = 0;
    }

    // -------------------------------------------------------------------------
    // Accessors
    // -------------------------------------------------------------------------

    getPosition() {
        return { x: this.x, y: this.y, z: this.z };
    }
}

export default PredictionSystem;

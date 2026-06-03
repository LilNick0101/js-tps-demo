const {
    Rotation,
    Controller,
    Jump,
    Dash
} = require('../../shared/components');
const { PLAYER_MOVE_SPEED, PLAYER_JUMP_FORCE, PHYSICS_TIMESTEP, DASH_COOLDOWN_FRAMES, AIR_CONTROL_FACTOR, ABILITY_COOLDOWNS } = require('../../shared/constants');

class MovementSystem {
    constructor(ecsWorld, physicsWorld) {
        /** @type {import('../world/World')} */
        this.ecsWorld     = ecsWorld;
        /** @type {import('../world/PhysicsWorld')} */
        this.physicsWorld = physicsWorld;
        /** @type {import('./HeroSystem') | null} Injected after HeroSystem is created */
        this.heroSystem = null;
    }

    checkJump(eid, bodyId) {
        Jump.jumpTimer[eid] = Math.max(0, Jump.jumpTimer[eid] - PHYSICS_TIMESTEP); // Decrement jump timer

        // Decrement dash cooldown (integer frames); re-enable dash when timer expires
        if (Dash.dashTimer[eid] > 0) {
            Dash.dashTimer[eid]--;
            Dash.dashDuration[eid] = Math.max(0, Dash.dashDuration[eid] - 1);
            if (Dash.dashDuration[eid] == 0 && Dash.isDashing[eid] === 1) {
                const v = this.physicsWorld.getLinearVelocity(bodyId);
                this.physicsWorld.setLinearVelocity(bodyId, v.x / 4, v.y, v.z / 4); // Optional: apply a velocity penalty when dash ends
                Dash.isDashing[eid] = 0;
            } 
            if (Dash.dashTimer[eid] === 0) {
                Dash.canDash[eid] = 1; // Cooldown expired — restore dash
                
            }
        }

        const wasGrounded = Jump.isGrounded[eid];
        const isGrounded = this.physicsWorld.checkGroundDetection(bodyId); // Update grounded state for jump logic
        Jump.isGrounded[eid] = isGrounded;
        if (!wasGrounded && isGrounded) {
            Jump.jumpsRemaining[eid] = 2;
            Dash.canDash[eid] = 1; // Also restore dash immediately on landing
        }
    }

    update() {
        if (!this.physicsWorld) return; // Wait for physics to initialize
        
        for (const eid of this.ecsWorld.getAllPlayerAndBotEntities()) {
            const bodyId = this.ecsWorld.getSocketByEntity(eid) || this.ecsWorld.getBotIdString(eid);
            if (bodyId) {
                this.checkJump(eid, bodyId);
            }
        }
    }

    isPlayerOnGround(eid) {
        const jumpState = Jump.isGrounded[eid] !== undefined ? Jump.isGrounded[eid] : false;
        return jumpState;
    }

    /**
     * Compute the desired XZ velocity for an entity based on its controller
     * state and facing direction, then apply it directly to the physics body.
     *
     * @param {number} eid       - bitECS entity id
     * @param {string} bodyId    - physics body id (usually channel.id or "bot_<eid>")
     * @returns {boolean}        - true if any directional input was active
     */
    moveEntity(eid, bodyId) {
        const yaw = Rotation.yaw[eid];

        // Accumulate raw input vectors (local space → world space via yaw)
        let dirX = 0;
        let dirZ = 0;

        if (Controller.forward[eid]) {
            dirX -= Math.sin(yaw);
            dirZ -= Math.cos(yaw);
        }
        if (Controller.backward[eid]) {
            dirX += Math.sin(yaw);
            dirZ += Math.cos(yaw);
        }
        if (Controller.left[eid]) {
            dirX -= Math.cos(yaw);   //  sin(yaw + π/2) = cos(yaw)
            dirZ += Math.sin(yaw);   // -cos(yaw + π/2) = sin(yaw)
        }
        if (Controller.right[eid]) {
            dirX += Math.cos(yaw);   //  sin(yaw - π/2) = -cos(yaw)
            dirZ -= Math.sin(yaw);   // -cos(yaw - π/2) = -sin(yaw)
        }

        if (dirX === 0 && dirZ === 0) {
            return false; // No input — let the caller apply friction
        }

        // Normalise so diagonal movement isn't faster than cardinal movement
        const len = Math.sqrt(dirX * dirX + dirZ * dirZ);
        if (len < 1e-6) return false; // Small epsilon check

        const speedMult = this.heroSystem?.isSlowed(eid)
            ? ABILITY_COOLDOWNS.SHOCK_GRENADE_SLOW_FACTOR * (this.heroSystem?.getMovementSpeedMult(eid) ?? 1.0)
            : (this.heroSystem?.getMovementSpeedMult(eid) ?? 1.0);
        const targetVx = (dirX / len) * PLAYER_MOVE_SPEED * speedMult;
        const targetVz = (dirZ / len) * PLAYER_MOVE_SPEED * speedMult;

        // Don't override velocity while a dash is still in flight
        if (Dash.dashDuration[eid] > 0) {
            this.physicsWorld.setVerticalVelocity(bodyId, 0); // Cancel any vertical velocity changes during dash
            return true;
        }

        if (Jump.isGrounded[eid]) {
            this.physicsWorld.setHorizontalVelocity(bodyId, targetVx, targetVz);
        } else {
            
            const cur = this.physicsWorld.getLinearVelocity(bodyId);
            const vx = cur.x + (targetVx - cur.x) * AIR_CONTROL_FACTOR;
            const vz = cur.z + (targetVz - cur.z) * AIR_CONTROL_FACTOR;
            this.physicsWorld.setHorizontalVelocity(bodyId, vx, vz);
        }

        return true;
    }

    jumpEntity(bodyId) {
        const eid = this.ecsWorld.getEntityEid(bodyId);
        if (!eid) {
            console.error(`MovementSystem: could not resolve entity for bodyId ${bodyId}`);
            return;
        }
        if (Jump.jumpsRemaining[eid] <= 0 || Jump.jumpTimer[eid] > 0) {
            return; 
        }

        const isFirstJump = Jump.jumpsRemaining[eid] === 2;
        if (isFirstJump && Jump.isGrounded[eid] === 0) return;
        if (!isFirstJump && Jump.isGrounded[eid] === 1) return;
        

        this.physicsWorld.setVerticalVelocity(bodyId, 8);

        Jump.jumpsRemaining[eid]--;
        Jump.jumpTimer[eid] = 0.4;
        Jump.isGrounded[eid] = 0; 
    }

    dashEntity(eid, forward, right, bodyId) {
        if (Dash.canDash[eid] === 0 || Dash.dashTimer[eid] > 0) {
            return; // Dash is on cooldown
        }

        const yaw = Rotation.yaw[eid];
        const dashSpeed = PLAYER_MOVE_SPEED * 4; // Dash is faster than normal movement

        // Build a world-space direction from local forward/right inputs
        const dirX = -Math.sin(yaw) * forward + Math.cos(yaw) * right;
        const dirZ = -Math.cos(yaw) * forward - Math.sin(yaw) * right;

        // If there's no directional input, do nothing
        const len = Math.sqrt(dirX * dirX + dirZ * dirZ);
        if (len === 0) return;

        const vx = (dirX / len) * dashSpeed;
        const vz = (dirZ / len) * dashSpeed;

        this.physicsWorld.setHorizontalVelocity(bodyId, vx, vz);
        Dash.canDash[eid] = 0; // Consume the dash
        Dash.dashTimer[eid] = DASH_COOLDOWN_FRAMES; // Start cooldown timer (frames)
        Dash.dashDuration[eid] = 14; // Dash lasts for 14 frames (about 0.23 seconds at 60fps) during which normal movement is overridden
        Dash.isDashing[eid] = 1; // Mark as currently dashing
    }
}


module.exports = MovementSystem;

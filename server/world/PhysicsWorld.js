const RAPIER = require('@dimforge/rapier3d-compat');
const { 
    GRAVITY,
    GROUND_FRICTION,
    GROUND_RESTITUTION,
    PLAYER_RADIUS,
} = require('../../shared/constants');
const { Vector3 } = require('../../shared/utils/Vector3.js');
const {
    Position,
    Velocity,
} = require('../../shared/components');

const GROUP_PLAYER = 0x0001; // Group 0
const GROUP_GROUND = 0x0002; // Group 1
const GROUP_MAP    = 0x0004; // Group 2 — map collision meshes

// Players collide with ground, map geometry, and other players
const PLAYER_MEMBERSHIP = (GROUP_PLAYER << 16) | (GROUP_GROUND | GROUP_MAP | GROUP_PLAYER);
const GROUND_MEMBERSHIP = (GROUP_GROUND << 16) | (GROUP_PLAYER | GROUP_GROUND);
// Map meshes collide with players and ground
const MAP_MEMBERSHIP    = (GROUP_MAP << 16)    | (GROUP_PLAYER | GROUP_GROUND | GROUP_MAP);
// LOS should ignore players and only hit solid world geometry
const LOS_MEMBERSHIP    = (GROUP_PLAYER << 16) | (GROUP_GROUND | GROUP_MAP);



/**
 * PhysicsWorld - Wrapper for Rapier physics simulation
 * Manages the physics world, bodies, and stepping
 */
class PhysicsWorld {
    constructor() {
        this.world = null;
        this.bodies = new Map();
        this.rigidBodies = new Map();
        /** @type {Map<number, RAPIER.CharacterController>} */
        this.characterControllers = new Map();
        this.colliders = new Map();
        
        // Time step settings
        this.fixedTimeStep = 1 / 60;
        
        // Initialize Rapier asynchronously
        this.initPromise = this.init();
    }

    
    
    async init() {
        await RAPIER.init();
        this.world = new RAPIER.World({ x: 0.0, y: GRAVITY, z: 0.0 });
        console.log('Rapier physics world initialized');
    }
    
    async ensureInitialized() {
        if (!this.world) {
            await this.initPromise;
        }
    }
    
    /**
     * Add a body to the physics world
     */
    addBody(id, body) {
        if (!this.world) return;
        // Body is already added to world in create methods
        this.bodies.set(id, body.handle);
        this.rigidBodies.set(id, body);
    }
    
    /**
     * Remove a body from the physics world
     */
    removeBody(id) {
        const body = this.rigidBodies.get(id);
        if (body && this.world) {
            this.world.removeRigidBody(body);
            this.bodies.delete(id);
            this.rigidBodies.delete(id);
        }
    }
    
    /**
     * Get a body by ID
     * @returns {RAPIER.RigidBody} The rigid body associated with the given ID, or null if not found
     */
    getBody(id) {
        return this.rigidBodies.get(id);
    }
    
    /**
     * Step the physics simulation
     */
    step(deltaTime) {
        if (!this.world) return;
        if (deltaTime) {
            this.fixedTimeStep = deltaTime;
        }
        this.applyKinematicGravity(this.fixedTimeStep);
        this.world.step();

    }

    applyKinematicGravity(deltaTime) {
        for (const [id, body] of this.rigidBodies.entries()) {
            if (!body || !body.bodyType) continue;

            const bodyType = body.bodyType();
            const isKinematic = bodyType === RAPIER.RigidBodyType.KinematicPositionBased
                || bodyType === RAPIER.RigidBodyType.KinematicVelocityBased;

            if (!isKinematic) continue;

            const cur = body.linvel();
            const charCont = this.characterControllers.get(body.handle);

            if (charCont) {
                const isGrounded = this.checkGroundDetection(id);
                let verticalVelocity = cur.y;

                if (!isGrounded) {
                    verticalVelocity += GRAVITY * deltaTime;
                } else {
                    verticalVelocity = 0;
                }

                const desiredTranslation = {
                    x: cur.x * deltaTime,
                    y: verticalVelocity * deltaTime,
                    z: cur.z * deltaTime,
                };

                charCont.computeColliderMovement(body, desiredTranslation);
                const movement = charCont.computedMovement();

                body.setLinvel({
                    x: movement.x / deltaTime,
                    y: movement.y / deltaTime,
                    z: movement.z / deltaTime,
                }, true);
                continue;
            }

            body.setLinvel({ x: cur.x, y: cur.y + GRAVITY * deltaTime, z: cur.z }, true);
        }
    }

    /**
     * 
     * @param {string} id 
     * @returns {boolean} True if the body with the given ID is currently grounded (i.e. has solid contact below it), false otherwise
     */
    checkGroundDetection(id) {
        const body = this.rigidBodies.get(id);
        if (!body) return false;
        
        const pos = body.translation();
        const vel = body.linvel();
        // Probe just below the collider's feet and ignore hits against the same body.
        const rayOrigin = {
            x: pos.x,
            y: pos.y - PLAYER_RADIUS + 0.06,
            z: pos.z,
        };
        //console.log(`Checking ground for body ${id} at position (${pos.x.toFixed(2)}, ${pos.y.toFixed(2)}, ${pos.z.toFixed(2)}), ray origin (${rayOrigin.x.toFixed(2)}, ${rayOrigin.y.toFixed(2)}, ${rayOrigin.z.toFixed(2)}), velocity (${vel.x.toFixed(2)}, ${vel.y.toFixed(2)}, ${vel.z.toFixed(2)})`);
        const rayDir = { x: 0, y: -1, z: 0 };
        const maxToi = 0.14;
        const solid = true;
        
        const ray = new RAPIER.Ray(rayOrigin, rayDir);
        const rayFilter = PLAYER_MEMBERSHIP;
        const hit = this.world.castRay(ray, maxToi, solid, 0xffffffff, rayFilter, null, body);

        return hit !== null && vel.y <= 0.5;
    }

    checkGroundDetectionAt(x,y,z) {
        const rayOrigin = {
            x: x,
            y: y,
            z: z,
        };
        const rayDir = { x: 0, y: -1, z: 0 };
        const maxToi = 0.13;
        const solid = true;
        
        const ray = new RAPIER.Ray(rayOrigin, rayDir);
        const rayFilter = PLAYER_MEMBERSHIP;
        const hit = this.world.castRay(ray, maxToi, solid, 0xffffffff, rayFilter, null, null);

        return hit !== null;
    }
    
    /**
     * Create a player physics body (sphere)
     */
    createPlayerBody(x, y, z, radius, mass) {
        if (!this.world) return null;
        
        // Create rigid body descriptor
        // Linear damping is set to 0 — we apply stopping friction manually
        // in the game loop only when there's no input, giving instant snappy stops.
        const rigidBodyDesc = RAPIER.RigidBodyDesc.kinematicVelocityBased()
            .setTranslation(x, y, z)
            .setLinearDamping(0.0)
            .setAngularDamping(10.0) // Prevent spinning
            .setCanSleep(false) // Always active for responsive controls
        
        const rigidBody = this.world.createRigidBody(rigidBodyDesc);
        
        // Create sphere collider
        const colliderDesc = RAPIER.ColliderDesc.ball(radius)
            .setDensity(mass / (4/3 * Math.PI * radius * radius * radius))
            .setRestitution(GROUND_RESTITUTION)
            .setCollisionGroups(PLAYER_MEMBERSHIP);
        
        this.world.createCollider(colliderDesc, rigidBody);
        
        // Lock rotation to prevent player from tipping over
        rigidBody.lockRotations(true, true);

        // The gap the controller will leave between the character and its environment.
        let offset = 0.05;
        // Create the controller.
        let characterController = this.world.createCharacterController(offset);
        characterController.enableAutostep(0.4, 0.2, true);
        characterController.enableSnapToGround(0.5);
        characterController.setMaxSlopeClimbAngle(45 * Math.PI / 180);
        characterController.setMinSlopeSlideAngle(40 * Math.PI / 180);

        this.characterControllers.set(rigidBody.handle, characterController);
        
        return rigidBody;
    }
    
    /**
     * Create a static trimesh collision body from pre-baked vertex/index data.
     * Used by MapLoader for both real map meshes and procedural flat maps.
     * @param {number[]} vertices - Flat array of [x,y,z, x,y,z, ...] positions
     * @param {number[]} indices  - Flat array of triangle indices [i0,i1,i2, ...]
     * @param {number} tx - World-space X translation
     * @param {number} ty - World-space Y translation
     * @param {number} tz - World-space Z translation
     * @returns {RAPIER.RigidBody}
     */
    createTrimeshBody(vertices, indices, tx = 0, ty = 0, tz = 0) {
        if (!this.world) return null;

        const rigidBodyDesc = RAPIER.RigidBodyDesc.fixed().setTranslation(tx, ty, tz);
        const rigidBody = this.world.createRigidBody(rigidBodyDesc);

        const colliderDesc = RAPIER.ColliderDesc
            .trimesh(new Float32Array(vertices), new Uint32Array(indices))
            .setFriction(GROUND_FRICTION)
            .setRestitution(GROUND_RESTITUTION)
            .setCollisionGroups(MAP_MEMBERSHIP);

        this.world.createCollider(colliderDesc, rigidBody);
        return rigidBody;
    }

    /**
     * Create a static floor body (cuboid)
     * @param {number} x - Center X
     * @param {number} z - Center Z
     * @param {number} width - Total width along X
     * @param {number} depth - Total depth along Z
     * @param {number} y - Top surface Y (default 0)
     */
    createFloorBody(x, z, width, depth, y = 0) {
        if (!this.world) return null;
        
        // The cuboid collider takes half-extents
        const hx = width / 2;
        const hz = depth / 2;
        const hy = 1.0; // 2 units thick floor
        
        // Position it so the top surface is at `y`
        const cy = y - hy;
        
        const rigidBodyDesc = RAPIER.RigidBodyDesc.fixed().setTranslation(x, cy, z);
        const rigidBody = this.world.createRigidBody(rigidBodyDesc);
        
        const colliderDesc = RAPIER.ColliderDesc.cuboid(hx, hy, hz)
            .setFriction(GROUND_FRICTION)
            .setRestitution(GROUND_RESTITUTION)
            .setCollisionGroups(MAP_MEMBERSHIP);
            
        this.world.createCollider(colliderDesc, rigidBody);
        
        return rigidBody;
    }

    /**
     * Create a static wall body (cuboid between two points)
     * @param {number} x1 - Start X
     * @param {number} z1 - Start Z
     * @param {number} x2 - End X
     * @param {number} z2 - End Z
     * @param {number} height - Wall height
     * @param {number} y - Bottom Y (default 0)
     * @param {number} thickness - Wall thickness (default 2)
     */
    createWallBody(x1, z1, x2, z2, height = 10, y = 0, thickness = 2) {
        if (!this.world) return null;
        
        const dx = x2 - x1;
        const dz = z2 - z1;
        const length = Math.sqrt(dx * dx + dz * dz);
        
        const cx = (x1 + x2) / 2;
        const cz = (z1 + z2) / 2;
        const cy = y + height / 2;
        
        const angle = Math.atan2(dz, dx);
        
        const rigidBodyDesc = RAPIER.RigidBodyDesc.fixed()
            .setTranslation(cx, cy, cz)
            // Rapier uses quaternions for rotation. For rotation around Y axis:
            .setRotation({ x: 0, y: Math.sin(angle / 2), z: 0, w: Math.cos(angle / 2) });
            
        const rigidBody = this.world.createRigidBody(rigidBodyDesc);
        
        const colliderDesc = RAPIER.ColliderDesc.cuboid(length / 2, height / 2, thickness / 2)
            .setFriction(GROUND_FRICTION)
            .setRestitution(GROUND_RESTITUTION)
            .setCollisionGroups(MAP_MEMBERSHIP);
            
        this.world.createCollider(colliderDesc, rigidBody);
        
        return rigidBody;
    }

    /**
     * Create a projectile body (small sphere)
     */
    createProjectileBody(x, y, z, radius, vx, vy, vz, options = {}) {
        if (!this.world) return null;
        
        const {
            gravityScale = 1.0,
            restitution = 0.4,
            friction = 0.5,
            density = 0.1,
            angularDamping = 0.5
        } = options;
        
        const rigidBodyDesc = RAPIER.RigidBodyDesc.dynamic()
            .setTranslation(x, y, z)
            .setLinvel(vx, vy, vz)
            .setGravityScale(gravityScale)
            .setAngularDamping(angularDamping);
        
        const rigidBody = this.world.createRigidBody(rigidBodyDesc);
        
        const colliderDesc = RAPIER.ColliderDesc.ball(radius)
            .setDensity(density)
            .setRestitution(restitution)
            .setFriction(friction)
            .setCollisionGroups(PLAYER_MEMBERSHIP);
        
        this.world.createCollider(colliderDesc, rigidBody);
        
        return rigidBody;
    }
    
    /**
     * Raycast from position downward to detect ground
     */
    raycastGround(x, y, z, distance = 0.1) {
        if (!this.world) return false;
        
        const rayOrigin = { x, y, z };
        const rayDir = { x: 0, y: -1, z: 0 };
        const ray = new RAPIER.Ray(rayOrigin, rayDir);
        
        const hit = this.world.castRay(ray, distance, true);
        return hit !== null;
    }

    /**
     * Raycast against solid world geometry (ground + map meshes).
     * Returns null or { toi, x, y, z } where toi is distance along the ray.
     */
    raycastWorld(origin, direction, maxDistance) {
        if (!this.world) return null;
        if (maxDistance <= 0) return null;

        const dirLen = Math.sqrt(
            direction.x * direction.x +
            direction.y * direction.y +
            direction.z * direction.z
        );
        if (dirLen < 1e-8) return null;

        const rayDir = {
            x: direction.x / dirLen,
            y: direction.y / dirLen,
            z: direction.z / dirLen,
        };

        const ray = new RAPIER.Ray(origin, rayDir);
        const hit = this.world.castRay(ray, maxDistance, true, 0xffffffff, LOS_MEMBERSHIP, null, null);
        if (!hit) return null;

        const toi = hit.timeOfImpact;
        return {
            toi,
            x: origin.x + rayDir.x * toi,
            y: origin.y + rayDir.y * toi,
            z: origin.z + rayDir.z * toi,
        };
    }
    
    /**
     * Apply force to a body
     */
    applyForce(id, fx, fy, fz) {
        const body = this.rigidBodies.get(id);
        if (body) {
            body.addForce({ x: fx, y: fy, z: fz }, true);
        }
    }

    checkLineOfSight(id1, id2) {

        const body1 = this.rigidBodies.get(id1);
        const body2 = this.rigidBodies.get(id2);
        if (!body1 || !body2) return false;

        const pos1 = body1.translation();
        const pos2 = body2.translation();

        const rayOrigin = { x: pos1.x, y: pos1.y + 0.5, z: pos1.z };
        const rayDir = { x: pos2.x - pos1.x, y: (pos2.y + 0.5) - (pos1.y + 0.5), z: pos2.z - pos1.z };
        const length = Math.sqrt(rayDir.x * rayDir.x + rayDir.y * rayDir.y + rayDir.z * rayDir.z);
        if (length === 0) return true;

        rayDir.x /= length;
        rayDir.y /= length;
        rayDir.z /= length;

        const ray = new RAPIER.Ray(rayOrigin, rayDir);
    
        // Only test against ground/map, and exclude the shooter body to avoid self-hits.
        const hit = this.world.castRay(ray, length, true, 0xffffffff, LOS_MEMBERSHIP, null, body1);
        
        return hit === null; // No hit means clear line of sight
    }

    /**
     * Return the current linear velocity of a body as { x, y, z }.
     */
    getLinearVelocity(id) {
        const body = this.rigidBodies.get(id);
        return body ? body.linvel() : { x: 0, y: 0, z: 0 };
    }

    /**
     * Directly set the horizontal (XZ) velocity of a body while preserving
     * the current vertical (Y) velocity.  This gives instant, snappy
     * response to player input instead of waiting for forces to accelerate.
     * 
     * DEPRECATED: Use setLinearVelocity instead with the full velocity vector for better character controller integration and more consistent behavior across body types.
     */
    setHorizontalVelocity(id, vx, vz) {
        const body = this.rigidBodies.get(id);
        if (body) {
            const charCont = this.characterControllers.get(body.handle);
            const cur = body.linvel();
            if (charCont) {
                let verticalVelocity = cur.y;

                const desiredTranslation = {
                    x: vx * this.fixedTimeStep,
                    y: verticalVelocity * this.fixedTimeStep,
                    z: vz * this.fixedTimeStep,
                };
                charCont.computeColliderMovement(body, desiredTranslation);
                
                const movement = charCont.computedMovement(); 
                
                body.setLinvel({ 
                    x: movement.x / this.fixedTimeStep, 
                    y: movement.y / this.fixedTimeStep, 
                    z: movement.z / this.fixedTimeStep 
                }, true);
                return;
            }
            body.setLinvel({ x: vx, y: cur.y, z: vz }, true);
        }
    }

    /**
     * Directly set the vertical (Y) velocity of a body while preserving
     * the current horizontal (XZ) velocity.  Used for jumping and gravity.
     * DEPRECATED: Use setLinearVelocity instead with the full velocity vector for better character controller integration and more consistent behavior across body types.
     */
    setVerticalVelocity(id, vy) {
        const body = this.rigidBodies.get(id);
        if (body) {
            const charCont = this.characterControllers.get(body.handle);
            if (charCont) {
                const desiredTranslation = { x: 0, y: vy * this.fixedTimeStep, z: 0 };
                charCont.computeColliderMovement(body, desiredTranslation);
                
                const movement = charCont.computedMovement();
                const cur = body.linvel();
                
                body.setLinvel({ 
                    x: cur.x, 
                    y: movement.y / this.fixedTimeStep, 
                    z: cur.z 
                }, true);
                return;
            } 
            const cur = body.linvel();
            body.setLinvel({ x: cur.x, y: vy, z: cur.z }, true);
        }
    }

    /**
     * Set the full linear velocity of a body.  For character controllers, this will compute the appropriate movement and collision response to achieve the desired velocity while respecting slopes and steps.
     * @param {string} id - The ID of the body to modify
     * @param {number} vx - Desired velocity along X axis
     * @param {number} vy - Desired velocity along Y axis
     * @param {number} vz - Desired velocity along Z axis
     * @param {boolean} raw - If true, directly set the velocity without character controller processing (use with caution, may cause tunneling or clipping)
     */
    setLinearVelocity(id, vx, vy, vz, raw = false) {
        const body = this.rigidBodies.get(id);
        if (body && !raw) {
            const charCont = this.characterControllers.get(body.handle);
            if (charCont) {
                const desiredTranslation = { x: vx * this.fixedTimeStep, y: vy * this.fixedTimeStep, z: vz * this.fixedTimeStep };
                charCont.computeColliderMovement(body, desiredTranslation);
                
                const movement = charCont.computedMovement();
                const cur = body.linvel();
                
                body.setLinvel({ 
                    x: movement.x / this.fixedTimeStep, 
                    y: movement.y / this.fixedTimeStep, 
                    z: movement.z / this.fixedTimeStep 
                }, true);
                return;
            } 
            const cur = body.linvel();
            body.setLinvel({ x: cur.x, y: vy, z: cur.z }, true);
        }
    }

    raytrace(origin, direction, maxDistance) {
        if (!this.world) return null;
        
        const ray = new RAPIER.Ray(origin, direction);
        const hit = this.world.castRay(ray, maxDistance, true);
        
        if (hit != null) {
        // 3. Calculate the exact x, y, z position
            const hitPosition = {
                x: ray.origin.x + ray.dir.x * hit.timeOfImpact,
                y: ray.origin.y + ray.dir.y * hit.timeOfImpact,
                z: ray.origin.z + ray.dir.z * hit.timeOfImpact
            };

            console.log("Hit at:", hitPosition.x, hitPosition.y, hitPosition.z);
        
            return hitPosition;
        }
        return null
    }

    /**
     * Smoothly brake horizontal movement by multiplying XZ velocity by a
     * friction factor each tick.  Used when the player has no directional input.
     */
    applyGroundFriction(id, factor) {
        const body = this.rigidBodies.get(id);
        if (body) {
            const vel = body.linvel();
            const charCont = this.characterControllers.get(body.handle);
            if (charCont) {
                const desiredTranslation = {
                    x: vel.x * factor * this.fixedTimeStep,
                    y: vel.y * this.fixedTimeStep,
                    z: vel.z * factor * this.fixedTimeStep,
                };
                charCont.computeColliderMovement(body, desiredTranslation);
                const movement = charCont.computedMovement();
                body.setLinvel({
                    x: movement.x / this.fixedTimeStep,
                    y: movement.y / this.fixedTimeStep,
                    z: movement.z / this.fixedTimeStep,
                }, true);
                return;
            }
            body.setLinvel({ x: vel.x * factor, y: vel.y, z: vel.z * factor }, true);
        }
    }

    getTranslation(id) {
        const body = this.rigidBodies.get(id);
        return body ? body.translation() : { x: 0, y: 0, z: 0 };
    }

    setTranslation(id, pos) {
        const body = this.rigidBodies.get(id);
        if (body) {
            body.setTranslation(pos, true);
        }
    }
    
    resetForces(id) {
        const body = this.rigidBodies.get(id);
        if (body) {
            body.setLinvel({ x: 0, y: 0, z: 0 }, true);
            body.setAngvel({ x: 0, y: 0, z: 0 }, true);
        }
    }

    applyImpulse(id, ix, iy, iz) {
        const body = this.rigidBodies.get(id);
        if (body) {
            body.applyImpulse({ x: ix, y: iy, z: iz }, true);
        }
    }

}

module.exports = PhysicsWorld;

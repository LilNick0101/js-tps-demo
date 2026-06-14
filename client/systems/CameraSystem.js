import * as THREE from 'three';

const WORLD_UP = new THREE.Vector3(0, 1, 0);
const DEFAULT_FOV = 75;
const SCOPED_FOV = 32;
const PLAYER_HEAD_OFFSET = 1.1; 
const CAMERA_SHOULDER_OFFSET = new THREE.Vector3(1.2, 2.3, 4.5);
const CAMERA_AIM_DISTANCE = 200;
const CAMERA_COLLISION_PUSH = 0.15;

class CameraSystem {
    constructor(renderSystem) {
        this.renderSystem = renderSystem;
        this.camera = new THREE.PerspectiveCamera(DEFAULT_FOV, window.innerWidth / window.innerHeight, 0.1, 1000);
        this.mapRoot = null;
        this.cameraOffset = new THREE.Vector3();
        this.desiredCameraPos = new THREE.Vector3();
        this.finalCameraPos = new THREE.Vector3();
        this.headPosition = new THREE.Vector3();
        this.cameraForward = new THREE.Vector3();
        this.aimTarget = new THREE.Vector3();
        this.aimDirection = new THREE.Vector3();
        this.cameraCollisionRaycaster = new THREE.Raycaster();
        this.cameraAimRaycaster = new THREE.Raycaster();
        this.attachedMesh = null; // The mesh the camera is currently attached to (for visibility toggling)
        this.aimYaw = 0;
        this.aimPitch = 0;

    }

    setScoped(isScoped) {
        this.camera.fov = isScoped ? SCOPED_FOV : DEFAULT_FOV;
        this.camera.updateProjectionMatrix();
    }

    attachMesh(id){
        this.attachedMesh = this.renderSystem.getMesh(id);
    }

    onWindowResize(){
        this.camera.aspect = window.innerWidth / window.innerHeight;
        this.camera.updateProjectionMatrix();
    }

    setMapRoot(mapRoot) {
        this.mapRoot = mapRoot;
    }

    update(yaw,pitch,dt){
        this.aimYaw = yaw;
        this.aimPitch = pitch;
        if (!this.attachedMesh) return;
        const cameraLerpAlpha = 1 - Math.exp(-8 * dt);
        
        this.headPosition.copy(this.attachedMesh.position);
        this.headPosition.y += PLAYER_HEAD_OFFSET;

        // Rotate right-shoulder offset by yaw (horizontal rotation)
        this.cameraOffset.copy(CAMERA_SHOULDER_OFFSET);
        this.cameraOffset.applyAxisAngle(WORLD_UP, yaw);

        this.desiredCameraPos.copy(this.attachedMesh.position).add(this.cameraOffset);
        this.finalCameraPos.copy(this.desiredCameraPos);

        // Camera collision: slide toward the head if a wall blocks the view
        if (this.mapRoot) {
            this.aimDirection.copy(this.desiredCameraPos).sub(this.headPosition);
            this.cameraCollisionRaycaster.set(this.headPosition, this.aimDirection.normalize());
            this.cameraCollisionRaycaster.far = this.headPosition.distanceTo(this.desiredCameraPos);
            const hits = this.cameraCollisionRaycaster.intersectObjects(this.mapRoot.children, true);
            if (hits.length > 0) {
                const hit = hits[0];
                const movement = this.desiredCameraPos.clone().sub(this.headPosition);
                const n = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
                const slide = movement.sub(n.multiplyScalar(movement.dot(n)));
                this.finalCameraPos.copy(this.headPosition).add(slide);
                this.finalCameraPos.add(n.multiplyScalar(CAMERA_COLLISION_PUSH));
            }
        }

        this.camera.position.lerp(this.finalCameraPos, cameraLerpAlpha); // Frame-rate independent smoothing

        // Aim ray from camera through crosshair (screen center)
        this.cameraForward.set(
            -Math.sin(yaw) * Math.cos(pitch),
            Math.sin(pitch),
            -Math.cos(yaw) * Math.cos(pitch)
        ).normalize();

        this.aimTarget.copy(this.camera.position).addScaledVector(this.cameraForward, CAMERA_AIM_DISTANCE);
        if (this.mapRoot) {
            this.cameraAimRaycaster.set(this.camera.position, this.cameraForward);
            this.cameraAimRaycaster.far = CAMERA_AIM_DISTANCE;
            this.cameraAimRaycaster.near = 12; // Don't aim at walls right in front of the camera
            const hits = this.cameraAimRaycaster.intersectObjects(this.mapRoot.children, true);
            if (hits.length > 0) {
                this.aimTarget.copy(hits[0].point);
            }
        }
        this.camera.lookAt(this.aimTarget);

        // Parallax-correct aim: compute yaw/pitch from head to crosshair target
        this.aimDirection.copy(this.aimTarget).sub(this.headPosition);
        const aimFlatLen = Math.hypot(this.aimDirection.x, this.aimDirection.z);
        if (aimFlatLen > 1e-6) {
            this.aimYaw = Math.atan2(-this.aimDirection.x, -this.aimDirection.z);
            this.aimPitch = Math.atan2(this.aimDirection.y, aimFlatLen);
        }

    }
}

export default CameraSystem;
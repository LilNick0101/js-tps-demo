import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

/**
 * MapLoader (client-side)
 *
 * Populates a THREE.Scene with the visual geometry for a given map config.
 *
 * Two rendering strategies:
 *   - gltfPath set  → load the GLTF/GLB model;
 *   - gltfPath null → procedurally build a flat PlaneGeometry floor + GridHelper based on mapConfig.size (and mapConfig.floor if provided).
 *
 * In both cases the scene.fog is set from mapConfig.fog.
 *
 * Usage:
 *   import MapLoader from './world/MapLoader.js';
 *   const loader    = new MapLoader();
 *   const mapRoot   = await loader.load(mapConfig, scene);
 */
export default class MapLoader {
    /**
     * @param {object}     mapConfig - Entry from shared/config/maps.json
     * @param {THREE.Scene} scene    - The active Three.js scene
     * @returns {Promise<THREE.Object3D>} Root object added to the scene
     */
    load(mapConfig, scene) {
        // Apply fog
        if (mapConfig.fog) {
            scene.fog = new THREE.Fog(
                mapConfig.fog.color,
                mapConfig.fog.near,
                mapConfig.fog.far
            );
        } else {
            scene.fog = null;
        }
        if (mapConfig.skybox) {
            this._loadSkybox(mapConfig, scene);
        }

        if (mapConfig.gltfPath) {
            return this._loadGLTF(mapConfig, scene);
        } else {
            return Promise.resolve(this._buildFlatScene(mapConfig, scene));
        }
    }

    // -------------------------------------------------------------------------
    // Private helpers
    // -------------------------------------------------------------------------

    /**
     * Load a GLTF/GLB model and add it to the scene.
     * Any THREE.Object3D whose name matches mapConfig.collisionLayer is hidden
     * (the mesh data is only needed server-side for Rapier).
     */
    _loadSkybox(mapConfig, scene) {
        if (!mapConfig.skybox) return;

        const loader = new THREE.CubeTextureLoader();
        const urls = [
            `${mapConfig.skybox}px.png`,
            `${mapConfig.skybox}nx.png`,
            `${mapConfig.skybox}py.png`,
            `${mapConfig.skybox}ny.png`,
            `${mapConfig.skybox}pz.png`,
            `${mapConfig.skybox}nz.png`,
        ];
        const skyboxTexture = loader.load(urls);
        scene.background = skyboxTexture;
    }

    _loadGLTF(mapConfig, scene) {
        return new Promise((resolve, reject) => {
            const loader = new GLTFLoader();
            loader.load(
                mapConfig.gltfPath,
                (gltf) => {
                    const root = gltf.scene;

                    // Hide collision-only meshes
                    if (mapConfig.collisionLayer) {
                        root.traverse((node) => {
                            if (node.name === mapConfig.collisionLayer ||
                                (node.parent && node.parent.name === mapConfig.collisionLayer)) {
                                node.visible = false;
                            }
                        });
                    }

                    // Enable shadow casting / receiving on visible meshes
                    root.traverse((node) => {
                        if (node.isMesh && node.visible) {
                            node.castShadow    = true;
                            node.receiveShadow = true;
                        }
                    });

                    scene.add(root);
                    console.log(`[MapLoader] GLTF '${mapConfig.gltfPath}' loaded`);
                    resolve(root);
                },
                undefined,
                (err) => {
                    console.error(`[MapLoader] Failed to load GLTF '${mapConfig.gltfPath}':`, err);
                    // Fall back to flat scene so the game doesn't break
                    resolve(this._buildFlatScene(mapConfig, scene));
                }
            );
        });
    }

    /**
     * Build a simple flat floor plane + grid helper for maps with no GLTF.
     * Mirrors the geometry that was previously hardcoded in client/main.js.
     */
    _buildFlatScene(mapConfig, scene) {
        const floor = mapConfig.floor;
        const size  = mapConfig.size;
        const w = floor ? floor.width : size;
        const d = floor ? floor.depth : size;

        const root = new THREE.Group();
        root.name  = `map_${mapConfig.id}`;

        // Floor plane
        const floorMesh = new THREE.Mesh(
            new THREE.PlaneGeometry(w, d),
            new THREE.MeshStandardMaterial({
                color: floor?.color ?? 0x333333,
                roughness: 0.9,
                metalness: 0.0,
            })
        );
        floorMesh.rotation.x  = -Math.PI / 2;
        floorMesh.receiveShadow = true;
        root.add(floorMesh);

        // Grid helper (cells = size / 2 so one grid unit = 2 world units)
        const gridDivisions = Math.round(size / 2);
        root.add(new THREE.GridHelper(size, gridDivisions));

        scene.add(root);
        console.log(`[MapLoader] Flat scene built for map '${mapConfig.id}' (${w}x${d})`);
        return root;
    }
}

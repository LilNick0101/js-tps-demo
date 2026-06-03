'use strict';

const fs   = require('fs');
const path = require('path');
const MAPS = require('../../shared/config/maps.json');

/**
 * MapLoader (server-side)
 *
 * Reads map configuration from shared/config/maps.json and builds the
 * corresponding Rapier collision bodies inside the given PhysicsWorld.
 *
 * Two collision strategies:
 *   1. collisionPath set  → load a pre-baked .collision.json file
 *      Format: { "floors": [{ "x": number, "z": number, "width": number, "depth": number, "y": number }],
 *                "walls": [{ "x1": number, "z1": number, "x2": number, "z2": number, "height": number, "y": number, "thickness": number }] }
 *   2. collisionPath null → procedurally build a flat floor + boundary walls
 *      using the map's "floor" and "size" properties.
 *
 * Usage:
 *   const MapLoader = require('./MapLoader');
 *   const loader    = new MapLoader();
 *   const mapConfig = await loader.load('default', physicsWorld);
 */
class MapLoader {
    async load(mapId, physicsWorld) {
        await physicsWorld.ensureInitialized();

        const mapConfig = MAPS[mapId];
        if (!mapConfig) {
            throw new Error(`[MapLoader] Unknown map id '${mapId}'. Check shared/config/maps.json.`);
        }

        console.log(`[MapLoader] Loading map '${mapConfig.name}' (id: ${mapId})`);
        
        if (mapConfig.collisionPath) {
            this._loadFileCollision(mapConfig, physicsWorld);
        } else {
            this._buildFlatCollision(mapConfig, physicsWorld);
        }

        return mapConfig;
    }

    _hasParentCollision(node, collisionLayer) {
        let parent = node.parent;
        while (parent) {
            if (parent.name.toLowerCase().includes(collisionLayer) || 
                (parent.userData && parent.userData.collisionLayer === collisionLayer)) {
                return true;
            }
            parent = parent.parent;
        }
        return false;
    }

    _loadFileCollision(mapConfig, physicsWorld) {
        const collisionPath = path.join(
            __dirname, '..', '..', 'public',
            mapConfig.collisionPath.replace(/^\//, '')
        );

        let collisionData;
        try {
            collisionData = JSON.parse(fs.readFileSync(collisionPath, 'utf8'));
        } catch (err) {
            throw new Error(
                `[MapLoader] Failed to read collision file '${collisionPath}': ${err.message}`
            );
        }

        if (!Array.isArray(collisionData.meshes) || collisionData.meshes.length === 0) {
            throw new Error(`[MapLoader] Collision file has no 'meshes' array: ${collisionPath}`);
        }

        for (const mesh of collisionData.meshes) {
            physicsWorld.createTrimeshBody(
                mesh.vertices,
                mesh.indices,
                mesh.tx ?? 0,
                mesh.ty ?? 0,
                mesh.tz ?? 0
            );
            console.log(
                `[MapLoader]   Mesh '${mesh.name}': ${mesh.vertices.length / 3} verts, ` +
                `${mesh.indices.length / 3} tris`
            );
        }
        /*
        if (collisionData.floors && Array.isArray(collisionData.floors)) {
            for (const f of collisionData.floors) {
                physicsWorld.createFloorBody(f.x, f.z, f.width, f.depth, f.y ?? 0);
            }
            console.log(`[MapLoader] Loaded ${collisionData.floors.length} floors.`);
        }

        if (collisionData.walls && Array.isArray(collisionData.walls)) {
            for (const w of collisionData.walls) {
                physicsWorld.createWallBody(w.x1, w.z1, w.x2, w.z2, w.height ?? 10, w.y ?? 0, w.thickness ?? 2);
            }
            console.log(`[MapLoader] Loaded ${collisionData.walls.length} walls.`);
        }
        */
    }

    /**
     * 
     * @param {Object} mapConfig 
     * @param {import('./PhysicsWorld')} physicsWorld 
     */
    _buildFlatCollision(mapConfig, physicsWorld) {
        const size = mapConfig.size;
        const floor = mapConfig.floor;
        const hw = (floor ? floor.width : size) / 2;
        const hd = (floor ? floor.depth : size) / 2;
        const wallH = 20;
        const wallThickness = 2;

        // Floor
        physicsWorld.createFloorBody(0, 0, hw * 2, hd * 2, 0);

        // Boundary walls
        // North wall (+Z)
        physicsWorld.createWallBody(-hw, hd, hw, hd, wallH, 0, wallThickness);
        // South wall (-Z)
        physicsWorld.createWallBody(-hw, -hd, hw, -hd, wallH, 0, wallThickness);
        // East wall (+X)
        physicsWorld.createWallBody(hw, -hd, hw, hd, wallH, 0, wallThickness);
        // West wall (-X)
        physicsWorld.createWallBody(-hw, -hd, -hw, hd, wallH, 0, wallThickness);

        console.log(
            `[MapLoader] Flat collision built: floor ${hw * 2}x${hd * 2}, ` +
            `wall height ${wallH}, boundary size ${size}`
        );
    }
}

module.exports = MapLoader;

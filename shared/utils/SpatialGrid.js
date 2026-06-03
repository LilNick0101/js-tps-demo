/**
 * SpatialGrid - Grid-based spatial partitioning for fast nearest-neighbour queries.
 *
 * Entities are bucketed into fixed-size cells.  A range query only inspects
 * the cells that overlap the query circle, reducing the average complexity
 * from O(n*m) to roughly O(1) when entities are distributed across the map.
 *
 * Typical usage per game tick:
 *   1. grid.clear()
 *   2. grid.add(eid, x, z)  – for every living entity
 *   3. grid.getNearby(x, z, range) – inside each bot's target-detection loop
 */
class SpatialGrid {
    /**
     * @param {number} cellSize  Side length of each grid cell (units).
     *   Optimal value ≈ the typical query range.  A value of
     *   BOT_DETECTION_RANGE / 2 keeps the number of candidate cells small.
     */
    constructor(cellSize) {
        this.cellSize = cellSize;
        /** @type {Map<string, number[]>} */
        this.grid = new Map();
    }

    /** Remove all entities from the grid.  Call once at the start of each tick. */
    clear() {
        this.grid.clear();
    }

    /**
     * Insert an entity into the cell that covers (x, z).
     * @param {number} eid
     * @param {number} x
     * @param {number} z
     */
    add(eid, x, z) {
        const key = this.getCellKey(x, z);
        let cell = this.grid.get(key);
        if (!cell) {
            cell = [];
            this.grid.set(key, cell);
        }
        cell.push(eid);
    }

    /**
     * Return all entity IDs whose cell overlaps the bounding box of the
     * circle centred at (x, z) with the given radius.
     *
     * Note: the result may include entities outside the exact circle (false
     * positives from the bounding-box approximation).  Callers should still
     * do a precise distance check on the returned candidates.
     *
     * @param {number} x
     * @param {number} z
     * @param {number} range  Query radius.
     * @returns {number[]}
     */
    getNearby(x, z, range) {
        const minCX = Math.floor((x - range) / this.cellSize);
        const maxCX = Math.floor((x + range) / this.cellSize);
        const minCZ = Math.floor((z - range) / this.cellSize);
        const maxCZ = Math.floor((z + range) / this.cellSize);

        const nearby = [];
        for (let cx = minCX; cx <= maxCX; cx++) {
            for (let cz = minCZ; cz <= maxCZ; cz++) {
                const cell = this.grid.get(`${cx},${cz}`);
                if (cell) {
                    for (let i = 0; i < cell.length; i++) {
                        nearby.push(cell[i]);
                    }
                }
            }
        }
        return nearby;
    }

    /**
     * @param {number} x
     * @param {number} z
     * @returns {string}
     */
    getCellKey(x, z) {
        const cellX = Math.floor(x / this.cellSize);
        const cellZ = Math.floor(z / this.cellSize);
        return `${cellX},${cellZ}`;
    }
}

module.exports = SpatialGrid;

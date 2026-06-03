const { Team } = require('../../shared/components');

/**
 * TeamSystem manages team assignment and simple balancing helpers.
 */
class TeamSystem {
    constructor(ecsWorld, options = {}) {
        this.ecsWorld = ecsWorld;
        this.teamCount = Number.isInteger(options.teamCount) && options.teamCount > 0
            ? options.teamCount
            : 2;
        this.firstTeamId = 1;
    }

    /**
     * Returns team occupancy as an object keyed by teamId.
     */
    getTeamCounts() {
        const counts = {};
        for (let teamId = this.firstTeamId; teamId < this.firstTeamId + this.teamCount; teamId++) {
            counts[teamId] = 0;
        }

        for (const eid of this.ecsWorld.getAllPlayerAndBotEntities()) {
            const teamId = this.getEntityTeam(eid);
            if (counts[teamId] !== undefined) {
                counts[teamId]++;
            }
        }

        return counts;
    }

    /**
     * Returns an entity team ID (0 when not assigned/invalid).
     */
    getEntityTeam(eid) {
        const teamId = Number(Team.id[eid] ?? 0);
        if (!Number.isInteger(teamId)) return 0;
        if (teamId < this.firstTeamId || teamId >= this.firstTeamId + this.teamCount) return 0;
        return teamId;
    }

    /**
     * Assign a team to a new player using lowest-population balancing.
     */
    assignTeamForNewPlayer() {
        const counts = this.getTeamCounts();
        let selectedTeam = this.firstTeamId;
        let minCount = Number.POSITIVE_INFINITY;

        for (let teamId = this.firstTeamId; teamId < this.firstTeamId + this.teamCount; teamId++) {
            const count = counts[teamId] ?? 0;
            if (count < minCount) {
                minCount = count;
                selectedTeam = teamId;
            }
        }

        return selectedTeam;
    }

    /**
     * Assigns/clamps an entity team ID and returns final assignment.
     */
    setEntityTeam(eid, desiredTeamId) {
        let teamId = Number(desiredTeamId);
        if (!Number.isInteger(teamId)) {
            teamId = this.assignTeamForNewPlayer();
        }

        if (teamId < this.firstTeamId || teamId >= this.firstTeamId + this.teamCount) {
            teamId = this.assignTeamForNewPlayer();
        }

        Team.id[eid] = teamId;
        return teamId;
    }
}

module.exports = TeamSystem;

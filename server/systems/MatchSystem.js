const { Score } = require("../../shared/components");

/**
 * MatchSystem manages mode-agnostic match state and win-condition checks.
 */
class MatchSystem {
    constructor(options = {}) {
        this.availableModeKeys = Array.isArray(options.availableModeKeys) ? options.availableModeKeys : [];
        this.modeKey = options.modeKey || 'tdm';
        this.modeConfig = options.modeConfig || {};
        this.teamSystem = options.teamSystem;
        this.nowFn = options.nowFn || (() => Date.now());
        this.world = options.world;
        this.respawnSystem = options.respawnSystem;
        this.currentMatchTick = 0;

        if (this.availableModeKeys.length > 0 && !this.availableModeKeys.includes(this.modeKey)) {
            console.warn(`[MatchSystem] Unknown mode key '${this.modeKey}', falling back to 'tdm'.`);
            this.modeKey = 'tdm';
        }

        if (!this.modeConfig || Object.keys(this.modeConfig).length === 0) {
            console.warn(`[MatchSystem] Missing mode config for '${this.modeKey}', using safe defaults.`);
        }

        this.teamCount = Number.isInteger(this.modeConfig.teamCount) && this.modeConfig.teamCount > 1
            ? this.modeConfig.teamCount
            : 2;
        if (!(Number.isInteger(this.modeConfig.teamCount) && this.modeConfig.teamCount > 1)) {
            console.warn(`[MatchSystem] Invalid teamCount '${this.modeConfig.teamCount}', using 2.`);
        }

        this.winCondition = this._sanitizeWinCondition(this.modeConfig.winCondition);
        this.targetScore = this.winCondition.target;

        this.postMatchRestartMs = Number.isFinite(this.modeConfig.postMatchRestartMs) && this.modeConfig.postMatchRestartMs > 0
            ? this.modeConfig.postMatchRestartMs
            : Number.isFinite(options.postMatchRestartMs)
                ? options.postMatchRestartMs
                : 8000;
        if (!(Number.isFinite(this.modeConfig.postMatchRestartMs) && this.modeConfig.postMatchRestartMs > 0)) {
            console.warn(`[MatchSystem] Invalid postMatchRestartMs '${this.modeConfig.postMatchRestartMs}', using ${this.postMatchRestartMs}.`);
        }

        this.status = 'running';
        this.teamScores = this._createZeroTeamScores();
        this.winnerTeam = 0;
        this.reason = '';
        this.matchEndAt = 0;
        this.matchStartAt = this.nowFn();
    }

    startMatch(world) {
        this.resetMatch(this.nowFn());
    }

    _sanitizeWinCondition(raw) {
        const fallback = { type: 'teamKills', target: 100 };
        if (!raw || typeof raw !== 'object') {
            console.warn('[MatchSystem] Missing winCondition config, using default teamKills=100.');
            return fallback;
        }

        const validTypes = new Set(['teamKills', 'timeLimit', 'objective']);
        const type = typeof raw.type === 'string' ? raw.type : 'teamKills';
        if (!validTypes.has(type)) {
            console.warn(`[MatchSystem] Unsupported winCondition type '${raw.type}', using default teamKills=100.`);
            return fallback;
        }

        if (type === 'teamKills') {
            const target = Number.isFinite(raw.target) && raw.target > 0
                ? Math.floor(raw.target)
                : 100;
            if (!(Number.isFinite(raw.target) && raw.target > 0)) {
                console.warn(`[MatchSystem] Invalid teamKills target '${raw.target}', using ${target}.`);
            }
            return { type, target };
        }

        if (type === 'timeLimit') {
            const durationMs = Number.isFinite(raw.durationMs) && raw.durationMs > 0
                ? Math.floor(raw.durationMs)
                : 600000;
            const target = Number.isFinite(raw.target) && raw.target > 0
                ? Math.floor(raw.target)
                : 0;
            if (!(Number.isFinite(raw.durationMs) && raw.durationMs > 0)) {
                console.warn(`[MatchSystem] Invalid timeLimit durationMs '${raw.durationMs}', using ${durationMs}.`);
            }
            return { type, durationMs, target };
        }

        return {
            type,
            target: Number.isFinite(raw.target) && raw.target > 0 ? Math.floor(raw.target) : 0,
        };
    }

    _createZeroTeamScores() {
        const scores = {};
        for (let teamId = 1; teamId <= this.teamCount; teamId++) {
            scores[teamId] = 0;
        }
        return scores;
    }

    getSnapshot(now = this.nowFn()) {
        const restartInMs = this.status === 'finished' && this.matchEndAt > 0
            ? Math.max(0, this.postMatchRestartMs - (now - this.matchEndAt))
            : 0;

        return {
            mode: this.modeKey,
            status: this.status,
            teamScores: { ...this.teamScores },
            targetScore: this.targetScore,
            winnerTeam: this.winnerTeam,
            reason: this.reason,
            matchEndAt: this.matchEndAt,
            currentMatchTick: this.currentMatchTick,
            restartInMs,
        };
    }

    registerKill(killerEid, victimEid, now = this.nowFn()) {
        if (this.status !== 'running') {
            return { ended: false, ignored: true, reason: 'match-not-running' };
        }

        const killerTeam = this.teamSystem?.getEntityTeam(killerEid) ?? 0;
        const victimTeam = this.teamSystem?.getEntityTeam(victimEid) ?? 0;

        if (killerTeam <= 0 || this.teamScores[killerTeam] === undefined) {
            return { ended: false, ignored: true, reason: 'invalid-killer-team' };
        }

        this.teamScores[killerTeam] += 1;

        const winnerTeam = this.checkWin(now);
        if (winnerTeam) {
            this.beginPostMatch(winnerTeam, this.winCondition.type || 'winCondition', now);
            return {
                ended: true,
                winnerTeam,
                reason: this.reason,
                snapshot: this.getSnapshot(now),
                killerTeam,
                victimTeam,
            };
        }

        return {
            ended: false,
            killerTeam,
            victimTeam,
            snapshot: this.getSnapshot(now),
        };
    }

    checkWin(now = this.nowFn()) {
        const type = this.winCondition.type || 'teamKills';

        switch (type) {
            case 'teamKills': {
                for (let teamId = 1; teamId <= this.teamCount; teamId++) {
                    if ((this.teamScores[teamId] || 0) >= this.targetScore) {
                        return teamId;
                    }
                }
                return 0;
            }
            case 'timeLimit': {
                const durationMs = Number.isFinite(this.winCondition.durationMs)
                    ? this.winCondition.durationMs
                    : 0;

                if (durationMs <= 0) return 0;
                if ((now - this.matchStartAt) < durationMs) return 0;

                let winner = 1;
                let best = this.teamScores[1] || 0;
                for (let teamId = 2; teamId <= this.teamCount; teamId++) {
                    const score = this.teamScores[teamId] || 0;
                    if (score > best) {
                        best = score;
                        winner = teamId;
                    }
                }
                return winner;
            }
            case 'objective':
                // Placeholder branch for objective-centric modes.
                return 0;
            default:
                return 0;
        }
    }

    beginPostMatch(winnerTeam, reason = 'winCondition', now = this.nowFn()) {
        this.status = 'finished';
        this.winnerTeam = winnerTeam;
        this.reason = reason;
        this.matchEndAt = now;
    }

    resetMatch(now = this.nowFn()) {
        this.status = 'running';
        this.teamScores = this._createZeroTeamScores();
        this.winnerTeam = 0;
        this.reason = '';
        this.matchEndAt = 0;
        this.matchStartAt = now;
        this.currentMatchTick = 0;

        for (const entity of this.world.getAllPlayerAndBotEntities()) {
            this.respawnSystem.resetEntity(entity);
        }
        return this.getSnapshot(now);
    }

    update(now = this.nowFn()) {
        if (this.status === 'running') {
            this.currentMatchTick++;
            const winnerTeam = this.checkWin(now);
            if (winnerTeam) {
                this.beginPostMatch(winnerTeam, this.winCondition.type || 'winCondition', now);
                return {
                    transition: 'finished',
                    snapshot: this.getSnapshot(now),
                };
            }
            return {
                transition: 'none',
                snapshot: this.getSnapshot(now),
            };
        }

        if (this.status === 'finished' && this.matchEndAt > 0) {
            if ((now - this.matchEndAt) >= this.postMatchRestartMs) {
                return {
                    transition: 'reset',
                    snapshot: this.resetMatch(now),
                };
            }
        }
        

        return {
            transition: 'none',
            snapshot: this.getSnapshot(now),
        };
    }
}

module.exports = MatchSystem;

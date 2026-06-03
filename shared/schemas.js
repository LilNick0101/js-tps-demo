/**
 * shared/schemas.js
 *
 * Defines the canonical shape of every network message exchanged between
 * client and server.  These are plain-object templates – they are used for
 * documentation, validation hints, and as a single source of truth so both
 * sides stay in sync.
 */

/**
 * playerInput – client → server (sent every state-update tick)
 */
const INPUT_MESSAGE = {
    seq: 0,
    inputs: {
        forward:  false,
        backward: false,
        left:     false,
        right:    false,
        jump:     false,
        dash:     false,
        scope:    false,
        ability1: false,
        ability1Self: false,
        ability2: false,
        ultimate: false,
    },
    yaw:   0.0,
    pitch: 0.0,
    dt:    0.0,
};

/**
 * stateUpdate – server → all clients (sent every game-loop tick)
 */
const PLAYER_STATE = {
    id:               '',
    eid:              0,
    x:                0.0,
    y:                0.0,
    z:                0.0,
    yaw:              0.0,
    pitch:            0.0,
    color:            0,
    health:           0,
    armor:            0,
    shield:           0,
    heroClass:        0,
    weaponId:         0,
    ammo:             0,
    reserveAmmo:      0,
    ability1Cooldown: 0,
    ability2Cooldown: 0,
    ultimateCooldown: 0,
    ultimateActive:   false,
    name:             '',
    team:             0,
    kills:            0,
    deaths:           0,
    lastProcessedSeq: 0,
};

/**
 * pickup state entry inside stateUpdate.pickups
 */
const PICKUP_STATE = {
    id:     0,
    type:   0,
    x:      0.0,
    y:      0.0,
    z:      0.0,
    active: true,
};

/**
 * match state / lifecycle metadata payload (server -> clients)
 */
const MATCH_STATE = {
    mode: 'tdm',
    status: 'running',
    teamScores: {
        1: 0,
        2: 0,
    },
    targetScore: 100,
    winnerTeam: 0,
    reason: '',
};

module.exports = { INPUT_MESSAGE, PLAYER_STATE, PICKUP_STATE, MATCH_STATE };

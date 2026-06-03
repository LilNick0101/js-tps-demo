/**
 * Shared binary serialization codec using msgpackr.
 *
 * encode(data) → Buffer (Node.js) | Uint8Array (browser)
 * decode(raw)  → plain JS object
 *
 * Used for the two high-frequency message types:
 *   • stateUpdate  – server → all clients, every game tick (broadcast via io.raw)
 *   • playerInput  – client → server, up to ~120 Hz (channel.raw)
 *
 * useRecords is intentionally left disabled (default) so schema definition
 * packets are never sent over the wire.  Over a lossy UDP-like transport such
 * as WebRTC data channels a dropped schema packet would break all subsequent
 * decodings.
 */

const { pack, unpack } = require('msgpackr');

/**
 * Encode a plain object to a compact binary representation.
 * @param {object} data
 * @returns {Buffer|Uint8Array}
 */
function encode(data) {
    return pack(data);
}

/**
 * Decode a raw message received from the network.
 * Accepts Buffer, Uint8Array, and ArrayBuffer (the possible types delivered by
 * geckos.io's onRaw callback in both Node and browser environments).
 * @param {Buffer|Uint8Array|ArrayBuffer} raw
 * @returns {object}
 */
function decode(raw) {
    if (raw instanceof ArrayBuffer) {
        return unpack(new Uint8Array(raw));
    }
    return unpack(raw);
}

module.exports = { encode, decode };

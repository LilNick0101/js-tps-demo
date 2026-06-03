// ESM wrapper for browser/client usage. Keeps the original CommonJS
// `Codec.js` for server-side require() compatibility.
import { pack, unpack } from 'msgpackr';

export function encode(data) {
    return pack(data);
}

export function decode(raw) {
    if (raw instanceof ArrayBuffer) {
        return unpack(new Uint8Array(raw));
    }
    return unpack(raw);
}

export default { encode, decode };

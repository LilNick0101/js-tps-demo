class MathUtils {

    static lerp(a, b, t) {
        return a + (b - a) * t;
    }

    static lerpAngle(a, b, t) {
        let diff = b - a;
        // Wrap diff into [-π, π]
        while (diff >  Math.PI) diff -= 2 * Math.PI;
        while (diff < -Math.PI) diff += 2 * Math.PI;
        return a + diff * t;
    }
}

export default MathUtils;
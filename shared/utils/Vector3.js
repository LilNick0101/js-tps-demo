
class Vector3 {
    constructor(x = 0, y = 0, z = 0) {
        this.x = x;
        this.y = y;
        this.z = z;
    }

    add(v) {
        return new Vector3(this.x + v.x, this.y + v.y, this.z + v.z);
    }

    subtract(v) {
        return new Vector3(this.x - v.x, this.y - v.y, this.z - v.z);
    }

    multiply(scalar) {
        return new Vector3(this.x * scalar, this.y * scalar, this.z * scalar);
    }

    divide(scalar) {
        return new Vector3(this.x / scalar, this.y / scalar, this.z / scalar);
    }

    length() {
        return Math.sqrt(this.x * this.x + this.y * this.y + this.z * this.z);
    }

    normalize() {
        const len = this.length();
        if (len > 0) {
            return this.divide(len);
        }
        return new Vector3(0, 0, 0);
    }

    static zero() {
        return new Vector3(0, 0, 0);
    }

    static fromArray(arr) {
        return new Vector3(arr[0], arr[1], arr[2]);
    }

    toArray() {
        return [this.x, this.y, this.z];
    }
}

module.exports = { Vector3 };
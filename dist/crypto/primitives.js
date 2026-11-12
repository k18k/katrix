// src/crypto/primitives.ts
var CryptoPrimitiveError = class extends Error {
	constructor(message) {
		super(message);
		this.name = "CryptoPrimitiveError";
	}
};
export { CryptoPrimitiveError };

//# sourceMappingURL=primitives.js.map
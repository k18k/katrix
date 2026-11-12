// src/protocol/protocol.ts
var ProtocolError = class extends Error {
	code;
	constructor(code, message) {
		super(message ?? code);
		this.name = "ProtocolError";
		this.code = code;
	}
};
export { ProtocolError };

//# sourceMappingURL=protocol.js.map
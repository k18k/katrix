// src/e2ee/crypto-store.ts
const olmSessionKey = (senderKey, sessionId) => `${senderKey}|${sessionId}`;
const inboundKey = (roomId, sessionId) => `${roomId}|${sessionId}`;
const deviceKey = (userId) => `user:${userId}`;
/** Pickling and unpickling with the protocol and pickle key, checking the protocol matches. */
var Pickler = class {
	protocol;
	key;
	constructor(protocol, key) {
		this.protocol = protocol;
		this.key = key;
	}
	account(record) {
		if (record.protocol !== this.protocol.id) throw new Error(`The stored account belongs to E2EE protocol ${record.protocol}, not ${this.protocol.id}`);
		return this.protocol.accountFromPickle(record.pickle, this.key);
	}
	session(record) {
		return this.protocol.sessionFromPickle(record.pickle, this.key);
	}
	inbound(record) {
		return this.protocol.inboundGroupSessionFromPickle(record.pickle, this.key);
	}
	outbound(record) {
		return this.protocol.outboundGroupSessionFromPickle(record.pickle, this.key);
	}
	pickle(obj) {
		return obj.pickle(this.key);
	}
};
async function loadAccount(tx, pickler) {
	const record = await tx.get("account", "account");
	if (!record) throw new Error("No Olm account: the crypto engine is not initialised");
	return {
		record,
		account: pickler.account(record)
	};
}
function saveAccount(tx, pickler, record, account) {
	tx.put("account", "account", {
		...record,
		pickle: pickler.pickle(account)
	});
}
export { Pickler, deviceKey, inboundKey, loadAccount, olmSessionKey, saveAccount };

//# sourceMappingURL=crypto-store.js.map
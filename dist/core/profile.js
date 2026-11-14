import { canonicalJson } from "../packages/shared/src/canonical-json.js";
// src/core/profile.ts
const BUILTIN_FIELDS = /* @__PURE__ */ new Set(["displayname", "avatar_url"]);
const MAX_PROFILE_BYTES = 65536;
async function fullProfile(hs, userId) {
	const user = await hs.db.findOne("users", [{
		field: "user_id",
		value: userId
	}]);
	if (!user || user.deactivated) return null;
	const out = {};
	for (const row of await hs.db.findMany("profile_fields", { where: [{
		field: "user_id",
		value: userId
	}] })) if (row.value !== null && row.value !== void 0 && !BUILTIN_FIELDS.has(row.field)) out[row.field] = row.value;
	if (user.displayname) out.displayname = user.displayname;
	if (user.avatar_url) out.avatar_url = user.avatar_url;
	return out;
}
function profileSize(profile) {
	return Buffer.byteLength(canonicalJson(profile));
}
/** Set (or with `null`, clear) one profile field and notify users sharing a room. */
async function setProfileField(hs, userId, field, value) {
	if (BUILTIN_FIELDS.has(field)) await hs.db.update("users", [{
		field: "user_id",
		value: userId
	}], { [field]: value || null });
	await hs.streams.write((stream) => hs.db.upsert("profile_fields", {
		user_id: userId,
		field,
		value: value ?? null,
		stream
	}));
	if (BUILTIN_FIELDS.has(field)) await hs.membership.propagateProfile(userId);
	hs.notifier.notify([...await hs.rooms.usersSharingRooms(userId)]);
}
export { BUILTIN_FIELDS, MAX_PROFILE_BYTES, fullProfile, profileSize, setProfileField };

//# sourceMappingURL=profile.js.map
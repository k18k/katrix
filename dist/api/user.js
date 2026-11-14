import { canonicalJson } from "../packages/shared/src/canonical-json.js";
import { isObject } from "../packages/shared/src/json.js";
import { M } from "../packages/shared/src/m.js";
import { errors } from "../core/errors.js";
import { procedure } from "../http/procedure.js";
import { jsonResponse } from "../http/handler.js";
import { requireUia } from "./uia.js";
import { v } from "../core/vpm.js";
import { body, fail } from "../http/input.js";
// src/api/user.ts
const deleteDevicesBody = body({ devices: v.array(v.unknown(), fail("M_BAD_JSON", "devices must be a list")) });
const keysQueryBody = body({
	device_keys: v.record(v.string(), v.array(v.string(), fail("M_BAD_JSON", "device_keys values must be lists of device IDs")), fail("M_BAD_JSON", "device_keys must be an object")),
	timeout: v.unknown().optional()
});
const keysClaimBody = body({ one_time_keys: v.record(v.string(), v.unknown(), fail("M_BAD_JSON", "one_time_keys must be an object")) });
const SERVER_MANAGED_TYPES = [M.FULLY_READ, M.PUSH_RULES];
async function setAccountData(hs, userId, roomId, type, content) {
	await hs.streams.write((stream) => hs.db.upsert("account_data", {
		user_id: userId,
		room_id: roomId,
		type,
		content,
		stream
	}));
	hs.notifier.notify([userId]);
}
async function getAccountData(hs, userId, roomId, type) {
	const row = await hs.db.findOne("account_data", [
		{
			field: "user_id",
			value: userId
		},
		{
			field: "room_id",
			value: roomId
		},
		{
			field: "type",
			value: type
		}
	]);
	if (!row || Object.keys(row.content ?? {}).length === 0) throw errors.notFound("Account data not found");
	return row.content;
}
async function checkUser(ctx) {
	const s = await ctx.auth();
	if (ctx.params.userId !== s.userId) throw errors.forbidden("Cannot access another user's data");
	return s;
}
async function checkRoom(ctx) {
	if (!ctx.params.roomId.startsWith("!")) throw errors.invalidParam("Invalid room ID");
}
function registerUserRoutes(r) {
	r.client("PUT", "/user/:userId/account_data/:type", procedure({ handler: async (ctx) => {
		const s = await checkUser(ctx);
		if (SERVER_MANAGED_TYPES.includes(ctx.params.type)) throw errors.badJson("This type is managed by the server");
		await setAccountData(ctx.hs, s.userId, "", ctx.params.type, await ctx.json());
		return {};
	} }));
	r.client("GET", "/user/:userId/account_data/:type", procedure({ handler: async (ctx) => {
		const s = await checkUser(ctx);
		return getAccountData(ctx.hs, s.userId, "", ctx.params.type);
	} }));
	r.client("PUT", "/user/:userId/rooms/:roomId/account_data/:type", procedure({ handler: async (ctx) => {
		const s = await checkUser(ctx);
		await checkRoom(ctx);
		if (SERVER_MANAGED_TYPES.includes(ctx.params.type)) throw errors.badJson("This type is managed by the server");
		await setAccountData(ctx.hs, s.userId, ctx.params.roomId, ctx.params.type, await ctx.json());
		return {};
	} }));
	r.client("GET", "/user/:userId/rooms/:roomId/account_data/:type", procedure({ handler: async (ctx) => {
		const s = await checkUser(ctx);
		await checkRoom(ctx);
		return getAccountData(ctx.hs, s.userId, ctx.params.roomId, ctx.params.type);
	} }));
	const del = "/_matrix/client/unstable/org.matrix.msc3391";
	r.delete(`${del}/user/:userId/account_data/:type`, procedure({ handler: async (ctx) => {
		const s = await checkUser(ctx);
		await setAccountData(ctx.hs, s.userId, "", ctx.params.type, {});
		return {};
	} }));
	r.delete(`${del}/user/:userId/rooms/:roomId/account_data/:type`, procedure({ handler: async (ctx) => {
		const s = await checkUser(ctx);
		await setAccountData(ctx.hs, s.userId, ctx.params.roomId, ctx.params.type, {});
		return {};
	} }));
	const readTags = async (hs, userId, roomId) => {
		const row = await hs.db.findOne("account_data", [
			{
				field: "user_id",
				value: userId
			},
			{
				field: "room_id",
				value: roomId
			},
			{
				field: "type",
				value: M.TAG
			}
		]);
		return isObject(row?.content?.tags) ? row.content.tags : {};
	};
	r.client("GET", "/user/:userId/rooms/:roomId/tags", procedure({ handler: async (ctx) => {
		const s = await checkUser(ctx);
		return { tags: await readTags(ctx.hs, s.userId, ctx.params.roomId) };
	} }));
	r.client("PUT", "/user/:userId/rooms/:roomId/tags/:tag", procedure({ handler: async (ctx) => {
		const s = await checkUser(ctx);
		const body = await ctx.json();
		if (body.order !== void 0 && typeof body.order !== "number") throw errors.badJson("order must be a number");
		const tags = await readTags(ctx.hs, s.userId, ctx.params.roomId);
		tags[ctx.params.tag] = body;
		await setAccountData(ctx.hs, s.userId, ctx.params.roomId, M.TAG, { tags });
		return {};
	} }));
	r.client("DELETE", "/user/:userId/rooms/:roomId/tags/:tag", procedure({ handler: async (ctx) => {
		const s = await checkUser(ctx);
		const tags = await readTags(ctx.hs, s.userId, ctx.params.roomId);
		delete tags[ctx.params.tag];
		await setAccountData(ctx.hs, s.userId, ctx.params.roomId, M.TAG, { tags });
		return {};
	} }));
	const formatDevice = (d) => ({
		device_id: d.device_id,
		display_name: d.display_name ?? void 0,
		last_seen_ip: d.last_seen_ip ?? void 0,
		last_seen_ts: d.last_seen_ts ?? void 0
	});
	r.client("GET", "/devices", procedure({
		auth: "user",
		handler: async (ctx) => {
			const s = ctx.session;
			return { devices: (await ctx.hs.db.findMany("devices", { where: [{
				field: "user_id",
				value: s.userId
			}] })).map(formatDevice) };
		}
	}));
	r.client("GET", "/devices/:deviceId", procedure({
		auth: "user",
		handler: async (ctx) => {
			const s = ctx.session;
			const row = await ctx.hs.db.findOne("devices", [{
				field: "user_id",
				value: s.userId
			}, {
				field: "device_id",
				value: ctx.params.deviceId
			}]);
			if (!row) throw errors.notFound("Device not found");
			return formatDevice(row);
		}
	}));
	r.client("PUT", "/devices/:deviceId", procedure({
		auth: "user",
		handler: async (ctx) => {
			const s = ctx.session;
			const body = await ctx.json();
			const where = [{
				field: "user_id",
				value: s.userId
			}, {
				field: "device_id",
				value: ctx.params.deviceId
			}];
			if (body.display_name !== void 0 && typeof body.display_name !== "string") throw errors.badJson("display_name must be a string");
			if (!await ctx.hs.db.findOne("devices", where)) {
				if (!s.appservice) throw errors.notFound("Device not found");
				await ctx.hs.auth.createDevice(s.userId, ctx.params.deviceId, body.display_name);
				return jsonResponse({}, 201);
			}
			if (body.display_name !== void 0) {
				await ctx.hs.db.update("devices", where, { display_name: body.display_name });
				await ctx.hs.keys.deviceChanged(s.userId);
			}
			return {};
		}
	}));
	r.client("DELETE", "/devices/:deviceId", procedure({
		auth: "user",
		handler: async (ctx) => {
			const s = ctx.session;
			const body = await ctx.json();
			const where = [{
				field: "user_id",
				value: s.userId
			}, {
				field: "device_id",
				value: ctx.params.deviceId
			}];
			if (!await ctx.hs.db.findOne("devices", where)) throw errors.notFound("Device not found");
			if (!s.appservice) await requireUia(ctx.hs, body, [[M.LOGIN.PASSWORD]], s.userId, { session: s });
			await ctx.hs.auth.deleteDevice(s.userId, ctx.params.deviceId);
			return {};
		}
	}));
	r.client("POST", "/delete_devices", procedure({
		auth: "user",
		input: deleteDevicesBody,
		handler: async (ctx) => {
			const s = ctx.session;
			const body = ctx.input;
			if (!s.appservice) await requireUia(ctx.hs, body, [[M.LOGIN.PASSWORD]], s.userId, { session: s });
			for (const d of body.devices) if (typeof d === "string") await ctx.hs.auth.deleteDevice(s.userId, d);
			return {};
		}
	}));
	r.client("POST", "/keys/upload", procedure({
		endpoint: "POST /v3/keys/upload",
		auth: "user",
		input: body({}),
		handler: async (ctx) => {
			const s = ctx.session;
			return { one_time_key_counts: await ctx.hs.keys.upload(s.userId, s.deviceId, ctx.input) };
		}
	}));
	r.client("POST", "/keys/query", procedure({
		endpoint: "POST /v3/keys/query",
		auth: "user",
		rateLimit: "keyQuery",
		input: keysQueryBody,
		handler: async (ctx) => {
			const s = ctx.session;
			const body = ctx.input;
			return ctx.hs.keys.query(s.userId, body.device_keys, Math.min(Number(body.timeout ?? 1e4) || 1e4, 3e4));
		}
	}));
	r.client("POST", "/keys/claim", procedure({
		endpoint: "POST /v3/keys/claim",
		auth: "user",
		input: keysClaimBody,
		handler: async (ctx) => {
			const body = ctx.input;
			const local = {};
			const remote = {};
			for (const [userId, devices] of Object.entries(body.one_time_keys)) (ctx.hs.isLocalUser(userId) ? local : remote)[userId] = devices;
			const claimed = await ctx.hs.keys.claim(local);
			const fed = Object.keys(remote).length ? await ctx.hs.federation.claimKeys(remote) : {
				results: {},
				failures: {}
			};
			return {
				one_time_keys: {
					...claimed,
					...fed.results
				},
				failures: fed.failures
			};
		}
	}));
	r.client("GET", "/keys/changes", procedure({
		auth: "user",
		handler: async (ctx) => {
			const s = ctx.session;
			const parse = (v) => {
				const m = /^s?(\d+)/.exec(v ?? "");
				if (!m) throw errors.invalidParam("Invalid token");
				return Number(m[1]);
			};
			return ctx.hs.keys.changesSince(s.userId, parse(ctx.query.get("from")), parse(ctx.query.get("to")));
		}
	}));
	r.client("POST", "/keys/device_signing/upload", procedure({
		auth: "user",
		input: body({}),
		handler: async (ctx) => {
			const s = ctx.session;
			const body = ctx.input;
			if (await ctx.hs.db.findOne("cross_signing_keys", [{
				field: "user_id",
				value: s.userId
			}, {
				field: "key_type",
				value: "master"
			}])) {
				const stored = new Map((await ctx.hs.db.findMany("cross_signing_keys", { where: [{
					field: "user_id",
					value: s.userId
				}] })).map((row) => [row.key_type, canonicalJson(row.key)]));
				if ([
					"master",
					"self_signing",
					"user_signing"
				].filter((type) => body[`${type}_key`] !== void 0).every((type) => stored.get(type) === canonicalJson(body[`${type}_key`]))) return {};
				await requireUia(ctx.hs, body, [[M.LOGIN.PASSWORD]], s.userId, {
					session: s,
					crossSigningReset: true
				});
			}
			await ctx.hs.keys.uploadCrossSigning(s.userId, body);
			return {};
		}
	}));
	r.client("POST", "/keys/signatures/upload", procedure({
		auth: "user",
		input: body({}),
		handler: async (ctx) => {
			const s = ctx.session;
			return ctx.hs.keys.uploadSignatures(s.userId, ctx.input);
		}
	}));
	r.client("PUT", "/sendToDevice/:eventType/:txnId", procedure({
		endpoint: "PUT /v3/sendToDevice/:eventType/:txnId",
		auth: "user",
		handler: async (ctx) => {
			const s = ctx.session;
			const hs = ctx.hs;
			const body = await ctx.json();
			if (!isObject(body.messages)) throw errors.badJson("messages must be an object");
			const txnKey = `${s.userId}|${s.deviceId}|${ctx.params.txnId}`;
			if (!await hs.cluster.setIfAbsent(`todevice-txn:${txnKey}`, true, 864e5)) return {};
			const recipients = /* @__PURE__ */ new Set();
			for (const [userId, devices] of Object.entries(body.messages)) {
				if (!isObject(devices) || !hs.isLocalUser(userId)) continue;
				let targets = Object.keys(devices);
				if (targets.includes("*")) targets = (await hs.db.findMany("devices", { where: [{
					field: "user_id",
					value: userId
				}] })).map((d) => d.device_id);
				for (const deviceId of targets) {
					const content = devices[deviceId] ?? devices["*"];
					await hs.streams.write((stream) => hs.db.create("to_device", {
						stream,
						user_id: userId,
						device_id: deviceId,
						sender: s.userId,
						type: ctx.params.eventType,
						content
					}));
				}
				recipients.add(userId);
			}
			hs.notifier.notify(recipients);
			const messages = Object.fromEntries(Object.entries(body.messages).filter((e) => isObject(e[1])));
			await hs.federation.sendToDevice(s.userId, ctx.params.eventType, messages, `${s.deviceId}-${ctx.params.txnId}`);
			return {};
		}
	}));
}
export { keysClaimBody, keysQueryBody, registerUserRoutes };

//# sourceMappingURL=user.js.map
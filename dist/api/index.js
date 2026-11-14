import { registerAccountRoutes } from "./account.js";
import { registerOAuthServerRoutes } from "./oauthserver.js";
import { registerBackupRoutes } from "./backup.js";
import { registerSearchRoutes } from "./search.js";
import { registerPreviewRoutes } from "./preview.js";
import { registerSpaceRoutes } from "./spaces.js";
import { registerAdminRoutes } from "./admin.js";
import { registerSlidingSyncRoutes } from "./slidingsync.js";
import { registerFederationRoutes } from "./federation.js";
import { registerRtcRoutes } from "./rtc.js";
import { registerAppServiceRoutes } from "./appservice.js";
import { registerMediaRoutes } from "./media.js";
import { registerLegacyRoutes } from "./legacy.js";
import { registerThreepidRoutes } from "./threepid.js";
import { registerMiscRoutes } from "./misc.js";
import { registerProfileRoutes } from "./profile.js";
import { registerPushRoutes } from "./push.js";
import { registerRoomRoutes } from "./rooms.js";
import { registerMembershipRoutes } from "./membership.js";
import { registerTimelineRoutes } from "./timeline.js";
import { registerDirectoryRoutes } from "./directory.js";
import { registerSyncRoutes } from "./sync.js";
import { registerThreadSubscriptionRoutes } from "./threadsubs.js";
import { registerRelationshipRoutes } from "./relationships.js";
import { registerUserRoutes } from "./user.js";
// src/api/index.ts
function registerRoutes(r) {
	registerMiscRoutes(r);
	registerAccountRoutes(r);
	registerOAuthServerRoutes(r);
	registerProfileRoutes(r);
	registerRoomRoutes(r);
	registerMembershipRoutes(r);
	registerTimelineRoutes(r);
	registerDirectoryRoutes(r);
	registerLegacyRoutes(r);
	registerThreepidRoutes(r);
	registerSyncRoutes(r);
	registerUserRoutes(r);
	registerPushRoutes(r);
	registerMediaRoutes(r);
	registerSearchRoutes(r);
	registerBackupRoutes(r);
	registerPreviewRoutes(r);
	registerSpaceRoutes(r);
	registerAdminRoutes(r);
	registerSlidingSyncRoutes(r);
	registerFederationRoutes(r);
	registerRtcRoutes(r);
	registerAppServiceRoutes(r);
	registerThreadSubscriptionRoutes(r);
	registerRelationshipRoutes(r);
}
export { registerRoutes };

//# sourceMappingURL=index.js.map
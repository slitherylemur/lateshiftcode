// @effect-diagnostics nodeBuiltinImport:off - reads the same plain JSON
// sidecar files MessageAttribution writes; see that module's header.
/**
 * LateShift W6-D: HTTP read side of message attribution.
 *
 * GET /api/lsc/thread-attribution?threadId=<id>
 *   → { "threadId": "<id>", "senders": { "<messageId>": "<githubLogin>" } }
 *
 * Trust model: the route answers only when the request carries an `X-Lsc-User`
 * header, i.e. only when it arrived through the gateway (Caddy sets that
 * header after the portal's /authz; the workspace unix socket is reachable by
 * nothing else — architecture-v2 §3/§6). Desktop and upstream-dev requests
 * have no such header — and no attribution directory configured — so
 * off-gateway builds behave exactly like upstream. Anyone who CAN reach this
 * route is an authenticated member of this workspace, and attribution is data
 * those members already see rendered beside every message.
 *
 * @module lateshift/attributionHttp
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import {
  LSC_ATTRIBUTION_DIR_ENV,
  normalizeSenderLogin,
  readThreadAttribution,
} from "./MessageAttribution.ts";

export const LSC_THREAD_ATTRIBUTION_PATH = "/api/lsc/thread-attribution";

export const lscAttributionRouteLayer = HttpRouter.add(
  "GET",
  LSC_THREAD_ATTRIBUTION_PATH,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    // Gateway-only: no X-Lsc-User header → behave as if the route is absent.
    if (normalizeSenderLogin(request.headers["x-lsc-user"]) === null) {
      return HttpServerResponse.text("Not Found", { status: 404 });
    }
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url)) {
      return HttpServerResponse.text("Bad Request", { status: 400 });
    }
    const threadId = url.value.searchParams.get("threadId");
    if (threadId === null || threadId.length === 0 || threadId.length > 128) {
      return HttpServerResponse.text("Bad Request", { status: 400 });
    }
    const senders = yield* Effect.promise(() =>
      readThreadAttribution(process.env[LSC_ATTRIBUTION_DIR_ENV], threadId),
    );
    return yield* HttpServerResponse.json(
      { threadId, senders },
      { headers: { "Cache-Control": "no-store" } },
    );
  }),
);

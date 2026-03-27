import { ApiError, AuthExpiredError } from "@/lib/api/types";

export interface SetupStatusFailureDiagnostics {
  title: string;
  detail: string;
  actions: string[];
}

function normalizeOrigin(origin: string): string {
  return origin.endsWith("/") ? origin.slice(0, -1) : origin;
}

function buildCanonicalAccessHints(origin: string): string[] {
  return [
    `Use the canonical local entrypoint when possible: http://127.0.0.1:3141/ instead of ${origin}.`,
    "For frontend development, use `npm run ui:dev` on port 5173 so `/v1` is proxied to the Friday API on 3141.",
    "If you intentionally opened a static preview or wrapper port, make sure that origin forwards `/v1/*` to the Friday API.",
  ];
}

export function describeSetupStatusFailure(
  error: unknown,
  origin: string,
): SetupStatusFailureDiagnostics {
  const currentOrigin = normalizeOrigin(origin);

  if (error instanceof AuthExpiredError) {
    return {
      title: "Friday session expired before setup completed",
      detail: `The UI at ${currentOrigin} reached the setup route, but the local session expired before setup status could be loaded.`,
      actions: [
        "Reload the page and sign in again.",
        "If you expect no-sign-in local mode, restart Friday with `NODE_ENV=development` and without `FRIDAY_TOKEN_SECRET`.",
      ],
    };
  }

  if (error instanceof ApiError) {
    if (error.statusCode === 401) {
      return {
        title: "Setup status requires a valid local session",
        detail: `The UI at ${currentOrigin} reached \`/v1/setup/status\`, but the Friday API rejected the request as unauthorized.`,
        actions: [
          "Sign in again on this origin, or reopen the canonical local entrypoint on the API port.",
          "If you expect no-sign-in local mode, restart Friday with `NODE_ENV=development` and no explicit `FRIDAY_TOKEN_SECRET`.",
        ],
      };
    }

    if (error.statusCode === 403) {
      return {
        title: "Setup status is authenticated but forbidden",
        detail: `The UI at ${currentOrigin} reached \`/v1/setup/status\`, but the current session does not have permission to read setup state.`,
        actions: [
          "Use an admin-capable local session for setup and onboarding.",
          "If this is an embedded or wrapper UI, verify it is forwarding the same authenticated session to the Friday API.",
        ],
      };
    }

    if (error.statusCode === 404 || error.code === "NOT_FOUND") {
      return {
        title: "This origin is not mounted to the Friday API",
        detail: `The page loaded from ${currentOrigin}, but \`/v1/setup/status\` returned 404. This usually means you opened a static preview port or an API-only port that does not mount the Friday UI and API together.`,
        actions: buildCanonicalAccessHints(currentOrigin),
      };
    }

    if (error.code === "INVALID_RESPONSE") {
      return {
        title: "This origin returned the wrong payload for `/v1`",
        detail: `The UI at ${currentOrigin} expected a Friday JSON API response from \`/v1/setup/status\`, but received something else.${error.details ? ` ${error.details}` : ""}`,
        actions: buildCanonicalAccessHints(currentOrigin),
      };
    }

    if (error.code === "NETWORK_ERROR" || error.statusCode === 0) {
      return {
        title: "Friday API is not reachable from this origin",
        detail: `The UI at ${currentOrigin} could not reach \`/v1/setup/status\` at all. The frontend shell is running, but the API is not reachable from the current origin.`,
        actions: buildCanonicalAccessHints(currentOrigin),
      };
    }

    return {
      title: "Setup status unavailable",
      detail: `The UI at ${currentOrigin} received an unexpected API error while loading \`/v1/setup/status\`: ${error.message}`,
      actions: buildCanonicalAccessHints(currentOrigin),
    };
  }

  if (error instanceof Error) {
    return {
      title: "Setup status unavailable",
      detail: `The UI at ${currentOrigin} failed before it could classify the setup request: ${error.message}`,
      actions: buildCanonicalAccessHints(currentOrigin),
    };
  }

  return {
    title: "Setup status unavailable",
    detail: `The UI at ${currentOrigin} failed to load setup status for an unknown reason.`,
    actions: buildCanonicalAccessHints(currentOrigin),
  };
}

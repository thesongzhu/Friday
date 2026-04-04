import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";

const ROLE_SCOPES = Object.freeze({
  owner: [
    "hub.admin",
    "workflow.read",
    "workflow.write",
    "workflow.run",
    "workflow.conflict.resolve",
    "satellite.read",
    "satellite.write",
    "fleet.read",
    "security.read",
    "security.write",
    "session.read",
    "session.write",
    "diagnosis.read",
    "diagnosis.write",
    "agent.read",
    "agent.run",
    "agent.write",
    "skill.read",
    "skill.write",
    "plugin.read",
    "plugin.write",
    "plugin.install",
    "desktop.read",
    "desktop.write",
    "desktop.execute",
    "marketplace.read",
    "marketplace.write",
    "marketplace.admin",
    "rules.read",
    "rules.write",
    "execution.read",
    "acceptance.read",
    "retry.read",
    "playbook.read",
    "playbook.write",
  ],
  admin: [
    "hub.admin",
    "workflow.read",
    "workflow.write",
    "workflow.run",
    "workflow.conflict.resolve",
    "satellite.read",
    "satellite.write",
    "fleet.read",
    "security.read",
    "security.write",
    "session.read",
    "session.write",
    "diagnosis.read",
    "diagnosis.write",
    "agent.read",
    "agent.run",
    "agent.write",
    "skill.read",
    "skill.write",
    "plugin.read",
    "plugin.write",
    "plugin.install",
    "desktop.read",
    "desktop.write",
    "desktop.execute",
    "marketplace.read",
    "marketplace.write",
    "marketplace.admin",
    "rules.read",
    "rules.write",
    "execution.read",
    "acceptance.read",
    "retry.read",
    "playbook.read",
    "playbook.write",
  ],
  operator: [
    "workflow.read",
    "workflow.write",
    "workflow.run",
    "workflow.conflict.resolve",
    "satellite.read",
    "fleet.read",
    "session.read",
    "session.write",
    "diagnosis.read",
    "agent.read",
    "agent.run",
    "agent.write",
    "skill.read",
    "plugin.read",
    "desktop.read",
    "desktop.write",
    "desktop.execute",
    "marketplace.read",
    "marketplace.write",
    "rules.read",
    "execution.read",
    "acceptance.read",
    "retry.read",
    "playbook.read",
  ],
  viewer: [
    "workflow.read",
    "satellite.read",
    "fleet.read",
    "security.read",
    "session.read",
    "diagnosis.read",
    "agent.read",
    "skill.read",
    "plugin.read",
    "desktop.read",
    "marketplace.read",
    "rules.read",
    "execution.read",
    "acceptance.read",
    "retry.read",
    "playbook.read",
  ],
});

function expandHome(input) {
  if (typeof input !== "string" || input.trim().length === 0) {
    return null;
  }
  const trimmed = input.trim();
  if (trimmed.startsWith("~")) {
    return path.resolve(path.join(os.homedir(), trimmed.slice(1)));
  }
  return path.resolve(trimmed);
}

function resolvePlatformStatePath(platform, home, env) {
  switch (platform) {
    case "darwin":
      return path.join(home, "Library", "Application Support", "Friday", "state");
    case "linux": {
      const xdgState = env.XDG_STATE_HOME || path.join(home, ".local", "state");
      return path.join(xdgState, "friday");
    }
    case "win32": {
      const localAppData = env.LOCALAPPDATA || path.join(home, "AppData", "Local");
      return path.join(localAppData, "Friday", "state");
    }
    default:
      return undefined;
  }
}

export function resolveFridayStateDir(processEnv = process.env) {
  const dotEnv = loadDotEnvOverrides({ processEnv });
  const mergedEnv = { ...dotEnv, ...processEnv };
  const explicit = expandHome(mergedEnv.FRIDAY_STATE_DIR);
  if (explicit) {
    return explicit;
  }
  const home = os.homedir();
  const platformPath = resolvePlatformStatePath(process.platform, home, mergedEnv);
  if (platformPath && fs.existsSync(platformPath)) {
    return platformPath;
  }
  const legacyPath = path.join(home, ".friday", "state");
  if (fs.existsSync(legacyPath)) {
    return legacyPath;
  }
  return platformPath ?? legacyPath;
}

export function resolveFridayDbPath(processEnv = process.env, explicitPath) {
  return expandHome(explicitPath) ?? path.join(resolveFridayStateDir(processEnv), "friday.db");
}

export function resolveFridayTokenSecretPath(explicitPath) {
  return expandHome(explicitPath) ?? path.join(os.homedir(), ".friday", "token.secret");
}

function encodeToken(claims, secret) {
  const payloadJson = JSON.stringify(claims);
  const payloadB64 = Buffer.from(payloadJson).toString("base64url");
  const signature = crypto.createHmac("sha256", secret).update(payloadB64).digest("base64url");
  return `${payloadB64}.${signature}`;
}

function decodeDotEnvValue(rawValue) {
  const trimmed = rawValue.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
    || (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function loadDotEnvOverrides({ processEnv = process.env, cwd = process.cwd(), envFilePath } = {}) {
  const configuredPath = expandHome(envFilePath ?? processEnv.FRIDAY_ENV_FILE);
  const resolvedPath = configuredPath ?? path.resolve(cwd, ".env");
  if (!fs.existsSync(resolvedPath)) {
    return {};
  }
  const text = fs.readFileSync(resolvedPath, "utf8");
  const entries = {};
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      continue;
    }
    const withoutExport = trimmed.startsWith("export ") ? trimmed.slice(7).trim() : trimmed;
    const eqIndex = withoutExport.indexOf("=");
    if (eqIndex <= 0) {
      continue;
    }
    const key = withoutExport.slice(0, eqIndex).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) {
      continue;
    }
    entries[key] = decodeDotEnvValue(withoutExport.slice(eqIndex + 1));
  }
  return entries;
}

function parsePositiveInteger(value, defaultValue) {
  if (value === undefined || value === null || value === "") {
    return defaultValue;
  }
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive integer but received "${String(value)}".`);
  }
  return parsed;
}

export function loadMintTokenSecret({
  processEnv = process.env,
  explicitSecret,
  tokenSecretFile,
  envFilePath: _envFilePath,
}) {
  if (typeof explicitSecret === "string" && explicitSecret.trim().length > 0) {
    return {
      secret: explicitSecret.trim(),
      source: "FRIDAY_TOKEN_SECRET",
    };
  }
  if (typeof processEnv.FRIDAY_TOKEN_SECRET === "string" && processEnv.FRIDAY_TOKEN_SECRET.trim().length > 0) {
    return {
      secret: processEnv.FRIDAY_TOKEN_SECRET.trim(),
      source: "FRIDAY_TOKEN_SECRET",
    };
  }
  const resolvedPath = resolveFridayTokenSecretPath(tokenSecretFile);
  const secret = fs.readFileSync(resolvedPath, "utf8").trim();
  if (secret.length === 0) {
    throw new Error(`Token secret file is empty: ${resolvedPath}`);
  }
  return {
    secret,
    source: resolvedPath,
  };
}

function requireMintableRole(user) {
  if (!["owner", "admin"].includes(user.role)) {
    throw new Error(
      `Mint-local-admin requires an owner/admin account, but selected user ${user.id} has role "${user.role}".`,
    );
  }
  return user;
}

function selectMintUser(db, { userId, userEmail }) {
  if (userId) {
    const user = db.prepare(`
      SELECT id, email, display_name, role, last_login_at
      FROM users
      WHERE id = ?
      LIMIT 1
    `).get(userId);
    if (!user) {
      throw new Error(`Mint-local-admin could not find user id "${userId}".`);
    }
    return requireMintableRole(user);
  }

  if (userEmail) {
    const user = db.prepare(`
      SELECT id, email, display_name, role, last_login_at
      FROM users
      WHERE lower(email) = lower(?)
      LIMIT 1
    `).get(userEmail);
    if (!user) {
      throw new Error(`Mint-local-admin could not find user email "${userEmail}".`);
    }
    return requireMintableRole(user);
  }

  const user = db.prepare(`
    SELECT id, email, display_name, role, last_login_at
    FROM users
    WHERE role IN ('owner', 'admin')
    ORDER BY
      CASE role
        WHEN 'owner' THEN 0
        WHEN 'admin' THEN 1
        ELSE 2
      END ASC,
      COALESCE(last_login_at, '') DESC,
      id ASC
    LIMIT 1
  `).get();

  if (!user) {
    throw new Error("Mint-local-admin could not find any owner/admin user in the local state DB.");
  }
  return requireMintableRole(user);
}

export function mintLocalAdminAccessToken(options = {}) {
  const processEnv = options.processEnv ?? process.env;
  const dotEnv = loadDotEnvOverrides({
    processEnv,
    envFilePath: options.envFilePath,
  });
  const mergedEnv = { ...dotEnv, ...processEnv };
  const dbPath = resolveFridayDbPath(mergedEnv, options.stateDbPath);
  const { secret, source } = loadMintTokenSecret({
    processEnv,
    explicitSecret: options.tokenSecret,
    tokenSecretFile: options.tokenSecretFile,
  });
  const accessTokenTtlSec = parsePositiveInteger(options.accessTokenTtlSec, 3600);
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });

  try {
    const user = selectMintUser(db, {
      userId: options.userId,
      userEmail: options.userEmail,
    });
    const nowSec = Math.floor(Date.now() / 1000);
    const sessionId = crypto.randomUUID();
    const tenantId = typeof options.tenantId === "string" && options.tenantId.trim().length > 0
      ? options.tenantId.trim()
      : user.id;
    const scopes = [...(ROLE_SCOPES[user.role] ?? [])];
    if (scopes.length === 0) {
      throw new Error(`No scopes configured for role "${user.role}".`);
    }

    const claims = {
      tokenId: crypto.randomUUID(),
      principalType: "user",
      principalId: user.id,
      tenantId,
      userId: user.id,
      role: user.role,
      scopes,
      iat: nowSec,
      exp: nowSec + accessTokenTtlSec,
      sid: sessionId,
    };

    return {
      accessToken: encodeToken(claims, secret),
      user: {
        id: user.id,
        email: user.email ?? undefined,
        displayName: user.display_name,
        role: user.role,
      },
      metadata: {
        source: "mint_local_admin_token",
        mintedAt: new Date(nowSec * 1000).toISOString(),
        accessTokenTtlSec,
        userId: user.id,
        userEmail: user.email ?? null,
        role: user.role,
        tenantId,
        sessionId,
        stateDbPath: dbPath,
        tokenSecretSource: source,
      },
    };
  } finally {
    db.close();
  }
}

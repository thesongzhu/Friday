import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROFILE_PATH = join(__dirname, 'user-profile.json');

const DEFAULT_PROFILE = {
  capitalSize: 100000,
  riskTolerance: 'moderate',
  maxPositionPct: 10,
  maxConcurrentPositions: 5,
  preferredStyles: ['低吸', '打板'],
  preferredSectors: [],
  stockWatchlist: [],
  tradingHours: { preMarket: true, mainSession: true },
  notificationPrefs: { channel: 'discord', urgencyThreshold: 'high' },
  experienceLevel: 'intermediate',
  trackedHotMoneySeats: [],
};

function loadProfile() {
  if (!existsSync(PROFILE_PATH)) {
    writeFileSync(PROFILE_PATH, JSON.stringify(DEFAULT_PROFILE, null, 2), 'utf-8');
    return structuredClone(DEFAULT_PROFILE);
  }
  return JSON.parse(readFileSync(PROFILE_PATH, 'utf-8'));
}

function saveProfile(profile) {
  writeFileSync(PROFILE_PATH, JSON.stringify(profile, null, 2), 'utf-8');
}

function output(data) {
  console.log(JSON.stringify(data));
}

// Parse input from env or stdin
let input = {};
if (process.env.SKILL_INPUT) {
  input = JSON.parse(process.env.SKILL_INPUT);
} else {
  // Try reading from stdin (non-blocking)
  try {
    const chunks = [];
    const fd = 0;
    const buf = Buffer.alloc(4096);
    const { openSync, readSync, closeSync } = await import('node:fs');
    // Check if stdin has data (non-TTY)
    if (!process.stdin.isTTY) {
      const stdinData = readFileSync(fd, 'utf-8').trim();
      if (stdinData) {
        input = JSON.parse(stdinData);
      }
    }
  } catch {
    // No stdin data, use defaults
  }
}

const { action = 'get', field, value } = input;

switch (action) {
  case 'get': {
    const profile = loadProfile();
    if (field) {
      if (!(field in profile)) {
        output({ error: `Unknown field: ${field}`, profile: null, changesMade: [] });
        process.exit(1);
      }
      output({ profile: { [field]: profile[field] }, changesMade: [] });
    } else {
      output({ profile, changesMade: [] });
    }
    break;
  }

  case 'set': {
    if (!field || value === undefined) {
      output({ error: 'Both "field" and "value" are required for set action', profile: null, changesMade: [] });
      process.exit(1);
    }
    const profile = loadProfile();
    if (!(field in profile)) {
      output({ error: `Unknown field: ${field}`, profile: null, changesMade: [] });
      process.exit(1);
    }
    const oldValue = profile[field];
    profile[field] = value;
    saveProfile(profile);
    output({
      profile,
      changesMade: [{ field, oldValue, newValue: value }],
    });
    break;
  }

  case 'update': {
    if (value === undefined || typeof value !== 'object') {
      output({ error: '"value" must be an object with fields to update', profile: null, changesMade: [] });
      process.exit(1);
    }
    const profile = loadProfile();
    const changesMade = [];
    for (const [k, v] of Object.entries(value)) {
      if (!(k in profile)) {
        output({ error: `Unknown field: ${k}`, profile: null, changesMade: [] });
        process.exit(1);
      }
      const oldValue = profile[k];
      if (Array.isArray(profile[k]) && Array.isArray(v)) {
        // Merge arrays (append unique values)
        const merged = [...new Set([...profile[k], ...v])];
        profile[k] = merged;
        changesMade.push({ field: k, oldValue, newValue: merged });
      } else if (typeof profile[k] === 'object' && !Array.isArray(profile[k]) && typeof v === 'object' && !Array.isArray(v)) {
        // Shallow merge objects
        profile[k] = { ...profile[k], ...v };
        changesMade.push({ field: k, oldValue, newValue: profile[k] });
      } else {
        profile[k] = v;
        changesMade.push({ field: k, oldValue, newValue: v });
      }
    }
    saveProfile(profile);
    output({ profile, changesMade });
    break;
  }

  case 'reset': {
    const oldProfile = existsSync(PROFILE_PATH) ? JSON.parse(readFileSync(PROFILE_PATH, 'utf-8')) : {};
    saveProfile(structuredClone(DEFAULT_PROFILE));
    const changesMade = Object.keys(DEFAULT_PROFILE).map((k) => ({
      field: k,
      oldValue: oldProfile[k] ?? null,
      newValue: DEFAULT_PROFILE[k],
    }));
    output({ profile: DEFAULT_PROFILE, changesMade });
    break;
  }

  default:
    output({ error: `Unknown action: ${action}. Use get|set|update|reset.`, profile: null, changesMade: [] });
    process.exit(1);
}

// Wrapper for nLogger submodule.
//
// The gateway's logging strategy — see documentation/api_rest.md > Logging:
//
//   debug — per-request trace: stream start/end, per-request parameter mapping,
//           background sweeps. Off unless actively investigating.
//   info  — lifecycle and state changes: startup, config (re)load, cache
//           pruning, admin actions. Once per run or per event, not per request.
//   warn  — something was tolerated, degraded, or looks wrong, and the request
//           survived: repaired history, dropped data, a fallback in use.
//   error — a request or the service failed. Carries enough identity to act on.
//
// The gateway runs quiet: warnings and errors only. A log file therefore starts
// with its header and stays empty until something is wrong, which is the point —
// anything that appears in it is worth reading.
//
// LOG_LEVEL overrides the default at startup; POST /logs/level changes it at
// runtime without a restart.
//
// nLogger resolves its level from LOG_LEVEL when the instance is constructed and
// offers no option for it, so the default is seeded into the environment here,
// immediately before construction. Seeding has to happen at that moment and not
// at module load: main.js calls process.loadEnvFile() in its own body, and a
// value already present in process.env takes precedence over the .env file — so
// seeding earlier would silently override a LOG_LEVEL set there.
// (An `options.level` in nLogger would remove this nudge; filed as an issue on
// herrbasan/nLogger.)
import {
    createLogger as createNLogger,
    getLogger as getNLogger,
    resetLogger as resetNLogger
} from '../nLogger/src/logger.js';

const DEFAULT_LOG_LEVEL = 'warn';

// nLogger's getLogger() constructs the singleton with its own defaults when none
// exists, ignoring options — so the first caller decides where logs land. The
// wrapper therefore constructs the singleton itself on first use, so LOG_DIR is
// honoured no matter which module asks for the logger first.
let constructed = false;

function seedDefaultLevel() {
    if (!process.env.LOG_LEVEL) {
        process.env.LOG_LEVEL = DEFAULT_LOG_LEVEL;
    }
}

// Tests create logger instances too, and without this they write into the same
// folder the running gateway writes to — which reads as a gateway that restarted
// dozens of times ("Shutting down. Session duration: 0s" x48). LOG_DIR keeps them
// apart; tests/setup.js points it at tests/_Test_Assets/logs.
function withLogDir(options) {
    if (options?.logsDir || !process.env.LOG_DIR) return options;
    return { ...options, logsDir: process.env.LOG_DIR };
}

export function createLogger(options) {
    seedDefaultLevel();
    constructed = true;
    return createNLogger(withLogDir(options));
}

export function getLogger(name) {
    seedDefaultLevel();
    if (!constructed) {
        constructed = true;
        return createNLogger(withLogDir());
    }
    return getNLogger(name);
}

export function resetLogger() {
    constructed = false;
    return resetNLogger();
}

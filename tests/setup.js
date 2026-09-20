// Mocha setup: runs before any test file is loaded.
//
// The logger writes a new timestamped file per instance, and the test suite
// creates several. Without this they land in the gateway's own logs/ folder,
// where they read as a gateway that restarted dozens of times (48 files each
// ending in "Shutting down. Session duration: 0s"). Point them at their own
// directory instead.
import path from 'node:path';

process.env.LOG_DIR = path.join(process.cwd(), 'tests', '_Test_Assets', 'logs');

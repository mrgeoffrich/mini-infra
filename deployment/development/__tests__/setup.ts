import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Redirect MINI_INFRA_HOME to a per-process temp dir before the registry
// module captures it at import time. This isolates tests from the user's
// real ~/.mini-infra/worktrees.yaml.
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mini-infra-test-'));
process.env.MINI_INFRA_HOME = tmpHome;

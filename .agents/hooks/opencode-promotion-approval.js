import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);

export const UsernodePromotionApproval = async (context) => {
  const candidate = context?.worktree || context?.directory;
  if (typeof candidate !== 'string' || !path.isAbsolute(candidate)) {
    throw new Error('Homeroom promotion guard requires an absolute OpenCode worktree');
  }
  const checkoutRoot = fs.realpathSync(candidate);
  const guardPath = path.join(
    checkoutRoot,
    '.agents',
    'hooks',
    'opencode-promotion-guard.js'
  );
  const guardStat = fs.lstatSync(guardPath);
  if (!guardStat.isFile() || guardStat.isSymbolicLink()
      || fs.realpathSync(guardPath) !== guardPath) {
    throw new Error('Homeroom OpenCode promotion guard must be a real file in this checkout');
  }
  return require(guardPath)(context);
};

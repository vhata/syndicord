import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';

export function isolatedGitEnvironment(
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  // Even invalid inherited selectors/configuration must not affect discovery.
  const discovery = Object.fromEntries(
    Object.entries(environment).filter(([name]) => !name.startsWith('GIT_')),
  );
  const names = execFileSync('git', ['rev-parse', '--local-env-vars'], {
    cwd: tmpdir(),
    env: discovery,
    encoding: 'utf8',
    timeout: 10_000,
    maxBuffer: 64 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const isolated = { ...environment };
  for (const name of names.trim().split(/\s+/)) delete isolated[name];
  // Git lists the count, but not its dynamically numbered config entries.
  for (const name of Object.keys(isolated))
    if (/^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(name)) delete isolated[name];
  return isolated;
}

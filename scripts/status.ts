import { runStatus } from '../src/status-command.ts';

export { runStatus };

if (import.meta.main) {
  const result = await runStatus(process.argv.slice(2));
  if (result.stdout) console.log(result.stdout);
  if (result.stderr) console.error(result.stderr);
  process.exitCode = result.code;
}

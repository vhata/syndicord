import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export const redirects = {
  'docs/WEB.html': {
    target: 'DISCORD_SIGN_IN.html',
    sections: {
      '#cli-login': 'USAGE.html#select-an-installation',
      '#installation-name-and-colour':
        'OPERATIONS.html#installation-name-and-colour',
      '#local-preview': 'DEVELOPMENT.html#run-locally',
      '#authentication-design': 'DEVELOPMENT.html#authentication-design',
      '#add-feeds-and-routing':
        'USAGE.html#choose-the-section-matching-your-editor',
    },
  },
  'docs/API.html': { target: 'PROVIDER_API.html' },
  'docs/DEPLOYMENT.html': { target: 'GITHUB_DEPLOYMENT.html' },
};

export function writeRedirects(output) {
  for (const [from, { target, sections = {} }] of Object.entries(redirects)) {
    const file = resolve(output, from);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(
      file,
      `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Guide moved · syndicord</title>
<script>
const sections = ${JSON.stringify(sections)};
const target = new URL(sections[location.hash] || ${JSON.stringify(target)}, location.href);
target.search = location.search;
if (!target.hash) target.hash = location.hash;
location.replace(target.href);
</script>
</head>
<body>
<p>This guide is now at <a href="${target}">${target}</a>.</p>
</body>
</html>
`,
    );
  }
}

// Map one reviewed workspace postinstall to its shared-lock file URI identity.
// This is only for the pinned 0.1.5 source build, never the installed runtime.
import {readFileSync, writeFileSync, realpathSync, lstatSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {join, resolve, isAbsolute} from 'node:path';
import {pathToFileURL} from 'node:url';

const source = process.argv[2];
if (process.argv.length !== 3 || !source || !isAbsolute(source)) throw new Error('Supply one absolute path to the pinned Harness source checkout.');
const root = realpathSync.native(resolve(source));
const commit = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], {encoding:'utf8', windowsHide:true, stdio:['ignore','pipe','ignore']}).trim();
if (commit !== '183f08e9c6dde7e36cd2318eaee70b0da08fb35e') throw new Error('Only the pinned official 0.1.5 source is supported.');
const hash = filename => createHash('sha256').update(readFileSync(join(root, filename), 'utf8').replaceAll('\r\n','\n')).digest('hex');
if (hash('pnpm-lock.yaml') !== 'a6515566578a26c29b5faddaf94abb5ec452ce6e533f8957e813328ebd4b3c27') throw new Error('The original dependency lock must remain unchanged.');
if (hash('packages/subprocess/subprocess-local/package.json') !== '77c1f1466cfef9d6c997b83852fb2c51b4378056a39fd2867dd34d500f702faa') throw new Error('The reviewed package manifest has changed; no build policy was granted.');
if (hash('packages/subprocess/subprocess-local/scripts/ensure-spawn-helper.mjs') !== 'ca5509febf1e6ec1356df121835ebe5ed2f9cace4bdc2ba6d83d41c7e45e0f1b') throw new Error('The reviewed postinstall script has changed; no build policy was granted.');
const filename = join(root, 'pnpm-workspace.yaml');
if (lstatSync(filename).isSymbolicLink()) throw new Error('Refusing to change a redirected workspace policy.');
const exactId = '@deepseek-ai/dsh-subprocess-local@' + pathToFileURL(realpathSync.native(join(root,'packages/subprocess/subprocess-local'))).href;
const yamlKey = `'${exactId.replaceAll("'", "''")}'`;
const text = readFileSync(filename, 'utf8');
const ending = text.includes('\r\n') ? '\r\n' : '\n';
const relativeEntry = /^  '@deepseek-ai\/dsh-subprocess-local@file:packages\/subprocess\/subprocess-local': true\r?$/m;
if (!relativeEntry.test(text) || [...text.matchAll(/^allowBuilds:\s*$/gm)].length !== 1) throw new Error('The expected narrow build policy is missing.');
const line = `  ${yamlKey}: true`;
const exactLine = text.split(/\r?\n/).find(row => row.trimStart().startsWith(yamlKey + ':'));
if (exactLine && exactLine !== line) throw new Error('An existing policy decision conflicts with this exact source identity.');
if (!exactLine) writeFileSync(filename, text.replace(relativeEntry, match => match.replace(/\r$/, '') + ending + line + (match.endsWith('\r') ? '\r' : '')), 'utf8');
process.stdout.write(JSON.stringify({commit,originalLockVerified:true,reviewedScriptVerified:true,addedExactBuildIdentity:!exactLine}) + '\n');

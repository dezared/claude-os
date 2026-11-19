// A stand-in for the agentation daemon in the supervisor's tests: `node fake-daemon.mjs <port> <mode> <pid file>`.
// ok: answers /health and keeps a grandchild; crash: says why on stderr and exits. Like the real one, it leaves when stdin closes.
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { createServer } from 'node:http';

const [port, mode, pids] = process.argv.slice(2);
appendFileSync(pids, `${process.pid}\n`);
if (mode === 'crash') {
  process.stderr.write('boom: the fake crashed\n');
  process.exit(2);
}
const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
appendFileSync(pids, `${grandchild.pid}\n`);
createServer((req, res) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ status: 'ok', mode: 'local' }))).listen(Number(port), '127.0.0.1');
process.stdin.on('end', () => process.exit(0));
process.stdin.resume();

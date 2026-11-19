// The agentation HTTP server alone, as the plugin's supervisor runs it. `agentation-mcp server` also serves MCP on stdio and
// stays up with a dead port, so it would look healthy to the supervisor; this entry exits instead and says why.
import { startHttpServer } from 'agentation-mcp';

const at = process.argv.indexOf('--port');
const port = at >= 0 ? Number(process.argv[at + 1]) : 4747;

const server = startHttpServer(port);
server.on('error', (err: NodeJS.ErrnoException) => {
  process.stderr.write(err.code === 'EADDRINUSE' ? `port ${port} is taken by another program\n` : `${err.message}\n`);
  process.exit(1);
});

// The supervisor holds stdin open: when it goes away, even killed outright, the pipe closes and no orphan is left.
process.stdin.on('end', () => process.exit(0));
process.stdin.resume();

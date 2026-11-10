import { createServer } from 'node:http';

createServer((req, res) => res.end('ok')).listen(3000);

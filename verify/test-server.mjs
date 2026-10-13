import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';

const body = readFileSync(process.argv[2]);
const port = Number(process.argv[3] ?? 18099);
createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'content-length': String(body.length) });
  res.end(body);
}).listen(port, '127.0.0.1', () => console.log('serving installer on ' + String(port) + ', bytes=' + String(body.length)));

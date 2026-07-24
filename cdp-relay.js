/**
 * TCP relay: escuta em 0.0.0.0:LISTEN_PORT e encaminha para 127.0.0.1:TARGET_PORT.
 * Roda no Windows para o WSL conseguir falar com o CDP do Chrome (que só escuta em 127.0.0.1).
 *
 * Uso:
 *   node cdp-relay.js [listenPort=9334] [targetPort=9333]
 */
const net = require('net');

const listenPort = Number(process.argv[2] || 9334);
const targetPort = Number(process.argv[3] || 9333);
const targetHost = '127.0.0.1';

const server = net.createServer((client) => {
  const upstream = net.connect(targetPort, targetHost);
  client.pipe(upstream);
  upstream.pipe(client);
  const kill = () => {
    try { client.destroy(); } catch (_) {}
    try { upstream.destroy(); } catch (_) {}
  };
  client.on('error', kill);
  upstream.on('error', kill);
  client.on('close', kill);
  upstream.on('close', kill);
});

server.on('error', (err) => {
  console.error('[cdp-relay] error', err.message);
  process.exit(1);
});

server.listen(listenPort, '0.0.0.0', () => {
  console.log(`[cdp-relay] 0.0.0.0:${listenPort} -> ${targetHost}:${targetPort}`);
});

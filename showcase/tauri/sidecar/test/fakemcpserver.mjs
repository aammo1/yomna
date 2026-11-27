// A fake MCP server over Streamable HTTP on 127.0.0.1 (plain JSON replies, no SSE): enough of the protocol for gg's
// real MCPClientManager to connect, list tools and call one. Used by cp14-connections.test.mjs. No network beyond loopback.
import http from 'node:http';

export const FAKE_TOOLS = [
  { name: 'search_notes', description: 'Search the notes', inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] }, annotations: { readOnlyHint: true } },
  { name: 'delete_note', description: 'Delete a note', inputSchema: { type: 'object', properties: { id: { type: 'string' } } }, annotations: { destructiveHint: true } },
];

/** Starts the server; resolves { url, calls, close }. calls: every JSON-RPC method seen, with its params. */
export function startFakeMcp({ tools = FAKE_TOOLS, token = null } = {}) {
  const calls = [];
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST') { res.writeHead(req.method === 'DELETE' ? 200 : 405).end(); return; }
    if (token && req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401, { 'content-type': 'application/json' }).end('{"error":"unauthorized"}'); return; }
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const msgs = [].concat(JSON.parse(body));
      const out = [];
      for (const m of msgs) {
        calls.push({ method: m.method, params: m.params ?? null });
        if (m.id === undefined) continue; // a notification
        let result;
        if (m.method === 'initialize') result = { protocolVersion: m.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake-notes', version: '1.0.0' } };
        else if (m.method === 'tools/list') result = { tools };
        else if (m.method === 'tools/call') result = { content: [{ type: 'text', text: `found ${JSON.stringify(m.params?.arguments ?? {})} via ${m.params?.name}` }] };
        else if (m.method === 'ping') result = {};
        if (result) out.push({ jsonrpc: '2.0', id: m.id, result });
        else out.push({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: `no method ${m.method}` } });
      }
      if (!out.length) { res.writeHead(202).end(); return; }
      res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'fake-session-1' }).end(JSON.stringify(Array.isArray(JSON.parse(body)) ? out : out[0]));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    resolve({ url: `http://127.0.0.1:${port}/mcp`, calls, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }) });
  }));
}

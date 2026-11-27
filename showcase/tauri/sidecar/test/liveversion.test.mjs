import assert from 'node:assert/strict';
import { geminiConnect, reasonFor } from '../live.mjs';

// The SDK constructor is injected as a stub; nothing touches the network.
{
  let seen = null;
  class FakeGenAI {
    constructor(opts) { seen = opts; this.live = { connect: async (p) => ({ p }) }; }
  }
  const params = { model: 'm' };
  const out = await geminiConnect('k', async () => ({ GoogleGenAI: FakeGenAI }))(params);
  assert.equal(seen.apiKey, 'k');
  assert.equal(seen.httpOptions?.apiVersion, 'v1alpha');
  assert.equal(out.p, params);
}

// v1alpha closes a bad key with 1007 and this text.
assert.equal(reasonFor('API key not valid. Please pass a valid API key.'), 'key');

console.log('liveversion ok');

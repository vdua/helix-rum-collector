/*
 * Copyright 2023 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */
/* eslint-env mocha */
import assert from 'assert';
import { it, describe, before } from 'node:test';
// eslint-disable-next-line import/no-extraneous-dependencies
import esmock from 'esmock';
import { lastLogMessage } from '../src/logger.mjs';

const methods = {};

// Mock this function which will be called by index.mjs
global.addEventListener = function addEventListener() {
};

describe('Test index', () => {
  before(async () => {
    const mod = await import('../src/index.mjs');
    Object.keys(mod).forEach((f) => {
      methods[f] = mod[f];
    });
  });

  it('main GET', async () => {
    const headers = new Map();
    headers.set('host', 'somehost');
    headers.set('user-agent', 'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36');

    const req = { headers };
    req.method = 'GET';
    req.url = 'http://foo.bar.org?data={"referer":"http://blahblah", "checkpoint": "error"}';

    const ctx = { runtime: { name: 'compute-at-edge' } };

    const resp = await methods.main(req, ctx);
    assert.equal(201, resp.status);
    assert.equal('text/plain; charset=utf-8', resp.headers.get('Content-Type'));

    const logged = JSON.parse(lastLogMessage);
    assert.equal('error', logged.checkpoint);
    assert.equal('http://blahblah/', logged.url);
    assert.equal('desktop:chromeos', logged.user_agent);
    assert.equal(1, logged.weight);
    assert.equal('somehost', logged.host);
    assert.equal('blahblah', logged.hostname);
  });

  it('main GET generates ID', async () => {
    const headers = new Map();
    const req = { headers };
    req.method = 'GET';
    req.url = 'http://foo.bar.org?data={"checkpoint":"error"}';

    const ctx = { runtime: { name: 'compute-at-edge' } };

    const resp = await methods.main(req, ctx);
    assert.equal(201, resp.status);

    const logged = JSON.parse(lastLogMessage);
    const id1 = logged.id;
    assert(id1.length > 0);

    // Make another identical request
    const resp2 = await methods.main(req, ctx);
    assert.equal(201, resp2.status);

    const logged2 = JSON.parse(lastLogMessage);
    assert(logged2.id.length > 0);

    assert(id1 !== logged2.id, 'The generated IDs should be different for 2 identical GET requests');
  });

  it('main POST via handler', async () => {
    const headers = new Map();
    headers.set('user-agent', 'Opera/9.80 (MAUI Runtime; Opera Mini/4.4.39030/191.315; U; en) Presto/2.12.423 Version/12.16');
    headers.set('x-forwarded-host', 'www.foobar.com');

    const json = () => JSON.parse(`{
      "weight": 5,
      "id": "foobar",
      "cwv": {
        "a": "aaa",
        "b": 123
      },
      "referrer": "http://a.b.c",
      "generation": 42,
      "checkpoint": "error",
      "target": "https://t",
      "source": "1.2.3.4",
      "t": "3"
    }`);

    const req = { headers, json };
    req.method = 'POST';
    req.url = 'http://foo.bar.org';

    const event = {
      request: req,
      ctx: { runtime: { name: 'compute-at-edge' } },
    };

    const resp = await methods.handler(event);

    assert.equal(201, resp.status);
    assert.equal('text/plain; charset=utf-8', resp.headers.get('Content-Type'));

    const logged = JSON.parse(lastLogMessage);
    assert.equal('foobar', logged.id);
    assert(logged.time.toString().endsWith('.003'));
    assert.equal('http://a.b.c/', logged.url);
    assert.equal(5, logged.weight);
    assert.equal(42, logged.generation);
    assert.equal('https://t/', logged.target);
    assert.equal('1.2.3.4', logged.source);
    assert.equal('aaa', logged.a);
    assert.equal(123, logged.b);
    assert.equal('www.foobar.com', logged.host);
    assert.equal('mobile', logged.user_agent);
  });

  it('error handling', async () => {
    const headers = new Map();
    headers.set('host', 'some.host');
    headers.set('user-agent', 'Mozilla/5.0 (X11; Linux i686; rv:10.0) Gecko/20100101 Firefox/10.0');

    const json = () => JSON.parse('{"malformed"}');

    const req = { headers, json };
    req.method = 'POST';
    req.url = 'http://foo.bar.org';

    const resp = await methods.main(req);

    assert.equal(400, resp.status);
    assert(resp.headers.get('X-Error').startsWith('RUM Collector expects'));
    assert.equal('text/plain; charset=utf-8', resp.headers.get('Content-Type'));

    const logged = JSON.parse(lastLogMessage);
    assert.equal(4, logged.severity);
    assert.equal('some.host', logged.subsystemName);

    const loggedJSON = JSON.parse(logged.text);

    assert.equal('http://foo.bar.org', loggedJSON.edgecompute.url);
    assert.equal('http://foo.bar.org', loggedJSON.cdn.url);
    assert.equal('POST', loggedJSON.request.method);
    assert.equal('desktop:linux', loggedJSON.request.user_agent);
    assert(logged.timestamp.toString().endsWith('000'));
    assert.equal(logged.timestamp, loggedJSON.time.start_msec);
    assert(loggedJSON.message.startsWith('RUM Collector expects'));
  });

  it('responds to robots.txt', async () => {
    const headers = new Map();

    const req = { headers };
    req.method = 'GET';
    req.url = 'http://x.y/robots.txt';

    const resp = await methods.main(req);
    assert.equal(200, resp.status);
    assert.equal('text/plain', resp.headers.get('content-type'));
    const t = await resp.text();
    assert(t.includes('User-agent: *'));
    assert(t.includes('Disallow: /'));
  });

  async function verifyInput(data, errPrefix) {
    const headers = new Map();

    const req = { headers };
    req.method = 'GET';
    req.url = `http://foo.bar.org?data=${data}`;

    const resp = await methods.main(req);
    assert.equal(400, resp.status);
    assert(
      resp.headers.get('X-Error').startsWith(errPrefix),
      `${resp.headers.get('X-Error')} should start with ${errPrefix}`,
    );
  }

  it('responds to web-vitals', async () => {
    const headers = new Map();

    const req = { headers };
    req.method = 'GET';
    req.url = 'http://x.y/.rum/web-vitals';

    const resp = await methods.main(req);

    assert.equal(200, resp.status);
    assert(resp.ok);

    const t = await resp.text();
    assert(t.includes('webVitals'));
  }); // .timeout(5000);

  it('responds to web-vitals dir list', async () => {
    const headers = new Map();

    const req = { headers };
    req.method = 'GET';
    req.url = 'http://x.y/.rum/web-vitals/';

    const resp = await methods.main(req);

    assert.equal(404, resp.status);
  }); // .timeout(5000);

  it('responds to helix-rum-js', async () => {
    const headers = new Map();

    const req = { headers };
    req.method = 'GET';
    req.url = 'http://x.y/.rum/@adobe/helix-rum-js';

    const resp = await methods.main(req);

    assert.equal(200, resp.status);
    assert(resp.ok);
    assert(resp.headers.has('etag'));
    assert(!resp.headers.has('server'));
    assert(!resp.headers.has('cf-cache-status'));
    assert(!resp.headers.has('cr-ray'));

    const t = await resp.text();
    assert(t.includes('export function sampleRUM'));
  }); // .timeout(5000);

  it('responds to helix-rum-js dir list', async () => {
    const headers = new Map();

    const req = { headers };
    req.method = 'GET';
    req.url = 'http://x.y/.rum/@adobe/helix-rum-js/';

    const resp = await methods.main(req);

    assert.equal(404, resp.status);
  }); // .timeout(5000);

  it('responds to helix-rum-enhancer dir list', async () => {
    const headers = new Map();

    const req = { headers };
    req.method = 'GET';
    req.url = 'http://x.y/.rum/@adobe/helix-rum-enhancer/';

    const resp = await methods.main(req);

    assert.equal(404, resp.status);
  }); // .timeout(5000);

  it('Retry with another package registry', async () => {
    const mockUnpkg = () => ({ status: 500 });
    const { main } = await esmock('../src/index.mjs', {
      '../src/unpkg.mjs': {
        respondUnpkg: mockUnpkg,
      },
    });
    const headers = new Map();

    const req = { headers };
    req.method = 'GET';
    req.url = 'http://x.y/.rum/web-vitals?pkgreg=unpkg';

    const resp = await main(req);

    assert.equal(200, resp.status);
    assert(resp.ok);

    const t = await resp.text();
    assert(t.includes('webVitals'));
  });

  it('Retry with another package registry after exception', async () => {
    const { main } = await esmock('../src/index.mjs', {
      '../src/jsdelivr.mjs': {
        respondJsdelivr: () => { throw new Error('boom'); },
      },
    });
    const headers = new Map();

    const req = { headers };
    req.method = 'GET';
    req.url = 'http://x.y/.rum/@adobe/helix-rum-js@^1?pkgreg=jsdelivr';

    const resp = await main(req);

    assert.equal(200, resp.status);
    assert(resp.ok);

    const t = await resp.text();
    assert(t.includes('export function sampleRUM'));
  });

  it('verifies inputs', async () => {
    await verifyInput('{"id": null}', 'id field is required');
    await verifyInput('{"weight": "hello"}', 'weight must be a number');
    await verifyInput('{"cwv": 123}', 'cwv must be an object');
  });// .timeout(5000);

  it('Core Web Vitals', async () => {
    const headers = new Map();

    const json = () => JSON.parse(`{
      "id": "myid1",
      "cwv": {
        "CLS": 0.06,
        "LCP": 1.1,
        "FCP": 0.9,
        "TTFB": 800
      },
      "checkpoint": "cwv",
      "target": "https://t",
      "source": "1.2.3.4",
      "t": "3"
    }`);

    const req = { headers, json };
    req.method = 'POST';
    req.url = 'http://foo.bar.org';

    const resp = await methods.main(req, { runtime: { name: 'compute-at-edge' } });
    assert.equal(201, resp.status);

    const logged = JSON.parse(lastLogMessage);
    assert.equal(0.06, logged.CLS);
    assert.equal(1.1, logged.LCP);
    assert.equal(0.9, logged.FCP);
    assert.equal(800, logged.TTFB);
  });

  it('info request', async () => {
    const req = {
      method: 'GET',
      url: 'http://test.org/info.json?key=val',
    };

    const ctx = {
      runtime: {
        name: 'my-platform',
      },
      func: {
        version: '1.2.ZZ',
      },
    };

    const resp = await methods.main(req, ctx);
    const res = await resp.json();
    assert.equal('my-platform', res.platform);
    assert.equal('1.2.ZZ', res.version);
  });

  it('console logger', async () => {
    const logged = [];
    const capturedConsole = {
      log: (...args) => logged.push(args),
    };

    const req = {};
    req.headers = new Map();
    req.method = 'POST';
    req.url = 'http://www.acme.org';
    req.json = () => ({
      id: 'xyz123',
    });

    const ctx = { altConsole: capturedConsole };
    const resp = await methods.main(req, ctx);

    assert.equal(201, resp.status);
    assert.equal(logged.length, 1);

    const ld = JSON.parse(logged[0]);
    assert.equal(ld.url, 'http://www.acme.org');
    assert.equal(ld.weight, 1);
    assert.equal(ld.id, 'xyz123');
  });

  it('get other package registry', () => {
    assert.equal('jsdelivr', methods.getOtherPackageRegistry('unpkg'));
    assert.equal('unpkg', methods.getOtherPackageRegistry('jsdelivr'));
  });
});

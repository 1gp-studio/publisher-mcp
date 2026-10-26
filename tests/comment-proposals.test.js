import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Platform } from '../src/platform.js';
import { registerCommentProposalTools } from '../src/comment-proposals.js';

const commentId = '11111111-1111-4111-8111-111111111111';
const game = { id: '22222222-2222-4222-8222-222222222222', slug: 'test-game', title: 'Test game' };
const previewUrl = 'https://preview.example.org/play?version=2';
const token = 'c'.repeat(64);
const data = result => JSON.parse(result.content[0].text);

async function harness(t, { authenticated = true } = {}) {
  const directory = await mkdtemp(join(tmpdir(), '1gp-proposal-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const requests = [];
  const state = { proposal: null, revision: 0, rejection: null };
  const http = createServer((request, response) => {
    let text = '';
    request.on('data', chunk => { text += chunk; });
    request.on('end', () => {
      const body = text ? JSON.parse(text) : undefined;
      requests.push({ method: request.method, url: request.url, authorization: request.headers.authorization, body });
      response.setHeader('Content-Type', 'application/json');
      if (state.rejection) {
        response.statusCode = state.rejection.status;
        response.end(JSON.stringify({ code: state.rejection.code, error: 'Rejected progress update' }));
        return;
      }
      if (request.method === 'POST') {
        state.revision++;
        state.proposal = { status: body.status, previewUrl: body.previewUrl, note: body.note, updatedAt: '2026-10-26T10:00:00.123456+00:00' };
      }
      response.end(JSON.stringify({ id: commentId, game, proposal: state.proposal, revision: state.revision, platformOrigin: 'https://untrusted-response.example' }));
    });
  });
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => http.close(resolve)));
  const platform = new Platform({ origin: `http://127.0.0.1:${http.address().port}`, configDirectory: join(directory, 'credentials') });
  if (authenticated) {
    await mkdir(platform.directory, { recursive: true, mode: 0o700 });
    await writeFile(platform.file, JSON.stringify({ token }), { mode: 0o600 });
  }
  const server = new McpServer({ name: '1gp-proposal-test', version: '1.0.0' });
  registerCommentProposalTools(server, platform, value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], isError: !!value.error }));
  const client = new Client({ name: '1gp-proposal-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); });
  return { client, requests, state, origin: platform.origin };
}

test('proposal MCP tools reuse the creator connection and preserve the exact comment and revision', async t => {
  const { client, requests, origin } = await harness(t);
  const read = await client.callTool({ name: 'read_comment_proposal', arguments: { commentId } });
  assert.equal(read.isError, false);
  assert.deepEqual(data(read), { id: commentId, game, proposal: null, revision: 0, platformOrigin: origin });
  const update = { commentId, status: 'testing', previewUrl, note: '  Larger mobile controls; main controls verified.  ', expectedRevision: data(read).revision };
  const saved = await client.callTool({ name: 'update_comment_proposal', arguments: update });
  assert.equal(saved.isError, false);
  assert.equal(data(saved).proposal.status, 'testing');
  assert.equal(data(saved).revision, 1);
  assert.equal(data(saved).platformOrigin, origin, 'local connection origin overrides a supplied API response origin');
  assert.equal(data(saved).proposal.note, update.note.trim());
  assert.deepEqual(requests, [
    { method: 'GET', url: `/api/comments/${commentId}/proposal`, authorization: `Bearer ${token}`, body: undefined },
    { method: 'POST', url: `/api/comments/${commentId}/proposal`, authorization: `Bearer ${token}`, body: {
      status: 'testing', previewUrl, note: update.note.trim(), expectedRevision: 0,
    } },
  ]);
  assert.ok(!JSON.stringify([read, saved]).includes(token));
  const tools = (await client.listTools()).tools;
  const writeTool = tools.find(tool => tool.name === 'update_comment_proposal');
  assert.equal(tools.find(tool => tool.name === 'read_comment_proposal').annotations.readOnlyHint, true);
  assert.equal(writeTool.annotations.readOnlyHint, false);
  assert.ok(writeTool.inputSchema.required.includes('expectedRevision'));
  assert.match(writeTool.description, /separately authorized successful production deployment/);
});

test('invalid progress, unsafe previews and missing revisions never reach the platform', async t => {
  const { client, requests } = await harness(t);
  const valid = { commentId, status: 'testing', previewUrl, note: 'Ready to try.', expectedRevision: 0 };
  const missingRevision = { ...valid };
  delete missingRevision.expectedRevision;
  for (const args of [
    { ...valid, commentId: '../another-comment' }, { ...valid, status: 'done' },
    { ...valid, previewUrl: null }, { ...valid, previewUrl: 'http://preview.example.org/' },
    { ...valid, previewUrl: 'https://user:secret@preview.example.org/' },
    { ...valid, previewUrl: 'https:///preview.example.org/' },
    { ...valid, previewUrl: 'https://preview.example.org/\nbad' },
    { ...valid, previewUrl: 'https://preview.example.org\\@evil.example/' },
    { ...valid, note: 'x'.repeat(1001) }, { ...valid, note: 'hidden\u0001control' },
    { ...valid, expectedRevision: -1 }, { ...valid, expectedRevision: 1.5 },
    { ...valid, expectedRevision: Number.MAX_SAFE_INTEGER + 1 }, missingRevision,
  ]) {
    const rejected = await client.callTool({ name: 'update_comment_proposal', arguments: args });
    assert.equal(rejected.isError, true, JSON.stringify(args));
  }
  assert.equal(requests.length, 0);
  const local = await client.callTool({ name: 'update_comment_proposal', arguments: { ...valid, status: 'in_progress', previewUrl: null } });
  assert.equal(local.isError, false);
  assert.equal(requests.length, 1);
});

test('authorization failures and stale progress conflicts are returned without retries or publishing', async t => {
  const { client, requests, state, origin } = await harness(t);
  for (const rejection of [
    { status: 401, code: 'AUTH_REQUIRED' }, { status: 403, code: 'PROPOSAL_FORBIDDEN' },
    { status: 409, code: 'PROPOSAL_CONFLICT' }, { status: 503, code: 'PROPOSAL_UNAVAILABLE' },
  ]) {
    state.rejection = rejection;
    const result = await client.callTool({ name: 'update_comment_proposal', arguments: {
      commentId, status: 'testing', previewUrl, note: 'Tested.', expectedRevision: 2,
    } });
    assert.equal(result.isError, true);
    assert.equal(data(result).code, rejection.code);
    assert.equal(data(result).platformOrigin, origin);
  }
  assert.equal(requests.length, 4);
  assert.ok(requests.every(request => request.url === `/api/comments/${commentId}/proposal` && request.body.expectedRevision === 2));
  assert.equal(state.proposal, null);
});

test('an unconnected client requests connection without sending credentials or changing progress', async t => {
  const { client, requests, origin } = await harness(t, { authenticated: false });
  for (const call of [
    { name: 'read_comment_proposal', arguments: { commentId } },
    { name: 'update_comment_proposal', arguments: { commentId, status: 'in_progress', previewUrl: null, note: 'Working locally.', expectedRevision: 0 } },
  ]) {
    const result = await client.callTool(call);
    assert.equal(result.isError, true);
    assert.equal(data(result).code, 'AUTH_REQUIRED');
    assert.equal(data(result).platformOrigin, origin);
  }
  assert.equal(requests.length, 0);
});

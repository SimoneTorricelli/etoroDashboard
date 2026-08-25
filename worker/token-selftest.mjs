/** Test di regressione del parsing e dell'autenticazione Agent Portfolio. */
import assert from 'node:assert/strict';
import { agentToken401Hint } from './lib/diagnose.js';
import {
  EtoroClient,
  EtoroError,
  extractAgentTokenSecret,
  isUuidIdentifier,
} from './lib/etoro.js';
import {
  clearCredentials, credentialFingerprint, hasVerifiedAgentBinding, resolveCredentials, saveCredentials,
  saveVerifiedAgentToken,
} from './lib/vault.js';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const TOKEN_ID = 'f9e8d7c6-b5a4-4210-8edc-ba9876543210';
const CLIENT_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
const SECRET = 'sk_live_a1b2c3d4e5f6_agent_secret';
const API_KEY = 'api-key-binding-test';
const USER_KEY = 'owner-user-key-binding-test';

function memoryD1() {
  const rows = new Map();
  const updatedAt = new Map();
  return {
    rows,
    updatedAt,
    failNextBatch: false,
    prepare(sql) {
      return {
        sql,
        args: [],
        bind(...args) { this.args = args; return this; },
        async first() {
          if (/^SELECT value(?:, updated_at)? FROM config/.test(this.sql)) {
            const value = rows.get(this.args[0]);
            return value == null ? null : { value, updated_at: updatedAt.get(this.args[0]) ?? 0 };
          }
          if (this.sql.startsWith('INSERT INTO config') && this.sql.includes('RETURNING value, updated_at')) {
            const [key, value, nextUpdatedAt,,, expectedExists,, expectedValue, expectedUpdatedAt] = this.args;
            const exists = rows.has(key);
            if (exists !== Boolean(expectedExists)) return null;
            if (exists && (rows.get(key) !== expectedValue || updatedAt.get(key) !== expectedUpdatedAt)) return null;
            rows.set(key, value);
            updatedAt.set(key, nextUpdatedAt);
            return { value, updated_at: nextUpdatedAt };
          }
          return null;
        },
        async run() {
          if (this.sql.startsWith('DELETE FROM config')) {
            rows.delete(this.args[0]);
            updatedAt.delete(this.args[0]);
            return { success: true };
          }
          throw new Error(`run() non gestito: ${this.sql.slice(0, 80)}`);
        },
      };
    },
    async batch(statements) {
      if (this.failNextBatch) { this.failNextBatch = false; throw new Error('injected batch failure'); }
      const staged = new Map(rows);
      const stagedUpdatedAt = new Map(updatedAt);
      for (const statement of statements) {
        const key = statement.args[0];
        if (key !== 'autopilot') {
          const [, value, nextUpdatedAt,,, expectedExists,, expectedValue, expectedUpdatedAt] = statement.args;
          const exists = staged.has(key);
          if (exists === Boolean(expectedExists)
            && (!exists || (staged.get(key) === expectedValue && stagedUpdatedAt.get(key) === expectedUpdatedAt))) {
            staged.set(key, value);
            stagedUpdatedAt.set(key, nextUpdatedAt);
          }
          continue;
        }
        const requiredVaultValue = statement.args[6];
        const requiredVaultUpdatedAt = statement.args[7];
        if (staged.get('vault') !== requiredVaultValue || stagedUpdatedAt.get('vault') !== requiredVaultUpdatedAt) {
          continue;
        }
        const fallback = JSON.parse(statement.args[1]);
        const patch = JSON.parse(statement.args[2]);
        const current = staged.has(key) ? JSON.parse(staged.get(key)) : fallback;
        staged.set(key, JSON.stringify({
          ...current,
          ...patch,
          decisionRevision: Number(current.decisionRevision ?? 0) + 1,
        }));
      }
      rows.clear();
      for (const [key, value] of staged) rows.set(key, value);
      updatedAt.clear();
      for (const [key, value] of stagedUpdatedAt) updatedAt.set(key, value);
    },
  };
}

test('estrae userToken, non il precedente userTokenId', () => {
  const response = {
    userTokenId: TOKEN_ID,
    userToken: SECRET,
    userTokenName: 'my-trading-token',
    clientId: CLIENT_ID,
  };
  assert.equal(extractAgentTokenSecret(response), SECRET);
});

test('trova il segreto in wrapper e array', () => {
  const response = { data: { userTokens: [{ userTokenId: TOKEN_ID, UserTokenValue: `  ${SECRET}  ` }] } };
  assert.equal(extractAgentTokenSecret(response), SECRET);
});

test('rifiuta metadata, UUID e chiavi generiche', () => {
  assert.equal(extractAgentTokenSecret({
    userTokenId: TOKEN_ID,
    userTokenName: 'autopilot-token-name-long-enough',
    clientId: CLIENT_ID,
    token: SECRET,
    value: SECRET,
  }), null);
  assert.equal(extractAgentTokenSecret({ userToken: TOKEN_ID }), null);
  assert.equal(isUuidIdentifier(TOKEN_ID), true);
  assert.equal(isUuidIdentifier('00000000-0000-0000-0000-000000000000'), true);
  assert.equal(isUuidIdentifier(SECRET), false);
});

test('il messaggio 401 distingue un UUID da un segreto opaco', () => {
  assert.match(agentToken401Hint(TOKEN_ID), /UUID/);
  assert.match(agentToken401Hint(TOKEN_ID), /non il segreto userToken/);
  assert.match(agentToken401Hint(SECRET), /revocato, scaduto/);
});

test('createAgentUserToken usa il segreto ufficiale e non effettua fallback GET', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    if (calls.length === 1) {
      return new Response(JSON.stringify({ scopes: EtoroClient.AGENT_SCOPES.map((name) => ({ name })) }), { status: 200 });
    }
    return new Response(JSON.stringify({
      userTokenId: TOKEN_ID,
      userToken: SECRET,
      userTokenName: 'autopilot-test',
      clientId: CLIENT_ID,
    }), { status: 201 });
  };
  try {
    const client = new EtoroClient({ apiKey: 'api-key', userKey: 'owner-user-key' });
    const result = await client.createAgentUserToken('0405bc2a-2bd1-443b-9000-8e6846fe6d10', 'autopilot-test');
    assert.equal(result.token, SECRET);
    assert.equal(calls.length, 2);
    assert.match(calls[1].url, /\/api\/v2\/agent-portfolios\/0405bc2a-2bd1-443b-9000-8e6846fe6d10\/user-tokens$/);
    assert.equal(JSON.parse(calls[1].init.body).scopeNames.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('una risposta con soli metadata fallisce senza tentare di rileggerli', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      return new Response(JSON.stringify({ scopes: EtoroClient.AGENT_SCOPES.map((name) => ({ name })) }), { status: 200 });
    }
    return new Response(JSON.stringify({ userTokenId: TOKEN_ID, userTokenName: 'autopilot-test', clientId: CLIENT_ID }), { status: 201 });
  };
  try {
    const client = new EtoroClient({ apiKey: 'api-key', userKey: 'owner-user-key' });
    await assert.rejects(
      () => client.createAgentUserToken('0405bc2a-2bd1-443b-9000-8e6846fe6d10', 'autopilot-test'),
      (error) => error instanceof EtoroError && error.status === 502 && /non ne ha restituito il segreto/.test(error.message),
    );
    assert.equal(calls, 2, 'non deve esistere un GET di fallback del segreto');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('gli errori ufficiali errorCode/errorMessage non diventano HTTP generico', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    errorCode: 'Unauthorized',
    errorMessage: 'Unauthorized',
  }), { status: 401 });
  try {
    const client = new EtoroClient({ apiKey: 'api-key', userKey: 'owner-user-key' });
    await assert.rejects(
      () => client.request('v1', 'trading/info/real/pnl'),
      (error) => error instanceof EtoroError && error.status === 401 && error.message === 'Unauthorized',
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('binding: fingerprint A con token B viene rifiutata', async () => {
  const fingerprintA = await credentialFingerprint(`${SECRET}-A`);
  const fingerprintB = await credentialFingerprint(`${SECRET}-B`);
  const config = {
    activeAgentPortfolioId: 'portfolio-A',
    agentTokenVerifiedAt: 123,
    agentTokenFingerprint: fingerprintA,
  };
  const resolved = {
    values: { etoroAgentToken: `${SECRET}-B` },
    origin: { etoroAgentToken: 'vault' },
    agentBinding: { portfolioId: 'portfolio-B', verifiedAt: 123, fingerprint: fingerprintB },
  };
  assert.equal(hasVerifiedAgentBinding(resolved, config), false);
});

test('binding: salvataggi concorrenti lasciano una sola tupla atomica', async () => {
  const db = memoryD1();
  const env = {
    CONTROL_TOKEN: 'vault-test-control-token',
    ETORO_API_KEY: API_KEY,
    ETORO_USER_KEY: USER_KEY,
  };
  const currentConfig = { executionMode: 'shadow' };
  const expectedVaultRevision = (await resolveCredentials(db, env)).vaultRevision;
  const results = await Promise.allSettled([
    saveVerifiedAgentToken(db, env, {
      token: `${SECRET}-A`, etoroApiKey: API_KEY, etoroUserKey: USER_KEY,
      portfolioId: 'portfolio-A', verifiedAt: 101, currentConfig, expectedVaultRevision,
    }),
    saveVerifiedAgentToken(db, env, {
      token: `${SECRET}-B`, etoroApiKey: API_KEY, etoroUserKey: USER_KEY,
      portfolioId: 'portfolio-B', verifiedAt: 202, currentConfig, expectedVaultRevision,
    }),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
  const config = JSON.parse(db.rows.get('autopilot'));
  const resolved = await resolveCredentials(db, env);
  assert.equal(hasVerifiedAgentBinding(resolved, config), true);
  const expectedToken = config.activeAgentPortfolioId === 'portfolio-A' ? `${SECRET}-A` : `${SECRET}-B`;
  assert.equal(resolved.values.etoroAgentToken, expectedToken);
});

test('binding: un errore batch conserva integralmente la tupla precedente', async () => {
  const db = memoryD1();
  const env = {
    CONTROL_TOKEN: 'vault-test-control-token',
    ETORO_API_KEY: API_KEY,
    ETORO_USER_KEY: USER_KEY,
  };
  const firstVaultRevision = (await resolveCredentials(db, env)).vaultRevision;
  await saveVerifiedAgentToken(db, env, {
    token: `${SECRET}-A`, etoroApiKey: API_KEY, etoroUserKey: USER_KEY,
    portfolioId: 'portfolio-A', verifiedAt: 101,
    currentConfig: { executionMode: 'shadow' }, expectedVaultRevision: firstVaultRevision,
  });
  const before = new Map(db.rows);
  db.failNextBatch = true;
  const secondVaultRevision = (await resolveCredentials(db, env)).vaultRevision;
  await assert.rejects(() => saveVerifiedAgentToken(db, env, {
    token: `${SECRET}-B`, etoroApiKey: API_KEY, etoroUserKey: USER_KEY,
    portfolioId: 'portfolio-B', verifiedAt: 202,
    currentConfig: { executionMode: 'shadow' }, expectedVaultRevision: secondVaultRevision,
  }), /injected batch failure/);
  assert.deepEqual(db.rows, before);
});

test('binding: ruotare API key o owner key richiede una nuova verifica', async () => {
  const db = memoryD1();
  const env = {
    CONTROL_TOKEN: 'vault-test-control-token',
    ETORO_API_KEY: API_KEY,
    ETORO_USER_KEY: USER_KEY,
  };
  const expectedVaultRevision = (await resolveCredentials(db, env)).vaultRevision;
  await saveVerifiedAgentToken(db, env, {
    token: SECRET,
    etoroApiKey: API_KEY,
    etoroUserKey: USER_KEY,
    portfolioId: 'portfolio-A',
    verifiedAt: 303,
    currentConfig: { executionMode: 'shadow' },
    expectedVaultRevision,
  });
  const config = JSON.parse(db.rows.get('autopilot'));
  assert.equal(hasVerifiedAgentBinding(await resolveCredentials(db, env), config), true);
  assert.equal(hasVerifiedAgentBinding(await resolveCredentials(db, {
    ...env,
    ETORO_API_KEY: `${API_KEY}-rotated`,
  }), config), false);
  assert.equal(hasVerifiedAgentBinding(await resolveCredentials(db, {
    ...env,
    ETORO_USER_KEY: `${USER_KEY}-rotated`,
  }), config), false);
});

test('binding: una rotazione concorrente non può essere sovrascritta dal token in volo', async () => {
  const db = memoryD1();
  const env = {
    CONTROL_TOKEN: 'vault-test-control-token',
    ETORO_API_KEY: API_KEY,
    ETORO_USER_KEY: USER_KEY,
  };
  const expectedVaultRevision = (await resolveCredentials(db, env)).vaultRevision;

  await saveCredentials(db, env, { etoroApiKey: `${API_KEY}-rotated` });
  await assert.rejects(() => saveVerifiedAgentToken(db, env, {
    token: SECRET,
    etoroApiKey: API_KEY,
    etoroUserKey: USER_KEY,
    portfolioId: 'portfolio-old',
    verifiedAt: 404,
    currentConfig: { executionMode: 'shadow' },
    expectedVaultRevision,
  }), /credenziali eToro cambiate durante la generazione/);

  const resolved = await resolveCredentials(db, env);
  assert.equal(resolved.values.etoroApiKey, `${API_KEY}-rotated`);
  assert.equal(resolved.agentBinding, null);
  assert.equal(db.rows.has('autopilot'), false);
});

test('binding: DELETE su vault assente lascia un tombstone che ferma il token in volo', async () => {
  const db = memoryD1();
  const env = {
    CONTROL_TOKEN: 'vault-test-control-token',
    ETORO_API_KEY: API_KEY,
    ETORO_USER_KEY: USER_KEY,
  };
  const expectedVaultRevision = (await resolveCredentials(db, env)).vaultRevision;
  assert.equal(expectedVaultRevision.exists, false);

  await clearCredentials(db, env);
  const afterClear = await resolveCredentials(db, env);
  assert.equal(afterClear.vaultRevision.exists, true);
  assert.equal(afterClear.values.etoroApiKey, API_KEY, 'il tombstone lascia disponibile il fallback Worker Secret');

  await assert.rejects(() => saveVerifiedAgentToken(db, env, {
    token: SECRET,
    etoroApiKey: API_KEY,
    etoroUserKey: USER_KEY,
    portfolioId: 'portfolio-before-delete',
    verifiedAt: 505,
    currentConfig: { executionMode: 'shadow' },
    expectedVaultRevision,
  }), /credenziali eToro cambiate durante la generazione/);
  assert.equal((await resolveCredentials(db, env)).agentBinding, null);
  assert.equal(db.rows.has('autopilot'), false);
});

let failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL  ${name}\n      ${error instanceof Error ? error.message : String(error)}`);
  }
}

console.log(`\n${tests.length - failed}/${tests.length} test token superati`);
process.exit(failed ? 1 : 0);

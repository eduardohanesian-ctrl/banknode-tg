"use strict";

const http = require("http");
const https = require("https");
const { ethers } = require("ethers");
const {
  MPC,
  assert,
  identifyPeerRequest,
  broadcastTransaction,
  buildUnsignedErc20Transfer,
  buildUnsignedTransaction,
  completeDkg,
  createState,
  finalizeTransaction,
  getBalance,
  getErc20Balance,
  getErc20Balances,
  initializeDkg,
  loadConfig,
  log,
  makeChallenge,
  parseWire,
  peerRequest,
  prepareSigner,
  precomputeWalletChallenge,
  queueInboundShare,
  randomId,
  readRequestBody,
  stringifyWire,
  verifyDkgTranscript,
  verifyPeerNtildeChallenge,
  verifyThresholdSignature,
} = require("./crypto_backend");
const {
  loadBotIdentity,
  pollTelegram,
  sendGroupEvent,
  sendHelp,
} = require("./tg_backend");

const SESSION_TTL_MS = 30 * 60_000;
const CRYPTO_SETUP_TIMEOUT_MS = 60 * 60_000;
const RETRYABLE_SIGNER_ERROR_CODES = new Set([
  "PEER_TIMEOUT",
  "APPROVAL_TIMEOUT",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ENOTFOUND",
]);

function shouldTryNextSigner(error) {
  return RETRYABLE_SIGNER_ERROR_CODES.has(error?.code);
}

function jsonResponse(res, statusCode, payload) {
  const body = stringifyWire(payload);
  res.writeHead(statusCode, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(body);
}

function getWallet(state, walletKey) {
  return state.db.wallets[walletKey] || null;
}

function walletsForUser(state, userId) {
  return Object.values(state.db.wallets).filter((wallet) => wallet.memberUserIds.includes(String(userId)));
}

function isCommitment(value) {
  return Buffer.isBuffer(value) && value.length === 32;
}

function commitmentsEqual(left, right) {
  return isCommitment(left) && isCommitment(right) && left.equals(right);
}

async function waitForApproval(state, details) {
  const timeoutMs = state.config.telegram.approvalTimeoutMs || state.config.runtime?.roundTtlMs || 120_000;
  const approvalId = details.sessionId;
  assert(!state.pendingApprovals.has(approvalId), "approval already pending");
  const allowed = new Set(details.approverIds.map(String));
  const personal = allowed.size === 1 && allowed.has(String(details.requesterId));
  const startedAt = Date.now();
  log("DEBUG", `sign ${details.sessionId}: creating Telegram approval request`);
  const decision = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      state.pendingApprovals.delete(approvalId);
      reject(Object.assign(new Error("Telegram approval timed out"), { code: "APPROVAL_TIMEOUT" }));
    }, timeoutMs);
    timer.unref?.();
    state.pendingApprovals.set(approvalId, {
      ...details, allowed, personal, createdAt: Date.now(),
      approve: () => { clearTimeout(timer); state.pendingApprovals.delete(approvalId); resolve(true); },
      reject: () => {
        clearTimeout(timer);
        state.pendingApprovals.delete(approvalId);
        reject(Object.assign(new Error("request rejected"), { code: "APPROVAL_REJECTED" }));
      },
    });
  });
  const mode = personal ? `approval required from ${details.requesterId}` :
    `approval required from one of: ${[...allowed].join(", ")}`;
  await sendGroupEvent(state, [
    `${state.config.node.id}: THRESHOLD SIGNING APPROVAL`,
    mode,
    details.description,
    `digest: 0x${details.digest.toString("hex")}`,
    `send /approve@${state.telegramBotUsername}${personal ? ` or /reject@${state.telegramBotUsername}` : ""}`,
  ].join("\n"));
  log("DEBUG", `sign ${details.sessionId}: approval message sent; waiting for a decision`);
  await decision;
  log("DEBUG", `sign ${details.sessionId}: approved after ${Date.now() - startedAt} ms`);
  return true;
}

function resolveApproval(state, userId, approve) {
  const candidates = [...state.pendingApprovals.values()]
    .filter((item) => item.allowed.has(String(userId)))
    .sort((a, b) => b.createdAt - a.createdAt);
  if (!candidates.length) return "no pending request that you may approve";
  const pending = candidates[0];
  if (!approve && !pending.personal) return "group requests cannot be rejected; allow them to time out";
  if (approve) pending.approve(); else pending.reject();
  return approve ? `approved session ${pending.sessionId}` : `rejected session ${pending.sessionId}`;
}

async function peerSignInit(state, payload, sourcePeer) {
  const { sessionId, walletKey, digest, peerChallenge, requesterId, approverIds, description } = payload;
  assert(typeof sessionId === "string" && /^[0-9a-f]{48}$/.test(sessionId), "invalid signing sessionId");
  assert(Buffer.isBuffer(digest) && digest.length === 32, "digest must be 32 bytes");
  const wallet = getWallet(state, walletKey);
  assert(wallet, "wallet does not exist on this signer");
  assert(wallet.verified === true, "wallet DKG transcript is not fully verified");
  assert(wallet.memberUserIds.includes(String(requesterId)), "requester is not a wallet member");
  assert(Array.isArray(approverIds) && approverIds.length >= 1 &&
    approverIds.every((id) => wallet.memberUserIds.includes(String(id))), "invalid wallet approvers");
  assert(typeof description === "string" && description.length <= 1000, "invalid signing description");
  assert(!state.signSessions.has(sessionId), "signing session already exists");
  log("DEBUG", `sign ${sessionId}: init received from ${sourcePeer.id}`);
  await verifyPeerNtildeChallenge(state, sourcePeer.id, peerChallenge?.ntilde);
  await waitForApproval(state, { sessionId, walletKey, digest, requesterId, approverIds, description });
  const challengeStartedAt = Date.now();
  log("DEBUG", `sign ${sessionId}: remote signer challenge generation started after approval`);
  const ownChallenge = await makeChallenge(state, wallet, sourcePeer.index_fix);
  log("DEBUG", `sign ${sessionId}: remote signer challenge ready (${Date.now() - challengeStartedAt} ms)`);
  const signer = prepareSigner(wallet, sourcePeer.index_fix, ownChallenge, peerChallenge);
  state.signSessions.set(sessionId, {
    sessionId, walletKey, digest, sourcePeerId: sourcePeer.id, sourceIndex: sourcePeer.index_fix,
    ownChallenge, peerChallenge, signer, phase: 1, createdAt: Date.now(),
  });
  return { challenge: ownChallenge };
}

async function peerSignRound1(state, payload, sourcePeer) {
  const session = state.signSessions.get(payload.sessionId);
  assert(session && session.sourcePeerId === sourcePeer.id && session.phase === 1, "invalid signing phase 1");
  const converted = await MPC.signConvertStep1({
    xShare: session.signer.xShare,
    yShare: session.signer.yShare,
    kShare: payload.kShare,
  });
  session.bShare = converted.bShare;
  session.phase = 2;
  return { aShare: converted.aShare };
}

async function peerSignRound2(state, payload, sourcePeer) {
  const session = state.signSessions.get(payload.sessionId);
  assert(session && session.sourcePeerId === sourcePeer.id && session.phase === 2, "invalid signing phase 2");
  const converted = await MPC.signConvertStep3({ bShare: session.bShare, muShare: payload.muShare });
  const combined = MPC.signCombine({ gShare: converted.gShare, signIndex: converted.signIndex });
  session.va = MPC.generateVAProofs(
    session.digest,
    MPC.sign(session.digest, combined.oShare, payload.dShare, undefined, false)
  );
  session.phase = 3;
  return { dShare: combined.dShare, vaCommitment: session.va.comDecomVA.commitment };
}

function peerSignRound3(state, payload, sourcePeer) {
  const session = state.signSessions.get(payload.sessionId);
  assert(session && session.sourcePeerId === sourcePeer.id && session.phase === 3, "invalid signing phase 3");
  assert(isCommitment(payload.vaCommitment), "missing or invalid VA commitment");
  session.peerVaCommitment = payload.vaCommitment;
  session.phase = 4;
  return { vaShare: session.va };
}

function peerSignRound4(state, payload, sourcePeer) {
  const session = state.signSessions.get(payload.sessionId);
  assert(session && session.sourcePeerId === sourcePeer.id && session.phase === 4, "invalid signing phase 4");
  assert(commitmentsEqual(payload.vaShare?.comDecomVA?.commitment, session.peerVaCommitment),
    "VA commitment changed after commit phase");
  session.ut = MPC.verifyVAShares(session.va, [payload.vaShare]);
  session.phase = 5;
  return { utCommitment: session.ut.comDecomUT.commitment };
}

function peerSignRound5(state, payload, sourcePeer) {
  const session = state.signSessions.get(payload.sessionId);
  assert(session && session.sourcePeerId === sourcePeer.id && session.phase === 5, "invalid signing phase 5");
  assert(isCommitment(payload.utCommitment), "missing or invalid UT commitment");
  assert(commitmentsEqual(payload.utShare?.comDecomUT?.commitment, payload.utCommitment), "UT commitment mismatch");
  const signatureShare = MPC.verifyUTShares(session.ut, [payload.utShare]);
  const result = { utShare: session.ut, signatureShare };
  state.signSessions.delete(payload.sessionId);
  return result;
}

async function coordinateSignatureWithPeer(state, peer, params) {
  const wallet = getWallet(state, params.walletKey);
  assert(wallet, "wallet does not exist; run /create first");
  assert(wallet.verified === true, "wallet DKG transcript is not fully verified");
  assert(Buffer.isBuffer(params.digest) && params.digest.length === 32, "digest must be 32 bytes");
  const sessionId = randomId(24);
  const signingStartedAt = Date.now();
  log("DEBUG", `sign ${sessionId}: threshold signing started with ${peer.id}`);
  const localChallengeStartedAt = Date.now();
  const ownChallenge = await makeChallenge(state, wallet, peer.index_fix);
  log("DEBUG", `sign ${sessionId}: coordinator challenge ready (${Date.now() - localChallengeStartedAt} ms)`);
  log("DEBUG", `sign ${sessionId}: requesting approval from ${peer.id}`);
  const initialized = await peerRequest(state, peer, "/peer/sign/init", {
    sessionId,
    walletKey: params.walletKey,
    digest: params.digest,
    peerChallenge: ownChallenge,
    requesterId: String(params.requesterId),
    approverIds: params.approverIds.map(String),
    description: params.description,
  }, 20 * 60_000);
  await verifyPeerNtildeChallenge(state, peer.id, initialized.challenge?.ntilde);
  log("DEBUG", `sign ${sessionId}: peer initialized; starting MPC signing rounds`);
  const signer = prepareSigner(wallet, peer.index_fix, ownChallenge, initialized.challenge);
  const roundsStartedAt = Date.now();
  const first = await MPC.signShare(signer.xShare, signer.yShare);
  log("DEBUG", `sign ${sessionId}: local sign share generated (${Date.now() - roundsStartedAt} ms)`);
  const round1 = await peerRequest(state, peer, "/peer/sign/round1", { sessionId, kShare: first.kShare });
  const localStep2 = await MPC.signConvertStep2({ wShare: first.wShare, aShare: round1.aShare });
  const localCombined = MPC.signCombine({
    gShare: localStep2.gShare,
    signIndex: { i: localStep2.muShare.i, j: localStep2.muShare.j },
  });
  const round2 = await peerRequest(state, peer, "/peer/sign/round2", {
    sessionId, muShare: localStep2.muShare, dShare: localCombined.dShare,
  });
  assert(isCommitment(round2.vaCommitment), "peer returned an invalid VA commitment");
  log("DEBUG", `sign ${sessionId}: MtA conversion rounds completed (${Date.now() - roundsStartedAt} ms)`);
  const localVa = MPC.generateVAProofs(
    params.digest,
    MPC.sign(params.digest, localCombined.oShare, round2.dShare, undefined, false)
  );
  const round3 = await peerRequest(state, peer, "/peer/sign/round3", {
    sessionId, vaCommitment: localVa.comDecomVA.commitment,
  });
  assert(commitmentsEqual(round3.vaShare?.comDecomVA?.commitment, round2.vaCommitment),
    "peer changed VA after commitment");
  const localUt = MPC.verifyVAShares(localVa, [round3.vaShare]);
  const round4 = await peerRequest(state, peer, "/peer/sign/round4", { sessionId, vaShare: localVa });
  assert(isCommitment(round4.utCommitment), "peer returned an invalid UT commitment");
  const round5 = await peerRequest(state, peer, "/peer/sign/round5", {
    sessionId, utCommitment: localUt.comDecomUT.commitment, utShare: localUt,
  });
  assert(commitmentsEqual(round5.utShare?.comDecomUT?.commitment, round4.utCommitment),
    "peer changed UT after commitment");
  const localSignatureShare = MPC.verifyUTShares(localUt, [round5.utShare]);
  const signature = MPC.constructSignature([localSignatureShare, round5.signatureShare]);
  const serialized = verifyThresholdSignature(params.digest, signature, wallet.address);
  log("DEBUG", `sign ${sessionId}: signature constructed and verified (rounds ${Date.now() - roundsStartedAt} ms, total ${Date.now() - signingStartedAt} ms)`);
  return {
    signature: serialized,
    recoveredAddress: ethers.recoverAddress(`0x${params.digest.toString("hex")}`, serialized),
    signerNodeIds: [state.config.node.id, peer.id],
  };
}

async function coordinateSignature(state, params) {
  let lastError;
  for (const peer of state.config.peers) {
    try { return await coordinateSignatureWithPeer(state, peer, params); }
    catch (error) {
      lastError = error;
      log("WARN", `signer ${peer.id} failed: ${error.message}`);
      if (!shouldTryNextSigner(error)) throw error;
      log("WARN", `signer ${peer.id} is unavailable; trying the next configured signer`);
    }
  }
  throw new Error(`no second signer completed the protocol: ${lastError?.message || "unknown error"}`);
}

async function createWallet(state, walletKey, memberUserIds) {
  const startedAt = Date.now();
  if (state.db.wallets[walletKey]?.verified === true) {
    log("DEBUG", "existing wallet found; ensuring signing parameters are precomputed on all nodes");
    const prepared = await Promise.all([
      precomputeWalletChallenge(state, walletKey),
      ...state.config.peers.map((peer) => peerRequest(
        state,
        peer,
        "/peer/create/precompute",
        { walletKey },
        CRYPTO_SETUP_TIMEOUT_MS
      )),
    ]);
    return {
      ...state.db.wallets[walletKey],
      setupTiming: {
        totalMs: Date.now() - startedAt,
        existingWallet: true,
        nodes: prepared.map((item) => item.precomputation),
      },
    };
  }
  const existingSession = Object.values(state.db.dkg).find((session) => session.walletKey === walletKey);
  const roundId = existingSession?.roundId || randomId(24);
  await Promise.all([
    initializeDkg(state, { roundId, walletKey, memberUserIds }),
    ...state.config.peers.map((peer) => peerRequest(state, peer, "/peer/create/init", {
      roundId, walletKey, memberUserIds,
    }, CRYPTO_SETUP_TIMEOUT_MS)),
  ]);
  const results = await Promise.all([
    Promise.resolve(completeDkg(state, { roundId, walletKey })),
    ...state.config.peers.map((peer) => peerRequest(
      state,
      peer,
      "/peer/create/complete",
      { roundId, walletKey },
      CRYPTO_SETUP_TIMEOUT_MS
    )),
  ]);
  const addresses = new Set(results.map((item) => item.address.toLowerCase()));
  const publicKeys = new Set(results.map((item) => item.publicKey));
  assert(addresses.size === 1 && publicKeys.size === 1, "DKG nodes derived different public keys");
  const vssEncodings = new Set(results.map((item) => stringifyWire(item.vss)));
  assert(vssEncodings.size === 1, "DKG nodes observed different VSS transcripts");
  const proofs = {};
  for (let offset = 0; offset < results.length; offset += 1) {
    const index = offset === 0 ? state.config.node.index_fix : state.config.peers[offset - 1].index_fix;
    proofs[String(index)] = results[offset].schnorrProofX;
  }
  const verificationPayload = { walletKey, proofs, vss: results[0].vss };
  const verified = await Promise.all([
    Promise.resolve(verifyDkgTranscript(state, verificationPayload)),
    ...state.config.peers.map((peer) => peerRequest(
      state,
      peer,
      "/peer/create/verify",
      verificationPayload,
      CRYPTO_SETUP_TIMEOUT_MS
    )),
  ]);
  return {
    ...state.db.wallets[walletKey],
    setupTiming: {
      totalMs: Date.now() - startedAt,
      existingWallet: false,
      nodes: verified.map((item) => item.precomputation),
    },
  };
}

async function healthStatus(state) {
  const rows = await Promise.all(state.config.peers.map(async (peer) => {
    const started = Date.now();
    try {
      const response = await peerRequest(state, peer, "/peer/health", {}, 5000);
      return `${peer.id}: online (${Date.now() - started} ms, ${response.walletCount} wallets)`;
    } catch (error) {
      return `${peer.id}: offline (${error.message})`;
    }
  }));
  return [
    `self: ${state.config.node.id} / index ${state.config.node.index_fix}`,
    `wallets: ${Object.keys(state.db.wallets).length}`,
    `uptime: ${Math.floor((Date.now() - state.startedAt) / 1000)} sec`,
    ...rows,
  ].join("\n");
}

function installActions(state) {
  state.pendingApprovals = new Map();
  state.actions = {
    create: (walletKey, members) => createWallet(state, walletKey, members),
    getWallet: (walletKey) => getWallet(state, walletKey),
    walletsForUser: (userId) => walletsForUser(state, userId),
    balance: (address) => getBalance(state, address),
    tokenBalance: (tokenAddress, ownerAddress) => getErc20Balance(state, tokenAddress, ownerAddress),
    tokenBalances: (tokenAddress, ownerAddresses) => getErc20Balances(state, tokenAddress, ownerAddresses),
    account: async (address) => ({
      nonce: await state.provider.getTransactionCount(address, "pending"),
      balance: await getBalance(state, address),
    }),
    status: () => healthStatus(state),
    resolveApproval: (userId, approve) => resolveApproval(state, userId, approve),
    sign: (params) => coordinateSignature(state, params),
    send: async (params) => {
      const wallet = getWallet(state, params.walletKey);
      assert(wallet, "wallet does not exist; run /create first");
      const { tx, digest, sendAll, sourceBalanceWei, maximumNetworkFeeWei } = await buildUnsignedTransaction(
        state, wallet, params.to, params.valueWei, params.maxFeePerGasGwei
      );
      const signed = await coordinateSignature(state, {
        walletKey: params.walletKey,
        digest,
        requesterId: params.requesterId,
        approverIds: params.approverIds,
        description: [
          sendAll
            ? `Ethereum send-all transfer ${tx.value} wei to ${ethers.getAddress(params.to)} from pending balance ${sourceBalanceWei} wei`
            : `Ethereum transfer ${tx.value} wei to ${ethers.getAddress(params.to)}`,
          `chainId ${tx.chainId}; nonce ${tx.nonce}`,
          `maximum network fee ${maximumNetworkFeeWei} wei`,
          ...(sendAll ? ["unused EIP-1559 maximum-fee reserve may remain after mining"] : []),
          `unsigned tx ${tx.unsignedHash}`,
        ].join("; "),
      });
      const raw = finalizeTransaction(tx, signed.signature);
      return broadcastTransaction(state, raw);
    },
    tokenSend: async (params) => {
      const wallet = getWallet(state, params.walletKey);
      assert(wallet, "wallet does not exist; run /create first");
      const { tx, digest, token } = await buildUnsignedErc20Transfer(
        state,
        wallet,
        params.tokenAddress,
        params.to,
        params.amount,
        params.maxFeePerGasGwei
      );
      const signed = await coordinateSignature(state, {
        walletKey: params.walletKey,
        digest,
        requesterId: params.requesterId,
        approverIds: params.approverIds,
        description: [
          `ERC-20 transfer ${token.amount} ${token.symbol} (${token.amountRaw} base units)`,
          `token ${token.address}; recipient ${token.recipient}`,
          `chainId ${tx.chainId}; nonce ${tx.nonce}`,
          `maximum network fee ${tx.gasLimit * tx.maxFeePerGas} wei`,
          `unsigned tx ${tx.unsignedHash}`,
        ].join("; "),
      });
      const raw = finalizeTransaction(tx, signed.signature);
      return { ...(await broadcastTransaction(state, raw)), token };
    },
  };
}

async function routePeerRequest(state, req, payload, sourcePeer) {
  const route = new URL(req.url, "http://peer").pathname;
  if (route === "/peer/health") return {
    nodeId: state.config.node.id,
    index: state.config.node.index_fix,
    walletCount: Object.keys(state.db.wallets).length,
  };
  if (route === "/peer/create/init") return initializeDkg(state, payload);
  if (route === "/peer/create/share") {
    assert(payload.fromIndex === sourcePeer.index_fix, "DKG sender index mismatch");
    queueInboundShare(state, payload.roundId, payload.fromIndex, payload.share);
    return { accepted: true };
  }
  if (route === "/peer/create/complete") return completeDkg(state, payload);
  if (route === "/peer/create/verify") return verifyDkgTranscript(state, payload);
  if (route === "/peer/create/precompute") return precomputeWalletChallenge(state, payload.walletKey);
  if (route === "/peer/sign/init") return peerSignInit(state, payload, sourcePeer);
  if (route === "/peer/sign/round1") return peerSignRound1(state, payload, sourcePeer);
  if (route === "/peer/sign/round2") return peerSignRound2(state, payload, sourcePeer);
  if (route === "/peer/sign/round3") return peerSignRound3(state, payload, sourcePeer);
  if (route === "/peer/sign/round4") return peerSignRound4(state, payload, sourcePeer);
  if (route === "/peer/sign/round5") return peerSignRound5(state, payload, sourcePeer);
  throw Object.assign(new Error("not found"), { statusCode: 404 });
}

function createPeerServer(state) {
  const handler = async (req, res) => {
    const startedAt = Date.now();
    try {
      if (req.method !== "POST") throw Object.assign(new Error("method not allowed"), { statusCode: 405 });
      const rawBody = await readRequestBody(req);
      const sourcePeer = identifyPeerRequest(state, req);
      const route = new URL(req.url, "http://peer").pathname;
      log("DEBUG", `peer request received: ${sourcePeer.id} ${route}`);
      const payload = rawBody ? parseWire(rawBody) : {};
      const result = await routePeerRequest(state, req, payload, sourcePeer);
      log("DEBUG", `peer request handled: ${sourcePeer.id} ${route} (${Date.now() - startedAt} ms)`);
      jsonResponse(res, 200, { ok: true, result });
    } catch (error) {
      log("WARN", `peer request failed: ${error.message}`);
      if (!res.headersSent) jsonResponse(res, error.statusCode || 400, {
        ok: false,
        error: error.message,
        code: error.code,
      });
      else res.destroy();
    }
  };
  const tls = state.config.http.tls;
  return tls.certPem && tls.keyPem
    ? https.createServer({ cert: tls.certPem, key: tls.keyPem, ca: tls.clientCaPem, minVersion: "TLSv1.2" }, handler)
    : http.createServer(handler);
}

function cleanupSessions(state) {
  const cutoff = Date.now() - (state.config.runtime?.roundTtlMs || SESSION_TTL_MS);
  for (const [id, session] of state.signSessions) {
    if (session.createdAt < cutoff) state.signSessions.delete(id);
  }
}

async function start(configPath) {
  const config = loadConfig(configPath);
  const state = createState(config);
  installActions(state);
  const server = createPeerServer(state);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.http.port, config.http.listenHost || "127.0.0.1", resolve);
  });
  log("INFO", `${config.node.id} peer server listening on ${config.http.listenHost || "127.0.0.1"}:${config.http.port}`);
  await loadBotIdentity(state);
  await sendGroupEvent(state, `${config.node.id}: online; Ethereum 2-of-3 threshold ECDSA ready`);
  await sendHelp(state);
  const cleanup = setInterval(
    () => cleanupSessions(state),
    Math.min(state.config.runtime?.healthcheckIntervalMs || 60_000, 60_000)
  );
  cleanup.unref();
  const stop = async () => {
    if (state.stopping) return;
    state.stopping = true;
    clearInterval(cleanup);
    for (const pending of state.pendingApprovals.values()) pending.reject();
    await new Promise((resolve) => server.close(resolve));
  };
  process.once("SIGINT", () => stop().finally(() => process.exit(0)));
  process.once("SIGTERM", () => stop().finally(() => process.exit(0)));
  await pollTelegram(state);
}

if (require.main === module) {
  const configPath = process.argv[2];
  if (!configPath) {
    console.error("Usage: node three-headed-bot.js <node.config.json>");
    process.exit(2);
  }
  start(configPath).catch((error) => {
    log("FATAL", error.stack || error.message);
    process.exit(1);
  });
}

module.exports = {
  commitmentsEqual,
  coordinateSignature,
  createPeerServer,
  createWallet,
  installActions,
  routePeerRequest,
  shouldTryNextSigner,
  start,
};

"use strict";

const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const https = require("https");
const path = require("path");
const { URL } = require("url");
const { ethers } = require("ethers");
const BitGoEcdsa = require("@bitgo/sdk-core/dist/src/account-lib/mpc/tss/ecdsa/ecdsa").default;
const {
  EcdsaPaillierProof,
  EcdsaRangeProof,
  EcdsaTypes,
  hexToBigInt,
} = require("@bitgo/sdk-lib-mpc");

const PROTOCOL = "tg-threshold-eth";
const ETHEREUM_MAINNET_USDT = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
const MAX_BODY_BYTES = 16 * 1024 * 1024;
const MPC = new BitGoEcdsa();
const ERC20_INTERFACE = new ethers.Interface([
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function transfer(address to, uint256 amount) returns (bool)",
]);
const MAX_UINT256 = (1n << 256n) - 1n;
const LOG_LEVELS = Object.freeze({ DEBUG: 10, INFO: 20, WARN: 30, ERROR: 40, FATAL: 50 });
let activeLogLevel = LOG_LEVELS.INFO;

function setLogLevel(level = "info") {
  const normalized = String(level).toUpperCase();
  assert(Object.hasOwn(LOG_LEVELS, normalized),
    `runtime.logLevel must be one of: ${Object.keys(LOG_LEVELS).map((name) => name.toLowerCase()).join(", ")}`);
  activeLogLevel = LOG_LEVELS[normalized];
}

function log(level, message, extra) {
  const normalized = String(level).toUpperCase();
  const severity = LOG_LEVELS[normalized] ?? LOG_LEVELS.INFO;
  if (severity < activeLogLevel) return;
  const prefix = `[${new Date().toISOString()}] [${normalized}]`;
  if (extra === undefined) console.log(prefix, message);
  else console.log(prefix, message, extra);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function randomId(bytes = 24) {
  return crypto.randomBytes(bytes).toString("hex");
}

function walletKeyForUsers(userIds) {
  const ids = userIds.map((id) => String(id)).sort((a, b) =>
    BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0
  );
  return ids.length === 1 ? `user:${ids[0]}` : `group:${ids.join("-")}`;
}

function pack(value) {
  if (typeof value === "bigint") return { __banknodeType: "bigint", value: value.toString(16) };
  if (Buffer.isBuffer(value)) return { __banknodeType: "buffer", value: value.toString("base64") };
  if (Array.isArray(value)) return value.map(pack);
  if (value && typeof value === "object") {
    const result = {};
    for (const [key, child] of Object.entries(value)) result[key] = pack(child);
    return result;
  }
  return value;
}

function unpack(value) {
  if (Array.isArray(value)) return value.map(unpack);
  if (value && typeof value === "object") {
    if (value.__banknodeType === "bigint") return BigInt(`0x${value.value || "0"}`);
    if (value.__banknodeType === "buffer") return Buffer.from(value.value, "base64");
    if (value.type === "Buffer" && Array.isArray(value.data)) return Buffer.from(value.data);
    const result = {};
    for (const [key, child] of Object.entries(value)) result[key] = unpack(child);
    return result;
  }
  return value;
}

function stringifyWire(value) {
  return JSON.stringify(pack(value));
}

function parseWire(text) {
  return unpack(JSON.parse(text));
}

function readPem(value, configDir) {
  if (!value) return undefined;
  if (value.includes("-----BEGIN")) return value;
  return fs.readFileSync(path.resolve(configDir, value), "utf8");
}

function loadConfig(configFile) {
  const fullPath = path.resolve(configFile);
  const configDir = path.dirname(fullPath);
  const config = JSON.parse(fs.readFileSync(fullPath, "utf8"));
  if (config.telegram?.allowedGroupId !== undefined) config.telegram.allowedGroupId = Number(config.telegram.allowedGroupId);
  if (config.ethereum?.chainId !== undefined) config.ethereum.chainId = Number(config.ethereum.chainId);
  if (config.http?.port !== undefined) config.http.port = Number(config.http.port);
  assert(config.protocol_fix === PROTOCOL, `protocol_fix must be ${PROTOCOL}`);
  assert(config.version === "v1", "version must be v1");
  assert(Number.isInteger(config.node?.index_fix) && config.node.index_fix >= 1 && config.node.index_fix <= 3,
    "node.index_fix must be 1, 2, or 3");
  assert(config.node?.id, "node.id is required");
  assert(typeof config.crypto?.masterSeed_fix === "string" &&
    Buffer.byteLength(config.crypto.masterSeed_fix, "utf8") >= 32,
    "crypto.masterSeed_fix must contain at least 32 bytes of secret material");
  assert(Array.isArray(config.peers) && config.peers.length === 2, "exactly two peers are required");
  const indexes = new Set([config.node.index_fix]);
  for (const peer of config.peers) {
    assert(peer.id && Number.isInteger(peer.index_fix), "each peer needs id and index_fix");
    if (!peer.url) {
      assert(peer.ip && Number.isInteger(Number(peer.port)), `peer ${peer.id} needs ip and port`);
      const peerProtocol = peer.protocol || (config.http?.tls?.certPem && config.http?.tls?.keyPem ? "https" : "http");
      peer.url = `${peerProtocol}://${peer.ip}:${Number(peer.port)}`;
    }
    indexes.add(peer.index_fix);
  }
  assert(indexes.size === 3 && [...indexes].every((i) => i >= 1 && i <= 3), "peer indexes must complete 1,2,3");
  config.__file = fullPath;
  config.__dir = configDir;
  config.http.tls = config.http.tls || {};
  config.http.tls.certPem = readPem(config.http.tls.certPem, configDir);
  config.http.tls.keyPem = readPem(config.http.tls.keyPem, configDir);
  const environment = config.runtime?.environment || "development";
  assert(environment === "development" || environment === "production",
    "runtime.environment must be development or production");
  if (environment === "production") {
    assert(config.http.tls.certPem && config.http.tls.keyPem, "TLS is mandatory in production");
    assert(config.peers.every((p) => new URL(p.url).protocol === "https:"), "all peers must use HTTPS in production");
  }
  setLogLevel(config.runtime?.logLevel || "info");
  return config;
}

function databasePath(config) {
  const configured = config.storage?.dbPath || config.storage?.file || `./data/${config.node.id}.db`;
  return path.resolve(config.__dir, configured);
}

function loadDatabase(config) {
  const file = databasePath(config);
  if (!fs.existsSync(file)) return { version: 1, wallets: {}, dkg: {} };
  const db = parseWire(fs.readFileSync(file, "utf8"));
  assert(db.version === 1 && db.wallets && db.dkg, "unsupported or damaged database");
  return db;
}

function saveDatabase(state) {
  const file = state.databaseFile;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${randomId(6)}.tmp`;
  fs.writeFileSync(temp, `${stringifyWire(state.db)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  fs.renameSync(temp, file);
  try { fs.chmodSync(file, 0o600); } catch (_) { /* Windows ACLs are configured externally. */ }
}

function createState(config) {
  const db = loadDatabase(config);
  return {
    config,
    databaseFile: databasePath(config),
    db,
    dkgInbox: new Map(),
    signSessions: new Map(),
    ntildeJobs: new WeakMap(),
    verifiedPeerNtilde: new Map(),
    telegramOffset: 0,
    telegramBotUsername: null,
    startedAt: Date.now(),
    provider: createEthereumProvider(config),
  };
}

function createEthereumProvider(config) {
  const configured = config.ethereum?.rpcUrl
    ? [{ id: "legacy-rpc", kind: "json-rpc", baseUrl: config.ethereum.rpcUrl }]
    : config.ethereum?.providers;
  if (!Array.isArray(configured) || configured.length === 0) return null;
  const urls = new Set();
  const providers = configured.map((entry, index) => {
    assert(entry?.kind === "json-rpc", `ethereum.providers[${index}].kind must be json-rpc`);
    assert(typeof entry.baseUrl === "string", `ethereum.providers[${index}].baseUrl is required`);
    const url = new URL(entry.baseUrl);
    assert(url.protocol === "https:" ||
      (config.runtime?.environment !== "production" && url.protocol === "http:"),
    `ethereum provider ${entry.id || index} must use HTTPS`);
    assert(!urls.has(url.href), `duplicate Ethereum provider URL: ${url.href}`);
    urls.add(url.href);
    return {
      provider: new ethers.JsonRpcProvider(url.href, config.ethereum.chainId),
      priority: Number(entry.priority || index + 1),
      stallTimeout: Number(entry.stallTimeoutMs || 1000),
      weight: 1,
    };
  });
  if (providers.length === 1) return providers[0].provider;
  return new ethers.FallbackProvider(providers, config.ethereum.chainId, { quorum: 1 });
}

function deterministicDkgSeed(state, walletKey) {
  return crypto
    .createHmac("sha512", Buffer.from(state.config.crypto.masterSeed_fix, "utf8"))
    .update(`${PROTOCOL}\0v1\0${state.config.node.index_fix}\0${walletKey}`, "utf8")
    .digest();
}

function publicKeyToAddress(compressedPublicKey) {
  return ethers.computeAddress(`0x${compressedPublicKey}`);
}

function getPeerById(state, id) {
  return state.config.peers.find((peer) => peer.id === id);
}

function getPeerByIndex(state, index) {
  return state.config.peers.find((peer) => peer.index_fix === index);
}

function peerHeaders(state, body) {
  return {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
    "x-banknode-protocol": PROTOCOL,
    "x-banknode-node": state.config.node.id,
  };
}

function shouldRejectPeerCertificate(config) {
  return config.runtime?.environment === "production";
}

function identifyPeerRequest(state, req) {
  const protocol = req.headers["x-banknode-protocol"];
  const nodeId = req.headers["x-banknode-node"];
  assert(protocol === PROTOCOL, "protocol mismatch");
  const peer = getPeerById(state, nodeId);
  assert(peer, "unknown peer");
  return peer;
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("request body too large"));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function peerRequest(state, peer, requestPath, payload, timeoutMs = 180_000) {
  const startedAt = Date.now();
  log("DEBUG", `peer request started: ${peer.id} ${requestPath}`);
  const url = new URL(requestPath, peer.url);
  const body = stringifyWire(payload);
  const transport = url.protocol === "https:" ? https : http;
  const headers = peerHeaders(state, body);
  const options = {
    protocol: url.protocol,
    hostname: url.hostname,
    port: url.port || undefined,
    path: `${url.pathname}${url.search}`,
    method: "POST",
    headers,
    timeout: timeoutMs,
  };
  if (url.protocol === "https:") {
    options.servername = peer.servername || url.hostname;
    options.rejectUnauthorized = shouldRejectPeerCertificate(state.config);
  }
  return new Promise((resolve, reject) => {
    const req = transport.request(options, (res) => {
      const chunks = [];
      let size = 0;
      res.on("data", (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) req.destroy(new Error("peer response too large"));
        else chunks.push(chunk);
      });
      res.on("end", () => {
        let decoded;
        try { decoded = parseWire(Buffer.concat(chunks).toString("utf8") || "{}"); }
        catch (error) {
          return reject(Object.assign(
            new Error(`invalid response from ${peer.id}: ${error.message}`),
            { code: "PEER_INVALID_RESPONSE", peerId: peer.id }
          ));
        }
        if (res.statusCode < 200 || res.statusCode >= 300 || decoded.ok === false) {
          return reject(Object.assign(
            new Error(decoded.error || `${peer.id} returned HTTP ${res.statusCode}`),
            {
              code: decoded.code || "PEER_RESPONSE_ERROR",
              peerId: peer.id,
              statusCode: res.statusCode,
            }
          ));
        }
        log("DEBUG", `peer request completed: ${peer.id} ${requestPath} (${Date.now() - startedAt} ms)`);
        resolve(decoded.result);
      });
    });
    req.on("timeout", () => req.destroy(Object.assign(
      new Error(`peer ${peer.id} timeout`),
      { code: "PEER_TIMEOUT", peerId: peer.id }
    )));
    req.on("error", reject);
    req.end(body);
  });
}

async function requestJson(url, options = {}, payload) {
  const response = await fetch(url, {
    ...options,
    body: payload === undefined ? options.body : JSON.stringify(payload),
    signal: AbortSignal.timeout(options.timeoutMs || 30_000),
  });
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch (_) { body = text; }
  return { statusCode: response.status, body, headers: response.headers };
}

function queueInboundShare(state, roundId, fromIndex, share) {
  if (!state.dkgInbox.has(roundId)) state.dkgInbox.set(roundId, new Map());
  const inbox = state.dkgInbox.get(roundId);
  const previous = inbox.get(fromIndex);
  if (previous) assert(stringifyWire(previous) === stringifyWire(share), "conflicting DKG share");
  inbox.set(fromIndex, share);
  const session = state.db.dkg[roundId];
  if (session) {
    session.inbound[String(fromIndex)] = share;
    saveDatabase(state);
  }
}

async function initializeDkg(state, { roundId, walletKey, memberUserIds }) {
  assert(typeof roundId === "string" && /^[0-9a-f]{48}$/.test(roundId), "invalid roundId");
  assert(typeof walletKey === "string" && walletKey.length <= 256, "invalid walletKey");
  assert(Array.isArray(memberUserIds) && (memberUserIds.length === 1 || memberUserIds.length === 3),
    "a wallet must have one or three Telegram members");
  assert(walletKeyForUsers(memberUserIds) === walletKey, "walletKey does not match memberUserIds");
  if (state.db.wallets[walletKey]?.verified === true) {
    return { existing: true, address: state.db.wallets[walletKey].address };
  }
  let session = state.db.dkg[roundId];
  if (!session) {
    const keyShare = await MPC.keyShare(
      state.config.node.index_fix,
      2,
      3,
      deterministicDkgSeed(state, walletKey)
    );
    session = {
      roundId,
      walletKey,
      memberUserIds: memberUserIds.map(String),
      createdAt: Date.now(),
      keyShare,
      inbound: {},
    };
    const queued = state.dkgInbox.get(roundId);
    if (queued) for (const [from, share] of queued) session.inbound[String(from)] = share;
    state.db.dkg[roundId] = session;
    saveDatabase(state);
  }
  assert(session.walletKey === walletKey, "roundId already belongs to another wallet");
  const deliveries = [];
  for (const [targetIndex, share] of Object.entries(session.keyShare.nShares)) {
    const peer = getPeerByIndex(state, Number(targetIndex));
    assert(peer, `no peer for DKG target ${targetIndex}`);
    deliveries.push(peerRequest(state, peer, "/peer/create/share", {
      roundId, walletKey, fromIndex: state.config.node.index_fix, share,
    }));
  }
  await Promise.all(deliveries);
  return { existing: false, readyShares: Object.keys(session.inbound).length };
}

function completeDkg(state, { roundId, walletKey }) {
  if (state.db.wallets[walletKey]) {
    const wallet = state.db.wallets[walletKey];
    return {
      address: wallet.address,
      publicKey: wallet.publicKey,
      schnorrProofX: wallet.schnorrProofX,
      vss: wallet.vss,
      verified: wallet.verified,
    };
  }
  const session = state.db.dkg[roundId];
  assert(session && session.walletKey === walletKey, "unknown DKG round");
  const inbound = Object.values(session.inbound);
  assert(inbound.length === 2, `waiting for DKG shares (${inbound.length}/2)`);
  const combined = MPC.keyCombine(session.keyShare.pShare, inbound);
  const ownVssShare = Object.values(session.keyShare.nShares)[0];
  assert(ownVssShare?.v, "own DKG contribution has no VSS commitment");
  const vss = { [state.config.node.index_fix]: ownVssShare.v };
  for (const share of inbound) {
    assert(share.j && share.v, "incoming DKG contribution has no source/VSS commitment");
    vss[String(share.j)] = share.v;
  }
  assert(Object.keys(vss).length === 3, "incomplete VSS transcript");
  const wallet = {
    walletKey,
    memberUserIds: session.memberUserIds,
    createdAt: Date.now(),
    publicKey: combined.xShare.y,
    address: publicKeyToAddress(combined.xShare.y),
    xShare: combined.xShare,
    yShares: combined.yShares,
    schnorrProofX: combined.xShare.schnorrProofX,
    vss,
    verified: false,
  };
  state.db.wallets[walletKey] = wallet;
  saveDatabase(state);
  return {
    address: wallet.address,
    publicKey: wallet.publicKey,
    schnorrProofX: wallet.schnorrProofX,
    vss: wallet.vss,
    verified: wallet.verified,
  };
}

async function verifyDkgTranscript(state, { walletKey, proofs, vss }) {
  const wallet = state.db.wallets[walletKey];
  assert(wallet, "wallet does not exist");
  assert(proofs && vss, "missing DKG verification transcript");
  const transcript = [1, 2, 3].map((index) => {
    assert(typeof vss[String(index)] === "string", `missing VSS commitment for participant ${index}`);
    return [hexToBigInt(vss[String(index)])];
  });
  const publicKey = hexToBigInt(wallet.publicKey);
  for (const index of [1, 2, 3]) {
    const proof = proofs[String(index)];
    assert(proof, `missing Schnorr proof for participant ${index}`);
    assert(MPC.verifySchnorrProofX(publicKey, transcript, index, proof),
      `invalid Schnorr proof for participant ${index}`);
  }
  assert(stringifyWire(wallet.vss) === stringifyWire(vss), "local VSS transcript differs from coordinator transcript");
  log("DEBUG", "DKG verified; preparing reusable threshold signing parameters");
  const precomputation = await prepareWalletNtilde(state, wallet);
  wallet.verified = true;
  for (const [roundId, session] of Object.entries(state.db.dkg)) {
    if (session.walletKey === walletKey) delete state.db.dkg[roundId];
  }
  saveDatabase(state);
  return { verified: true, address: wallet.address, precomputation };
}

async function prepareWalletNtilde(state, wallet) {
  const generated = !wallet.ecdsaAuxiliaryNtilde;
  const startedAt = Date.now();
  await getOrCreateNtildeChallenge(state, wallet);
  return {
    nodeId: state.config.node.id,
    generated,
    durationMs: Date.now() - startedAt,
  };
}

async function precomputeWalletChallenge(state, walletKey) {
  const wallet = state.db.wallets[walletKey];
  assert(wallet, "wallet does not exist");
  assert(wallet.verified === true, "wallet DKG transcript is not fully verified");
  const precomputation = await prepareWalletNtilde(state, wallet);
  return { prepared: true, address: wallet.address, precomputation };
}

async function verifyNtildeChallenge(serialized) {
  assert(serialized && typeof serialized === "object", "missing Ntilde challenge");
  let challenge;
  try {
    challenge = EcdsaTypes.deserializeNtildeWithProofs(serialized);
  } catch (error) {
    throw new Error(`invalid Ntilde challenge encoding: ${error.message}`);
  }
  assert(challenge.ntilde.toString(2).length >= 3072, "Ntilde modulus must be at least 3072 bits");
  const [forward, reverse] = await Promise.all([
    EcdsaRangeProof.verifyNtildeProof({
      ntilde: challenge.ntilde,
      h1: challenge.h1,
      h2: challenge.h2,
    }, challenge.ntildeProof.h1WrtH2),
    EcdsaRangeProof.verifyNtildeProof({
      ntilde: challenge.ntilde,
      h1: challenge.h2,
      h2: challenge.h1,
    }, challenge.ntildeProof.h2WrtH1),
  ]);
  assert(forward && reverse, "Ntilde discrete-log proof verification failed");
  return true;
}

async function getOrCreateNtildeChallenge(state, wallet) {
  state.ntildeJobs ||= new WeakMap();
  const running = state.ntildeJobs.get(wallet);
  if (running) return running;
  const job = (async () => {
    if (wallet.ecdsaAuxiliaryNtilde) {
      const startedAt = Date.now();
      log("DEBUG", "threshold challenge: validating cached 3072-bit Ntilde");
      await verifyNtildeChallenge(wallet.ecdsaAuxiliaryNtilde);
      log("DEBUG", `threshold challenge: cached Ntilde validated (${Date.now() - startedAt} ms)`);
      return wallet.ecdsaAuxiliaryNtilde;
    }
    const startedAt = Date.now();
    log("DEBUG", "threshold challenge: generating one-time 3072-bit Ntilde for this wallet");
    const ntilde = await EcdsaRangeProof.generateNtilde(3072);
    const serialized = EcdsaTypes.serializeNtildeWithProofs(ntilde);
    wallet.ecdsaAuxiliaryNtilde = serialized;
    saveDatabase(state);
    log("DEBUG", `threshold challenge: wallet Ntilde generated and persisted (${Date.now() - startedAt} ms)`);
    return serialized;
  })();
  state.ntildeJobs.set(wallet, job);
  try {
    return await job;
  } catch (error) {
    state.ntildeJobs.delete(wallet);
    throw error;
  }
}

async function verifyPeerNtildeChallenge(state, peerId, serialized) {
  state.verifiedPeerNtilde ||= new Map();
  assert(serialized && typeof serialized === "object", `missing Ntilde challenge from ${peerId}`);
  const fingerprint = crypto.createHash("sha256").update(stringifyWire(serialized)).digest("hex");
  const known = state.verifiedPeerNtilde.get(peerId);
  if (known?.has(fingerprint)) {
    log("DEBUG", `threshold challenge: previously verified Ntilde reused for ${peerId}`);
    return true;
  }
  const startedAt = Date.now();
  log("DEBUG", `threshold challenge: verifying Ntilde proof from ${peerId}`);
  await verifyNtildeChallenge(serialized);
  if (known) known.add(fingerprint);
  else state.verifiedPeerNtilde.set(peerId, new Set([fingerprint]));
  log("DEBUG", `threshold challenge: Ntilde proof from ${peerId} verified (${Date.now() - startedAt} ms)`);
  return true;
}

async function makeChallenge(state, wallet, counterpartyIndex) {
  const yShare = wallet.yShares[String(counterpartyIndex)] || wallet.yShares[counterpartyIndex];
  assert(yShare, `wallet has no yShare for participant ${counterpartyIndex}`);
  const startedAt = Date.now();
  const ntilde = await getOrCreateNtildeChallenge(state, wallet);
  log("DEBUG", `threshold challenge: Ntilde ready (${Date.now() - startedAt} ms); generating fresh Paillier challenge`);
  const paillierStartedAt = Date.now();
  const p = await EcdsaPaillierProof.generateP(hexToBigInt(yShare.n));
  log("DEBUG", `threshold challenge: fresh Paillier challenge generated (${Date.now() - paillierStartedAt} ms, total ${Date.now() - startedAt} ms)`);
  return {
    ntilde,
    paillier: EcdsaTypes.serializePaillierChallenge({ p }),
  };
}

function prepareSigner(wallet, counterpartyIndex, ownChallenge, peerChallenge) {
  const yShare = wallet.yShares[String(counterpartyIndex)] || wallet.yShares[counterpartyIndex];
  assert(yShare, `missing yShare for ${counterpartyIndex}`);
  return {
    xShare: MPC.appendChallenge(wallet.xShare, ownChallenge.ntilde, ownChallenge.paillier),
    yShare: MPC.appendChallenge(yShare, peerChallenge.ntilde, peerChallenge.paillier),
  };
}

function signatureToHex(signature) {
  return ethers.Signature.from({
    r: `0x${signature.r.padStart(64, "0")}`,
    s: `0x${signature.s.padStart(64, "0")}`,
    yParity: signature.recid,
  }).serialized;
}

function verifyThresholdSignature(digest, signature, expectedAddress) {
  assert(Buffer.isBuffer(digest) && digest.length === 32, "digest must be 32 bytes");
  assert(MPC.verify(digest, signature, undefined, false), "BitGo MPC signature verification failed");
  const serialized = signatureToHex(signature);
  const recovered = ethers.recoverAddress(`0x${digest.toString("hex")}`, serialized);
  assert(recovered.toLowerCase() === expectedAddress.toLowerCase(), "recovered Ethereum address mismatch");
  return serialized;
}

async function getBalance(state, address) {
  assert(state.provider, "ethereum.rpcUrl is not configured");
  const balance = await state.provider.getBalance(address);
  return { wei: balance.toString(), ether: ethers.formatEther(balance) };
}

function parseTokenAmount(value, decimals) {
  const text = String(value);
  assert(Number.isInteger(decimals) && decimals >= 0 && decimals <= 255, "invalid ERC-20 decimals");
  assert(text.length > 0 && text.length <= 200 && /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(text),
    "token amount must be a positive decimal number without exponent notation");
  const [whole, fraction = ""] = text.split(".");
  assert(fraction.length <= decimals, `token amount has more than ${decimals} decimal places`);
  const units = BigInt(whole) * (10n ** BigInt(decimals)) +
    BigInt((fraction + "0".repeat(decimals)).slice(0, decimals) || "0");
  assert(units > 0n, "token amount must be positive");
  assert(units <= MAX_UINT256, "token amount exceeds uint256");
  return units;
}

function formatTokenAmount(value, decimals) {
  const units = BigInt(value);
  if (decimals === 0) return units.toString();
  const digits = units.toString().padStart(decimals + 1, "0");
  const whole = digits.slice(0, -decimals);
  const fraction = digits.slice(-decimals).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

async function callErc20(state, tokenAddress, method, args = [], from) {
  const data = ERC20_INTERFACE.encodeFunctionData(method, args);
  const request = { to: tokenAddress, data };
  if (from) request.from = from;
  const result = await state.provider.call(request);
  return { data, raw: result, decoded: ERC20_INTERFACE.decodeFunctionResult(method, result) };
}

async function getErc20Metadata(state, tokenAddress) {
  assert(state.provider, "ethereum RPC is not configured");
  assert(ethers.isAddress(tokenAddress), "invalid ERC-20 contract address");
  const address = ethers.getAddress(tokenAddress);
  const code = await state.provider.getCode(address);
  assert(code && code !== "0x", "ERC-20 address has no contract code");
  let decimals;
  try {
    decimals = Number((await callErc20(state, address, "decimals")).decoded[0]);
  } catch (error) {
    throw new Error(`contract does not expose valid ERC-20 decimals(): ${error.message}`);
  }
  assert(Number.isInteger(decimals) && decimals >= 0 && decimals <= 255, "invalid ERC-20 decimals");
  let symbol = "ERC20";
  try {
    const candidate = String((await callErc20(state, address, "symbol")).decoded[0])
      .replace(/[\u0000-\u001f\u007f]/g, "")
      .trim();
    if (candidate && /^[A-Za-z0-9._-]{1,32}$/.test(candidate)) symbol = candidate;
  } catch (_) { /* symbol() is optional metadata and is not trusted for transaction construction. */ }
  return { address, decimals, symbol };
}

async function getErc20Balances(state, tokenAddress, ownerAddresses) {
  assert(Array.isArray(ownerAddresses) && ownerAddresses.length > 0,
    "at least one ERC-20 owner address is required");
  const owners = ownerAddresses.map((ownerAddress) => {
    assert(ethers.isAddress(ownerAddress), "invalid ERC-20 owner address");
    return ethers.getAddress(ownerAddress);
  });
  const token = await getErc20Metadata(state, tokenAddress);
  return Promise.all(owners.map(async (owner) => {
    let rawBalance;
    try {
      rawBalance = BigInt((await callErc20(state, token.address, "balanceOf", [owner])).decoded[0]);
    } catch (error) {
      throw new Error(`contract does not expose valid ERC-20 balanceOf(): ${error.message}`);
    }
    return {
      tokenAddress: token.address,
      owner,
      symbol: token.symbol,
      decimals: token.decimals,
      raw: rawBalance.toString(),
      formatted: formatTokenAmount(rawBalance, token.decimals),
    };
  }));
}

async function getErc20Balance(state, tokenAddress, ownerAddress) {
  const [balance] = await getErc20Balances(state, tokenAddress, [ownerAddress]);
  return balance;
}

async function buildEip1559Transaction(state, wallet, {
  to,
  value,
  data,
  maxFeePerGasGwei,
  sendAll = false,
}) {
  assert(state.provider, "ethereum.rpcUrl is not configured");
  assert(ethers.isAddress(to), "invalid Ethereum destination address");
  assert(typeof data === "string" && ethers.isHexString(data), "transaction data must be hex");
  const valueWei = BigInt(value);
  assert(valueWei >= 0n, "transaction value cannot be negative");
  const rpcStartedAt = Date.now();
  log("DEBUG", "Ethereum RPC: fetching pending nonce, balance, network and fee data");
  const [nonce, balance, network, feeData] = await Promise.all([
    state.provider.getTransactionCount(wallet.address, "pending"),
    state.provider.getBalance(wallet.address, "pending"),
    state.provider.getNetwork(),
    state.provider.getFeeData(),
  ]);
  log("DEBUG", `Ethereum RPC: nonce, balance, network and fee data received (${Date.now() - rpcStartedAt} ms)`);
  if (state.config.ethereum?.chainId !== undefined) {
    assert(network.chainId === BigInt(state.config.ethereum.chainId),
      `RPC chainId ${network.chainId} does not match configured chainId ${state.config.ethereum.chainId}`);
  }
  const maxFeePerGas = maxFeePerGasGwei
    ? ethers.parseUnits(String(maxFeePerGasGwei), "gwei")
    : feeData.maxFeePerGas;
  assert(maxFeePerGas && maxFeePerGas > 0n, "provider did not return a positive maxFeePerGas");
  const maxPriorityFeePerGas = feeData.maxPriorityFeePerGas || ethers.parseUnits("1", "gwei");
  const draft = {
    type: 2,
    chainId: network.chainId,
    nonce,
    to: ethers.getAddress(to),
    value: valueWei,
    data,
    maxFeePerGas,
    maxPriorityFeePerGas: maxPriorityFeePerGas > maxFeePerGas ? maxFeePerGas : maxPriorityFeePerGas,
  };
  const estimateStartedAt = Date.now();
  if (sendAll) {
    assert(valueWei === 0n, "send-all requires a zero value placeholder");
    assert(balance > 0n, "insufficient balance for send-all: account balance is zero");
    log("DEBUG", "Ethereum RPC: estimating send-all transaction gas");

    // The destination may be a contract whose gas usage depends on msg.value.
    // Probe with half the balance, then converge on value = balance - maximum fee.
    draft.value = balance / 2n;
    let gasLimit = BigInt(await state.provider.estimateGas({ ...draft, from: wallet.address }));
    let stabilized = false;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const maximumNetworkFee = gasLimit * maxFeePerGas;
      assert(balance > maximumNetworkFee,
        `insufficient balance for send-all: maximum network fee ${maximumNetworkFee} wei, have ${balance} wei`);
      draft.value = balance - maximumNetworkFee;
      const refinedGasLimit = BigInt(await state.provider.estimateGas({ ...draft, from: wallet.address }));
      if (refinedGasLimit === gasLimit) {
        draft.gasLimit = gasLimit;
        stabilized = true;
        break;
      }
      gasLimit = refinedGasLimit;
    }
    assert(stabilized,
      "send-all gas estimation did not stabilize; specify an explicit amount_wei");
  } else {
    log("DEBUG", "Ethereum RPC: estimating transaction gas");
    draft.gasLimit = BigInt(await state.provider.estimateGas({ ...draft, from: wallet.address }));
  }
  log("DEBUG", `Ethereum RPC: gas estimated (${Date.now() - estimateStartedAt} ms)`);
  const maximumNetworkFee = draft.gasLimit * maxFeePerGas;
  const maximumCost = draft.value + maximumNetworkFee;
  assert(balance >= maximumCost,
    `insufficient balance: need at most ${maximumCost} wei, have ${balance} wei`);
  const tx = ethers.Transaction.from(draft);
  return {
    tx,
    digest: Buffer.from(tx.unsignedHash.slice(2), "hex"),
    sendAll: Boolean(sendAll),
    sourceBalanceWei: balance.toString(),
    maximumNetworkFeeWei: maximumNetworkFee.toString(),
  };
}

async function buildUnsignedTransaction(state, wallet, to, valueWei, maxFeePerGasGwei) {
  const value = BigInt(valueWei);
  assert(value >= 0n, "valueWei must be non-negative");
  return buildEip1559Transaction(state, wallet, {
    to,
    value,
    data: "0x",
    maxFeePerGasGwei,
    sendAll: value === 0n,
  });
}

async function buildUnsignedErc20Transfer(state, wallet, tokenAddress, recipientAddress, amount, maxFeePerGasGwei) {
  assert(ethers.isAddress(recipientAddress), "invalid ERC-20 recipient address");
  const recipient = ethers.getAddress(recipientAddress);
  assert(recipient !== ethers.ZeroAddress, "ERC-20 recipient cannot be the zero address");
  const tokenStartedAt = Date.now();
  log("DEBUG", "Ethereum RPC: loading ERC-20 metadata and balance");
  const balance = await getErc20Balance(state, tokenAddress, wallet.address);
  log("DEBUG", `Ethereum RPC: ERC-20 metadata and balance received (${Date.now() - tokenStartedAt} ms)`);
  const amountRaw = parseTokenAmount(amount, balance.decimals);
  assert(BigInt(balance.raw) >= amountRaw,
    `insufficient ${balance.symbol} balance: need ${amountRaw}, have ${balance.raw} base units`);
  const data = ERC20_INTERFACE.encodeFunctionData("transfer", [recipient, amountRaw]);
  try {
    const simulationStartedAt = Date.now();
    log("DEBUG", "Ethereum RPC: simulating ERC-20 transfer with eth_call");
    const result = await state.provider.call({
      from: wallet.address,
      to: balance.tokenAddress,
      value: 0n,
      data,
    });
    if (result !== "0x") {
      const returned = ERC20_INTERFACE.decodeFunctionResult("transfer", result)[0];
      assert(returned === true, "ERC-20 transfer simulation returned false");
    }
    log("DEBUG", `Ethereum RPC: ERC-20 transfer simulation completed (${Date.now() - simulationStartedAt} ms)`);
  } catch (error) {
    throw new Error(`ERC-20 transfer simulation failed: ${error.message}`);
  }
  const unsigned = await buildEip1559Transaction(state, wallet, {
    to: balance.tokenAddress,
    value: 0n,
    data,
    maxFeePerGasGwei,
  });
  return {
    ...unsigned,
    token: {
      address: balance.tokenAddress,
      symbol: balance.symbol,
      decimals: balance.decimals,
      amount: formatTokenAmount(amountRaw, balance.decimals),
      amountRaw: amountRaw.toString(),
      recipient,
    },
  };
}

function finalizeTransaction(tx, serializedSignature) {
  tx.signature = ethers.Signature.from(serializedSignature);
  return tx.serialized;
}

async function broadcastTransaction(state, rawTransaction) {
  assert(state.provider, "ethereum.rpcUrl is not configured");
  const startedAt = Date.now();
  log("DEBUG", "Ethereum RPC: broadcasting signed transaction");
  const response = await state.provider.broadcastTransaction(rawTransaction);
  log("DEBUG", `Ethereum RPC: transaction accepted (${Date.now() - startedAt} ms, hash ${response.hash})`);
  return { hash: response.hash, rawTransaction };
}

module.exports = {
  PROTOCOL,
  ETHEREUM_MAINNET_USDT,
  MPC,
  assert,
  identifyPeerRequest,
  broadcastTransaction,
  buildEip1559Transaction,
  buildUnsignedErc20Transfer,
  buildUnsignedTransaction,
  completeDkg,
  createState,
  deterministicDkgSeed,
  finalizeTransaction,
  formatTokenAmount,
  getBalance,
  getErc20Balance,
  getErc20Balances,
  getErc20Metadata,
  initializeDkg,
  loadConfig,
  log,
  makeChallenge,
  pack,
  parseTokenAmount,
  parseWire,
  peerRequest,
  prepareSigner,
  precomputeWalletChallenge,
  publicKeyToAddress,
  queueInboundShare,
  randomId,
  readRequestBody,
  requestJson,
  saveDatabase,
  setLogLevel,
  shouldRejectPeerCertificate,
  signatureToHex,
  stringifyWire,
  unpack,
  verifyThresholdSignature,
  verifyDkgTranscript,
  verifyNtildeChallenge,
  verifyPeerNtildeChallenge,
  walletKeyForUsers,
};

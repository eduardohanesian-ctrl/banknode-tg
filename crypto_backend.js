const fs = require("fs");
const path = require("path");
const https = require("https");
const crypto = require("crypto");
const { URL } = require("url");
const bitcoin = require("bitcoinjs-lib");
const ecc = require("tiny-secp256k1");
const { secp256k1, schnorr } = require("@noble/curves/secp256k1");

bitcoin.initEccLib(ecc);

const { ProjectivePoint: Point, CURVE } = secp256k1;
const CURVE_ORDER = CURVE.n;
const BTC_NETWORK = bitcoin.networks.bitcoin;
const BTC_DUST_LIMIT = 330;

function log(level, message, extra = null) {
  const timestamp = new Date().toISOString();
  if (extra === null) {
    console.log(`[${timestamp}] [${level}] ${message}`);
    return;
  }

  console.log(`[${timestamp}] [${level}] ${message}`, extra);
}

function fail(message) {
  throw new Error(message);
}

function readJson(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  return JSON.parse(raw);
}

function mod(value, modulus = CURVE_ORDER) {
  const result = value % modulus;
  return result >= 0n ? result : result + modulus;
}

function bytesToBigInt(bytes) {
  return BigInt(`0x${Buffer.from(bytes).toString("hex")}`);
}

function hexToBigInt(hex) {
  return BigInt(`0x${hex}`);
}

function bigIntToHex(value, byteLength = 32) {
  return value.toString(16).padStart(byteLength * 2, "0");
}

function hashToScalar(parts) {
  const hash = crypto.createHash("sha256");
  for (const part of parts) {
    hash.update(part);
  }
  const scalar = mod(bytesToBigInt(hash.digest()));
  if (scalar === 0n) {
    return 1n;
  }

  return scalar;
}

function pointToHex(point) {
  return Buffer.from(point.toRawBytes(true)).toString("hex");
}

function pointToBytes(point) {
  return Buffer.from(point.toRawBytes(true));
}

function pointHasEvenY(point) {
  return point.toAffine().y % 2n === 0n;
}

function negateScalar(value) {
  return mod(-value);
}

function getXOnlyHexFromCompressedPubkey(pubkeyHex) {
  return pubkeyHex.slice(2);
}

function taggedHash(tag, ...messages) {
  const tagHash = crypto.createHash("sha256").update(Buffer.from(tag, "utf8")).digest();
  const hash = crypto.createHash("sha256");
  hash.update(tagHash);
  hash.update(tagHash);
  for (const message of messages) {
    hash.update(message);
  }
  return hash.digest();
}

function polymod(values) {
  const generators = [
    0x3b6a57b2n,
    0x26508e6dn,
    0x1ea119fan,
    0x3d4233ddn,
    0x2a1462b3n,
  ];

  let checksum = 1n;
  for (const value of values) {
    const top = checksum >> 25n;
    checksum = ((checksum & 0x1ffffffn) << 5n) ^ BigInt(value);
    for (let i = 0; i < generators.length; i += 1) {
      if ((top >> BigInt(i)) & 1n) {
        checksum ^= generators[i];
      }
    }
  }

  return checksum;
}

function bech32HrpExpand(hrp) {
  const values = [];

  for (let i = 0; i < hrp.length; i += 1) {
    values.push(hrp.charCodeAt(i) >> 5);
  }

  values.push(0);

  for (let i = 0; i < hrp.length; i += 1) {
    values.push(hrp.charCodeAt(i) & 31);
  }

  return values;
}

function convertBits(data, fromBits, toBits, pad = true) {
  let acc = 0;
  let bits = 0;
  const result = [];
  const maxValue = (1 << toBits) - 1;

  for (const value of data) {
    if (value < 0 || value >> fromBits) {
      throw new Error("Invalid value while converting bits");
    }

    acc = (acc << fromBits) | value;
    bits += fromBits;

    while (bits >= toBits) {
      bits -= toBits;
      result.push((acc >> bits) & maxValue);
    }
  }

  if (pad) {
    if (bits > 0) {
      result.push((acc << (toBits - bits)) & maxValue);
    }
  } else if (bits >= fromBits || ((acc << (toBits - bits)) & maxValue)) {
    throw new Error("Invalid padding while converting bits");
  }

  return result;
}

function encodeBech32m(hrp, data) {
  const charset = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
  const values = [...bech32HrpExpand(hrp), ...data, 0, 0, 0, 0, 0, 0];
  const checksum = polymod(values) ^ 0x2bc830a3n;
  const checksumValues = [];

  for (let i = 0; i < 6; i += 1) {
    checksumValues.push(Number((checksum >> BigInt(5 * (5 - i))) & 31n));
  }

  const combined = [...data, ...checksumValues];
  return `${hrp}1${combined.map((value) => charset[value]).join("")}`;
}

function getBitcoinMainnetTaprootAddress(groupPublicKey) {
  const compressedHex = pointToHex(groupPublicKey);
  const xOnlyHex = getXOnlyHexFromCompressedPubkey(compressedHex);
  const witnessProgram = Buffer.from(xOnlyHex, "hex");
  const words = [1, ...convertBits([...witnessProgram], 8, 5, true)];
  return encodeBech32m("bc", words);
}

function reverseHex(hex) {
  return Buffer.from(hex, "hex").reverse();
}

function isValidBitcoinAddress(address) {
  try {
    bitcoin.address.toOutputScript(address, BTC_NETWORK);
    return true;
  } catch (error) {
    return false;
  }
}

function buildTaprootSpendCandidate({ utxos, recipientAddress, changeAddress, amountSats, feeRate }) {
  const recipientScript = bitcoin.address.toOutputScript(recipientAddress, BTC_NETWORK);
  const changeScript = bitcoin.address.toOutputScript(changeAddress, BTC_NETWORK);
  const prevOutScripts = utxos.map(() => changeScript);
  const inputValues = utxos.map((utxo) => BigInt(utxo.value));

  function buildTx(changeSats) {
    const tx = new bitcoin.Transaction();
    tx.version = 2;
    for (let i = 0; i < utxos.length; i += 1) {
      const utxo = utxos[i];
      tx.addInput(reverseHex(utxo.txid), utxo.vout, bitcoin.Transaction.DEFAULT_SEQUENCE);
    }
    tx.addOutput(recipientScript, BigInt(amountSats));
    if (changeSats !== null) {
      tx.addOutput(changeScript, BigInt(changeSats));
    }
    for (let i = 0; i < utxos.length; i += 1) {
      tx.setWitness(i, [Buffer.alloc(64)]);
    }
    return tx;
  }

  const totalInputSats = utxos.reduce((sum, utxo) => sum + utxo.value, 0);
  const twoOutputDummy = buildTx(0);
  const twoOutputFee = feeRate * twoOutputDummy.virtualSize();
  const tentativeChange = totalInputSats - amountSats - twoOutputFee;

  if (tentativeChange >= BTC_DUST_LIMIT) {
    const tx = buildTx(tentativeChange);
    const feeSats = feeRate * tx.virtualSize();
    const changeSats = totalInputSats - amountSats - feeSats;
    if (changeSats >= BTC_DUST_LIMIT) {
      tx.outs[1].value = BigInt(changeSats);
      const sighashHexes = utxos.map((_, index) =>
        Buffer.from(
          tx.hashForWitnessV1(index, prevOutScripts, inputValues, bitcoin.Transaction.SIGHASH_DEFAULT)
        ).toString("hex")
      );
      return {
        utxos,
        tx,
        feeSats,
        changeSats,
        sighashHexes,
      };
    }
  }

  const oneOutputTx = buildTx(null);
  const oneOutputFee = feeRate * oneOutputTx.virtualSize();
  if (totalInputSats < amountSats + oneOutputFee) {
    return null;
  }

  const sighashHexes = utxos.map((_, index) =>
    Buffer.from(
      oneOutputTx.hashForWitnessV1(index, prevOutScripts, inputValues, bitcoin.Transaction.SIGHASH_DEFAULT)
    ).toString("hex")
  );
  return {
    utxos,
    tx: oneOutputTx,
    feeSats: oneOutputFee,
    changeSats: 0,
    sighashHexes,
  };
}

function buildTaprootSendAllCandidate({ utxos, recipientAddress, sourceAddress, feeRate }) {
  const recipientScript = bitcoin.address.toOutputScript(recipientAddress, BTC_NETWORK);
  const prevOutScript = bitcoin.address.toOutputScript(sourceAddress, BTC_NETWORK);
  const prevOutScripts = utxos.map(() => prevOutScript);
  const inputValues = utxos.map((utxo) => BigInt(utxo.value));

  const tx = new bitcoin.Transaction();
  tx.version = 2;
  for (let i = 0; i < utxos.length; i += 1) {
    const utxo = utxos[i];
    tx.addInput(reverseHex(utxo.txid), utxo.vout, bitcoin.Transaction.DEFAULT_SEQUENCE);
  }

  const totalInputSats = utxos.reduce((sum, utxo) => sum + utxo.value, 0);
  tx.addOutput(recipientScript, BigInt(totalInputSats));
  for (let i = 0; i < utxos.length; i += 1) {
    tx.setWitness(i, [Buffer.alloc(64)]);
  }

  const feeSats = feeRate * tx.virtualSize();
  const sendAmountSats = totalInputSats - feeSats;
  if (sendAmountSats < BTC_DUST_LIMIT) {
    return null;
  }

  tx.outs[0].value = BigInt(sendAmountSats);
  const sighashHexes = utxos.map((_, index) =>
    Buffer.from(
      tx.hashForWitnessV1(index, prevOutScripts, inputValues, bitcoin.Transaction.SIGHASH_DEFAULT)
    ).toString("hex")
  );

  return {
    utxos,
    tx,
    feeSats,
    changeSats: 0,
    sendAmountSats,
    sighashHexes,
  };
}

function selectTaprootSpendCandidate(utxos, amountSats, feeRate, changeAddress, recipientAddress) {
  const sorted = [...utxos].sort((a, b) => a.value - b.value);
  let selected = [];

  for (const utxo of sorted) {
    selected = [...selected, utxo];
    const candidate = buildTaprootSpendCandidate({
      utxos: selected,
      recipientAddress,
      changeAddress,
      amountSats,
      feeRate,
    });
    if (candidate) {
      return candidate;
    }
  }

  return null;
}

function finalizeTaprootTransaction(candidate, signatureHexes) {
  const tx = candidate.tx.clone();
  for (let i = 0; i < signatureHexes.length; i += 1) {
    tx.setWitness(i, [Buffer.from(signatureHexes[i], "hex")]);
  }
  return {
    txHex: tx.toHex(),
    txid: tx.getId(),
    vsize: tx.virtualSize(),
  };
}

function buildCreateContext(protocolFix, telegramUserId) {
  return `${protocolFix}:user:${telegramUserId}`;
}

function buildGroupKey(userIds) {
  return [...userIds].map((value) => String(value)).sort((a, b) => Number(a) - Number(b)).join("-");
}

function buildGroupCreateContext(protocolFix, userIds) {
  return `${protocolFix}:group:${buildGroupKey(userIds)}`;
}

function buildKeyId(context) {
  return crypto.createHash("sha256").update(`key-id:${context}`).digest("hex");
}

function buildRoundId(nodeId, keyId) {
  return crypto
    .createHash("sha256")
    .update(`${nodeId}:${keyId}:${Date.now()}:${crypto.randomBytes(8).toString("hex")}`)
    .digest("hex")
    .slice(0, 24);
}

function getLocalPolynomial(config, context) {
  const seed = Buffer.from(config.crypto.masterSeed_fix, "utf8");
  return [
    hashToScalar([seed, Buffer.from(context), Buffer.from("coef:0")]),
    hashToScalar([seed, Buffer.from(context), Buffer.from("coef:1")]),
  ];
}

function evaluatePolynomial(coefficients, x) {
  let power = 1n;
  let result = 0n;

  for (const coefficient of coefficients) {
    result = mod(result + coefficient * power);
    power = mod(power * x);
  }

  return result;
}

function getLocalContribution(config, context) {
  const coefficients = getLocalPolynomial(config, context);
  const commitments = coefficients.map((coefficient) => pointToHex(Point.BASE.multiply(coefficient)));
  const shares = new Map();
  const allIndexes = [config.node.index_fix, ...config.peers.map((peer) => peer.index_fix)];

  for (const index of allIndexes) {
    shares.set(index, evaluatePolynomial(coefficients, BigInt(index)));
  }

  return {
    coefficients,
    commitments,
    shares,
  };
}

function verifyShare(senderCommitments, targetIndex, shareHex) {
  const share = hexToBigInt(shareHex);
  const left = Point.BASE.multiply(share);
  const c0 = Point.fromHex(senderCommitments[0]);
  const c1 = Point.fromHex(senderCommitments[1]);
  const right = c0.add(c1.multiply(BigInt(targetIndex)));
  return left.equals(right);
}

function computeGroupPublicKey(commitmentsByNode) {
  const points = Object.values(commitmentsByNode).map((commitments) => Point.fromHex(commitments[0]));
  return points.reduce((sum, point) => sum.add(point), Point.ZERO);
}

function invert(value, modulus = CURVE_ORDER) {
  let a = mod(value, modulus);
  let b = modulus;
  let x0 = 1n;
  let x1 = 0n;

  while (b !== 0n) {
    const q = a / b;
    [a, b] = [b, a % b];
    [x0, x1] = [x1, x0 - q * x1];
  }

  if (a !== 1n) {
    throw new Error("Inverse does not exist");
  }

  return mod(x0, modulus);
}

function lagrangeCoefficient(participantId, signingSet) {
  let numerator = 1n;
  let denominator = 1n;

  for (const otherId of signingSet) {
    if (otherId === participantId) {
      continue;
    }

    numerator = mod(numerator * otherId);
    denominator = mod(denominator * (otherId - participantId));
  }

  return mod(numerator * invert(denominator));
}

function getAllNodeDescriptors(config) {
  return [
    {
      index_fix: config.node.index_fix,
      id: config.node.id,
      ip: "127.0.0.1",
      port: config.http.port,
      isSelf: true,
    },
    ...config.peers.map((peer) => ({ ...peer, isSelf: false })),
  ].sort((a, b) => a.index_fix - b.index_fix);
}

function getPeerById(config, nodeId) {
  return config.peers.find((peer) => peer.id === nodeId) || null;
}

function loadStorage(storagePath) {
  if (!fs.existsSync(storagePath)) {
    return { users: {}, groups: {} };
  }

  try {
    return readJson(storagePath);
  } catch (error) {
    log("WARN", `Failed to read storage ${storagePath}: ${error.message}`);
    return { users: {}, groups: {} };
  }
}

function saveStorage(storagePath, storage) {
  fs.writeFileSync(storagePath, JSON.stringify(storage, null, 2) + "\n", "utf8");
}

function persistUserRecord(state, userId, record) {
  const storage = loadStorage(state.storagePath);
  storage.users = storage.users || {};
  storage.users[String(userId)] = record;
  storage.groups = storage.groups || {};
  saveStorage(state.storagePath, storage);
}

function getStoredUserRecord(state, userId) {
  const storage = loadStorage(state.storagePath);
  return storage.users?.[String(userId)] || null;
}

function persistGroupRecord(state, groupKey, record) {
  const storage = loadStorage(state.storagePath);
  storage.users = storage.users || {};
  storage.groups = storage.groups || {};
  storage.groups[String(groupKey)] = record;
  saveStorage(state.storagePath, storage);
}

function getStoredGroupRecord(state, groupKey) {
  const storage = loadStorage(state.storagePath);
  return storage.groups?.[String(groupKey)] || null;
}

function getStoredRecordByTarget(state, target) {
  if (!target || typeof target !== "object") {
    return null;
  }

  if (target.kind === "group") {
    return getStoredGroupRecord(state, target.groupKey);
  }

  return getStoredUserRecord(state, target.userId);
}

function listGroupRecordsForUser(state, userId) {
  const storage = loadStorage(state.storagePath);
  const groups = Object.values(storage.groups || {});
  return groups.filter((record) => Array.isArray(record.memberUserIds) && record.memberUserIds.includes(String(userId)));
}

function buildMessageHashHex(messageText) {
  return crypto.createHash("sha256").update(Buffer.from(messageText, "utf8")).digest("hex");
}

function isHex32Byte(value) {
  return typeof value === "string" && /^[0-9a-fA-F]{64}$/.test(value);
}

function deriveNonceScalar(finalShareSecretHex, keyId, messageHashHex, nodeId) {
  return hashToScalar([
    Buffer.from("sign-nonce:v1"),
    Buffer.from(finalShareSecretHex, "hex"),
    Buffer.from(keyId, "utf8"),
    Buffer.from(messageHashHex, "hex"),
    Buffer.from(nodeId, "utf8"),
  ]);
}

function createSignRound(state, { roundId, keyId, telegramUserId, messageText, messageHashHex, coordinatorNodeId, signingNodeIds, chatId = null, silentTelegramResult = false, requireApproval = false, approvalRequest = null, storageTarget = null, approvalAllowedUserIds = null, activeRoundOwnerKey = null }) {
  const effectiveStorageTarget = storageTarget || { kind: "user", userId: String(telegramUserId) };
  const record = getStoredRecordByTarget(state, effectiveStorageTarget);
  if (!record) {
    throw new Error(`No stored share for target ${JSON.stringify(effectiveStorageTarget)}`);
  }

  const nonce = deriveNonceScalar(record.finalShareSecretHex, keyId, messageHashHex, state.config.node.id);
  const nonceCommitment = Point.BASE.multiply(nonce);
  const round = {
    roundType: "SIGN",
    roundId,
    keyId,
    telegramUserId: String(telegramUserId),
    messageText,
    messageHashHex,
    coordinatorNodeId,
    signingNodeIds: [...signingNodeIds],
    chatId,
    storageTarget: effectiveStorageTarget,
    activeRoundOwnerKey,
    record,
    local: {
      finalShareSecretHex: record.finalShareSecretHex,
      finalSharePublic: record.finalSharePublic,
      nonce,
      nonceCommitmentHex: pointToHex(nonceCommitment),
    },
    requireApproval,
    approved: requireApproval !== true,
    approvalRequested: false,
    approvalRequest,
    approvalAllowedUserIds: Array.isArray(approvalAllowedUserIds)
      ? approvalAllowedUserIds.map((value) => String(value))
      : [String(telegramUserId)],
    commitmentsByNode: {
      [state.config.node.id]: pointToHex(nonceCommitment),
    },
    partialsByNode: {},
    finalized: false,
    announcedToTelegram: false,
    silentTelegramResult,
    createdAt: Date.now(),
    expiresAt: Date.now() + (Number(state.config.runtime.roundTtlMs) || 60000),
    aborted: false,
    abortReason: null,
  };

  state.rounds.set(roundId, round);
  return round;
}

function buildChallenge(groupCommitment, groupPublicKeyHex, messageHashHex) {
  const rXOnly = Buffer.from(getXOnlyHexFromCompressedPubkey(pointToHex(groupCommitment)), "hex");
  const pXOnly = Buffer.from(getXOnlyHexFromCompressedPubkey(groupPublicKeyHex), "hex");
  const challengeBytes = taggedHash(
    "BIP0340/challenge",
    rXOnly,
    pXOnly,
    Buffer.from(messageHashHex, "hex")
  );
  return mod(bytesToBigInt(challengeBytes));
}

function tryBuildSignPackage(state, round) {
  for (const nodeId of round.signingNodeIds) {
    if (!round.commitmentsByNode[nodeId]) {
      return null;
    }
  }

  const groupCommitment = round.signingNodeIds
    .map((nodeId) => Point.fromHex(round.commitmentsByNode[nodeId]))
    .reduce((sum, point) => sum.add(point), Point.ZERO);
  const record = round.record || getStoredRecordByTarget(state, round.storageTarget || { kind: "user", userId: round.telegramUserId });
  if (!record) {
    return null;
  }

  const challenge = buildChallenge(groupCommitment, record.groupPublicKey, round.messageHashHex);
  return {
    groupCommitmentHex: pointToHex(groupCommitment),
    challengeHex: bigIntToHex(challenge),
    negateNonce: !pointHasEvenY(groupCommitment),
  };
}

function createLocalPartialSignature(state, round, signPackage) {
  const record = round.record || getStoredRecordByTarget(state, round.storageTarget || { kind: "user", userId: round.telegramUserId });
  if (!record) {
    throw new Error(`No stored share for user ${round.telegramUserId}`);
  }

  const signingSet = round.signingNodeIds.map((nodeId) => {
    if (nodeId === state.config.node.id) {
      return BigInt(state.config.node.index_fix);
    }
    const peer = getPeerById(state.config, nodeId);
    if (!peer) {
      throw new Error(`Unknown peer ${nodeId}`);
    }
    return BigInt(peer.index_fix);
  });
  const participantId = BigInt(state.config.node.index_fix);
  const lambda = lagrangeCoefficient(participantId, signingSet);
  const challenge = hexToBigInt(signPackage.challengeHex);
  const effectiveNonce =
    signPackage.negateNonce === true ? negateScalar(round.local.nonce) : round.local.nonce;
  const z = mod(
    effectiveNonce + challenge * lambda * hexToBigInt(record.finalShareSecretHex)
  );

  return {
    participantId: state.config.node.id,
    partialSignatureHex: bigIntToHex(z),
  };
}

function verifyLocalPartial(state, round, partialPayload, signPackage) {
  const signerNodeId = partialPayload.fromNodeId || partialPayload.participantId;
  const record = round.record || getStoredRecordByTarget(state, round.storageTarget || { kind: "user", userId: round.telegramUserId });
  if (!record) {
    return false;
  }

  const signerIndex =
    signerNodeId === state.config.node.id
      ? state.config.node.index_fix
      : getPeerById(state.config, signerNodeId)?.index_fix;
  if (!signerIndex) {
    return false;
  }

  const signingSet = round.signingNodeIds.map((nodeId) => {
    if (nodeId === state.config.node.id) {
      return BigInt(state.config.node.index_fix);
    }
    return BigInt(getPeerById(state.config, nodeId).index_fix);
  });
  const lambda = lagrangeCoefficient(BigInt(signerIndex), signingSet);
  const challenge = hexToBigInt(signPackage.challengeHex);
  const left = Point.BASE.multiply(hexToBigInt(partialPayload.partialSignatureHex));
  const rawCommitment = Point.fromHex(round.commitmentsByNode[signerNodeId]);
  const commitment = signPackage.negateNonce === true ? rawCommitment.negate() : rawCommitment;
  const publicShare = Point.fromHex(
    signerNodeId === state.config.node.id
      ? record.finalSharePublic
      : partialPayload.finalSharePublic
  );
  const right = commitment.add(publicShare.multiply(mod(challenge * lambda)));
  return left.equals(right);
}

function tryFinalizeSignRound(state, round, signPackage) {
  if (round.finalized) {
    return round.result || null;
  }

  for (const nodeId of round.signingNodeIds) {
    if (!round.partialsByNode[nodeId]) {
      return null;
    }
  }

  const record = round.record || getStoredRecordByTarget(state, round.storageTarget || { kind: "user", userId: round.telegramUserId });
  if (!record) {
    return null;
  }

  let z = 0n;
  for (const nodeId of round.signingNodeIds) {
    z = mod(z + hexToBigInt(round.partialsByNode[nodeId].partialSignatureHex));
  }

  const rawGroupCommitment = Point.fromHex(signPackage.groupCommitmentHex);
  const effectiveGroupCommitment =
    signPackage.negateNonce === true ? rawGroupCommitment.negate() : rawGroupCommitment;
  const challenge = hexToBigInt(signPackage.challengeHex);
  const left = Point.BASE.multiply(z);
  const right = effectiveGroupCommitment.add(
    Point.fromHex(record.groupPublicKey).multiply(challenge)
  );
  const aggregateVerified = left.equals(right);
  const signatureHex =
    getXOnlyHexFromCompressedPubkey(pointToHex(effectiveGroupCommitment)) + bigIntToHex(z);
  let bip340Verified = false;
  try {
    bip340Verified = schnorr.verify(
      signatureHex,
      Buffer.from(round.messageHashHex, "hex"),
      record.groupPublicKeyXOnly
    );
  } catch (error) {
    bip340Verified = false;
  }

  const result = {
    keyId: round.keyId,
    userId: round.telegramUserId,
    messageText: round.messageText,
    messageHashHex: round.messageHashHex,
    signingSet: [...round.signingNodeIds],
    groupPublicKey: record.groupPublicKey,
    groupPublicKeyXOnly: record.groupPublicKeyXOnly,
    bitcoinAddress: record.bitcoinAddress,
    signatureHex,
    signature: {
      r: getXOnlyHexFromCompressedPubkey(pointToHex(effectiveGroupCommitment)),
      s: bigIntToHex(z),
    },
    aggregateVerified,
    bip340Verified,
  };

  round.finalized = true;
  round.result = result;
  releaseActiveRound(state, round);
  return result;
}

function sanitizePublicRoundReason(reason) {
  if (typeof reason !== "string" || !reason.trim()) {
    return "internal error";
  }

  if (reason.includes("transport error")) {
    return "peer unavailable";
  }

  return reason;
}

function normalizeBaseUrl(value) {
  if (typeof value !== "string" || !value.trim()) {
    fail("bitcoin provider baseUrl must be a non-empty string");
  }

  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function shuffleArray(values) {
  const copy = [...values];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function buildBitcoinProviderUrl(provider, pathName) {
  return `${normalizeBaseUrl(provider.baseUrl)}${pathName}`;
}

function chooseBitcoinProviders(config, count = 2) {
  const providers = Array.isArray(config.bitcoin?.providers) ? config.bitcoin.providers : [];
  if (providers.length < count) {
    fail(`config.bitcoin.providers must contain at least ${count} providers`);
  }

  return shuffleArray(providers).slice(0, count);
}

async function requestText(url, options = {}, body = null) {
  return new Promise((resolve, reject) => {
    const urlObject = new URL(url);
    const requestOptions = {
      protocol: urlObject.protocol,
      hostname: urlObject.hostname,
      port: urlObject.port,
      path: `${urlObject.pathname}${urlObject.search}`,
      method: options.method || "GET",
      headers: options.headers || {},
      rejectUnauthorized: false,
    };

    const req = https.request(requestOptions, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        resolve({
          statusCode: res.statusCode || 0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        });
      });
    });

    req.on("error", reject);

    if (body !== null) {
      req.write(body);
    }

    req.end();
  });
}

async function esploraGetJson(provider, pathName) {
  const response = await requestJson(buildBitcoinProviderUrl(provider, pathName));
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(`Esplora ${provider.id} GET ${pathName} failed with ${response.statusCode}`);
  }
  return response.body;
}

async function esploraGetText(provider, pathName) {
  const response = await requestText(buildBitcoinProviderUrl(provider, pathName));
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(`Esplora ${provider.id} GET ${pathName} failed with ${response.statusCode}`);
  }
  return response.body;
}

async function esploraPostText(provider, pathName, bodyText) {
  const response = await requestText(
    buildBitcoinProviderUrl(provider, pathName),
    {
      method: "POST",
      headers: {
        "Content-Type": "text/plain",
      },
    },
    bodyText
  );
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(`Esplora ${provider.id} POST ${pathName} failed with ${response.statusCode}`);
  }
  return response.body;
}

function getBitcoinProviderById(config, providerId) {
  return config.bitcoin.providers.find((provider) => provider.id === providerId) || null;
}

async function getAddressUtxosFromProvider(provider, address) {
  if (provider.kind !== "esplora") {
    throw new Error(`Unsupported provider kind: ${provider.kind}`);
  }

  return esploraGetJson(provider, `/address/${address}/utxo`);
}

async function getTxHexFromProvider(provider, txid) {
  if (provider.kind !== "esplora") {
    throw new Error(`Unsupported provider kind: ${provider.kind}`);
  }

  return esploraGetText(provider, `/tx/${txid}/hex`);
}

async function getTxFromProvider(provider, txid) {
  if (provider.kind !== "esplora") {
    throw new Error(`Unsupported provider kind: ${provider.kind}`);
  }

  return esploraGetJson(provider, `/tx/${txid}`);
}

async function broadcastTxWithProvider(provider, txHex) {
  if (provider.kind !== "esplora") {
    throw new Error(`Unsupported provider kind: ${provider.kind}`);
  }

  return esploraPostText(provider, "/tx", txHex);
}

function validateConfig(config) {
  if (!config || typeof config !== "object") {
    fail("Config must be a JSON object");
  }

  if (config.protocol_fix !== "tg-threshold-btc") {
    fail("config.protocol_fix must be 'tg-threshold-btc'");
  }

  if (config.version !== "v1") {
    fail("config.version must be 'v1'");
  }

  if (!config.node || !Number.isInteger(config.node.index_fix)) {
    fail("config.node.index_fix must be an integer");
  }

  if (!config.node.id || typeof config.node.id !== "string") {
    fail("config.node.id must be a non-empty string");
  }

  if (!config.telegram || typeof config.telegram.botToken !== "string") {
    fail("config.telegram.botToken must be a string");
  }

  if (!config.telegram.botToken.trim() || config.telegram.botToken.includes("REPLACE_")) {
    fail("config.telegram.botToken must be replaced with a real Telegram bot token");
  }

  if (!Number.isInteger(config.telegram.allowedGroupId)) {
    fail("config.telegram.allowedGroupId must be an integer");
  }

  if (!config.crypto || typeof config.crypto.masterSeed_fix !== "string") {
    fail("config.crypto.masterSeed_fix must be a string");
  }

  if (!config.crypto.masterSeed_fix.trim() || config.crypto.masterSeed_fix.includes("REPLACE_")) {
    fail("config.crypto.masterSeed_fix must be replaced with a real master seed");
  }

  if (!config.http || typeof config.http.listenHost !== "string") {
    fail("config.http.listenHost must be a string");
  }

  if (!Number.isInteger(config.http.port) || config.http.port <= 0) {
    fail("config.http.port must be a positive integer");
  }

  if (
    !config.http.tls ||
    typeof config.http.tls.certPem !== "string" ||
    typeof config.http.tls.keyPem !== "string"
  ) {
    fail("config.http.tls.certPem and config.http.tls.keyPem are required");
  }

  if (!Array.isArray(config.peers) || config.peers.length !== 2) {
    fail("config.peers must be an array with exactly 2 peers");
  }

  for (const peer of config.peers) {
    if (!Number.isInteger(peer.index_fix)) {
      fail("each peer.index_fix must be an integer");
    }

    if (!peer.id || typeof peer.id !== "string") {
      fail("each peer.id must be a string");
    }

    if (!peer.ip || typeof peer.ip !== "string") {
      fail("each peer.ip must be a string");
    }

    if (!Number.isInteger(peer.port) || peer.port <= 0) {
      fail("each peer.port must be a positive integer");
    }
  }

  if (!config.storage || typeof config.storage.dbPath !== "string") {
    fail("config.storage.dbPath must be a string");
  }

  if (!config.bitcoin || typeof config.bitcoin !== "object") {
    fail("config.bitcoin is required");
  }

  if (config.bitcoin.network !== "mainnet") {
    fail("config.bitcoin.network must be 'mainnet'");
  }

  if (!Array.isArray(config.bitcoin.providers) || config.bitcoin.providers.length < 3) {
    fail("config.bitcoin.providers must contain at least 3 providers");
  }

  for (const provider of config.bitcoin.providers) {
    if (!provider.id || typeof provider.id !== "string") {
      fail("each bitcoin provider.id must be a string");
    }

    if (provider.kind !== "esplora") {
      fail("each bitcoin provider.kind must be 'esplora' in v1");
    }

    provider.baseUrl = normalizeBaseUrl(provider.baseUrl);
  }

  if (!config.runtime || typeof config.runtime !== "object") {
    fail("config.runtime is required");
  }
}

function loadConfigFromArgv(argv = process.argv) {
  if (!argv[2]) {
    fail("Config path is required. Example: node three-headed-bot.js node-1.config.json");
  }

  const configPath = path.resolve(argv[2]);
  const config = readJson(configPath);
  validateConfig(config);

  return {
    configPath,
    config,
  };
}

function buildState(configPath, config) {
  const allowedPeerIps = new Set(config.peers.map((peer) => peer.ip));
  const storagePath = path.resolve(path.dirname(configPath), config.storage.dbPath);
  const peerStatus = new Map(
    config.peers.map((peer) => [
      peer.id,
      {
        healthy: null,
        lastOkAt: null,
        lastError: null,
      },
    ])
  );

  return {
    configPath,
    config,
    allowedPeerIps,
    peerStatus,
    rounds: new Map(),
    activeUserRounds: new Map(),
    pendingApprovals: new Map(),
    storagePath,
    offset: 0,
    telegramPollInFlight: false,
    shutdownRequested: false,
  };
}

function ensureStorageDir(storagePath) {
  fs.mkdirSync(path.dirname(storagePath), { recursive: true });
}

function getRequestRemoteIp(req) {
  const raw = req.socket.remoteAddress || "";
  if (raw.startsWith("::ffff:")) {
    return raw.slice(7);
  }

  return raw;
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function parseRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];

    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const body = Buffer.concat(chunks).toString("utf8");
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function createHttpsServer(state, peerRequestHandler) {
  return https.createServer(
    {
      cert: state.config.http.tls.certPem,
      key: state.config.http.tls.keyPem,
    },
    async (req, res) => {
      try {
        if (!req.url) {
          sendJson(res, 404, { ok: false, error: "Not found" });
          return;
        }

        if (req.method === "GET" && req.url === "/peer/health") {
          const remoteIp = getRequestRemoteIp(req);

          if (!state.allowedPeerIps.has(remoteIp)) {
            sendJson(res, 403, { ok: false, error: "IP not allowed", remoteIp });
            return;
          }

          sendJson(res, 200, {
            ok: true,
            nodeId: state.config.node.id,
            nodeIndex: state.config.node.index_fix,
            protocol: state.config.protocol_fix,
            version: state.config.version,
            now: new Date().toISOString(),
          });
          return;
        }

        if (req.method === "POST" && req.url.startsWith("/peer/")) {
          const remoteIp = getRequestRemoteIp(req);

          if (!state.allowedPeerIps.has(remoteIp)) {
            sendJson(res, 403, { ok: false, error: "IP not allowed", remoteIp });
            return;
          }

          const payload = await parseRequestBody(req);
          if (typeof peerRequestHandler === "function") {
            const result = await peerRequestHandler({ req, res, remoteIp, payload, state });
            if (result && !res.writableEnded) {
              sendJson(res, result.statusCode || 200, result.body || { ok: true });
            }
          } else {
            log("INFO", `Received peer request ${req.url} from ${remoteIp}`, payload);
            sendJson(res, 200, { ok: true, accepted: true });
          }
          return;
        }

        sendJson(res, 404, { ok: false, error: "Not found" });
      } catch (error) {
        log("ERROR", "HTTPS handler failed", error.message);
        if (!res.writableEnded) {
          sendJson(res, 500, { ok: false, error: "Internal error" });
        }
      }
    }
  );
}

function requestJson(url, options = {}, body = null) {
  return new Promise((resolve, reject) => {
    const urlObject = new URL(url);
    const requestOptions = {
      protocol: urlObject.protocol,
      hostname: urlObject.hostname,
      port: urlObject.port,
      path: `${urlObject.pathname}${urlObject.search}`,
      method: options.method || "GET",
      headers: options.headers || {},
      rejectUnauthorized: false,
    };

    const req = https.request(requestOptions, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        try {
          resolve({
            statusCode: res.statusCode || 0,
            headers: res.headers,
            body: text ? JSON.parse(text) : null,
          });
        } catch (error) {
          reject(error);
        }
      });
    });

    req.on("error", reject);

    if (body !== null) {
      req.write(JSON.stringify(body));
    }

    req.end();
  });
}

async function notifyEvent(state, eventType, message) {
  if (typeof state.notifyTelegram !== "function") {
    return;
  }

  try {
    await state.notifyTelegram({
      eventType,
      message,
    });
  } catch (error) {
    log("WARN", `Telegram event notify failed: ${error.message}`);
  }
}

function createCreateRound(state, { roundId, keyId, context, telegramUserId, coordinatorNodeId, chatId = null, activeRoundOwnerKey = null }) {
  const local = getLocalContribution(state.config, context);
  const round = {
    roundType: "CREATE",
    roundId,
    keyId,
    context,
    telegramUserId: String(telegramUserId),
    coordinatorNodeId,
    chatId,
    activeRoundOwnerKey,
    commitmentsByNode: {
      [state.config.node.id]: local.commitments,
    },
    sharesByTarget: {
      [state.config.node.id]: {
        [state.config.node.id]: bigIntToHex(local.shares.get(state.config.node.index_fix)),
      },
    },
    completionByNode: {},
    local,
    finalized: false,
    announcedToTelegram: false,
    createdAt: Date.now(),
    expiresAt: Date.now() + (Number(state.config.runtime.roundTtlMs) || 60000),
    aborted: false,
    abortReason: null,
  };

  state.rounds.set(roundId, round);
  return round;
}

function getRound(state, roundId) {
  return state.rounds.get(roundId) || null;
}

function buildActiveRoundKey(roundType, userId) {
  return `${roundType}:${String(userId)}`;
}

function claimActiveRound(state, roundType, userId, roundId) {
  const key = buildActiveRoundKey(roundType, userId);
  const existingRoundId = state.activeUserRounds.get(key);
  if (existingRoundId && existingRoundId !== roundId) {
    return existingRoundId;
  }

  state.activeUserRounds.set(key, roundId);
  return null;
}

function releaseActiveRound(state, round) {
  if (!round || !round.roundType) {
    return;
  }

  const ownerKey = round.activeRoundOwnerKey || round.telegramUserId;
  if (!ownerKey) {
    return;
  }

  const key = buildActiveRoundKey(round.roundType, ownerKey);
  if (state.activeUserRounds.get(key) === round.roundId) {
    state.activeUserRounds.delete(key);
  }
}

function removeRound(state, roundId) {
  const round = getRound(state, roundId);
  if (!round) {
    return;
  }

  releaseActiveRound(state, round);
  for (const [pendingKey, pending] of state.pendingApprovals.entries()) {
    if (pending?.roundId === round.roundId) {
      state.pendingApprovals.delete(pendingKey);
    }
  }
  state.rounds.delete(roundId);
}

async function abortRound(state, round, reason, options = {}) {
  if (!round || round.aborted === true || round.finalized === true) {
    return;
  }

  round.aborted = true;
  round.abortReason = reason;
  releaseActiveRound(state, round);
  for (const [pendingKey, pending] of state.pendingApprovals.entries()) {
    if (pending?.roundId === round.roundId) {
      state.pendingApprovals.delete(pendingKey);
    }
  }

  if (
    options.propagateAbort !== false &&
    round.roundType === "SIGN" &&
    state.config.node.id !== round.coordinatorNodeId
  ) {
    const coordinatorPeer = getPeerById(state.config, round.coordinatorNodeId);
    if (coordinatorPeer) {
      try {
        await postToPeer(state, coordinatorPeer, "/peer/sign/abort", {
          roundId: round.roundId,
          reason,
          fromNodeId: state.config.node.id,
        });
      } catch (error) {
        log("WARN", `Failed to propagate sign abort for round ${round.roundId}: ${error.message}`);
      }
    }
  }

  if (
    options.notifyTelegram !== false &&
    state.config.node.id === round.coordinatorNodeId &&
    round.silentTelegramResult !== true
  ) {
    const targetLabel =
      round.storageTarget?.kind === "group"
        ? `group ${round.storageTarget.groupKey}`
        : `user ${round.telegramUserId}`;
    await notifyEvent(
      state,
      "round_aborted",
      `${state.config.node.id}: ${round.roundType.toLowerCase()} failed for ${targetLabel}: ${sanitizePublicRoundReason(reason)}`
    );
  }

  if (options.remove !== false) {
    removeRound(state, round.roundId);
  }
}

async function cleanupExpiredRounds(state) {
  const now = Date.now();

  for (const round of state.rounds.values()) {
    if (round.finalized || round.aborted) {
      removeRound(state, round.roundId);
      continue;
    }

    if (typeof round.expiresAt === "number" && round.expiresAt <= now) {
      await abortRound(state, round, "round timeout");
    }
  }
}

function startRoundCleanupLoop(state) {
  const interval = Math.max(5000, Math.floor((Number(state.config.runtime.roundTtlMs) || 60000) / 4));

  cleanupExpiredRounds(state).catch((error) =>
    log("WARN", `Initial round cleanup failed: ${error.message}`)
  );
  return setInterval(() => {
    cleanupExpiredRounds(state).catch((error) =>
      log("WARN", `Round cleanup failed: ${error.message}`)
    );
  }, interval);
}

function getOrCreateSharesBucket(round, targetNodeId) {
  if (!round.sharesByTarget[targetNodeId]) {
    round.sharesByTarget[targetNodeId] = {};
  }

  return round.sharesByTarget[targetNodeId];
}

function tryFinalizeCreateRound(state, round) {
  if (round.finalized) {
    return round.result || null;
  }

  const allNodes = getAllNodeDescriptors(state.config);
  const nodeIds = allNodes.map((node) => node.id);

  for (const nodeId of nodeIds) {
    if (!round.commitmentsByNode[nodeId]) {
      return null;
    }
  }

  const ownShares = round.sharesByTarget[state.config.node.id];
  if (!ownShares) {
    return null;
  }

  for (const nodeId of nodeIds) {
    if (!ownShares[nodeId]) {
      return null;
    }
  }

  let finalShare = 0n;
  for (const shareHex of Object.values(ownShares)) {
    finalShare = mod(finalShare + hexToBigInt(shareHex));
  }

  const groupPublicKey = computeGroupPublicKey(round.commitmentsByNode);
  const adjustedFinalShare = pointHasEvenY(groupPublicKey) ? finalShare : negateScalar(finalShare);
  const finalSharePublic = Point.BASE.multiply(adjustedFinalShare);
  const groupPublicKeyXOnly = getXOnlyHexFromCompressedPubkey(pointToHex(groupPublicKey));
  const bitcoinAddress = getBitcoinMainnetTaprootAddress(groupPublicKey);
  const result = {
    userId: round.telegramUserId,
    keyId: round.keyId,
    context: round.context,
    groupPublicKey: pointToHex(groupPublicKey),
    groupPublicKeyXOnly,
    bitcoinAddress,
    finalShareSecretHex: bigIntToHex(adjustedFinalShare),
    finalSharePublic: pointToHex(finalSharePublic),
  };

  if (round.storageTarget?.kind === "group") {
    result.groupKey = round.storageTarget.groupKey;
    result.memberUserIds = [...round.storageTarget.memberUserIds];
  }

  round.finalized = true;
  round.result = result;
  if (round.storageTarget?.kind === "group") {
    persistGroupRecord(state, round.storageTarget.groupKey, result);
  } else {
    persistUserRecord(state, round.telegramUserId, result);
  }
  releaseActiveRound(state, round);
  return result;
}

async function postToPeer(state, peer, pathName, payload) {
  const url = `https://${peer.ip}:${peer.port}${pathName}`;
  return requestJson(
    url,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
    },
    payload
  );
}

async function broadcastLocalCreateData(state, round) {
  const peers = state.config.peers;
  const localCommitmentsPayload = {
    roundId: round.roundId,
    keyId: round.keyId,
    fromNodeId: state.config.node.id,
    commitments: round.local.commitments,
  };

  for (const peer of peers) {
    const shareHex = bigIntToHex(round.local.shares.get(peer.index_fix));
    await postToPeer(state, peer, "/peer/create/commitments", localCommitmentsPayload);
    await postToPeer(state, peer, "/peer/create/share", {
      roundId: round.roundId,
      keyId: round.keyId,
      fromNodeId: state.config.node.id,
      targetNodeId: peer.id,
      shareHex,
    });
  }
}

async function maybeSendCreateComplete(state, round) {
  const result = tryFinalizeCreateRound(state, round);
  if (!result) {
    return null;
  }

  if (state.config.node.id === round.coordinatorNodeId) {
    round.completionByNode[state.config.node.id] = {
      groupPublicKey: result.groupPublicKey,
      bitcoinAddress: result.bitcoinAddress,
    };
    return result;
  }

  if (round.completeSent) {
    return result;
  }

  const coordinatorPeer = getPeerById(state.config, round.coordinatorNodeId);
  if (!coordinatorPeer) {
    throw new Error(`Coordinator peer ${round.coordinatorNodeId} not found`);
  }

  await postToPeer(state, coordinatorPeer, "/peer/create/complete", {
    roundId: round.roundId,
    keyId: round.keyId,
    fromNodeId: state.config.node.id,
    telegramUserId: round.telegramUserId,
    groupPublicKey: result.groupPublicKey,
    bitcoinAddress: result.bitcoinAddress,
    finalSharePublic: result.finalSharePublic,
  });

  round.completeSent = true;
  return result;
}

function registerCompletion(round, fromNodeId, payload) {
  round.completionByNode[fromNodeId] = {
    groupPublicKey: payload.groupPublicKey,
    bitcoinAddress: payload.bitcoinAddress,
    finalSharePublic: payload.finalSharePublic || null,
  };
}

function isCoordinatorReadyToAnnounce(state, round) {
  if (state.config.node.id !== round.coordinatorNodeId) {
    return false;
  }

  const allNodes = getAllNodeDescriptors(state.config);
  for (const node of allNodes) {
    if (!round.completionByNode[node.id]) {
      return false;
    }
  }

  const completions = Object.values(round.completionByNode);
  const first = completions[0];
  return completions.every(
    (item) =>
      item.groupPublicKey === first.groupPublicKey &&
      item.bitcoinAddress === first.bitcoinAddress
  );
}

async function checkPeerHealth(state, peer) {
  const url = `https://${peer.ip}:${peer.port}/peer/health`;
  const startedAt = Date.now();
  const status = state.peerStatus.get(peer.id);

  try {
    const response = await requestJson(url);
    const elapsedMs = Date.now() - startedAt;

    if (!response.body || response.body.ok !== true) {
      throw new Error(`unexpected response with status ${response.statusCode}`);
    }

    if (!status || status.healthy !== true) {
      const message = `${state.config.node.id}: peer restored ${peer.id}`;
      log("INFO", `Peer restored: ${peer.id} responded in ${elapsedMs}ms`);
      await notifyEvent(state, "peer_restored", message);
    }

    if (status) {
      status.healthy = true;
      status.lastOkAt = Date.now();
      status.lastError = null;
    }

    log("INFO", `Peer health ${peer.id} ${response.statusCode} in ${elapsedMs}ms`);
  } catch (error) {
    if (!status || status.healthy !== false) {
      const message = `${state.config.node.id}: peer lost ${peer.id}`;
      log("WARN", `Peer lost: ${peer.id} is not responding`);
      await notifyEvent(state, "peer_lost", message);
    }

    if (status) {
      status.healthy = false;
      status.lastError = error.message;
    }

    log("WARN", `Peer health failed for ${peer.id}: ${error.message}`);
  }
}

function startPeerHealthLoop(state) {
  const interval = Number(state.config.runtime.healthcheckIntervalMs) || 15000;

  async function tick() {
    for (const peer of state.config.peers) {
      await checkPeerHealth(state, peer);
    }
  }

  tick().catch((error) => log("WARN", `Initial peer health loop failed: ${error.message}`));
  return setInterval(() => {
    tick().catch((error) => log("WARN", `Peer health loop failed: ${error.message}`));
  }, interval);
}

function createRequestId(nodeId, userId) {
  return crypto
    .createHash("sha256")
    .update(`${nodeId}:${userId}:${Date.now()}`)
    .digest("hex")
    .slice(0, 16);
}

module.exports = {
  buildState,
  buildCreateContext,
  buildKeyId,
  buildMessageHashHex,
  buildRoundId,
  createLocalPartialSignature,
  createSignRound,
  createHttpsServer,
  createCreateRound,
  createRequestId,
  buildTaprootSendAllCandidate,
  buildTaprootSpendCandidate,
  ensureStorageDir,
  finalizeTaprootTransaction,
  getPeerById,
  getRound,
  getStoredGroupRecord,
  getStoredRecordByTarget,
  getStoredUserRecord,
  isValidBitcoinAddress,
  isHex32Byte,
  buildGroupCreateContext,
  buildGroupKey,
  listGroupRecordsForUser,
  selectTaprootSpendCandidate,
  tryBuildSignPackage,
  tryFinalizeSignRound,
  loadConfigFromArgv,
  log,
  maybeSendCreateComplete,
  notifyEvent,
  pointToHex,
  postToPeer,
  registerCompletion,
  requestJson,
  claimActiveRound,
  abortRound,
  cleanupExpiredRounds,
  chooseBitcoinProviders,
  broadcastLocalCreateData,
  broadcastTxWithProvider,
  getAddressUtxosFromProvider,
  getBitcoinProviderById,
  getTxFromProvider,
  getTxHexFromProvider,
  tryFinalizeCreateRound,
  verifyLocalPartial,
  verifyShare,
  isCoordinatorReadyToAnnounce,
  startPeerHealthLoop,
  startRoundCleanupLoop,
  removeRound,
};

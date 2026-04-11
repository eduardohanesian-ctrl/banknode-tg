const {
  buildState,
  buildCreateContext,
  buildGroupCreateContext,
  buildGroupKey,
  buildKeyId,
  buildMessageHashHex,
  buildRoundId,
  buildTaprootSendAllCandidate,
  buildTaprootSpendCandidate,
  claimActiveRound,
  chooseBitcoinProviders,
  broadcastLocalCreateData,
  broadcastTxWithProvider,
  createLocalPartialSignature,
  createSignRound,
  createHttpsServer,
  createCreateRound,
  ensureStorageDir,
  finalizeTaprootTransaction,
  getAddressUtxosFromProvider,
  getPeerById,
  getRound,
  getStoredGroupRecord,
  getStoredRecordByTarget,
  getStoredUserRecord,
  isValidBitcoinAddress,
  isHex32Byte,
  isCoordinatorReadyToAnnounce,
  loadConfigFromArgv,
  log,
  maybeSendCreateComplete,
  abortRound,
  listGroupRecordsForUser,
  postToPeer,
  registerCompletion,
  startRoundCleanupLoop,
  startPeerHealthLoop,
  tryBuildSignPackage,
  tryFinalizeCreateRound,
  tryFinalizeSignRound,
  removeRound,
  selectTaprootSpendCandidate,
  verifyLocalPartial,
  verifyShare,
} = require("./crypto_backend");
const { loadBotIdentity, sendGroupEvent, startTelegramPollingLoop } = require("./tg_backend");

function buildStartupHelpMessage(state) {
  const bot = state.telegramBotUsername;
  return [
    `${state.config.node.id}: available commands`,
    `/create@${bot}`,
    `/create@${bot} <user_id2> <user_id3>`,
    `/address@${bot}`,
    `/balance@${bot} [address]`,
    `/utxo@${bot}`,
    `/status@${bot}`,
    `/sign@${bot} <message>`,
    `/signhash@${bot} <32-byte-hex-hash>`,
    `/send@${bot} <to_address> <amount_sats> <fee_rate>`,
    `/multisign@${bot} <user_id2> <user_id3> <message>`,
    `/multisignhash@${bot} <user_id2> <user_id3> <32-byte-hex-hash>`,
    `/multisend@${bot} <user_id2> <user_id3> <to_address> <amount_sats> <fee_rate>`,
    `/approve@${bot}`,
    `/reject@${bot}`,
  ].join("\n");
}

function describeStorageTarget(storageTarget, fallbackUserId) {
  return storageTarget?.kind === "group"
    ? `group ${storageTarget.groupKey}`
    : `user ${String(fallbackUserId)}`;
}

function buildTargetRoundOwnerKey(storageTarget, fallbackUserId) {
  return storageTarget?.kind === "group"
    ? `group:${storageTarget.groupKey}`
    : `user:${String(fallbackUserId)}`;
}

function buildGroupStorageTarget(initiatorUserId, otherUserIds) {
  const memberUserIds = [String(initiatorUserId), ...otherUserIds.map((value) => String(value))];
  return {
    kind: "group",
    groupKey: buildGroupKey(memberUserIds),
    memberUserIds: [...memberUserIds].sort((a, b) => Number(a) - Number(b)),
  };
}

async function announceCreateResultIfReady(state, round) {
  if (!isCoordinatorReadyToAnnounce(state, round) || round.announcedToTelegram) {
    return;
  }

  round.announcedToTelegram = true;
  const completion = Object.values(round.completionByNode)[0];
  await sendGroupEvent(
    state,
    `${state.config.node.id}: address ready for ${describeStorageTarget(round.storageTarget, round.telegramUserId)}: ${completion.bitcoinAddress}`
  );
}

async function handleCreateInit(state, payload) {
  const round = createCreateRound(state, {
    roundId: payload.roundId,
    keyId: payload.keyId,
    context: payload.context,
    telegramUserId: payload.telegramUserId,
    coordinatorNodeId: payload.coordinatorNodeId,
    activeRoundOwnerKey: payload.activeRoundOwnerKey || null,
  });
  if (payload.storageTarget) {
    round.storageTarget = payload.storageTarget;
  }
  return { ok: true, accepted: true };
}

async function handleCreateStart(state, payload) {
  const round = getRound(state, payload.roundId);
  if (!round) {
    return { ok: false, error: "Unknown round" };
  }

  await broadcastLocalCreateData(state, round);
  await maybeSendCreateComplete(state, round);
  return { ok: true, accepted: true };
}

async function handleCreateCommitments(state, payload) {
  const round = getRound(state, payload.roundId);
  if (!round) {
    return { ok: false, error: "Unknown round" };
  }

  round.commitmentsByNode[payload.fromNodeId] = payload.commitments;
  await maybeSendCreateComplete(state, round);
  return { ok: true, accepted: true };
}

async function handleCreateShare(state, payload) {
  const round = getRound(state, payload.roundId);
  if (!round) {
    return { ok: false, error: "Unknown round" };
  }

  if (payload.targetNodeId !== state.config.node.id) {
    return { ok: false, error: "Share target mismatch" };
  }

  const senderCommitments = round.commitmentsByNode[payload.fromNodeId];
  if (!senderCommitments) {
    await abortRound(state, round, `missing commitments from ${payload.fromNodeId}`);
    return { ok: false, error: "Missing sender commitments" };
  }

  if (!verifyShare(senderCommitments, state.config.node.index_fix, payload.shareHex)) {
    await abortRound(state, round, `invalid create share from ${payload.fromNodeId}`);
    return { ok: false, error: "Invalid share" };
  }

  if (!round.sharesByTarget[state.config.node.id]) {
    round.sharesByTarget[state.config.node.id] = {};
  }
  round.sharesByTarget[state.config.node.id][payload.fromNodeId] = payload.shareHex;
  await maybeSendCreateComplete(state, round);
  return { ok: true, accepted: true };
}

async function handleCreateComplete(state, payload) {
  const round = getRound(state, payload.roundId);
  if (!round) {
    return { ok: false, error: "Unknown round" };
  }

  registerCompletion(round, payload.fromNodeId, payload);
  await announceCreateResultIfReady(state, round);
  return { ok: true, accepted: true };
}

async function handleSignInit(state, payload) {
  createSignRound(state, {
    roundId: payload.roundId,
    keyId: payload.keyId,
    telegramUserId: payload.telegramUserId,
    messageText: payload.messageText,
    messageHashHex: payload.messageHashHex,
    coordinatorNodeId: payload.coordinatorNodeId,
    signingNodeIds: payload.signingNodeIds,
    silentTelegramResult: payload.silentTelegramResult === true,
    requireApproval: payload.requireApproval === true,
    approvalRequest: payload.approvalRequest || null,
    storageTarget: payload.storageTarget || null,
    approvalAllowedUserIds: payload.approvalAllowedUserIds || null,
    activeRoundOwnerKey: payload.activeRoundOwnerKey || null,
  });
  return { ok: true, accepted: true };
}

async function handleSignStart(state, payload) {
  const round = getRound(state, payload.roundId);
  if (!round) {
    return { ok: false, error: "Unknown sign round" };
  }

  for (const peer of state.config.peers) {
    if (!round.signingNodeIds.includes(peer.id)) {
      continue;
    }

    await postToPeer(state, peer, "/peer/sign/commitment", {
      roundId: round.roundId,
      keyId: round.keyId,
      fromNodeId: state.config.node.id,
      nonceCommitmentHex: round.local.nonceCommitmentHex,
    });
  }

  return { ok: true, accepted: true };
}

async function handleSignCommitment(state, payload) {
  const round = getRound(state, payload.roundId);
  if (!round) {
    return { ok: false, error: "Unknown sign round" };
  }

  round.commitmentsByNode[payload.fromNodeId] = payload.nonceCommitmentHex;

  const signPackage = tryBuildSignPackage(state, round);
  if (!signPackage || round.signPackageSent) {
    return { ok: true, accepted: true };
  }

  if (state.config.node.id !== round.coordinatorNodeId) {
    return { ok: true, accepted: true };
  }

  round.signPackage = signPackage;
  round.signPackageSent = true;

  for (const nodeId of round.signingNodeIds) {
    if (nodeId === state.config.node.id) {
      continue;
    }

    const peer = getPeerById(state.config, nodeId);
    await postToPeer(state, peer, "/peer/sign/package", {
      roundId: round.roundId,
      keyId: round.keyId,
      fromNodeId: state.config.node.id,
      groupCommitmentHex: signPackage.groupCommitmentHex,
      challengeHex: signPackage.challengeHex,
      negateNonce: signPackage.negateNonce,
    });
  }

  const localPartial = createLocalPartialSignature(state, round, signPackage);
  round.partialsByNode[state.config.node.id] = {
    fromNodeId: state.config.node.id,
    finalSharePublic: round.record.finalSharePublic,
    partialSignatureHex: localPartial.partialSignatureHex,
  };

  const result = tryFinalizeSignRound(state, round, signPackage);
  if (result && round.silentTelegramResult !== true) {
    await sendGroupEvent(
      state,
      `${state.config.node.id}: sign result for ${round.storageTarget?.kind === "group" ? `group ${round.storageTarget.groupKey}` : `user ${round.telegramUserId}`}: ${result.signatureHex} verified=${result.bip340Verified} signingSet=${result.signingSet.join(",")}`
    );
  }

  return { ok: true, accepted: true };
}

async function handleSignPackage(state, payload) {
  const round = getRound(state, payload.roundId);
  if (!round) {
    return { ok: false, error: "Unknown sign round" };
  }

  round.signPackage = {
    groupCommitmentHex: payload.groupCommitmentHex,
    challengeHex: payload.challengeHex,
    negateNonce: payload.negateNonce === true,
  };

  if (round.requireApproval === true && round.approved !== true) {
    const approvalKey = round.storageTarget?.kind === "group"
      ? `group:${round.storageTarget.groupKey}`
      : `user:${round.telegramUserId}`;
    state.pendingApprovals.set(approvalKey, {
      roundId: round.roundId,
      telegramUserId: String(round.telegramUserId),
      coordinatorNodeId: round.coordinatorNodeId,
      approvalRequest: round.approvalRequest,
      approvalAllowedUserIds: round.approvalAllowedUserIds,
      storageTarget: round.storageTarget,
    });

    if (!round.approvalRequested) {
      round.approvalRequested = true;
      const details = round.approvalRequest || {};
      const groupApprovalNote =
        round.storageTarget?.kind === "group" && Array.isArray(round.approvalAllowedUserIds)
          ? ` Ожидается подтверждение от пользователей ${round.approvalAllowedUserIds.join(" или ")}.`
          : "";
      let promptText = `Подтвердите операцию командой /approve@${state.telegramBotUsername} или отклоните /reject@${state.telegramBotUsername}`;
      if (details.type === "send") {
        const amountLabel =
          Number(details.amountSats) === 0 || details.sendAll === true
            ? "all available funds"
            : `${details.amountSats} sats`;
        promptText = `${round.storageTarget?.kind === "group" ? `Участники группы ${round.storageTarget.groupKey},${groupApprovalNote}` : `Пользователь ${round.telegramUserId},`} подтвердите отправку ${amountLabel} на ${details.toAddress} с fee rate ${details.feeRate} командой /approve@${state.telegramBotUsername}${round.storageTarget?.kind === "group" ? "" : ` или отклоните /reject@${state.telegramBotUsername}`}`;
      } else if (details.type === "sign") {
        promptText = `${round.storageTarget?.kind === "group" ? `Участники группы ${round.storageTarget.groupKey},${groupApprovalNote}` : `Пользователь ${round.telegramUserId},`} подтвердите подпись сообщения "${details.preview}" командой /approve@${state.telegramBotUsername}${round.storageTarget?.kind === "group" ? "" : ` или отклоните /reject@${state.telegramBotUsername}`}`;
      } else if (details.type === "signhash") {
        promptText = `${round.storageTarget?.kind === "group" ? `Участники группы ${round.storageTarget.groupKey},${groupApprovalNote}` : `Пользователь ${round.telegramUserId},`} подтвердите подпись хеша ${details.messageHashHex} командой /approve@${state.telegramBotUsername}${round.storageTarget?.kind === "group" ? "" : ` или отклоните /reject@${state.telegramBotUsername}`}`;
      }
      await sendGroupEvent(
        state,
        promptText
      );
    }

    return { ok: true, accepted: true, awaitingApproval: true };
  }

  const partial = createLocalPartialSignature(state, round, round.signPackage);
  const coordinatorPeer = getPeerById(state.config, round.coordinatorNodeId);
  await postToPeer(state, coordinatorPeer, "/peer/sign/partial", {
    roundId: round.roundId,
    keyId: round.keyId,
    fromNodeId: state.config.node.id,
    finalSharePublic: round.record.finalSharePublic,
    partialSignatureHex: partial.partialSignatureHex,
  });

  return { ok: true, accepted: true };
}

async function handleSignAbort(state, payload) {
  const round = getRound(state, payload.roundId);
  if (!round) {
    return { ok: true, accepted: true };
  }

  await abortRound(state, round, payload.reason || "remote sign abort");
  return { ok: true, accepted: true };
}

async function handleSignPartial(state, payload) {
  const round = getRound(state, payload.roundId);
  if (!round) {
    return { ok: false, error: "Unknown sign round" };
  }

  if (state.config.node.id !== round.coordinatorNodeId) {
    return { ok: false, error: "Only coordinator accepts partials" };
  }

  if (!round.signPackage) {
    return { ok: false, error: "Sign package not ready" };
  }

  if (!verifyLocalPartial(state, round, payload, round.signPackage)) {
    log(
      "WARN",
      `Invalid partial signature for round ${round.roundId} from ${payload.fromNodeId}`
    );
    await abortRound(state, round, `invalid partial signature from ${payload.fromNodeId}`);
    return { ok: false, error: "Invalid partial signature" };
  }

  round.partialsByNode[payload.fromNodeId] = {
    fromNodeId: payload.fromNodeId,
    finalSharePublic: payload.finalSharePublic,
    partialSignatureHex: payload.partialSignatureHex,
  };

  const result = tryFinalizeSignRound(state, round, round.signPackage);
  if (result && round.silentTelegramResult !== true) {
    await sendGroupEvent(
      state,
      `${state.config.node.id}: sign result for ${round.storageTarget?.kind === "group" ? `group ${round.storageTarget.groupKey}` : `user ${round.telegramUserId}`}: ${result.signatureHex} verified=${result.bip340Verified} signingSet=${result.signingSet.join(",")}`
    );
  }

  return { ok: true, accepted: true };
}

async function handlePeerRequest(state, req, remoteIp, payload) {
  log("INFO", `Received peer request ${req.url} from ${remoteIp}`, payload);

  if (req.url === "/peer/create/init") {
    return { statusCode: 200, body: await handleCreateInit(state, payload) };
  }

  if (req.url === "/peer/create/commitments") {
    return { statusCode: 200, body: await handleCreateCommitments(state, payload) };
  }

  if (req.url === "/peer/create/start") {
    return { statusCode: 200, body: await handleCreateStart(state, payload) };
  }

  if (req.url === "/peer/create/share") {
    return { statusCode: 200, body: await handleCreateShare(state, payload) };
  }

  if (req.url === "/peer/create/complete") {
    return { statusCode: 200, body: await handleCreateComplete(state, payload) };
  }

  if (req.url === "/peer/sign/init") {
    return { statusCode: 200, body: await handleSignInit(state, payload) };
  }

  if (req.url === "/peer/sign/start") {
    return { statusCode: 200, body: await handleSignStart(state, payload) };
  }

  if (req.url === "/peer/sign/commitment") {
    return { statusCode: 200, body: await handleSignCommitment(state, payload) };
  }

  if (req.url === "/peer/sign/package") {
    return { statusCode: 200, body: await handleSignPackage(state, payload) };
  }

  if (req.url === "/peer/sign/partial") {
    return { statusCode: 200, body: await handleSignPartial(state, payload) };
  }

  if (req.url === "/peer/sign/abort") {
    return { statusCode: 200, body: await handleSignAbort(state, payload) };
  }

  return { statusCode: 200, body: { ok: true, accepted: true } };
}

async function handleCreateCommand(state, { chatId, userId, requestId, groupUserIds = null }) {
  const storageTarget = getCreateStorageTargetForCommand(userId, groupUserIds);
  const createOwnerKey = buildTargetRoundOwnerKey(storageTarget, userId);
  const activeRoundId = claimActiveRound(state, "CREATE", createOwnerKey, requestId);
  if (activeRoundId) {
    await sendGroupEvent(
      state,
      `${state.config.node.id}: create already in progress for ${describeStorageTarget(storageTarget, userId)}`
    );
    return;
  }

  const cached = storageTarget.kind === "group"
    ? getStoredGroupRecord(state, storageTarget.groupKey)
    : getStoredUserRecord(state, userId);
  if (cached) {
    state.activeUserRounds.delete(`CREATE:${createOwnerKey}`);
    await sendGroupEvent(
      state,
      `${state.config.node.id}: cached address for ${describeStorageTarget(storageTarget, userId)}: ${cached.bitcoinAddress}`
    );
    return;
  }

  const unavailablePeers = state.config.peers.filter(
    (peer) => state.peerStatus.get(peer.id)?.healthy === false
  );
  if (unavailablePeers.length > 0) {
    state.activeUserRounds.delete(`CREATE:${createOwnerKey}`);
    await sendGroupEvent(
      state,
      `${state.config.node.id}: create unavailable for ${describeStorageTarget(storageTarget, userId)}: all 3 nodes must be online for first create`
    );
    return;
  }

  const context = storageTarget.kind === "group"
    ? buildGroupCreateContext(state.config.protocol_fix, storageTarget.memberUserIds)
    : buildCreateContext(state.config.protocol_fix, userId);
  const keyId = buildKeyId(context);
  const roundId = buildRoundId(state.config.node.id, keyId);
  state.activeUserRounds.set(`CREATE:${createOwnerKey}`, roundId);
  const round = createCreateRound(state, {
    roundId,
    keyId,
    context,
    telegramUserId: String(userId),
    coordinatorNodeId: state.config.node.id,
    chatId,
    activeRoundOwnerKey: createOwnerKey,
  });
  round.storageTarget = storageTarget;

  await sendGroupEvent(
    state,
    `${state.config.node.id}: create started for ${storageTarget.kind === "group" ? `group ${storageTarget.groupKey}` : `user ${userId}`}, request ${requestId}`
  );

  try {
    for (const peer of state.config.peers) {
      await postToPeer(state, peer, "/peer/create/init", {
        roundId,
        keyId,
        context,
        telegramUserId: String(userId),
        coordinatorNodeId: state.config.node.id,
        storageTarget,
        activeRoundOwnerKey: createOwnerKey,
        fromNodeId: state.config.node.id,
      });
    }

    for (const peer of state.config.peers) {
      await postToPeer(state, peer, "/peer/create/start", {
        roundId,
        keyId,
        fromNodeId: state.config.node.id,
      });
    }

    await broadcastLocalCreateData(state, round);
    const localResult = tryFinalizeCreateRound(state, round);
    if (localResult) {
      registerCompletion(round, state.config.node.id, localResult);
      await announceCreateResultIfReady(state, round);
    } else {
      await maybeSendCreateComplete(state, round);
    }
  } catch (error) {
    log("WARN", `Create transport error for round ${round.roundId}: ${error.message}`);
    await abortRound(state, round, "create transport error");
  }
}

async function handleSignCommand(state, { chatId, userId, requestId, messageText }) {
  const storageTarget = { kind: "user", userId: String(userId) };
  const record = getStoredRecordByTarget(state, storageTarget);
  if (!record) {
    await sendGroupEvent(
      state,
      `${state.config.node.id}: no address for user ${userId}, run create first`
    );
    return;
  }

  const keyId = record.keyId;
  const roundId = buildRoundId(state.config.node.id, keyId);
  const messageHashHex = buildMessageHashHex(messageText);
  return handleSignRound(state, {
    chatId,
    userId,
    requestId,
    keyId,
    roundId,
    messageText,
    messageHashHex,
    modeLabel: "sign",
    storageTarget,
    approvalAllowedUserIds: getAllowedApproverUserIds(storageTarget, userId),
    requireApproval: true,
    approvalRequest: {
      type: "sign",
      preview: messageText.length > 80 ? `${messageText.slice(0, 77)}...` : messageText,
    },
  });
}

async function handleMultiSignCommand(state, { chatId, userId, requestId, groupUserIds, messageText }) {
  const storageTarget = buildGroupStorageTarget(userId, groupUserIds);
  const record = getStoredGroupRecord(state, storageTarget.groupKey);
  if (!record) {
    await sendGroupEvent(
      state,
      `${state.config.node.id}: no address for group ${storageTarget.groupKey}, run group create first`
    );
    return;
  }

  const keyId = record.keyId;
  const roundId = buildRoundId(state.config.node.id, keyId);
  const messageHashHex = buildMessageHashHex(messageText);
  return handleSignRound(state, {
    chatId,
    userId,
    requestId,
    keyId,
    roundId,
    messageText,
    messageHashHex,
    modeLabel: "multisign",
    storageTarget,
    approvalAllowedUserIds: getAllowedApproverUserIds(storageTarget, userId, groupUserIds),
    requireApproval: true,
    approvalRequest: {
      type: "sign",
      preview: messageText.length > 80 ? `${messageText.slice(0, 77)}...` : messageText,
    },
    roundOwnerKey: buildTargetRoundOwnerKey(storageTarget, userId),
  });
}

async function handleSignHashCommand(state, { chatId, userId, requestId, messageHashHex }) {
  const storageTarget = { kind: "user", userId: String(userId) };
  const record = getStoredRecordByTarget(state, storageTarget);
  if (!record) {
    await sendGroupEvent(
      state,
      `${state.config.node.id}: no address for user ${userId}, run create first`
    );
    return;
  }

  if (!isHex32Byte(messageHashHex)) {
    await sendGroupEvent(
      state,
      `${state.config.node.id}: signhash requires exactly 32 bytes hex`
    );
    return;
  }

  const keyId = record.keyId;
  const roundId = buildRoundId(state.config.node.id, keyId);
  return handleSignRound(state, {
    chatId,
    userId,
    requestId,
    keyId,
    roundId,
    messageText: null,
    messageHashHex: messageHashHex.toLowerCase(),
    modeLabel: "signhash",
    storageTarget,
    approvalAllowedUserIds: getAllowedApproverUserIds(storageTarget, userId),
    requireApproval: true,
    approvalRequest: {
      type: "signhash",
      messageHashHex: messageHashHex.toLowerCase(),
    },
  });
}

async function handleMultiSignHashCommand(state, { chatId, userId, requestId, groupUserIds, messageHashHex }) {
  const storageTarget = buildGroupStorageTarget(userId, groupUserIds);
  const record = getStoredGroupRecord(state, storageTarget.groupKey);
  if (!record) {
    await sendGroupEvent(
      state,
      `${state.config.node.id}: no address for group ${storageTarget.groupKey}, run group create first`
    );
    return;
  }

  if (!isHex32Byte(messageHashHex)) {
    await sendGroupEvent(
      state,
      `${state.config.node.id}: signhash requires exactly 32 bytes hex`
    );
    return;
  }

  const keyId = record.keyId;
  const roundId = buildRoundId(state.config.node.id, keyId);
  return handleSignRound(state, {
    chatId,
    userId,
    requestId,
    keyId,
    roundId,
    messageText: null,
    messageHashHex: messageHashHex.toLowerCase(),
    modeLabel: "multisignhash",
    storageTarget,
    approvalAllowedUserIds: getAllowedApproverUserIds(storageTarget, userId, groupUserIds),
    requireApproval: true,
    approvalRequest: {
      type: "signhash",
      messageHashHex: messageHashHex.toLowerCase(),
    },
    roundOwnerKey: buildTargetRoundOwnerKey(storageTarget, userId),
  });
}

function getSigningPeerCandidates(state) {
  return [...state.config.peers]
    .map((peer) => ({
      peer,
      healthy: state.peerStatus.get(peer.id)?.healthy,
    }))
    .sort((a, b) => {
      const score = (value) => {
        if (value === true) {
          return 0;
        }
        if (value === null) {
          return 1;
        }
        return 2;
      };

      return score(a.healthy) - score(b.healthy);
    })
    .map((item) => item.peer);
}

async function handleSignRound(state, { chatId, userId, requestId, keyId, roundId, messageText, messageHashHex, modeLabel, announceStart = true, silentTelegramResult = false, forceSigningPeerId = null, requireApproval = false, approvalRequest = null, storageTarget = null, approvalAllowedUserIds = null, roundOwnerKey = null }) {
  const targetLabel = describeStorageTarget(storageTarget, userId);
  const effectiveRoundOwnerKey = roundOwnerKey || buildTargetRoundOwnerKey(storageTarget, userId);
  const activeRoundId = claimActiveRound(state, "SIGN", effectiveRoundOwnerKey, requestId);
  if (activeRoundId) {
    await sendGroupEvent(
      state,
      `${state.config.node.id}: sign already in progress for ${targetLabel}`
    );
    return;
  }

  if (announceStart) {
    await sendGroupEvent(
      state,
      `${state.config.node.id}: ${modeLabel} started for ${targetLabel}, request ${requestId}`
    );
  }

  const candidates = (forceSigningPeerId
    ? state.config.peers.filter((peer) => peer.id === forceSigningPeerId)
    : getSigningPeerCandidates(state)
  ).filter((peer) => state.peerStatus.get(peer.id)?.healthy !== false);

  if (candidates.length === 0) {
    state.activeUserRounds.delete(`SIGN:${effectiveRoundOwnerKey}`);
    await sendGroupEvent(
      state,
      `${state.config.node.id}: sign failed for ${targetLabel}: no signing peers available`
    );
    return;
  }

  for (let i = 0; i < candidates.length; i += 1) {
    const selectedPeer = candidates[i];
    const attemptRoundId = i === 0 ? roundId : buildRoundId(state.config.node.id, keyId);
    const signingNodeIds = [state.config.node.id, selectedPeer.id];
    state.activeUserRounds.set(`SIGN:${effectiveRoundOwnerKey}`, attemptRoundId);
    const round = createSignRound(state, {
      roundId: attemptRoundId,
      keyId,
      telegramUserId: String(userId),
      messageText,
      messageHashHex,
      coordinatorNodeId: state.config.node.id,
      signingNodeIds,
      chatId,
      silentTelegramResult,
      requireApproval,
      approvalRequest,
      storageTarget,
      approvalAllowedUserIds,
      activeRoundOwnerKey: effectiveRoundOwnerKey,
    });

    try {
      await postToPeer(state, selectedPeer, "/peer/sign/init", {
        roundId: attemptRoundId,
        keyId,
        telegramUserId: String(userId),
        messageText,
        messageHashHex,
        coordinatorNodeId: state.config.node.id,
        signingNodeIds,
        silentTelegramResult,
        requireApproval,
        approvalRequest,
        storageTarget,
        approvalAllowedUserIds,
        activeRoundOwnerKey: effectiveRoundOwnerKey,
        fromNodeId: state.config.node.id,
      });

      await postToPeer(state, selectedPeer, "/peer/sign/start", {
        roundId: attemptRoundId,
        keyId,
        fromNodeId: state.config.node.id,
      });

      round.commitmentsByNode[state.config.node.id] = round.local.nonceCommitmentHex;
      const signPackage = tryBuildSignPackage(state, round);
      if (!signPackage) {
        return waitForRoundResult(state, attemptRoundId, Number(state.config.runtime.roundTtlMs) || 60000);
      }

      return waitForRoundResult(state, attemptRoundId, Number(state.config.runtime.roundTtlMs) || 60000);
    } catch (error) {
      await abortRound(state, round, `${modeLabel} transport error: ${error.message}`, {
        notifyTelegram: false,
      });

      if (i === candidates.length - 1) {
        state.activeUserRounds.delete(`SIGN:${effectiveRoundOwnerKey}`);
        await sendGroupEvent(
          state,
          `${state.config.node.id}: sign failed for ${targetLabel}: no signing peers available`
        );
        return;
      }
    }
  }
}

async function handleAddressCommand(state, { userId }) {
  const record = getStoredUserRecord(state, userId);
  const groupRecords = listGroupRecordsForUser(state, userId);
  if (!record && groupRecords.length === 0) {
    await sendGroupEvent(
      state,
      `${state.config.node.id}: no address for user ${userId}, run /create first`
    );
    return;
  }

  const lines = [];
  if (record) {
    lines.push(`${state.config.node.id}: personal address for user ${userId}: ${record.bitcoinAddress}`);
  }
  for (const groupRecord of groupRecords) {
    lines.push(`${state.config.node.id}: group ${groupRecord.groupKey}: ${groupRecord.bitcoinAddress}`);
  }

  await sendGroupEvent(state, lines.join("\n"));
}

async function handleBalanceCommand(state, { userId, address }) {
  async function getBalanceSummary(targetAddress, label) {
    const results = [];
    for (const provider of state.config.bitcoin.providers) {
      try {
        const utxos = await getAddressUtxosFromProvider(provider, targetAddress);
        const normalized = normalizeUtxoList(Array.isArray(utxos) ? utxos : []);
        results.push({
          providerId: provider.id,
          ok: true,
          normalized,
        });
      } catch (error) {
        log("WARN", `Balance fetch failed for provider ${provider.id}: ${error.message}`);
        results.push({
          providerId: provider.id,
          ok: false,
        });
      }
    }

    const successful = results.filter((item) => item.ok);
    if (successful.length === 0) {
      return `${state.config.node.id}: ${label}: all bitcoin providers unavailable`;
    }

    const reference = JSON.stringify(successful[0].normalized);
    const consistent = successful.every((item) => JSON.stringify(item.normalized) === reference);
    if (!consistent) {
      return `${state.config.node.id}: ${label}: bitcoin providers inconsistent`;
    }

    const confirmedSats = successful[0].normalized
      .filter((utxo) => utxo.status.confirmed === true)
      .reduce((sum, utxo) => sum + utxo.value, 0);
    const totalSats = successful[0].normalized.reduce((sum, utxo) => sum + utxo.value, 0);
    const unconfirmedSats = totalSats - confirmedSats;

    return `${state.config.node.id}: ${label}: total=${totalSats} confirmed=${confirmedSats} unconfirmed=${unconfirmedSats} utxos=${successful[0].normalized.length}`;
  }

  if (address) {
    if (!isValidBitcoinAddress(address)) {
      await sendGroupEvent(
        state,
        `${state.config.node.id}: invalid bitcoin address`
      );
      return;
    }

    await sendGroupEvent(state, await getBalanceSummary(address, `balance for ${address}`));
    return;
  }

  const record = getStoredUserRecord(state, userId);
  const groupRecords = listGroupRecordsForUser(state, userId);
  if (!record && groupRecords.length === 0) {
    await sendGroupEvent(
      state,
      `${state.config.node.id}: no address for user ${userId}, run /create first`
    );
    return;
  }

  const lines = [];
  if (record) {
    lines.push(await getBalanceSummary(record.bitcoinAddress, `personal balance for user ${userId}`));
  }
  for (const groupRecord of groupRecords) {
    lines.push(await getBalanceSummary(groupRecord.bitcoinAddress, `group ${groupRecord.groupKey}`));
  }

  await sendGroupEvent(state, lines.join("\n"));
}

async function handleStatusCommand(state) {
  const peerStatuses = state.config.peers.map((peer) => {
    const status = state.peerStatus.get(peer.id);
    const label =
      status?.healthy === true ? "up" : status?.healthy === false ? "down" : "unknown";
    return `${peer.id}=${label}`;
  });

  await sendGroupEvent(
    state,
    `${state.config.node.id}: status peers ${peerStatuses.join(", ")}`
  );
}

async function handleApproveCommand(state, { userId }) {
  const pending = [...state.pendingApprovals.values()].find((item) =>
    Array.isArray(item.approvalAllowedUserIds) && item.approvalAllowedUserIds.includes(String(userId))
  );
  const pendingLabel = pending
    ? describeStorageTarget(pending.storageTarget, pending.telegramUserId)
    : `user ${userId}`;
  if (!pending) {
    await sendGroupEvent(
      state,
      `${state.config.node.id}: no pending approval for ${pendingLabel}`
    );
    return;
  }

  const round = getRound(state, pending.roundId);
  const pendingKey = getApprovalKey(pending.storageTarget, pending.telegramUserId);
  if (!round || !round.signPackage) {
    state.pendingApprovals.delete(pendingKey);
    await sendGroupEvent(
      state,
      `${state.config.node.id}: no pending approval for ${describeStorageTarget(pending.storageTarget, pending.telegramUserId)}`
    );
    return;
  }

  round.approved = true;
  state.pendingApprovals.delete(pendingKey);

  const partial = createLocalPartialSignature(state, round, round.signPackage);
  const coordinatorPeer = getPeerById(state.config, round.coordinatorNodeId);
  await postToPeer(state, coordinatorPeer, "/peer/sign/partial", {
    roundId: round.roundId,
    keyId: round.keyId,
    fromNodeId: state.config.node.id,
    finalSharePublic: round.record.finalSharePublic,
    partialSignatureHex: partial.partialSignatureHex,
  });

  await sendGroupEvent(
    state,
    `${state.config.node.id}: approval received for ${describeStorageTarget(pending.storageTarget, pending.telegramUserId)}`
  );
}

async function handleRejectCommand(state, { userId }) {
  const pending = [...state.pendingApprovals.values()].find((item) =>
    Array.isArray(item.approvalAllowedUserIds) && item.approvalAllowedUserIds.includes(String(userId))
  );
  const pendingLabel = pending
    ? describeStorageTarget(pending.storageTarget, pending.telegramUserId)
    : `user ${userId}`;
  if (!pending) {
    await sendGroupEvent(
      state,
      `${state.config.node.id}: no pending approval for ${pendingLabel}`
    );
    return;
  }

  const round = getRound(state, pending.roundId);
  const pendingKey = getApprovalKey(pending.storageTarget, pending.telegramUserId);
  if (round.storageTarget?.kind === "group") {
    await sendGroupEvent(
      state,
      `${state.config.node.id}: group requests can only expire by timeout or be approved`
    );
    return;
  }

  state.pendingApprovals.delete(pendingKey);
  if (!round) {
    await sendGroupEvent(
      state,
      `${state.config.node.id}: no pending approval for ${describeStorageTarget(pending.storageTarget, pending.telegramUserId)}`
    );
    return;
  }

  await abortRound(state, round, "rejected by user", { notifyTelegram: false });
  const coordinatorPeer = getPeerById(state.config, round.coordinatorNodeId);
  if (coordinatorPeer) {
    await postToPeer(state, coordinatorPeer, "/peer/sign/abort", {
      roundId: round.roundId,
      reason: "rejected by user",
      fromNodeId: state.config.node.id,
    });
  }

  await sendGroupEvent(
    state,
    `${state.config.node.id}: request rejected for ${describeStorageTarget(pending.storageTarget, pending.telegramUserId)}`
  );
}

function normalizeUtxoList(utxos) {
  return [...utxos]
    .map((item) => ({
      txid: String(item.txid),
      vout: Number(item.vout),
      value: Number(item.value),
      status: {
        confirmed: item.status?.confirmed === true,
        block_height: item.status?.block_height ?? null,
      },
    }))
    .sort((a, b) => {
      if (a.txid !== b.txid) {
        return a.txid.localeCompare(b.txid);
      }
      return a.vout - b.vout;
    });
}

function isLikelyBitcoinAddress(value) {
  return typeof value === "string" && /^(bc1|[13])[a-zA-Z0-9]{20,120}$/.test(value);
}

function parsePositiveInteger(value) {
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    return null;
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    return null;
  }

  return parsed;
}

function parseNonNegativeInteger(value) {
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    return null;
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    return null;
  }

  return parsed;
}

function getCreateStorageTargetForCommand(userId, groupUserIds) {
  if (Array.isArray(groupUserIds) && groupUserIds.length === 2) {
    return buildGroupStorageTarget(userId, groupUserIds);
  }

  return {
    kind: "user",
    userId: String(userId),
  };
}

function getApprovalKey(storageTarget, fallbackUserId) {
  return buildTargetRoundOwnerKey(storageTarget, fallbackUserId);
}

function getAllowedApproverUserIds(storageTarget, initiatorUserId, groupApproverUserIds = null) {
  if (storageTarget?.kind === "group") {
    if (Array.isArray(groupApproverUserIds) && groupApproverUserIds.length > 0) {
      return [...new Set(groupApproverUserIds.map((value) => String(value)))];
    }
    return [...new Set(storageTarget.memberUserIds)];
  }
  return [String(initiatorUserId)];
}

function waitForRoundResult(state, roundId, timeoutMs) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const timer = setInterval(() => {
      const round = getRound(state, roundId);
      if (!round) {
        clearInterval(timer);
        reject(new Error("round removed before completion"));
        return;
      }

      if (round.finalized && round.result) {
        clearInterval(timer);
        resolve(round.result);
        return;
      }

      if (round.aborted) {
        clearInterval(timer);
        reject(new Error(round.abortReason || "round aborted"));
        return;
      }

      if (Date.now() - startedAt > timeoutMs) {
        clearInterval(timer);
        reject(new Error("round wait timeout"));
      }
    }, 250);
  });
}

async function handleUtxoCommand(state, { userId }) {
  const record = getStoredUserRecord(state, userId);
  if (!record) {
    await sendGroupEvent(
      state,
      `${state.config.node.id}: no address for user ${userId}, run /create first`
    );
    return;
  }

  const results = [];
  for (const provider of state.config.bitcoin.providers) {
    try {
      const utxos = await getAddressUtxosFromProvider(provider, record.bitcoinAddress);
      const normalized = normalizeUtxoList(Array.isArray(utxos) ? utxos : []);
      results.push({
        providerId: provider.id,
        ok: true,
        normalized,
      });
    } catch (error) {
      log("WARN", `UTXO fetch failed for provider ${provider.id}: ${error.message}`);
      results.push({
        providerId: provider.id,
        ok: false,
        error: "provider unavailable",
      });
    }
  }

  const successful = results.filter((item) => item.ok);
  if (successful.length === 0) {
    await sendGroupEvent(
      state,
      `${state.config.node.id}: utxo check failed for user ${userId}: all providers unavailable`
    );
    return;
  }

  const reference = JSON.stringify(successful[0].normalized);
  const consistent = successful.every((item) => JSON.stringify(item.normalized) === reference);
  const providerSummary = results
    .map((item) =>
      item.ok
        ? `${item.providerId}=ok(${item.normalized.length})`
        : `${item.providerId}=unavailable`
    )
    .join(", ");

  await sendGroupEvent(
    state,
    `${state.config.node.id}: utxo check for user ${userId}: ${
      consistent ? "consistent" : "inconsistent"
    }; ${providerSummary}`
  );
}

async function handleSendForTarget(state, { userId, toAddress, amountSatsRaw, feeRateRaw, storageTarget, approvalAllowedUserIds, modeLabel = "send" }) {
  const record = getStoredRecordByTarget(state, storageTarget);
  const targetLabel = describeStorageTarget(storageTarget, userId);
  if (!record) {
    await sendGroupEvent(
      state,
      `${state.config.node.id}: no address for ${targetLabel}, run create first`
    );
    return;
  }

  if (!isValidBitcoinAddress(toAddress)) {
    await sendGroupEvent(
      state,
      `${state.config.node.id}: ${modeLabel} rejected for ${targetLabel}: invalid recipient address`
    );
    return;
  }

  const amountSats = parseNonNegativeInteger(amountSatsRaw);
  const feeRate = parsePositiveInteger(feeRateRaw);
  if (amountSats === null || !feeRate) {
    await sendGroupEvent(
      state,
      `${state.config.node.id}: ${modeLabel} rejected for ${targetLabel}: amount_sats must be a non-negative integer and fee_rate must be a positive integer`
    );
    return;
  }

  const selectedProviders = chooseBitcoinProviders(state.config, 2);
  const results = [];
  for (const provider of selectedProviders) {
    try {
      const utxos = await getAddressUtxosFromProvider(provider, record.bitcoinAddress);
      const normalized = normalizeUtxoList(Array.isArray(utxos) ? utxos : []);
      results.push({
        providerId: provider.id,
        ok: true,
        normalized,
      });
    } catch (error) {
      log("WARN", `Send preflight UTXO fetch failed for provider ${provider.id}: ${error.message}`);
      results.push({
        providerId: provider.id,
        ok: false,
      });
    }
  }

  const successful = results.filter((item) => item.ok);
  if (successful.length === 0) {
    await sendGroupEvent(
      state,
      `${state.config.node.id}: ${modeLabel} failed for ${targetLabel}: bitcoin providers unavailable`
    );
    return;
  }

  const reference = JSON.stringify(successful[0].normalized);
  const consistent = successful.every((item) => JSON.stringify(item.normalized) === reference);
  if (!consistent) {
    await sendGroupEvent(
      state,
      `${state.config.node.id}: ${modeLabel} failed for ${targetLabel}: bitcoin providers inconsistent`
    );
    return;
  }

  const availableUtxos = successful[0].normalized;
  const totalSats = availableUtxos.reduce((sum, utxo) => sum + utxo.value, 0);
  const candidate =
    amountSats === 0
      ? buildTaprootSendAllCandidate({
          utxos: availableUtxos,
          recipientAddress: toAddress,
          sourceAddress: record.bitcoinAddress,
          feeRate,
        })
      : selectTaprootSpendCandidate(
          availableUtxos,
          amountSats,
          feeRate,
          record.bitcoinAddress,
          toAddress
        );
  if (!candidate) {
    await sendGroupEvent(
      state,
      `${state.config.node.id}: ${modeLabel} failed for ${targetLabel}: insufficient funds total=${totalSats}`
    );
    return;
  }

  const signingPeer = getSigningPeerCandidates(state).find(
    (peer) => state.peerStatus.get(peer.id)?.healthy !== false
  );
  if (!signingPeer) {
    await sendGroupEvent(
      state,
      `${state.config.node.id}: ${modeLabel} failed for ${targetLabel}: no signing peers available`
    );
    return;
  }

  const signatureHexes = [];
  let lastSigningResult = null;
  for (let i = 0; i < candidate.sighashHexes.length; i += 1) {
    try {
      const signRequestId = `send-${Date.now()}-${i}`;
      const signRoundId = buildRoundId(state.config.node.id, record.keyId);
      const signingResult = await handleSignRound(state, {
        chatId: state.config.telegram.allowedGroupId,
        userId,
        requestId: signRequestId,
        keyId: record.keyId,
        roundId: signRoundId,
        messageText: null,
        messageHashHex: candidate.sighashHexes[i],
        modeLabel: `${modeLabel}-sign`,
        announceStart: false,
        silentTelegramResult: true,
        forceSigningPeerId: signingPeer.id,
        requireApproval: i === 0,
        approvalRequest:
          i === 0
            ? {
                type: "send",
                toAddress,
                amountSats: amountSats === 0 ? candidate.sendAmountSats : amountSats,
                feeRate,
                sendAll: amountSats === 0,
              }
            : null,
        storageTarget,
        approvalAllowedUserIds,
        roundOwnerKey: buildTargetRoundOwnerKey(storageTarget, userId),
      });
      if (!signingResult || !signingResult.signatureHex) {
        await sendGroupEvent(
          state,
          `${state.config.node.id}: ${modeLabel} failed for ${targetLabel}: signing did not complete`
        );
        return;
      }

      signatureHexes.push(signingResult.signatureHex);
      lastSigningResult = signingResult;
    } catch (error) {
      log("WARN", `Send signing failed for user ${userId} input ${i}: ${error.message}`);
      await sendGroupEvent(
        state,
        `${state.config.node.id}: ${modeLabel} failed for ${targetLabel}: signing failed`
      );
      return;
    }
  }

  const finalizedTx = finalizeTaprootTransaction(candidate, signatureHexes);
  const broadcastResults = [];
  for (const provider of selectedProviders) {
    try {
      const providerTxid = String(await broadcastTxWithProvider(provider, finalizedTx.txHex)).trim();
      broadcastResults.push({
        providerId: provider.id,
        ok: true,
        txid: providerTxid,
      });
    } catch (error) {
      log("WARN", `Broadcast failed for provider ${provider.id}: ${error.message}`);
      broadcastResults.push({
        providerId: provider.id,
        ok: false,
      });
    }
  }

  const successfulBroadcasts = broadcastResults.filter((item) => item.ok);
  if (successfulBroadcasts.length === 0) {
    await sendGroupEvent(
      state,
      `${state.config.node.id}: ${modeLabel} failed for ${targetLabel}: broadcast failed localTxid=${finalizedTx.txid}`
    );
    return;
  }

  const remoteSummary = broadcastResults
    .map((item) =>
      item.ok
        ? `${item.providerId}=${item.txid}`
        : `${item.providerId}=unavailable`
    )
    .join(", ");

  await sendGroupEvent(
    state,
    `${state.config.node.id}: ${modeLabel} complete for ${targetLabel}: localTxid=${finalizedTx.txid} remoteTxids=${remoteSummary} amount=${amountSats === 0 ? candidate.sendAmountSats : amountSats} fee=${candidate.feeSats} inputs=${candidate.utxos.length} signingSet=${lastSigningResult.signingSet.join(",")}`
  );
}

async function handleSendCommand(state, { userId, toAddress, amountSatsRaw, feeRateRaw }) {
  return handleSendForTarget(state, {
    userId,
    toAddress,
    amountSatsRaw,
    feeRateRaw,
    storageTarget: { kind: "user", userId: String(userId) },
    approvalAllowedUserIds: getAllowedApproverUserIds({ kind: "user", userId: String(userId) }, userId),
    modeLabel: "send",
  });
}

async function handleMultiSendCommand(state, { userId, groupUserIds, toAddress, amountSatsRaw, feeRateRaw }) {
  const storageTarget = buildGroupStorageTarget(userId, groupUserIds);
  return handleSendForTarget(state, {
    userId,
    toAddress,
    amountSatsRaw,
    feeRateRaw,
    storageTarget,
    approvalAllowedUserIds: getAllowedApproverUserIds(storageTarget, userId, groupUserIds),
    modeLabel: "multisend",
  });
}

async function main() {
  const { configPath, config } = loadConfigFromArgv();
  const state = buildState(configPath, config);
  state.notifyTelegram = async ({ message }) => sendGroupEvent(state, message);
  state.handleCreateCommand = (payload) => handleCreateCommand(state, payload);
  state.handleSignCommand = (payload) => handleSignCommand(state, payload);
  state.handleMultiSignCommand = (payload) => handleMultiSignCommand(state, payload);
  state.handleSignHashCommand = (payload) => handleSignHashCommand(state, payload);
  state.handleMultiSignHashCommand = (payload) => handleMultiSignHashCommand(state, payload);
  state.handleAddressCommand = (payload) => handleAddressCommand(state, payload);
  state.handleBalanceCommand = (payload) => handleBalanceCommand(state, payload);
  state.handleStatusCommand = (payload) => handleStatusCommand(state, payload);
  state.handleUtxoCommand = (payload) => handleUtxoCommand(state, payload);
  state.handleSendCommand = (payload) => handleSendCommand(state, payload);
  state.handleMultiSendCommand = (payload) => handleMultiSendCommand(state, payload);
  state.handleApproveCommand = (payload) => handleApproveCommand(state, payload);
  state.handleRejectCommand = (payload) => handleRejectCommand(state, payload);
  ensureStorageDir(state.storagePath);

  log("INFO", `Starting ${config.node.id} from ${configPath}`);
  await loadBotIdentity(state);

  const server = createHttpsServer(state, async ({ req, remoteIp, payload }) =>
    handlePeerRequest(state, req, remoteIp, payload)
  );
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.http.port, config.http.listenHost, resolve);
  });

  log(
    "INFO",
    `HTTPS peer server listening on https://${config.http.listenHost}:${config.http.port}`
  );

  await sendGroupEvent(
    state,
    `${config.node.id}: started`
  );
  await sendGroupEvent(state, buildStartupHelpMessage(state));

  const peerHealthTimer = startPeerHealthLoop(state);
  const roundCleanupTimer = startRoundCleanupLoop(state);
  const telegramTimer = startTelegramPollingLoop(state);

  function shutdown(signal) {
    if (state.shutdownRequested) {
      return;
    }

    state.shutdownRequested = true;
    log("INFO", `Received ${signal}, shutting down`);

    clearInterval(peerHealthTimer);
    clearInterval(roundCleanupTimer);
    clearInterval(telegramTimer);
    server.close(() => {
      log("INFO", "HTTPS server closed");
      process.exit(0);
    });
  }

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((error) => {
  log("ERROR", "Fatal startup error", error.stack || error.message);
  process.exit(1);
});

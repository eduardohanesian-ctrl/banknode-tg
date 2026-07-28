const { requestJson, createRequestId, log } = require("./crypto_backend");

const TELEGRAM_API_BASE = "https://api.telegram.org";

async function telegramApi(state, method, payload = {}) {
  const token = state.config.telegram.botToken;
  const url = `${TELEGRAM_API_BASE}/bot${token}/${method}`;
  const response = await requestJson(
    url,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
    },
    payload
  );

  if (response.statusCode !== 200 || !response.body || !response.body.ok) {
    throw new Error(`Telegram API ${method} failed`);
  }

  return response.body.result;
}

async function sendTelegramMessage(state, chatId, text) {
  return telegramApi(state, "sendMessage", {
    chat_id: chatId,
    text,
  });
}

async function loadBotIdentity(state) {
  const me = await telegramApi(state, "getMe");

  if (!me || !me.username) {
    throw new Error("Telegram getMe did not return username");
  }

  state.telegramBotId = me.id;
  state.telegramBotUsername = String(me.username).toLowerCase();
  log("INFO", `Telegram bot identity loaded: @${state.telegramBotUsername}`);
}

async function sendGroupEvent(state, text) {
  return sendTelegramMessage(state, state.config.telegram.allowedGroupId, text);
}

async function handleTelegramMessage(state, message) {
  if (!message || !message.chat || !message.from) {
    return;
  }

  const chatId = message.chat.id;
  const userId = message.from.id;
  const text = String(message.text || "").trim();

  if (chatId !== state.config.telegram.allowedGroupId) {
    return;
  }

  if (!text) {
    return;
  }

  const normalizedText = text.toLowerCase();
  const expectedCommand = `/create@${state.telegramBotUsername}`;
  const expectedAddressCommand = `/address@${state.telegramBotUsername}`;
  const expectedBalanceCommand = `/balance@${state.telegramBotUsername}`;
  const expectedBalancePrefix = `/balance@${state.telegramBotUsername} `;
  const expectedStatusCommand = `/status@${state.telegramBotUsername}`;
  const expectedUtxoCommand = `/utxo@${state.telegramBotUsername}`;
  const expectedApproveCommand = `/approve@${state.telegramBotUsername}`;
  const expectedRejectCommand = `/reject@${state.telegramBotUsername}`;
  const expectedSendCommand = `/send@${state.telegramBotUsername}`;
  const expectedSendPrefix = `/send@${state.telegramBotUsername} `;
  const expectedMultiSendCommand = `/multisend@${state.telegramBotUsername}`;
  const expectedMultiSendPrefix = `/multisend@${state.telegramBotUsername} `;
  const expectedSignCommand = `/sign@${state.telegramBotUsername}`;
  const expectedSignPrefix = `/sign@${state.telegramBotUsername} `;
  const expectedMultiSignCommand = `/multisign@${state.telegramBotUsername}`;
  const expectedMultiSignPrefix = `/multisign@${state.telegramBotUsername} `;
  const expectedSignHashCommand = `/signhash@${state.telegramBotUsername}`;
  const expectedSignHashPrefix = `/signhash@${state.telegramBotUsername} `;
  const expectedMultiSignHashCommand = `/multisignhash@${state.telegramBotUsername}`;
  const expectedMultiSignHashPrefix = `/multisignhash@${state.telegramBotUsername} `;
  const expectedCreatePrefix = `/create@${state.telegramBotUsername} `;

  if (normalizedText === expectedAddressCommand) {
    if (typeof state.handleAddressCommand === "function") {
      await state.handleAddressCommand({ chatId, userId });
    }
    return;
  }

  if (normalizedText === expectedBalanceCommand) {
    if (typeof state.handleBalanceCommand === "function") {
      await state.handleBalanceCommand({ chatId, userId, address: null });
    }
    return;
  }

  if (normalizedText.startsWith(expectedBalancePrefix)) {
    const address = text.slice(expectedBalancePrefix.length).trim();
    if (!address) {
      await sendTelegramMessage(
        state,
        chatId,
        "balance command format: /balance@bot [address]"
      );
      return;
    }

    if (typeof state.handleBalanceCommand === "function") {
      await state.handleBalanceCommand({ chatId, userId, address });
    }
    return;
  }

  if (normalizedText === expectedStatusCommand) {
    if (typeof state.handleStatusCommand === "function") {
      await state.handleStatusCommand({ chatId, userId });
    }
    return;
  }

  if (normalizedText === expectedUtxoCommand) {
    if (typeof state.handleUtxoCommand === "function") {
      await state.handleUtxoCommand({ chatId, userId });
    }
    return;
  }

  if (normalizedText === expectedApproveCommand) {
    if (typeof state.handleApproveCommand === "function") {
      await state.handleApproveCommand({ chatId, userId });
    }
    return;
  }

  if (normalizedText === expectedRejectCommand) {
    if (typeof state.handleRejectCommand === "function") {
      await state.handleRejectCommand({ chatId, userId });
    }
    return;
  }

  if (normalizedText !== expectedCommand) {
    if (normalizedText.startsWith(expectedCreatePrefix)) {
      const argsText = text.slice(expectedCreatePrefix.length).trim();
      const parts = argsText ? argsText.split(/\s+/).filter(Boolean) : [];
      if (parts.length !== 2 || !parts.every((part) => /^\d+$/.test(part))) {
        await sendTelegramMessage(
          state,
          chatId,
          "create command format: /create@bot or /create@bot <user_id2> <user_id3>"
        );
        return;
      }

      const requestId = createRequestId(state.config.node.id, userId);
      log("INFO", `Telegram create(group) received from user ${userId} request ${requestId}`);
      if (typeof state.handleCreateCommand === "function") {
        await state.handleCreateCommand({
          chatId,
          userId,
          requestId,
          groupUserIds: parts,
        });
        return;
      }
      return;
    }

    if (normalizedText === expectedSendCommand) {
      await sendTelegramMessage(
        state,
        chatId,
        "send command format: /send@bot <to_address> <amount_sats> <fee_rate>"
      );
      return;
    }

    if (normalizedText.startsWith(expectedSendPrefix)) {
      const argsText = text.slice(expectedSendPrefix.length).trim();
      const [toAddress = "", amountSatsRaw = "", feeRateRaw = ""] = argsText.split(/\s+/);
      if (!toAddress || !amountSatsRaw || !feeRateRaw) {
        await sendTelegramMessage(
          state,
          chatId,
          "send command format: /send@bot <to_address> <amount_sats> <fee_rate>"
        );
        return;
      }

      const requestId = createRequestId(state.config.node.id, userId);
      log("INFO", `Telegram send received from user ${userId} request ${requestId}`);
      if (typeof state.handleSendCommand === "function") {
        await state.handleSendCommand({
          chatId,
          userId,
          requestId,
          toAddress,
          amountSatsRaw,
          feeRateRaw,
        });
        return;
      }

      await sendTelegramMessage(state, chatId, `send accepted by ${state.config.node.id}, request ${requestId}`);
      return;
    }

    if (normalizedText === expectedMultiSendCommand) {
      await sendTelegramMessage(
        state,
        chatId,
        "multisend command format: /multisend@bot <user_id2> <user_id3> <to_address> <amount_sats> <fee_rate>"
      );
      return;
    }

    if (normalizedText.startsWith(expectedMultiSendPrefix)) {
      const argsText = text.slice(expectedMultiSendPrefix.length).trim();
      const parts = argsText.split(/\s+/).filter(Boolean);
      if (parts.length < 5 || !/^\d+$/.test(parts[0]) || !/^\d+$/.test(parts[1])) {
        await sendTelegramMessage(
          state,
          chatId,
          "multisend command format: /multisend@bot <user_id2> <user_id3> <to_address> <amount_sats> <fee_rate>"
        );
        return;
      }

      const [userId2, userId3, toAddress, amountSatsRaw, feeRateRaw] = parts;
      const requestId = createRequestId(state.config.node.id, userId);
      log("INFO", `Telegram multisend received from user ${userId} request ${requestId}`);
      if (typeof state.handleMultiSendCommand === "function") {
        await state.handleMultiSendCommand({
          chatId,
          userId,
          requestId,
          groupUserIds: [userId2, userId3],
          toAddress,
          amountSatsRaw,
          feeRateRaw,
        });
        return;
      }

      return;
    }

    if (normalizedText === expectedSignHashCommand) {
      await sendTelegramMessage(
        state,
        chatId,
        "signhash command format: /signhash@bot <32-byte-hex-hash>"
      );
      return;
    }

    if (normalizedText.startsWith(expectedSignHashPrefix)) {
      const messageHashHex = text.slice(expectedSignHashPrefix.length).trim();
      if (!messageHashHex) {
        await sendTelegramMessage(state, chatId, "signhash command requires a 32-byte hex hash");
        return;
      }

      const requestId = createRequestId(state.config.node.id, userId);
      log("INFO", `Telegram signhash received from user ${userId} request ${requestId}`);
      if (typeof state.handleSignHashCommand === "function") {
        await state.handleSignHashCommand({
          chatId,
          userId,
          requestId,
          messageHashHex,
        });
        return;
      }

      await sendTelegramMessage(
        state,
        chatId,
        `signhash accepted by ${state.config.node.id}, request ${requestId}`
      );
      return;
    }

    if (normalizedText === expectedMultiSignHashCommand) {
      await sendTelegramMessage(
        state,
        chatId,
        "multisignhash command format: /multisignhash@bot <user_id2> <user_id3> <32-byte-hex-hash>"
      );
      return;
    }

    if (normalizedText.startsWith(expectedMultiSignHashPrefix)) {
      const argsText = text.slice(expectedMultiSignHashPrefix.length).trim();
      const parts = argsText.split(/\s+/).filter(Boolean);
      if (parts.length < 3 || !/^\d+$/.test(parts[0]) || !/^\d+$/.test(parts[1])) {
        await sendTelegramMessage(
          state,
          chatId,
          "multisignhash command format: /multisignhash@bot <user_id2> <user_id3> <32-byte-hex-hash>"
        );
        return;
      }

      const [userId2, userId3, messageHashHex] = parts;
      const requestId = createRequestId(state.config.node.id, userId);
      log("INFO", `Telegram multisignhash received from user ${userId} request ${requestId}`);
      if (typeof state.handleMultiSignHashCommand === "function") {
        await state.handleMultiSignHashCommand({
          chatId,
          userId,
          requestId,
          groupUserIds: [userId2, userId3],
          messageHashHex,
        });
        return;
      }

      return;
    }

  if (normalizedText === expectedMultiSignCommand) {
    await sendTelegramMessage(
      state,
      chatId,
      "multisign command format: /multisign@bot <user_id2> <user_id3> <message>"
    );
    return;
  }

  if (normalizedText.startsWith(expectedMultiSignPrefix)) {
    const argsText = text.slice(expectedMultiSignPrefix.length).trim();
    const parts = argsText.split(/\s+/).filter(Boolean);
    if (parts.length < 3 || !/^\d+$/.test(parts[0]) || !/^\d+$/.test(parts[1])) {
      await sendTelegramMessage(
        state,
        chatId,
        "multisign command format: /multisign@bot <user_id2> <user_id3> <message>"
      );
      return;
    }

    const [userId2, userId3, ...messageParts] = parts;
    const messageText = messageParts.join(" ").trim();
    if (!messageText) {
      await sendTelegramMessage(
        state,
        chatId,
        "multisign command format: /multisign@bot <user_id2> <user_id3> <message>"
      );
      return;
    }

    const requestId = createRequestId(state.config.node.id, userId);
    log("INFO", `Telegram multisign received from user ${userId} request ${requestId}`);
    if (typeof state.handleMultiSignCommand === "function") {
      await state.handleMultiSignCommand({
        chatId,
        userId,
        requestId,
        groupUserIds: [userId2, userId3],
        messageText,
      });
      return;
    }

    return;
  }

    if (normalizedText === expectedSignCommand) {
      await sendTelegramMessage(
        state,
        chatId,
        "sign command format: /sign@bot <message>"
      );
      return;
    }

    if (!normalizedText.startsWith(expectedSignPrefix)) {
      return;
    }

    const messageText = text.slice(expectedSignPrefix.length).trim();
    if (!messageText) {
      await sendTelegramMessage(state, chatId, "sign command requires a message");
      return;
    }

    const requestId = createRequestId(state.config.node.id, userId);
    log("INFO", `Telegram sign received from user ${userId} request ${requestId}`);
    if (typeof state.handleSignCommand === "function") {
      await state.handleSignCommand({
        chatId,
        userId,
        requestId,
        messageText,
      });
      return;
    }

    await sendTelegramMessage(state, chatId, `sign accepted by ${state.config.node.id}, request ${requestId}`);
    return;
  }

  const requestId = createRequestId(state.config.node.id, userId);

  log("INFO", `Telegram create received from user ${userId} request ${requestId}`);
  if (typeof state.handleCreateCommand === "function") {
    await state.handleCreateCommand({
      chatId,
      userId,
      requestId,
      groupUserIds: null,
    });
    return;
  }

  await sendTelegramMessage(state, chatId, `create accepted by ${state.config.node.id}, request ${requestId}`);
}

async function pollTelegram(state) {
  if (state.telegramPollInFlight || state.shutdownRequested) {
    return;
  }

  state.telegramPollInFlight = true;

  try {
    const updates = await telegramApi(state, "getUpdates", {
      timeout: 20,
      offset: state.offset,
      allowed_updates: ["message"],
    });

    for (const update of updates) {
      state.offset = Math.max(state.offset, update.update_id + 1);
      if (update.message) {
        await handleTelegramMessage(state, update.message);
      }
    }
  } catch (error) {
    log("WARN", `Telegram polling failed: ${error.message}`);
  } finally {
    state.telegramPollInFlight = false;
  }
}

function startTelegramPollingLoop(state) {
  pollTelegram(state).catch((error) => log("WARN", `Initial telegram poll failed: ${error.message}`));
  return setInterval(() => {
    pollTelegram(state).catch((error) => log("WARN", `Telegram poll failed: ${error.message}`));
  }, 3000);
}

module.exports = {
  loadBotIdentity,
  sendGroupEvent,
  sendTelegramMessage,
  startTelegramPollingLoop,
};

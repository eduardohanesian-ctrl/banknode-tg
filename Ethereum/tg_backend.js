"use strict";

const { ethers } = require("ethers");
const { ETHEREUM_MAINNET_USDT, log, requestJson, walletKeyForUsers } = require("./crypto_backend");

const TELEGRAM_API_BASE = "https://api.telegram.org";
const TELEGRAM_LONG_POLL_TIMEOUT_MS = 40_000;
const TELEGRAM_SEND_TIMEOUT_MS = 10 * 60_000;
const TELEGRAM_DEFAULT_TIMEOUT_MS = 30_000;

function telegramRequestTimeout(method) {
  if (method === "getUpdates") return TELEGRAM_LONG_POLL_TIMEOUT_MS;
  if (method === "sendMessage") return TELEGRAM_SEND_TIMEOUT_MS;
  return TELEGRAM_DEFAULT_TIMEOUT_MS;
}

async function telegramApi(state, method, payload = {}) {
  const token = state.config.telegram.botToken;
  const response = await requestJson(`${TELEGRAM_API_BASE}/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    timeoutMs: telegramRequestTimeout(method),
  }, payload);
  if (response.statusCode !== 200 || !response.body?.ok) {
    throw new Error(`Telegram API ${method} failed: ${response.body?.description || response.statusCode}`);
  }
  return response.body.result;
}

async function sendTelegramMessage(state, chatId, text) {
  return telegramApi(state, "sendMessage", {
    chat_id: chatId,
    text: String(text).slice(0, 4000),
    disable_web_page_preview: true,
  });
}

async function sendGroupEvent(state, text) {
  return sendTelegramMessage(state, state.config.telegram.allowedGroupId, text);
}

async function loadBotIdentity(state) {
  const me = await telegramApi(state, "getMe");
  if (!me?.username) throw new Error("Telegram getMe did not return a username");
  state.telegramBotUsername = String(me.username).toLowerCase();
  state.telegramBotId = me.id;
  log("INFO", `Telegram bot identity loaded: @${state.telegramBotUsername}`);
}

function parseAddressedCommand(state, text) {
  const match = String(text || "").trim().match(/^\/([a-z]+)@([a-z0-9_]+)(?:\s+([\s\S]*))?$/i);
  if (!match || match[2].toLowerCase() !== state.telegramBotUsername) return null;
  return { command: match[1].toLowerCase(), tail: (match[3] || "").trim() };
}

function parseGroupTail(tail, remainingName) {
  const match = tail.match(/^(\d+)\s+(\d+)(?:\s+([\s\S]+))?$/);
  if (!match) throw new Error(`format: <user_id2> <user_id3> ${remainingName}`.trim());
  return { memberIds: [match[1], match[2]], rest: (match[3] || "").trim() };
}

function memberContext(requesterId, otherIds = []) {
  const members = [String(requesterId), ...otherIds.map(String)];
  return { members, walletKey: walletKeyForUsers(members) };
}

function mainnetUsdtAddress(state) {
  if (Number(state.config.ethereum?.chainId) !== 1) {
    throw new Error("USDT aliases are available only on Ethereum Mainnet (chainId 1)");
  }
  return ETHEREUM_MAINNET_USDT;
}

function orderedWalletsForUser(state, requesterId) {
  const personalWalletKey = memberContext(requesterId).walletKey;
  return [...state.actions.walletsForUser(requesterId)].sort((left, right) => {
    if (left.walletKey === personalWalletKey) return -1;
    if (right.walletKey === personalWalletKey) return 1;
    return left.walletKey.localeCompare(right.walletKey);
  });
}

function formatTokenBalance(balance, walletKey, symbolOverride) {
  return [
    ...(walletKey ? [walletKey] : []),
    `${balance.formatted} ${symbolOverride || balance.symbol}`,
    `base units: ${balance.raw}`,
    `token: ${balance.tokenAddress}`,
    `owner: ${balance.owner}`,
  ].join("\n");
}

async function allWalletTokenBalances(state, requesterId, tokenAddress, symbolOverride) {
  const wallets = orderedWalletsForUser(state, requesterId);
  if (!wallets.length) return null;
  const balances = await state.actions.tokenBalances(tokenAddress, wallets.map((wallet) => wallet.address));
  return balances.map((balance, index) =>
    formatTokenBalance(balance, wallets[index].walletKey, symbolOverride)
  ).join("\n\n");
}

async function handleCommand(state, message, parsed) {
  const requesterId = String(message.from.id);
  const chatId = message.chat.id;
  const reply = async (text) => {
    try {
      return await sendTelegramMessage(state, chatId, `${state.config.node.id}: ${text}`);
    } catch (error) {
      log("WARN", `Telegram reply delivery failed after command processing: ${error.message}`);
      return null;
    }
  };

  switch (parsed.command) {
    case "create": {
      let context;
      if (!parsed.tail) context = memberContext(requesterId);
      else {
        const group = parseGroupTail(parsed.tail, "");
        if (group.rest) throw new Error("create accepts exactly two additional user IDs");
        context = memberContext(requesterId, group.memberIds);
      }
      const result = await state.actions.create(context.walletKey, context.members);
      const lines = ["Ethereum address", result.address, "public key", result.publicKey];
      if (result.setupTiming) {
        lines.push(`create total: ${result.setupTiming.totalMs} ms`);
        for (const node of result.setupTiming.nodes || []) {
          lines.push(`Ntilde ${node.nodeId}: ${node.durationMs} ms (${node.generated ? "generated" : "cached"})`);
        }
      }
      return reply(lines.join("\n"));
    }
    case "address": {
      const wallets = state.actions.walletsForUser(requesterId);
      if (!wallets.length) return reply("no address; run /create first");
      return reply(wallets.map((w) => `${w.walletKey}\n${w.address}`).join("\n\n"));
    }
    case "balance": {
      let address = parsed.tail;
      if (!address) {
        const wallets = orderedWalletsForUser(state, requesterId);
        if (!wallets.length) return reply("no address; run /create first");
        const rows = await Promise.all(wallets.map(async (wallet) => ({
          wallet,
          balance: await state.actions.balance(wallet.address),
        })));
        return reply(rows.map(({ wallet, balance }) => [
          wallet.walletKey,
          wallet.address,
          `${balance.wei} wei`,
          `${balance.ether} ETH`,
        ].join("\n")).join("\n\n"));
      }
      if (!ethers.isAddress(address)) throw new Error("invalid Ethereum address");
      const balance = await state.actions.balance(address);
      return reply(`${ethers.getAddress(address)}\n${balance.wei} wei\n${balance.ether} ETH`);
    }
    case "tokenbalance": {
      const args = parsed.tail.split(/\s+/).filter(Boolean);
      if (args.length < 1 || args.length > 2) {
        throw new Error("format: /tokenbalance@bot <token_contract> [owner]");
      }
      const owner = args[1];
      if (!owner) {
        const text = await allWalletTokenBalances(state, requesterId, args[0]);
        return reply(text || "no address; run /create first");
      }
      const balance = await state.actions.tokenBalance(args[0], owner);
      return reply(formatTokenBalance(balance));
    }
    case "usdtbalance": {
      const args = parsed.tail.split(/\s+/).filter(Boolean);
      if (args.length > 1) throw new Error("format: /usdtbalance@bot [owner]");
      const tokenAddress = mainnetUsdtAddress(state);
      const owner = args[0];
      if (!owner) {
        const text = await allWalletTokenBalances(state, requesterId, tokenAddress, "USDT");
        return reply(text || "no address; run /create first");
      }
      const balance = await state.actions.tokenBalance(tokenAddress, owner);
      return reply(formatTokenBalance(balance, undefined, "USDT"));
    }
    case "utxo": {
      const wallet = state.actions.getWallet(memberContext(requesterId).walletKey);
      if (!wallet) return reply("no personal address; run /create first");
      const account = await state.actions.account(wallet.address);
      return reply(`Ethereum has no UTXO set\naddress: ${wallet.address}\nnonce: ${account.nonce}\nbalance: ${account.balance.wei} wei`);
    }
    case "status": {
      const status = await state.actions.status();
      return reply(status);
    }
    case "approve":
      return reply(await state.actions.resolveApproval(requesterId, true));
    case "reject":
      return reply(await state.actions.resolveApproval(requesterId, false));
    case "sign": {
      if (!parsed.tail) throw new Error("format: /sign@bot <message>");
      const context = memberContext(requesterId);
      const digestHex = ethers.hashMessage(parsed.tail);
      const result = await state.actions.sign({
        walletKey: context.walletKey,
        digest: Buffer.from(digestHex.slice(2), "hex"),
        requesterId,
        approverIds: [requesterId],
        description: `EIP-191 message from ${requesterId}: ${parsed.tail.slice(0, 300)}`,
      });
      return reply(`signature\n${result.signature}\nrecovered\n${result.recoveredAddress}`);
    }
    case "signhash": {
      if (!/^(?:0x)?[0-9a-fA-F]{64}$/.test(parsed.tail)) throw new Error("signhash requires exactly 32 bytes of hex");
      const context = memberContext(requesterId);
      const digest = Buffer.from(parsed.tail.replace(/^0x/, ""), "hex");
      const result = await state.actions.sign({
        walletKey: context.walletKey,
        digest,
        requesterId,
        approverIds: [requesterId],
        description: `raw digest 0x${digest.toString("hex")}`,
      });
      return reply(`signature\n${result.signature}\nrecovered\n${result.recoveredAddress}`);
    }
    case "send": {
      const args = parsed.tail.split(/\s+/).filter(Boolean);
      if (args.length < 2 || args.length > 3) throw new Error("format: /send@bot <to> <amount_wei> [max_fee_gwei]");
      const context = memberContext(requesterId);
      const result = await state.actions.send({
        walletKey: context.walletKey,
        to: args[0], valueWei: args[1], maxFeePerGasGwei: args[2],
        requesterId, approverIds: [requesterId],
      });
      return reply(`broadcast transaction\n${result.hash}`);
    }
    case "tokensend": {
      const args = parsed.tail.split(/\s+/).filter(Boolean);
      if (args.length < 3 || args.length > 4) {
        throw new Error("format: /tokensend@bot <token_contract> <to> <amount_tokens> [max_fee_gwei]");
      }
      const context = memberContext(requesterId);
      const result = await state.actions.tokenSend({
        walletKey: context.walletKey,
        tokenAddress: args[0],
        to: args[1],
        amount: args[2],
        maxFeePerGasGwei: args[3],
        requesterId,
        approverIds: [requesterId],
      });
      return reply(`broadcast ERC-20 transaction\n${result.hash}`);
    }
    case "usdtsend": {
      const args = parsed.tail.split(/\s+/).filter(Boolean);
      if (args.length < 2 || args.length > 3) {
        throw new Error("format: /usdtsend@bot <to> <amount_usdt> [max_fee_gwei]");
      }
      const context = memberContext(requesterId);
      const result = await state.actions.tokenSend({
        walletKey: context.walletKey,
        tokenAddress: mainnetUsdtAddress(state),
        to: args[0],
        amount: args[1],
        maxFeePerGasGwei: args[2],
        requesterId,
        approverIds: [requesterId],
      });
      return reply(`broadcast USDT transaction\n${result.hash}`);
    }
    case "multisign":
    case "multisignhash":
    case "multisend":
    case "multitokensend":
    case "usdtmultisend": {
      const remaining = parsed.command === "multisend"
        ? "<to> <amount_wei> [max_fee_gwei]"
        : parsed.command === "multitokensend"
          ? "<token_contract> <to> <amount_tokens> [max_fee_gwei]"
          : parsed.command === "usdtmultisend"
            ? "<to> <amount_usdt> [max_fee_gwei]"
            : "<message_or_hash>";
      const group = parseGroupTail(parsed.tail, remaining);
      const context = memberContext(requesterId, group.memberIds);
      const approverIds = group.memberIds;
      if (parsed.command === "multisign") {
        if (!group.rest) throw new Error("message is required");
        const digest = Buffer.from(ethers.hashMessage(group.rest).slice(2), "hex");
        const result = await state.actions.sign({ walletKey: context.walletKey, digest, requesterId, approverIds,
          description: `group EIP-191 message: ${group.rest.slice(0, 300)}` });
        return reply(`signature\n${result.signature}\nrecovered\n${result.recoveredAddress}`);
      }
      if (parsed.command === "multisignhash") {
        if (!/^(?:0x)?[0-9a-fA-F]{64}$/.test(group.rest)) throw new Error("multisignhash requires 32 bytes of hex");
        const digest = Buffer.from(group.rest.replace(/^0x/, ""), "hex");
        const result = await state.actions.sign({ walletKey: context.walletKey, digest, requesterId, approverIds,
          description: `group raw digest 0x${digest.toString("hex")}` });
        return reply(`signature\n${result.signature}\nrecovered\n${result.recoveredAddress}`);
      }
      if (parsed.command === "multitokensend") {
        const args = group.rest.split(/\s+/).filter(Boolean);
        if (args.length < 3 || args.length > 4) {
          throw new Error("format: /multitokensend@bot <id2> <id3> <token_contract> <to> <amount_tokens> [max_fee_gwei]");
        }
        const result = await state.actions.tokenSend({
          walletKey: context.walletKey,
          tokenAddress: args[0],
          to: args[1],
          amount: args[2],
          maxFeePerGasGwei: args[3],
          requesterId,
          approverIds,
        });
        return reply(`broadcast group ERC-20 transaction\n${result.hash}`);
      }
      if (parsed.command === "usdtmultisend") {
        const args = group.rest.split(/\s+/).filter(Boolean);
        if (args.length < 2 || args.length > 3) {
          throw new Error("format: /usdtmultisend@bot <id2> <id3> <to> <amount_usdt> [max_fee_gwei]");
        }
        const result = await state.actions.tokenSend({
          walletKey: context.walletKey,
          tokenAddress: mainnetUsdtAddress(state),
          to: args[0],
          amount: args[1],
          maxFeePerGasGwei: args[2],
          requesterId,
          approverIds,
        });
        return reply(`broadcast group USDT transaction\n${result.hash}`);
      }
      const args = group.rest.split(/\s+/).filter(Boolean);
      if (args.length < 2 || args.length > 3) throw new Error("format: /multisend@bot <id2> <id3> <to> <amount_wei> [max_fee_gwei]");
      const result = await state.actions.send({ walletKey: context.walletKey, to: args[0], valueWei: args[1],
        maxFeePerGasGwei: args[2], requesterId, approverIds });
      return reply(`broadcast transaction\n${result.hash}`);
    }
    case "help":
      return sendHelp(state);
    default:
      return undefined;
  }
}

async function handleTelegramMessage(state, message) {
  if (!message?.chat || !message?.from || message.chat.id !== state.config.telegram.allowedGroupId) return;
  const parsed = parseAddressedCommand(state, message.text);
  if (!parsed) return;
  try {
    await handleCommand(state, message, parsed);
  } catch (error) {
    if (error.code === "APPROVAL_REJECTED") {
      log("INFO", "Threshold signing request was rejected by the approver");
      await sendTelegramMessage(
        state,
        message.chat.id,
        `${state.config.node.id}: signing request rejected; transaction was not broadcast`
      );
      return;
    }
    log("ERROR", `Telegram command failed: ${error.stack || error.message}`);
    await sendTelegramMessage(state, message.chat.id, `${state.config.node.id}: ERROR: ${error.message}`);
  }
}

async function pollTelegram(state) {
  while (!state.stopping) {
    try {
      const updates = await telegramApi(state, "getUpdates", {
        offset: state.telegramOffset,
        timeout: 30,
        allowed_updates: ["message"],
      });
      for (const update of updates) {
        state.telegramOffset = Math.max(state.telegramOffset, update.update_id + 1);
        if (update.message) await handleTelegramMessage(state, update.message);
      }
    } catch (error) {
      log("ERROR", `Telegram polling error: ${error.message}`);
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
}

async function sendHelp(state) {
  const bot = state.telegramBotUsername;
  return sendGroupEvent(state, [
    `${state.config.node.id}: Ethereum threshold ECDSA commands`,
    `/create@${bot}`,
    `/create@${bot} <user_id2> <user_id3>`,
    `/address@${bot}`,
    `/balance@${bot} [address]`,
    `/tokenbalance@${bot} <token_contract> [owner]`,
    `/usdtbalance@${bot} [owner]`,
    `/utxo@${bot}`,
    `/status@${bot}`,
    `/sign@${bot} <message>`,
    `/signhash@${bot} <32-byte-hex>`,
    `/send@${bot} <to> <amount_wei> [max_fee_gwei]`,
    "amount_wei 0 = send maximum pending ETH balance minus maximum EIP-1559 fee",
    `/tokensend@${bot} <token_contract> <to> <amount_tokens> [max_fee_gwei]`,
    `/usdtsend@${bot} <to> <amount_usdt> [max_fee_gwei]`,
    `/multisign@${bot} <id2> <id3> <message>`,
    `/multisignhash@${bot} <id2> <id3> <32-byte-hex>`,
    `/multisend@${bot} <id2> <id3> <to> <amount_wei> [max_fee_gwei]`,
    `/multitokensend@${bot} <id2> <id3> <token_contract> <to> <amount_tokens> [max_fee_gwei]`,
    `/usdtmultisend@${bot} <id2> <id3> <to> <amount_usdt> [max_fee_gwei]`,
    `/approve@${bot}`,
    `/reject@${bot}`,
  ].join("\n"));
}

module.exports = {
  handleCommand,
  handleTelegramMessage,
  loadBotIdentity,
  mainnetUsdtAddress,
  pollTelegram,
  sendGroupEvent,
  sendHelp,
  sendTelegramMessage,
  telegramRequestTimeout,
  telegramApi,
};

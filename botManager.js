import TelegramBot from "node-telegram-bot-api";
import { db } from "./firebase.js";

const bots = new Map();

export async function getBot(botId) {
  if (bots.has(botId)) return bots.get(botId);

  const snap = await db.collection("telegramBots").doc(botId).get();
  if (!snap.exists) throw new Error("Bot config not found");

  const config = snap.data();

  const bot = new TelegramBot(config.token, { polling: false });

  const instance = { bot, config };
  bots.set(botId, instance);

  return instance;
}

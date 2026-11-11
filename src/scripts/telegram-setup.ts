import axios from "axios";
import { env } from "../config/env";
import { ARABIC_STRINGS } from "../services/format";
import { sendTelegramPayloadWithRetry } from "../services/telegram";
import { httpClient } from "../utils/http";
import { logger, maskSecrets } from "../utils/logger";

interface TelegramGetMeResponse {
  ok: boolean;
  result?: {
    id: number;
    is_bot: boolean;
    first_name: string;
    username?: string;
  };
  description?: string;
}

interface TelegramChatInfo {
  id: number;
  type: string;
  title?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
}

interface TelegramUpdateItem {
  update_id: number;
  message?: { chat?: TelegramChatInfo };
  edited_message?: { chat?: TelegramChatInfo };
  channel_post?: { chat?: TelegramChatInfo };
  my_chat_member?: { chat?: TelegramChatInfo };
}

interface TelegramGetUpdatesResponse {
  ok: boolean;
  result?: TelegramUpdateItem[];
  description?: string;
}

function printMissingTokenInstructions(): void {
  console.error(
    [
      "================================================================================",
      "❌ TELEGRAM_BOT_TOKEN is missing / مفتاح بوت تيليجرام غير موجود (TELEGRAM_BOT_TOKEN)",
      "================================================================================",
      "",
      "🇸🇦 خطوات إعداد بوت تيليجرام (بالعربية):",
      "1. افتح تطبيق تيليجرام وابحث عن الحساب الرسمي: @BotFather",
      "2. أرسل الأمر /newbot واتبع التعليمات لاختيار اسم ومعرّف البوت.",
      "3. انسخ رمز البوت (Token) وضعه في ملف .env بالشكل التالي:",
      '   TELEGRAM_BOT_TOKEN="123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ"',
      "4. افتح محادثة مع البوت الجديد واضغط زر Start (أو أرسل أي رسالة).",
      "5. أعد تشغيل الأمر: npm run telegram:setup لاكتشاف TELEGRAM_CHAT_ID تلقائياً.",
      "",
      "🇬🇧 How to set up your Telegram Bot (English):",
      "1. Open Telegram and message @BotFather.",
      "2. Send /newbot and follow the prompts to name your bot.",
      "3. Copy the HTTP API token into your .env file:",
      '   TELEGRAM_BOT_TOKEN="123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ"',
      "4. Open a chat with your new bot and press Start (or send any message).",
      "5. Re-run: npm run telegram:setup to discover your TELEGRAM_CHAT_ID.",
      "================================================================================",
    ].join("\n")
  );
}

async function runTelegramSetup(): Promise<void> {
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    printMissingTokenInstructions();
    process.exit(1);
  }

  // Step 2: Call getMe and print the bot username
  let botUsername = "unknown_bot";
  try {
    const meRes = await httpClient.get<TelegramGetMeResponse>(
      `https://api.telegram.org/bot${token}/getMe`
    );
    const bot = meRes.data?.result;
    botUsername = bot?.username ? `@${bot.username}` : bot?.first_name || "bot";
    console.log(
      `✅ Connected to Telegram Bot / تم الاتصال بالبوت: ${botUsername} (id: ${bot?.id})`
    );
  } catch (err) {
    let detail = err instanceof Error ? maskSecrets(err.message) : String(err);
    if (axios.isAxiosError(err) && err.response?.data) {
      const desc = (err.response.data as { description?: string }).description;
      if (desc) detail = `${detail} — ${maskSecrets(desc)}`;
    }
    console.error(
      `❌ Failed to verify TELEGRAM_BOT_TOKEN via getMe / فشل التحقق من رمز البوت: ${detail}`
    );
    process.exit(1);
  }

  // Step 3: If TELEGRAM_CHAT_ID is missing, call getUpdates and list chats
  const chatId = env.TELEGRAM_CHAT_ID;
  if (!chatId) {
    try {
      const updatesRes = await httpClient.get<TelegramGetUpdatesResponse>(
        `https://api.telegram.org/bot${token}/getUpdates`
      );
      const updates = updatesRes.data?.result ?? [];
      const chats = new Map<number, TelegramChatInfo>();

      for (const u of updates) {
        const chat =
          u.message?.chat ||
          u.edited_message?.chat ||
          u.channel_post?.chat ||
          u.my_chat_member?.chat;
        if (chat && typeof chat.id === "number") {
          chats.set(chat.id, chat);
        }
      }

      if (chats.size === 0) {
        console.log(
          [
            "",
            "⚠️ لم يتم العثور على أي محادثات بعد / No chats found in getUpdates!",
            `1. افتح البوت ${botUsername} في تيليجرام واضغط زر Start (أو أرسل كلمة مرحبا).`,
            `   Open ${botUsername} in Telegram and press Start (or send any message).`,
            "2. أعد تشغيل الأمر: npm run telegram:setup",
            "   Re-run: npm run telegram:setup",
          ].join("\n")
        );
        return;
      }

      console.log(
        "\n📋 المحادثات المكتشفة / Discovered Chats (copy TELEGRAM_CHAT_ID into .env):"
      );
      for (const chat of chats.values()) {
        const displayName =
          chat.title ||
          [chat.first_name, chat.last_name].filter(Boolean).join(" ") ||
          chat.username ||
          "Unknown";
        const handle = chat.username ? ` (@${chat.username})` : "";
        console.log(
          `  • chat.id = "${chat.id}" | type: ${chat.type} | name: ${displayName}${handle}`
        );
      }

      const firstId = Array.from(chats.keys())[0];
      console.log(
        [
          "",
          "👉 أضف السطر التالي إلى ملف .env الخاص بك ثم أعد تشغيل npm run telegram:setup:",
          "👉 Add the following line to your .env file and re-run npm run telegram:setup:",
          `   TELEGRAM_CHAT_ID="${firstId}"`,
        ].join("\n")
      );
      return;
    } catch (err) {
      const detail = err instanceof Error ? maskSecrets(err.message) : String(err);
      logger.error("Failed to fetch getUpdates from Telegram", { error: detail });
      process.exit(1);
    }
  }

  // Step 4: TELEGRAM_CHAT_ID is set -> send Arabic test message
  console.log(
    `📤 Sending Arabic test message to chat_id=${chatId} / جاري إرسال رسالة تجريبية...`
  );
  const res = await sendTelegramPayloadWithRetry(token, chatId, {
    text: ARABIC_STRINGS.telegramTestSuccess,
  });

  if (res.ok) {
    console.log(
      `🎉 Success! Test message sent ("${ARABIC_STRINGS.telegramTestSuccess}").`
    );
  } else {
    console.error(`❌ Failed to send test message: ${res.error}`);
    process.exit(1);
  }
}

runTelegramSetup().catch((err) => {
  logger.error("Unexpected error in telegram:setup", {
    error: err instanceof Error ? maskSecrets(err.message) : String(err),
  });
  process.exit(1);
});


import {
  Client,
  GatewayIntentBits,
  Events,
  TextChannel,
  Message,
} from "npm:discord.js@14.14.1";

import { BOT_VERSION } from "../util/version-check.ts";

// ================================
// Types
// ================================

export interface MentionBotConfig {
  discordToken: string;
  workDir: string;
}

/**
 * Callback invoked when the bot receives a @mention.
 * 
 * @param prompt - The user's message text (with bot mention removed)
 * @param context - Metadata about the Discord context (channel ID, guild ID, etc.)
 * @param reply - Function to send a reply back to the channel
 * @param sendTyping - Function to show typing indicator
 */
export type MentionHandler = (
  prompt: string,
  context: MentionContext,
  reply: (text: string) => Promise<void>,
  sendTyping: () => Promise<void>,
) => Promise<void>;

export interface MentionContext {
  channelId: string;
  guildId: string | null;
  /** Thread/forum thread ID if the message was sent inside a thread */
  threadId: string | null;
  /** The user who mentioned the bot */
  userId: string;
  username: string;
  /** The original message object for advanced use */
  messageId: string;
  /** URLs of image attachments (JPEG, PNG, GIF, WebP) */
  imageUrls: string[];
}

// ================================
// Main Bot Creation Function
// ================================

export async function createMentionBot(
  config: MentionBotConfig,
  onMention: MentionHandler,
) {
  const { discordToken } = config;

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  // ---- Ready event ----
  client.once(Events.ClientReady, () => {
    console.log(`Bot logged in: ${client.user?.tag}`);
    console.log(`Bot ID: ${client.user?.id}`);
    console.log(`Version: v${BOT_VERSION}`);
    console.log(`Listening for @mentions in all channels...`);
  });

  // ---- Message handler ----
  client.on(Events.MessageCreate, async (message: Message) => {
    // Ignore messages from bots (including self)
    if (message.author.bot) return;

    // Only react when the bot is @mentioned
    if (!client.user || !message.mentions.has(client.user.id)) return;

    // Extract the prompt: remove the bot mention from the text
    const botMentionPattern = new RegExp(`<@!?${client.user.id}>`, "g");
    const prompt = message.content.replace(botMentionPattern, "").trim();

    // Extract image attachment URLs
    const imageContentTypes = ["image/jpeg", "image/png", "image/gif", "image/webp"];
    const imageUrls = message.attachments
      .filter(a => a.contentType && imageContentTypes.includes(a.contentType))
      .map(a => a.url);

    // If the message is just a mention with no text and no images, ignore it
    if (!prompt && imageUrls.length === 0) {
      await message.reply("何かメッセージを添えてメンションしてください！");
      return;
    }

    // Build context metadata
    const context: MentionContext = {
      channelId: message.channelId,
      guildId: message.guildId,
      threadId: message.channel.isThread() ? message.channelId : null,
      userId: message.author.id,
      username: message.author.username,
      messageId: message.id,
      imageUrls,
    };

    // Reply helper: sends a normal text reply, splitting if over 2000 chars
    const reply = async (text: string) => {
      if (!text) return;

      const chunks = splitMessage(text, 2000);
      for (let i = 0; i < chunks.length; i++) {
        if (i === 0) {
          // First chunk: reply to the original message
          await message.reply(chunks[i]);
        } else {
          // Subsequent chunks: send as follow-up messages in the same channel
          await message.channel.send(chunks[i]);
        }
      }
    };

    // Typing indicator helper
    const sendTyping = async () => {
      try {
        await message.channel.sendTyping();
      } catch {
        // Ignore typing errors
      }
    };

    // Call the handler
    try {
      await onMention(prompt, context, reply, sendTyping);
    } catch (error) {
      console.error("Error handling mention:", error);
      try {
        await message.reply(
          `エラーが発生しました: ${error instanceof Error ? error.message : "Unknown error"}`,
        );
      } catch {
        // Ignore error-sending errors
      }
    }
  });

  // Login
  await client.login(discordToken);

  return {
    client,
    destroy() {
      client.destroy();
    },
  };
}

// ================================
// Helpers
// ================================

/**
 * Split a message into chunks that fit within Discord's character limit.
 * Tries to split at newlines or spaces when possible.
 */
function splitMessage(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    // Try to find a good split point (newline, then space)
    let splitAt = remaining.lastIndexOf("\n", maxLength);
    if (splitAt === -1 || splitAt < maxLength * 0.5) {
      splitAt = remaining.lastIndexOf(" ", maxLength);
    }
    if (splitAt === -1 || splitAt < maxLength * 0.5) {
      splitAt = maxLength;
    }

    chunks.push(remaining.substring(0, splitAt));
    remaining = remaining.substring(splitAt).trimStart();
  }

  return chunks;
}
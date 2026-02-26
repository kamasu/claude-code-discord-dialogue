import {
  Client,
  GatewayIntentBits,
  Events,
  TextChannel,
  Message,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  type Interaction,
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
 * Helpers provided to the mention handler for Discord interaction.
 */
export interface MentionHelpers {
  /** Send a reply to the original message (with @mention for notification) */
  reply: (text: string) => Promise<void>;
  /** Show typing indicator in the channel */
  sendTyping: () => Promise<void>;
  /** Send a normal (non-reply) message for progress updates. Returns the sent Message for later edit/delete. */
  sendProgress: (text: string) => Promise<Message>;
  /** Edit an existing progress message */
  editProgress: (msg: Message, text: string) => Promise<void>;
  /** Delete a progress message */
  deleteProgress: (msg: Message) => Promise<void>;
  /** Send a progress message with a cancel button. Returns the sent Message. */
  sendProgressWithCancel: (text: string, cancelId: string) => Promise<Message>;
  /** Edit a progress message while keeping the cancel button. */
  editProgressWithCancel: (msg: Message, text: string, cancelId: string) => Promise<void>;
  /** Disable the cancel button (e.g. after completion or cancellation). */
  disableCancelButton: (msg: Message) => Promise<void>;
  /** Register a cancel callback for a given cancel ID. */
  registerCancel: (cancelId: string, callback: () => void) => void;
  /** Unregister a cancel callback. */
  unregisterCancel: (cancelId: string) => void;
}

/**
 * Callback invoked when the bot receives a @mention.
 * 
 * @param prompt - The user's message text (with bot mention removed)
 * @param context - Metadata about the Discord context (channel ID, guild ID, etc.)
 * @param helpers - Functions to interact with Discord (reply, progress, typing)
 */
export type MentionHandler = (
  prompt: string,
  context: MentionContext,
  helpers: MentionHelpers,
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
}

// ================================
// Main Bot Creation Function
// ================================

export async function createMentionBot(
  config: MentionBotConfig,
  onMention: MentionHandler,
) {
  const { discordToken } = config;

  // Registry for cancel callbacks: cancelId → abort callback
  const cancelCallbacks = new Map<string, () => void>();

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  // ---- Button interaction handler ----
  client.on(Events.InteractionCreate, async (interaction: Interaction) => {
    if (!interaction.isButton()) return;

    const cancelId = interaction.customId;
    const callback = cancelCallbacks.get(cancelId);
    if (!callback) {
      // Not a cancel button we're tracking — ignore
      try {
        await interaction.deferUpdate();
      } catch { /* ignore */ }
      return;
    }

    // Execute the cancel callback
    callback();

    // Acknowledge the interaction and update the button to show cancelled state
    try {
      await interaction.update({
        components: [createCancelButtonRow(cancelId, true)],
      });
    } catch {
      // Ignore interaction errors
    }
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

    // If the message is just a mention with no text, ignore it
    if (!prompt) {
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
    };

    // Reply helper: sends a reply with @mention for notification, splitting if over 2000 chars
    const reply = async (text: string) => {
      if (!text) return;

      // Prepend @mention so the user gets a notification
      const mentionPrefix = `<@${message.author.id}> `;
      const firstChunkLimit = 2000 - mentionPrefix.length;

      const chunks = splitMessage(text, 2000);
      for (let i = 0; i < chunks.length; i++) {
        if (i === 0) {
          // First chunk: reply to the original message with @mention
          const content = chunks[i].length <= firstChunkLimit
            ? mentionPrefix + chunks[i]
            : mentionPrefix + chunks[i].substring(0, firstChunkLimit);
          await message.reply(content);
          // If we had to truncate, send the rest
          if (chunks[i].length > firstChunkLimit) {
            await message.channel.send(chunks[i].substring(firstChunkLimit));
          }
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

    // Progress message helpers (normal messages, not replies)
    const sendProgress = async (text: string): Promise<Message> => {
      return await message.channel.send(text);
    };

    const editProgress = async (msg: Message, text: string): Promise<void> => {
      try {
        await msg.edit(text);
      } catch {
        // Ignore edit errors (message may have been deleted)
      }
    };

    const deleteProgress = async (msg: Message): Promise<void> => {
      try {
        await msg.delete();
      } catch {
        // Ignore delete errors (message may already be deleted)
      }
    };

    // Cancel button helpers
    const sendProgressWithCancel = async (text: string, cancelId: string): Promise<Message> => {
      return await message.channel.send({
        content: text,
        components: [createCancelButtonRow(cancelId, false)],
      });
    };

    const editProgressWithCancel = async (msg: Message, text: string, cancelId: string): Promise<void> => {
      try {
        await msg.edit({
          content: text,
          components: [createCancelButtonRow(cancelId, false)],
        });
      } catch {
        // Ignore edit errors
      }
    };

    const disableCancelButton = async (msg: Message): Promise<void> => {
      try {
        await msg.edit({ components: [] });
      } catch {
        // Ignore errors — message may already be deleted
      }
    };

    const registerCancel = (cancelId: string, callback: () => void) => {
      cancelCallbacks.set(cancelId, callback);
    };

    const unregisterCancel = (cancelId: string) => {
      cancelCallbacks.delete(cancelId);
    };

    // Build helpers object
    const helpers: MentionHelpers = {
      reply,
      sendTyping,
      sendProgress,
      editProgress,
      deleteProgress,
      sendProgressWithCancel,
      editProgressWithCancel,
      disableCancelButton,
      registerCancel,
      unregisterCancel,
    };

    // Call the handler
    try {
      await onMention(prompt, context, helpers);
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
 * Create an ActionRow with a cancel button.
 * @param cancelId - Unique ID for this cancel button
 * @param disabled - Whether the button should be disabled
 */
function createCancelButtonRow(cancelId: string, disabled: boolean) {
  const button = new ButtonBuilder()
    .setCustomId(cancelId)
    .setLabel(disabled ? 'キャンセル済み' : 'キャンセル')
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(disabled);

  return new ActionRowBuilder<ButtonBuilder>().addComponents(button);
}

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
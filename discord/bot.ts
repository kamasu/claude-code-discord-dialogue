import {
  Client,
  GatewayIntentBits,
  Events,
  TextChannel,
  Message,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
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
  /** Add an emoji reaction to the original message */
  addReaction: (emoji: string) => Promise<void>;
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
  /** Send a progress message with "追加指示" and "キャンセル" buttons. */
  sendProgressWithButtons: (text: string, cancelId: string, instructionId: string) => Promise<Message>;
  /** Edit a progress message while keeping both buttons. */
  editProgressWithButtons: (msg: Message, text: string, cancelId: string, instructionId: string) => Promise<void>;
  /** Register a callback for additional instructions (modal submit + reply detection). */
  registerInstructionCallback: (instructionId: string, progressMsgId: string, callback: InstructionCallback) => void;
  /** Unregister an instruction callback. */
  unregisterInstructionCallback: (instructionId: string, progressMsgId: string) => void;
  /** Send a reply to the original message without @mention (for logging). Returns the sent Message. */
  sendReplyToOriginal: (text: string) => Promise<Message>;
  /** Edit an existing message's content. */
  editMessage: (msg: Message, text: string) => Promise<void>;
  /** Send a reply to a specific message (with @mention for notification). */
  replyToMessage: (targetMsg: Message, text: string) => Promise<void>;
  /** Send a reply to the original message (with @mention) and return the first sent Message. */
  replyAndReturn: (text: string) => Promise<Message | null>;
}

/**
 * Callback invoked when a user sends additional instructions via modal or reply.
 */
export type InstructionCallback = (text: string, userId: string, username: string) => void;

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
  // Registry for instruction callbacks: instructionId → callback (for modal submit)
  const instructionCallbacks = new Map<string, InstructionCallback>();
  // Registry for reply callbacks: progressMsgId → callback (for reply detection)
  const replyCallbacks = new Map<string, InstructionCallback>();

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  // ---- Interaction handler (buttons + modals) ----
  client.on(Events.InteractionCreate, async (interaction: Interaction) => {
    // Handle modal submissions (追加指示)
    if ('isModalSubmit' in interaction && (interaction as any).isModalSubmit()) {
      const modalInteraction = interaction as any;
      const modalId: string = modalInteraction.customId;
      if (modalId.startsWith('modal-instruction-')) {
        const instructionId = modalId.replace('modal-', '');
        const callback = instructionCallbacks.get(instructionId);
        if (callback) {
          const text = modalInteraction.fields.getTextInputValue('instruction-text');
          if (text?.trim()) {
            callback(text.trim(), modalInteraction.user.id, modalInteraction.user.username);
          }
          try {
            await modalInteraction.reply({ content: '📝 追加指示を受け付けました！', ephemeral: true });
          } catch {
            try { await modalInteraction.deferUpdate(); } catch { /* ignore */ }
          }
        } else {
          // Callback not found — processing already completed
          try {
            await modalInteraction.reply({ content: '⚠️ 処理は既に完了しています。新しいメッセージで指示してください。', ephemeral: true });
          } catch {
            try { await modalInteraction.deferUpdate(); } catch { /* ignore */ }
          }
        }
      }
      return;
    }

    if (!interaction.isButton()) return;

    // Handle "追加指示" button → show modal
    if (interaction.customId.startsWith('instruction-')) {
      const instructionId = interaction.customId;
      const modal = new ModalBuilder()
        .setCustomId(`modal-${instructionId}`)
        .setTitle('追加指示');
      const textInput = new TextInputBuilder()
        .setCustomId('instruction-text')
        .setLabel('追加の指示を入力してください')
        .setStyle(TextInputStyle.Paragraph)
        .setPlaceholder('例: あと○○も考慮して')
        .setRequired(true);
      const row = new ActionRowBuilder<TextInputBuilder>().addComponents(textInput);
      modal.addComponents(row);
      try {
        await interaction.showModal(modal);
      } catch { /* ignore */ }
      return;
    }

    // Handle cancel button
    if (interaction.customId.startsWith('cancel-')) {
      const cancelId = interaction.customId;
      const callback = cancelCallbacks.get(cancelId);
      if (!callback) {
        try { await interaction.deferUpdate(); } catch { /* ignore */ }
        return;
      }
      callback();
      // Disable both buttons
      const suffix = cancelId.replace('cancel-', '');
      const instructionId = `instruction-${suffix}`;
      try {
        await interaction.update({
          components: [createProgressButtonRow(cancelId, instructionId, true)],
        });
      } catch { /* ignore */ }
      return;
    }

    // Unknown button — acknowledge silently
    try { await interaction.deferUpdate(); } catch { /* ignore */ }
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
    // Ignore own messages only — react to all other bots
    if (client.user && message.author.id === client.user.id) return;

    // Check if this message is a reply to an active progress message (追加指示)
    if (message.reference?.messageId) {
      const replyCallback = replyCallbacks.get(message.reference.messageId);
      if (replyCallback) {
        const text = message.content.trim();
        if (text) {
          replyCallback(text, message.author.id, message.author.username);
          try { await message.react('📝'); } catch { /* ignore */ }
        }
        return; // Reply to progress message takes priority over @mention
      }
    }

    // Only react when the bot is @mentioned
    if (!client.user || !message.mentions.has(client.user.id)) return;

    // Extract the prompt: remove the bot mention from the text
    const botMentionPattern = new RegExp(`<@!?${client.user.id}>`, "g");
    const prompt = message.content.replace(botMentionPattern, "").trim();

    // Empty mentions are allowed (confirmation mentions, follow-up mentions, etc.)

    // Build context metadata
    const context: MentionContext = {
      channelId: message.channelId,
      guildId: message.guildId,
      threadId: message.channel.isThread() ? message.channelId : null,
      userId: message.author.id,
      username: message.author.username,
      messageId: message.id,
    };

    // Reaction helper: add emoji reaction to the original message
    const addReaction = async (emoji: string) => {
      try {
        await message.react(emoji);
      } catch {
        // Ignore reaction errors
      }
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

    // Progress message with both "追加指示" and "キャンセル" buttons
    const sendProgressWithButtons = async (text: string, cancelId: string, instructionId: string): Promise<Message> => {
      return await message.channel.send({
        content: text,
        components: [createProgressButtonRow(cancelId, instructionId, false)],
      });
    };

    const editProgressWithButtons = async (msg: Message, text: string, cancelId: string, instructionId: string): Promise<void> => {
      try {
        await msg.edit({
          content: text,
          components: [createProgressButtonRow(cancelId, instructionId, false)],
        });
      } catch { /* ignore */ }
    };

    // Instruction callback registration (for both modal and reply detection)
    const registerInstructionCallback = (instructionId: string, progressMsgId: string, callback: InstructionCallback) => {
      instructionCallbacks.set(instructionId, callback);
      replyCallbacks.set(progressMsgId, callback);
    };

    const unregisterInstructionCallback = (instructionId: string, progressMsgId: string) => {
      instructionCallbacks.delete(instructionId);
      replyCallbacks.delete(progressMsgId);
    };

    // Send a reply to the original message without @mention (for logging purposes)
    const sendReplyToOriginal = async (text: string): Promise<Message> => {
      return await message.reply({
        content: text,
        allowedMentions: { repliedUser: false },
      });
    };

    // Edit an existing message's content
    const editMessage = async (msg: Message, text: string): Promise<void> => {
      try {
        await msg.edit(text);
      } catch {
        // Ignore edit errors (message may have been deleted)
      }
    };

    // Send a reply to a specific message (with @mention for notification, splitting if needed)
    const replyToMessage = async (targetMsg: Message, text: string): Promise<void> => {
      if (!text) return;
      const mentionPrefix = `<@${message.author.id}> `;
      const firstChunkLimit = 2000 - mentionPrefix.length;
      const chunks = splitMessage(text, 2000);
      for (let i = 0; i < chunks.length; i++) {
        if (i === 0) {
          const content = chunks[i].length <= firstChunkLimit
            ? mentionPrefix + chunks[i]
            : mentionPrefix + chunks[i].substring(0, firstChunkLimit);
          await targetMsg.reply(content);
          if (chunks[i].length > firstChunkLimit) {
            await message.channel.send(chunks[i].substring(firstChunkLimit));
          }
        } else {
          await message.channel.send(chunks[i]);
        }
      }
    };

    // Reply to original message with @mention, returns the first sent Message
    const replyAndReturn = async (text: string): Promise<Message | null> => {
      if (!text) return null;
      const mentionPrefix = `<@${message.author.id}> `;
      const firstChunkLimit = 2000 - mentionPrefix.length;
      const chunks = splitMessage(text, 2000);
      let firstMsg: Message | null = null;
      for (let i = 0; i < chunks.length; i++) {
        if (i === 0) {
          const content = chunks[i].length <= firstChunkLimit
            ? mentionPrefix + chunks[i]
            : mentionPrefix + chunks[i].substring(0, firstChunkLimit);
          firstMsg = await message.reply(content);
          if (chunks[i].length > firstChunkLimit) {
            await message.channel.send(chunks[i].substring(firstChunkLimit));
          }
        } else {
          await message.channel.send(chunks[i]);
        }
      }
      return firstMsg;
    };

    // Build helpers object
    const helpers: MentionHelpers = {
      addReaction,
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
      sendProgressWithButtons,
      editProgressWithButtons,
      registerInstructionCallback,
      unregisterInstructionCallback,
      sendReplyToOriginal,
      editMessage,
      replyToMessage,
      replyAndReturn,
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
 * Create an ActionRow with "追加指示" and "キャンセル" buttons.
 */
function createProgressButtonRow(cancelId: string, instructionId: string, disabled: boolean) {
  const instructionButton = new ButtonBuilder()
    .setCustomId(instructionId)
    .setLabel('追加指示')
    .setStyle(ButtonStyle.Primary)
    .setDisabled(disabled);

  const cancelButton = new ButtonBuilder()
    .setCustomId(cancelId)
    .setLabel(disabled ? 'キャンセル済み' : 'キャンセル')
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(disabled);

  return new ActionRowBuilder<ButtonBuilder>().addComponents(instructionButton, cancelButton);
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
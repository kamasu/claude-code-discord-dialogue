#!/usr/bin/env -S deno run --allow-all

/**
 * Claude Code Discord Bot — Mention-Only Entry Point
 * 
 * A simple Discord bot that responds to @mentions by invoking Claude Code.
 * Claude can use MCP servers (Discord, Notion, etc.) to search for context.
 * 
 * @module index
 */

import { createMentionBot, type MentionContext } from "./discord/bot.ts";
import { sendToClaudeCode, type ClaudeModelOptions } from "./claude/client.ts";

// ================================
// .env Auto-Load
// ================================

async function loadEnvFile(): Promise<void> {
  try {
    const envPath = `${Deno.cwd()}/.env`;
    const stat = await Deno.stat(envPath).catch(() => null);
    if (!stat?.isFile) return;

    const content = await Deno.readTextFile(envPath);
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      const eqIndex = trimmed.indexOf('=');
      if (eqIndex === -1) continue;

      const key = trimmed.substring(0, eqIndex).trim();
      let value = trimmed.substring(eqIndex + 1).trim();

      // Remove surrounding quotes
      if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }

      if (!Deno.env.get(key) && key && value) {
        Deno.env.set(key, value);
      }
    }
    console.log('✓ Loaded configuration from .env file');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Note: Could not load .env file: ${message}`);
  }
}

// ================================
// Mention → Claude Code Handler
// ================================

/**
 * Build the prompt that gets sent to Claude Code when a user mentions the bot.
 * Includes Discord context metadata so Claude can use MCP tools to look up messages.
 */
function buildPrompt(userMessage: string, ctx: MentionContext): string {
  const parts: string[] = [];

  parts.push(`<discord-context>`);
  parts.push(`Channel ID: ${ctx.channelId}`);
  if (ctx.guildId) parts.push(`Guild ID: ${ctx.guildId}`);
  if (ctx.threadId) parts.push(`Thread ID: ${ctx.threadId}`);
  parts.push(`User: ${ctx.username} (ID: ${ctx.userId})`);
  parts.push(`Message ID: ${ctx.messageId}`);
  parts.push(`</discord-context>`);
  parts.push('');
  parts.push(userMessage);

  return parts.join('\n');
}

// ================================
// Main
// ================================

if (import.meta.main) {
  try {
    await loadEnvFile();

    const discordToken = Deno.env.get("DISCORD_TOKEN");
    if (!discordToken) {
      console.error("Error: DISCORD_TOKEN is required. Set it in .env or as an environment variable.");
      Deno.exit(1);
    }

    const workDir = Deno.env.get("WORK_DIR") || Deno.cwd();

    // Track active Claude session per channel to allow conversation continuity
    const channelSessions = new Map<string, string>(); // channelId → sessionId

    console.log(`Starting mention-only bot...`);
    console.log(`Working directory: ${workDir}`);

    const bot = await createMentionBot(
      { discordToken, workDir },
      async (prompt, context, helpers) => {
        // Reset command — clear session without calling Claude
        if (prompt === "リセット" || prompt === "reset") {
          channelSessions.clear();
          await helpers.reply("✅ セッションをリセットしました！新しい会話を始められます🐶");
          return;
        }

        // Show typing indicator
        await helpers.sendTyping();

        // Set up a periodic typing indicator (Discord typing lasts ~10s)
        const typingInterval = setInterval(async () => {
          try { await helpers.sendTyping(); } catch { /* ignore */ }
        }, 8000);

        // Generate a unique cancel ID for this request
        const cancelId = `cancel-${context.messageId}-${Date.now()}`;

        // Send initial progress message with cancel button
        // deno-lint-ignore no-explicit-any
        let progressMsg: any = null;
        try {
          progressMsg = await helpers.sendProgressWithCancel("はい、確認します！🐶", cancelId);
        } catch {
          // Ignore if progress message fails
        }

        // Debounce state for progress edits (avoid Discord rate limits)
        let lastEditTime = 0;
        let pendingEditText: string | null = null;
        let pendingEditTimer: ReturnType<typeof setTimeout> | null = null;
        const EDIT_DEBOUNCE_MS = 2000;

        const updateProgress = (rawText: string) => {
          if (!progressMsg) return;

          // Cap at 1500 chars to stay within Discord's 2000-char limit
          const text = rawText.length > 1500 ? rawText.substring(0, 1500) + '...' : rawText;

          const now = Date.now();
          const timeSinceLastEdit = now - lastEditTime;

          if (timeSinceLastEdit >= EDIT_DEBOUNCE_MS) {
            // Enough time has passed — edit immediately
            lastEditTime = now;
            pendingEditText = null;
            helpers.editProgressWithCancel(progressMsg, text, cancelId).catch(() => { });
          } else {
            // Too soon — schedule a debounced edit
            pendingEditText = text;
            if (pendingEditTimer) clearTimeout(pendingEditTimer);
            pendingEditTimer = setTimeout(() => {
              if (pendingEditText && progressMsg) {
                lastEditTime = Date.now();
                helpers.editProgressWithCancel(progressMsg, pendingEditText, cancelId).catch(() => { });
                pendingEditText = null;
              }
            }, EDIT_DEBOUNCE_MS - timeSinceLastEdit);
          }
        };

        try {
          const controller = new AbortController();

          // Register cancel callback: button click → abort
          helpers.registerCancel(cancelId, () => {
            console.log(`[Cancel] User cancelled request: ${cancelId}`);
            controller.abort();
          });

          // Build prompt with Discord context metadata
          const fullPrompt = buildPrompt(prompt, context);

          // Get existing session for this channel (if any) for conversation continuity
          const existingSessionId = channelSessions.get(context.channelId);

          // Model options — uses claude login auth (no API key needed)
          const modelOptions: ClaudeModelOptions = {
            permissionMode: "bypassPermissions",
          };

          // onStreamJson callback — update progress message with rich details
          // deno-lint-ignore no-explicit-any
          const onStreamJson = (message: any) => {
            try {
              if (message.type === 'assistant' && message.message?.content) {
                // deno-lint-ignore no-explicit-any
                const content = message.message.content as any[];

                // Check for thinking blocks → show Claude's thought process
                // deno-lint-ignore no-explicit-any
                const thinkingBlocks = content.filter((c: any) => c.type === 'thinking' && c.thinking);
                if (thinkingBlocks.length > 0) {
                  const thought = thinkingBlocks[thinkingBlocks.length - 1].thinking;
                  updateProgress(`🐶💭 ${thought}`);
                  return;
                }

                // Check for tool_use blocks → show tool name + input summary
                // deno-lint-ignore no-explicit-any
                const toolUses = content.filter((c: any) => c.type === 'tool_use');
                if (toolUses.length > 0) {
                  const lastTool = toolUses[toolUses.length - 1];
                  const toolName = (lastTool.name || 'unknown')
                    .replace(/^mcp__\w+__/, '')  // Remove MCP prefix
                    .replace(/_/g, ' ');

                  // Extract a meaningful summary from tool input
                  const input = lastTool.input || {};
                  const inputSummary = summarizeToolInput(toolName, input);
                  const line = inputSummary
                    ? `🐶 ${toolName} を調べてるワン！\n${inputSummary}`
                    : `🐶 ${toolName} をフェッチ中ワン！`;
                  updateProgress(line);
                  return;
                }

                // Check for text content → show preview of what Claude is writing
                // deno-lint-ignore no-explicit-any
                const textBlocks = content.filter((c: any) => c.type === 'text' && c.text);
                if (textBlocks.length > 0) {
                  const fullText = textBlocks.map((c: { text: string }) => c.text).join('');
                  if (fullText.trim()) {
                    updateProgress(`🐶 書いてるワン！\n\n${fullText}`);
                    return;
                  }
                }
              }

              // Tool result received — Claude is processing results
              if (message.type === 'tool_result' || message.type === 'result') {
                updateProgress("🐶 もぐもぐ... 結果を読んでるワン");
              }
            } catch {
              // Ignore progress update errors
            }
          };

          // Summarize tool input for progress display
          // deno-lint-ignore no-explicit-any
          const summarizeToolInput = (toolName: string, input: any): string => {
            try {
              // Search-related tools — show query/content
              if (input.query) return `🔍 「${truncate(input.query, 80)}」`;
              if (input.content) return `🔍 「${truncate(input.content, 80)}」`;

              // Message sending — show destination
              if (input.message) return `💬 「${truncate(input.message, 80)}」`;

              // Read/retrieve — show what's being read
              if (input.page_id) return `📄 ページ: ${input.page_id.substring(0, 8)}...`;
              if (input.channelId) return `📺 チャンネル: ${input.channelId}`;
              if (input.threadId) return `🧵 スレッド: ${input.threadId}`;

              // File operations
              if (input.path || input.file_path) return `📂 ${input.path || input.file_path}`;
              if (input.command) return `$ ${truncate(input.command, 80)}`;

              // Generic: show first key-value pair if available
              const keys = Object.keys(input).filter(k => typeof input[k] === 'string');
              if (keys.length > 0) {
                return `${keys[0]}: ${truncate(input[keys[0]], 60)}`;
              }
              return '';
            } catch {
              return '';
            }
          };

          const truncate = (s: string, max: number): string =>
            s.length > max ? s.substring(0, max) + '...' : s;

          // Call Claude Code with streaming progress
          const result = await sendToClaudeCode(
            workDir,
            fullPrompt,
            controller,
            existingSessionId,
            undefined,     // onChunk — not needed, we use onStreamJson
            onStreamJson,  // streaming progress updates
            false,         // continueMode
            modelOptions,
          );

          // Store session ID for conversation continuity
          if (result.sessionId) {
            channelSessions.set(context.channelId, result.sessionId);
          }

          // Cancel any pending debounced edit
          if (pendingEditTimer) clearTimeout(pendingEditTimer);

          // Clean up cancel registration
          helpers.unregisterCancel(cancelId);

          // Check if the request was cancelled
          if (result.response === "Request was cancelled") {
            // Silently delete the progress message
            if (progressMsg) {
              await helpers.deleteProgress(progressMsg);
            }
          } else {
            // Delete the progress message
            if (progressMsg) {
              await helpers.deleteProgress(progressMsg);
            }

            // Reply with the final response (as a reply with @mention)
            const response = result.response || "応答がありませんでした。";
            await helpers.reply(response);
          }

        } finally {
          clearInterval(typingInterval);
          // Clean up pending timer if still active
          if (pendingEditTimer) clearTimeout(pendingEditTimer);
          // Ensure cancel callback is cleaned up
          helpers.unregisterCancel(cancelId);
        }
      },
    );

    console.log("✓ Bot has started. Press Ctrl+C to stop.");

    // Graceful shutdown
    const handleSignal = () => {
      console.log("\nShutting down...");
      bot.destroy();
      Deno.exit(0);
    };

    try {
      Deno.addSignalListener("SIGINT", handleSignal);
      if (Deno.build.os !== "windows") {
        Deno.addSignalListener("SIGTERM", handleSignal);
      }
    } catch {
      // Signal registration may fail on some platforms
    }

  } catch (error) {
    console.error("Failed to start bot:", error);
    Deno.exit(1);
  }
}

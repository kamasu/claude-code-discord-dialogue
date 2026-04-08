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
import { sendToClaudeCode, type ClaudeModelOptions, type ThinkingConfig, type EffortLevel } from "./claude/client.ts";
import { interruptActiveQuery } from "./claude/query-manager.ts";

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
// Config Helpers
// ================================

/**
 * Parse CLAUDE_THINKING env var into ThinkingConfig.
 * Formats: "adaptive" | "disabled" | "enabled:10000" (with budgetTokens)
 */
function parseThinkingConfig(value?: string): ThinkingConfig | undefined {
  if (!value) return undefined;
  const v = value.trim().toLowerCase();
  if (v === "adaptive") return { type: "adaptive" };
  if (v === "disabled") return { type: "disabled" };
  if (v.startsWith("enabled")) {
    const parts = v.split(":");
    const budget = parts[1] ? parseInt(parts[1], 10) : 10000;
    return { type: "enabled", budgetTokens: isNaN(budget) ? 10000 : budget };
  }
  console.warn(`[Config] Unknown CLAUDE_THINKING value: "${value}", ignoring.`);
  return undefined;
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

        // Generate unique IDs for cancel and instruction buttons (shared suffix for pairing)
        // Using `let` so they can be re-pointed for follow-up queries
        const idSuffix = `${context.messageId}-${Date.now()}`;
        let cancelId = `cancel-${idSuffix}`;
        let instructionId = `instruction-${idSuffix}`;

        // Queue for additional instructions received during processing
        // deno-lint-ignore no-explicit-any
        const additionalInstructions: Array<{ text: string; userId: string; username: string; logMessage: any }> = [];
        let shouldInterrupt = false;  // Flag: interrupt requested, will fire at next onStreamJson
        let interruptTriggered = false;  // Debounce: only call interrupt once per query iteration

        // Send initial progress message with "追加指示" and "キャンセル" buttons
        // deno-lint-ignore no-explicit-any
        let progressMsg: any = null;
        let progressMsgId: string | null = null;
        try {
          progressMsg = await helpers.sendProgressWithButtons("ワン！確認します🐶", cancelId, instructionId);
          if (progressMsg) progressMsgId = progressMsg.id;
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
            helpers.editProgressWithButtons(progressMsg, text, cancelId, instructionId).catch(() => { });
          } else {
            // Too soon — schedule a debounced edit
            pendingEditText = text;
            if (pendingEditTimer) clearTimeout(pendingEditTimer);
            pendingEditTimer = setTimeout(() => {
              if (pendingEditText && progressMsg) {
                lastEditTime = Date.now();
                helpers.editProgressWithButtons(progressMsg, pendingEditText, cancelId, instructionId).catch(() => { });
                pendingEditText = null;
              }
            }, EDIT_DEBOUNCE_MS - timeSinceLastEdit);
          }
        };

        // Track whether processing is complete (for post-completion instruction handling)
        let processingComplete = false;
        // Track the last response message sent by inu (for post-completion reply target)
        // deno-lint-ignore no-explicit-any
        let lastResponseMsg: any = null;

        try {
          const controller = new AbortController();

          // Register cancel callback: button click → abort
          helpers.registerCancel(cancelId, () => {
            console.log(`[Cancel] User cancelled request: ${cancelId}`);
            controller.abort();
          });

          // Instruction callback: modal submit or reply → queue + log + set interrupt flag
          const instructionCallback = (text: string, userId: string, username: string) => {
            // Push synchronously so the main loop sees it immediately
            // deno-lint-ignore no-explicit-any
            const entry = { text, userId, username, logMessage: null as any };
            additionalInstructions.push(entry);
            console.log(`[AdditionalInstruction] Queued from ${username}: ${text.substring(0, 80)}...`);

            if (processingComplete) {
              // ---- POST-COMPLETION: handle as a new request ----
              (async () => {
                // Post log reply → immediately mark as 送信済
                try {
                  entry.logMessage = await helpers.sendReplyToOriginal(
                    `📝 **追加指示 (送信済 ✅):**\n${text}`
                  );
                } catch { /* ignore */ }

                // Process as new request in the same session
                const currentSessionId = channelSessions.get(context.channelId);
                const instrPrompt = buildPrompt(
                  `追加指示 (from ${username}): ${text}`,
                  context,
                );

                // Show typing and new progress
                await helpers.sendTyping();
                // deno-lint-ignore no-explicit-any
                let postProgressMsg: any = null;
                const postIdSuffix = `post-${context.messageId}-${Date.now()}`;
                const postCancelId = `cancel-${postIdSuffix}`;
                try {
                  const truncatedText = text.length > 100 ? text.substring(0, 100) + '…' : text;
                  postProgressMsg = await helpers.sendProgress(`📝 追加指示を処理中ワン！🐶\n> ${truncatedText}`);
                } catch { /* ignore */ }

                try {
                  const postResult = await sendToClaudeCode(
                    workDir,
                    instrPrompt,
                    new AbortController(),
                    currentSessionId,
                    undefined,
                    undefined,  // No streaming progress for post-completion
                    false,
                    modelOptions,
                  );

                  if (postResult.sessionId) {
                    channelSessions.set(context.channelId, postResult.sessionId);
                  }
                  if (postProgressMsg) await helpers.deleteProgress(postProgressMsg);

                  if (postResult.response && postResult.response !== "Request was cancelled") {
                    // Reply to inu's last response (not the original user message)
                    if (lastResponseMsg) {
                      await helpers.replyToMessage(lastResponseMsg, postResult.response);
                    } else {
                      await helpers.reply(postResult.response);
                    }
                  }
                } catch (err) {
                  console.error("[AdditionalInstruction] Post-completion failed:", err);
                  if (postProgressMsg) await helpers.deleteProgress(postProgressMsg);
                  await helpers.reply(
                    `追加指示の処理中にエラーが発生しました: ${err instanceof Error ? err.message : "Unknown error"}`
                  );
                }
              })();
              return;
            }

            // ---- DURING PROCESSING: queue + log + set interrupt flag ----
            // Set flag for onStreamJson to trigger interrupt at turn boundary
            shouldInterrupt = true;

            // Fire-and-forget: post visible log message
            (async () => {
              try {
                entry.logMessage = await helpers.sendReplyToOriginal(
                  `📝 **追加指示 (処理待ち):**\n${text}`
                );
              } catch { /* ignore */ }

              // Update progress to show receipt confirmation
              if (progressMsg) {
                const count = additionalInstructions.length;
                const notice = `\n\n📝 追加指示を${count}件受け付けました！次の区切りで処理します。`;
                helpers.editProgressWithButtons(progressMsg, `🐶 処理中...${notice}`, cancelId, instructionId).catch(() => {});
              }
            })();
          };

          // Register instruction callback
          if (progressMsgId) {
            helpers.registerInstructionCallback(instructionId, progressMsgId, instructionCallback);
          }

          // Build prompt with Discord context metadata
          const fullPrompt = buildPrompt(prompt, context);

          // Get existing session for this channel (if any) for conversation continuity
          const existingSessionId = channelSessions.get(context.channelId);

          // Model options — uses claude login auth (no API key needed)
          const claudeModel = Deno.env.get("CLAUDE_MODEL");
          const claudeThinking = parseThinkingConfig(Deno.env.get("CLAUDE_THINKING"));
          const claudeEffort = Deno.env.get("CLAUDE_EFFORT") as EffortLevel | undefined;
          const modelOptions: ClaudeModelOptions = {
            permissionMode: "bypassPermissions",
            ...(claudeModel && { model: claudeModel }),
            ...(claudeThinking && { thinking: claudeThinking }),
            ...(claudeEffort && { effort: claudeEffort }),
          };

          // onStreamJson callback — update progress + interrupt at turn boundaries
          let wasInterrupted = false;
          // deno-lint-ignore no-explicit-any
          const onStreamJson = (message: any) => {
            try {
              // ---- INTERRUPT CHECK at turn boundaries ----
              if (shouldInterrupt && !interruptTriggered) {
                interruptTriggered = true;
                interruptActiveQuery().then(success => {
                  if (success) {
                    wasInterrupted = true;
                    console.log(`[AdditionalInstruction] Interrupt triggered at turn boundary (type=${message.type})`);
                  } else {
                    console.log(`[AdditionalInstruction] Interrupt failed (query may have completed)`);
                  }
                }).catch(() => {});
              }

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

          // Helper: send response (handles REACTION_ONLY pattern)
          // If replyTarget is provided, replies to that message instead of the original
          // Returns the sent Message (or null for reactions)
          // deno-lint-ignore no-explicit-any
          const sendResponse = async (response: string, replyTarget?: any): Promise<any> => {
            const reactionMatch = response.trim().match(/\[REACTION_ONLY:(.+?)\]/);
            if (reactionMatch) {
              const emojis = reactionMatch[1].split(",");
              for (const emoji of emojis) {
                await helpers.addReaction(emoji.trim());
              }
              return null;
            } else if (replyTarget) {
              await helpers.replyToMessage(replyTarget, response);
              return null; // replyToMessage doesn't return message
            } else {
              return await helpers.replyAndReturn(response);
            }
          };

          // Helper: drain queued instructions, update log messages, build combined prompt
          const drainInstructions = (): { prompt: string; summary: string } => {
            const toProcess = additionalInstructions.splice(0);
            // Update log messages to "送信済"
            for (const instr of toProcess) {
              if (instr.logMessage) {
                helpers.editMessage(instr.logMessage, `📝 **追加指示 (送信済 ✅):**\n${instr.text}`).catch(() => {});
              }
            }
            // Build combined prompt
            const combined = toProcess
              .map((instr, i) => {
                const prefix = toProcess.length === 1
                  ? `追加指示 (from ${instr.username})`
                  : `追加指示${i + 1} (from ${instr.username})`;
                return `${prefix}: ${instr.text}`;
              })
              .join('\n');
            // Build summary of instruction texts for display
            const summary = toProcess.map(instr => instr.text).join(' / ');
            const truncatedSummary = summary.length > 100 ? summary.substring(0, 100) + '…' : summary;
            return { prompt: buildPrompt(combined, context), summary: truncatedSummary };
          };

          // ===== MAIN PROCESSING LOOP =====
          let currentPrompt = fullPrompt;
          let currentSessionId = existingSessionId;

          while (true) {
            // Reset interrupt state for this iteration
            wasInterrupted = false;
            shouldInterrupt = false;
            interruptTriggered = false;

            // Call Claude Code with streaming progress
            const result = await sendToClaudeCode(
              workDir,
              currentPrompt,
              controller,
              currentSessionId,
              undefined,     // onChunk — not needed, we use onStreamJson
              onStreamJson,  // streaming progress updates
              false,         // continueMode
              modelOptions,
            );

            // Store session ID for conversation continuity
            if (result.sessionId) {
              channelSessions.set(context.channelId, result.sessionId);
              currentSessionId = result.sessionId;
            }

            // Cancel any pending debounced edit
            if (pendingEditTimer) clearTimeout(pendingEditTimer);

            // Check if the request was cancelled
            if (result.response === "Request was cancelled") {
              if (progressMsg) await helpers.deleteProgress(progressMsg);
              break;
            }

            // ---- INTERRUPTED PATH: interrupt fired, instructions pending ----
            if (wasInterrupted && additionalInstructions.length > 0 && currentSessionId) {
              // Don't send partial response, don't delete progress
              // Drain instructions and resume session
              const drained = drainInstructions();
              currentPrompt = drained.prompt;

              // Update progress message
              if (progressMsg) {
                helpers.editProgressWithButtons(
                  progressMsg, `📝 追加指示を処理中ワン！🐶\n> ${drained.summary}`, cancelId, instructionId
                ).catch(() => {});
              }

              // Reset debounce state for next iteration
              lastEditTime = 0;
              pendingEditText = null;

              continue; // Back to top of loop
            }

            // ---- NATURAL COMPLETION PATH ----
            // Delete progress and send the response
            if (progressMsg) await helpers.deleteProgress(progressMsg);
            progressMsg = null;
            const sentMsg = await sendResponse(result.response || "応答がありませんでした。");
            if (sentMsg) lastResponseMsg = sentMsg;

            // Check if instructions arrived at completion (race window)
            if (additionalInstructions.length > 0 && currentSessionId) {
              // Drain instructions and continue
              const drained = drainInstructions();
              currentPrompt = drained.prompt;

              // New progress message for follow-up
              const followUpIdSuffix = `followup-${context.messageId}-${Date.now()}`;
              const followUpCancelId = `cancel-${followUpIdSuffix}`;
              const followUpInstructionId = `instruction-${followUpIdSuffix}`;
              try {
                progressMsg = await helpers.sendProgressWithButtons(
                  `📝 追加指示を処理中ワン！🐶\n> ${drained.summary}`,
                  followUpCancelId,
                  followUpInstructionId,
                );
                progressMsgId = progressMsg?.id || null;
              } catch { /* ignore */ }

              // Re-register callbacks with new IDs
              cancelId = followUpCancelId;
              instructionId = followUpInstructionId;
              helpers.registerCancel(cancelId, () => {
                console.log(`[Cancel] User cancelled follow-up: ${cancelId}`);
                controller.abort();
              });
              if (progressMsgId) {
                helpers.registerInstructionCallback(instructionId, progressMsgId, instructionCallback);
              }

              // Reset debounce state
              lastEditTime = 0;
              pendingEditText = null;

              continue; // Back to top of loop
            }

            // No more instructions — done
            break;
          }

          // ===== POST-COMPLETION: keep callbacks alive for late instructions =====
          processingComplete = true;

          // Keep callbacks registered for 2 minutes for post-completion instructions.
          // The instructionCallback checks processingComplete and handles them as new requests.
          setTimeout(() => {
            helpers.unregisterCancel(cancelId);
            if (progressMsgId) helpers.unregisterInstructionCallback(instructionId, progressMsgId);
          }, 2 * 60 * 1000);

        } finally {
          clearInterval(typingInterval);
          if (pendingEditTimer) clearTimeout(pendingEditTimer);
          // Note: if processingComplete, callbacks are cleaned up by the 2-minute timeout
          if (!processingComplete) {
            helpers.unregisterCancel(cancelId);
            if (progressMsgId) helpers.unregisterInstructionCallback(instructionId, progressMsgId);
          }
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

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
/** Image data for Claude Vision */
interface ImageData {
  base64: string;
  mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
}

/** Download an image from URL and return base64-encoded data */
async function downloadImageAsBase64(url: string): Promise<ImageData | null> {
  try {
    const response = await fetch(url);
    if (!response.ok) return null;

    const contentType = response.headers.get("content-type") || "image/png";
    const mediaType = contentType.split(";")[0].trim() as ImageData["mediaType"];
    const buffer = await response.arrayBuffer();

    // Encode to base64
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (const byte of bytes) {
      binary += String.fromCharCode(byte);
    }
    const base64 = btoa(binary);

    return { base64, mediaType };
  } catch (error) {
    console.error(`Failed to download image: ${url}`, error);
    return null;
  }
}

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
  parts.push(userMessage || '（画像が添付されています。内容を確認してください）');

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
      async (prompt, context, reply, sendTyping) => {
        // Show typing indicator
        await sendTyping();

        // Set up a periodic typing indicator (Discord typing lasts ~10s)
        const typingInterval = setInterval(async () => {
          try { await sendTyping(); } catch { /* ignore */ }
        }, 8000);

        try {
          const controller = new AbortController();

          // Build prompt with Discord context metadata
          const fullPrompt = buildPrompt(prompt, context);

          // Download and encode image attachments (if any)
          const images: ImageData[] = [];
          if (context.imageUrls.length > 0) {
            console.log(`Downloading ${context.imageUrls.length} image(s)...`);
            const results = await Promise.all(
              context.imageUrls.map(url => downloadImageAsBase64(url))
            );
            for (const img of results) {
              if (img) images.push(img);
            }
            console.log(`Successfully downloaded ${images.length} image(s)`);
          }

          // Get existing session for this channel (if any) for conversation continuity
          const existingSessionId = channelSessions.get(context.channelId);

          // Model options — uses claude login auth (no API key needed)
          const modelOptions: ClaudeModelOptions = {
            permissionMode: "bypassPermissions",
          };

          // Call Claude Code
          const result = await sendToClaudeCode(
            workDir,
            fullPrompt,
            controller,
            existingSessionId,
            undefined, // onChunk (not using streaming to Discord for now)
            undefined, // onStreamJson
            false,     // continueMode
            modelOptions,
            images.length > 0 ? images : undefined, // image attachments
          );

          // Store session ID for conversation continuity
          if (result.sessionId) {
            channelSessions.set(context.channelId, result.sessionId);
          }

          // Reply with the response
          const response = result.response || "応答がありませんでした。";
          await reply(response);

        } finally {
          clearInterval(typingInterval);
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

/**
 * Delayed / Polling execution scheduler.
 *
 * The bot process is long-lived, so it can hold in-memory timers that re-invoke
 * Claude after a delay — no cron, no shared-file races. Pending jobs are also
 * persisted to a JSON file and re-armed on startup so they survive a bot restart
 * / redeploy.
 *
 * Two command shapes are recognised on the FIRST LINE of a Claude response
 * (first-line matching prevents accidental triggers from mid-text mentions):
 *
 *   1. One-shot delayed execution:
 *        遅延実行:20m
 *        <2行目以降 = 後で実行するAI向け命令（自己完結で書く）>
 *
 *   2. Polling (single message is edited each cycle to reduce noise):
 *        ポーリング:30s:20        （間隔30秒・最大20回。回数は省略可）
 *        <2行目以降 = 毎サイクル確認するAI向け命令>
 *
 * A fired poll cycle asks Claude to reply with either:
 *        ポーリング継続: <状況一言>   → status message is edited, timer re-armed
 *        ポーリング完了              → status finalised + a NEW completion message
 */

import type { Client } from "discord.js";
import { sendToClaudeCode, type ClaudeModelOptions } from "../claude/client.ts";

// ================================
// Tunables (clamped ranges)
// ================================
const ONESHOT_MIN_MS = 5_000;
const ONESHOT_MAX_MS = 3 * 60 * 60 * 1000; // 3h
const POLL_MIN_INTERVAL_MS = 10_000;
const POLL_MAX_INTERVAL_MS = 60 * 60 * 1000; // 1h
const POLL_DEFAULT_MAX_ATTEMPTS = 20;
const POLL_MAX_MAX_ATTEMPTS = 60;
const DISCORD_LIMIT = 2000;

// ================================
// Types
// ================================
export interface DelayedContext {
  channelId: string;
  guildId: string | null;
  threadId: string | null;
  userId: string;
  username: string;
  messageId: string;
}

interface StoredJob {
  id: string;
  type: "oneshot" | "poll";
  channelId: string;
  guildId: string | null;
  threadId: string | null;
  instruction: string;
  fireAt: number;
  // poll-only
  statusMessageId?: string;
  intervalMs?: number;
  maxAttempts?: number;
  attempts?: number;
  startedAt?: number;
  summary?: string;
  lastStatus?: string;
}

export interface ParsedCommand {
  kind: "oneshot" | "poll";
  instruction: string;
  delayMs?: number; // oneshot
  intervalMs?: number; // poll
  maxAttempts?: number; // poll
  summary?: string;
}

// ================================
// Parsing helpers
// ================================

/** Parse a duration token like "30s", "10m", "2h", or bare seconds "90". */
export function parseDuration(raw: string): number | null {
  const s = raw.trim();
  const m = s.match(/^(\d+(?:\.\d+)?)\s*(s|sec|m|min|h|hour)?$/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!isFinite(n) || n <= 0) return null;
  const unit = (m[2] || "s").toLowerCase();
  if (unit.startsWith("h")) return n * 60 * 60 * 1000;
  if (unit.startsWith("m")) return n * 60 * 1000;
  return n * 1000; // s / sec / default
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

/**
 * Parse the FIRST LINE of a response for a delayed/polling start command.
 * Returns null if the first line is not a recognised command.
 */
export function parseStartCommand(response: string): ParsedCommand | null {
  const text = response.replace(/^﻿/, "");
  const nl = text.indexOf("\n");
  const firstLine = (nl === -1 ? text : text.slice(0, nl)).trim();
  const rest = nl === -1 ? "" : text.slice(nl + 1).trim();

  // One-shot: 遅延実行:<duration>
  let m = firstLine.match(/^遅延実行\s*[:：]\s*(\S+)$/);
  if (m) {
    const ms = parseDuration(m[1]);
    if (ms == null) return null;
    return {
      kind: "oneshot",
      instruction: rest,
      delayMs: clamp(ms, ONESHOT_MIN_MS, ONESHOT_MAX_MS),
      summary: firstSummary(rest),
    };
  }

  // Polling: ポーリング:<interval>[:<maxAttempts>]
  m = firstLine.match(/^ポーリング\s*[:：]\s*([^:：\s]+)(?:\s*[:：]\s*(\d+))?$/);
  if (m) {
    const interval = parseDuration(m[1]);
    if (interval == null) return null;
    const maxAttempts = m[2]
      ? clamp(parseInt(m[2], 10), 1, POLL_MAX_MAX_ATTEMPTS)
      : POLL_DEFAULT_MAX_ATTEMPTS;
    return {
      kind: "poll",
      instruction: rest,
      intervalMs: clamp(interval, POLL_MIN_INTERVAL_MS, POLL_MAX_INTERVAL_MS),
      maxAttempts,
      summary: firstSummary(rest),
    };
  }

  return null;
}

/** Detect a poll-cycle reply: continue vs complete. */
function parsePollReply(
  response: string,
): { kind: "continue"; status: string } | { kind: "complete"; body: string } | null {
  const text = response.replace(/^﻿/, "");
  const nl = text.indexOf("\n");
  const firstLine = (nl === -1 ? text : text.slice(0, nl)).trim();
  const rest = nl === -1 ? "" : text.slice(nl + 1).trim();

  let m = firstLine.match(/^ポーリング継続\s*[:：]?\s*(.*)$/);
  if (m) return { kind: "continue", status: m[1].trim() };

  m = firstLine.match(/^ポーリング完了\s*[:：]?\s*(.*)$/);
  if (m) {
    const body = [m[1].trim(), rest].filter(Boolean).join("\n").trim();
    return { kind: "complete", body };
  }

  return null;
}

function firstSummary(instruction: string): string {
  const line = instruction.split("\n").map((l) => l.trim()).find((l) => l.length > 0) || "";
  return line.length > 60 ? line.slice(0, 60) + "…" : line;
}

// ================================
// Scheduler
// ================================
export interface DelayedSchedulerDeps {
  client: Client;
  workDir: string;
  channelSessions: Map<string, string>;
  getModelOptions: () => ClaudeModelOptions;
  persistPath: string;
}

export class DelayedScheduler {
  private jobs = new Map<string, StoredJob>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private seq = 0;

  constructor(private deps: DelayedSchedulerDeps) {}

  /** Load persisted jobs and re-arm their timers. Call once after the bot is ready. */
  async init(): Promise<void> {
    let stored: StoredJob[] = [];
    try {
      const raw = await Deno.readTextFile(this.deps.persistPath);
      stored = JSON.parse(raw) as StoredJob[];
    } catch {
      stored = []; // no file yet → nothing to restore
    }
    for (const job of stored) {
      this.jobs.set(job.id, job);
      this.armTimer(job);
    }
    if (stored.length > 0) {
      console.log(`[Delayed] Restored ${stored.length} pending job(s) from ${this.deps.persistPath}`);
    }
  }

  /**
   * If the response's first line is a delayed/polling start command, schedule it
   * and return true (caller must NOT also send the raw response). Otherwise false.
   */
  async maybeScheduleFromResponse(response: string, ctx: DelayedContext): Promise<boolean> {
    const cmd = parseStartCommand(response);
    if (!cmd) return false;
    if (!cmd.instruction) {
      // Command with no body — nothing to run later. Treat as non-command.
      console.log("[Delayed] Start command had empty instruction — ignoring");
      return false;
    }
    if (cmd.kind === "oneshot") {
      await this.scheduleOneShot(ctx, cmd.instruction, cmd.delayMs!);
    } else {
      await this.schedulePolling(ctx, cmd.instruction, cmd.intervalMs!, cmd.maxAttempts!, cmd.summary);
    }
    return true;
  }

  // ---- One-shot ----
  private async scheduleOneShot(ctx: DelayedContext, instruction: string, delayMs: number): Promise<void> {
    const sec = Math.round(delayMs / 1000);
    const header = `⏳ 以下を${formatDelay(sec)}後に実行します`;
    await this.sendToChannel(ctx.channelId, `${header}\n\n${instruction}`);

    const job: StoredJob = {
      id: this.nextId(),
      type: "oneshot",
      channelId: ctx.channelId,
      guildId: ctx.guildId,
      threadId: ctx.threadId,
      instruction,
      fireAt: Date.now() + delayMs,
    };
    this.jobs.set(job.id, job);
    await this.persist();
    this.armTimer(job);
    console.log(`[Delayed] Scheduled one-shot ${job.id} in ${sec}s (channel ${ctx.channelId})`);
  }

  private async fireOneShot(job: StoredJob): Promise<void> {
    try {
      const response = await this.runClaude(job, this.buildPrompt(job, job.instruction));
      // The fired run may itself return another delayed/polling command → chain it.
      const chained = parseStartCommand(response);
      if (chained && chained.instruction) {
        const ctx = this.jobCtx(job);
        if (chained.kind === "oneshot") {
          await this.scheduleOneShot(ctx, chained.instruction, chained.delayMs!);
        } else {
          await this.schedulePolling(ctx, chained.instruction, chained.intervalMs!, chained.maxAttempts!, chained.summary);
        }
      } else {
        await this.sendToChannel(job.channelId, response || "（応答がありませんでした）");
      }
    } catch (e) {
      console.error(`[Delayed] one-shot ${job.id} failed:`, e);
      await this.sendToChannel(job.channelId, `⚠️ 遅延実行でエラーが発生しました: ${errMsg(e)}`);
    } finally {
      await this.removeJob(job.id);
    }
  }

  // ---- Polling ----
  private async schedulePolling(
    ctx: DelayedContext,
    instruction: string,
    intervalMs: number,
    maxAttempts: number,
    summary?: string,
  ): Promise<void> {
    const now = Date.now();
    const job: StoredJob = {
      id: this.nextId(),
      type: "poll",
      channelId: ctx.channelId,
      guildId: ctx.guildId,
      threadId: ctx.threadId,
      instruction,
      fireAt: now + intervalMs,
      intervalMs,
      maxAttempts,
      attempts: 0,
      startedAt: now,
      summary,
      lastStatus: "監視を開始しました",
    };
    const statusMsgId = await this.sendToChannel(job.channelId, renderPollStatus(job));
    if (statusMsgId) job.statusMessageId = statusMsgId;

    this.jobs.set(job.id, job);
    await this.persist();
    this.armTimer(job);
    console.log(
      `[Delayed] Scheduled poll ${job.id} every ${Math.round(intervalMs / 1000)}s x${maxAttempts} (channel ${ctx.channelId})`,
    );
  }

  private async firePoll(job: StoredJob): Promise<void> {
    job.attempts = (job.attempts || 0) + 1;
    const max = job.maxAttempts || POLL_DEFAULT_MAX_ATTEMPTS;
    try {
      const prompt = this.buildPollPrompt(job);
      const response = await this.runClaude(job, prompt);
      const reply = parsePollReply(response);

      if (reply && reply.kind === "complete") {
        await this.finishPoll(job, reply.body);
        return;
      }

      // continue (explicit marker) OR unrecognised → keep polling with a status note
      job.lastStatus = reply && reply.kind === "continue" && reply.status
        ? reply.status
        : firstSummary(response) || "確認中…";

      if (job.attempts >= max) {
        // Exhausted — stop and finalise as a timeout.
        await this.editStatus(job, renderPollFinished(job, "timeout"));
        await this.sendToChannel(
          job.channelId,
          `⏱️ ポーリングが最大${max}回に達したため終了しました。\n最後の状況: ${job.lastStatus}`,
        );
        await this.removeJob(job.id);
        return;
      }

      // Re-arm for the next cycle.
      job.fireAt = Date.now() + (job.intervalMs || POLL_MIN_INTERVAL_MS);
      await this.editStatus(job, renderPollStatus(job));
      await this.persist();
      this.armTimer(job);
    } catch (e) {
      console.error(`[Delayed] poll ${job.id} attempt ${job.attempts} failed:`, e);
      // A failed cycle shouldn't kill the whole poll — re-arm unless exhausted.
      job.lastStatus = `エラー: ${errMsg(e)}`;
      if (job.attempts >= max) {
        await this.sendToChannel(job.channelId, `⚠️ ポーリング中にエラーが続き終了しました: ${errMsg(e)}`);
        await this.removeJob(job.id);
        return;
      }
      job.fireAt = Date.now() + (job.intervalMs || POLL_MIN_INTERVAL_MS);
      await this.editStatus(job, renderPollStatus(job));
      await this.persist();
      this.armTimer(job);
    }
  }

  private async finishPoll(job: StoredJob, body: string): Promise<void> {
    await this.editStatus(job, renderPollFinished(job, "done"));
    // Completion report is a NEW message (per spec).
    await this.sendToChannel(job.channelId, body || "✅ ポーリングが完了しました。");
    await this.removeJob(job.id);
  }

  // ---- Timer / persistence plumbing ----
  private armTimer(job: StoredJob): void {
    const existing = this.timers.get(job.id);
    if (existing !== undefined) clearTimeout(existing);
    const delay = Math.max(0, job.fireAt - Date.now());
    const timer = setTimeout(() => {
      this.timers.delete(job.id);
      const current = this.jobs.get(job.id);
      if (!current) return; // removed in the meantime
      if (current.type === "oneshot") {
        this.fireOneShot(current);
      } else {
        this.firePoll(current);
      }
    }, delay);
    this.timers.set(job.id, timer);
  }

  private async removeJob(id: string): Promise<void> {
    const timer = this.timers.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.timers.delete(id);
    }
    this.jobs.delete(id);
    await this.persist();
  }

  private async persist(): Promise<void> {
    try {
      const arr = [...this.jobs.values()];
      await Deno.writeTextFile(this.deps.persistPath, JSON.stringify(arr, null, 2));
    } catch (e) {
      console.error("[Delayed] persist failed:", e);
    }
  }

  private nextId(): string {
    this.seq += 1;
    return `dl-${Date.now()}-${this.seq}`;
  }

  // ---- Claude invocation ----
  private async runClaude(job: StoredJob, prompt: string): Promise<string> {
    const sessionId = this.deps.channelSessions.get(job.channelId);
    const result = await sendToClaudeCode(
      this.deps.workDir,
      prompt,
      new AbortController(),
      sessionId,
      undefined,
      undefined,
      false,
      this.deps.getModelOptions(),
    );
    if (result.sessionId) {
      this.deps.channelSessions.set(job.channelId, result.sessionId);
    }
    return result.response || "";
  }

  private jobCtx(job: StoredJob): DelayedContext {
    return {
      channelId: job.channelId,
      guildId: job.guildId,
      threadId: job.threadId,
      userId: "",
      username: "",
      messageId: "",
    };
  }

  /** Build a prompt with the Discord context block so re-invoked Claude posts to the right place. */
  private buildPrompt(job: StoredJob, instruction: string): string {
    const parts: string[] = ["<discord-context>", `Channel ID: ${job.channelId}`];
    if (job.guildId) parts.push(`Guild ID: ${job.guildId}`);
    if (job.threadId) parts.push(`Thread ID: ${job.threadId}`);
    parts.push("</discord-context>", "", instruction);
    return parts.join("\n");
  }

  private buildPollPrompt(job: StoredJob): string {
    const n = job.attempts || 1;
    const max = job.maxAttempts || POLL_DEFAULT_MAX_ATTEMPTS;
    const protocol = [
      `これはポーリング確認です（${n}/${max}回目）。以下の【監視内容】を確認してください。`,
      `- まだ完了していなければ、応答の1行目に「ポーリング継続: <現在状況を一言>」と書いてください（それ以外の詳細は不要）。`,
      `- 完了していれば、応答の1行目に「ポーリング完了」と書き、2行目以降に完了報告を書いてください（この報告がユーザーに新規メッセージとして届きます）。`,
      ``,
      `【監視内容】`,
      job.instruction,
    ].join("\n");
    return this.buildPrompt(job, protocol);
  }

  // ---- Discord I/O ----
  private async sendToChannel(channelId: string, content: string): Promise<string | null> {
    try {
      // deno-lint-ignore no-explicit-any
      const ch: any = await this.deps.client.channels.fetch(channelId);
      const msg = await ch.send(truncate(content));
      return msg.id as string;
    } catch (e) {
      console.error(`[Delayed] send to ${channelId} failed:`, e);
      return null;
    }
  }

  private async editStatus(job: StoredJob, content: string): Promise<void> {
    if (!job.statusMessageId) {
      // No status message (initial send failed) — fall back to a fresh message.
      const id = await this.sendToChannel(job.channelId, content);
      if (id) job.statusMessageId = id;
      return;
    }
    try {
      // deno-lint-ignore no-explicit-any
      const ch: any = await this.deps.client.channels.fetch(job.channelId);
      const msg = await ch.messages.fetch(job.statusMessageId);
      await msg.edit(truncate(content));
    } catch (e) {
      console.error(`[Delayed] edit status ${job.statusMessageId} failed:`, e);
    }
  }
}

// ================================
// Rendering helpers
// ================================
function truncate(s: string): string {
  return s.length > DISCORD_LIMIT ? s.slice(0, DISCORD_LIMIT - 1) + "…" : s;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function jstTime(epochMs: number): string {
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(epochMs));
}

function formatDelay(sec: number): string {
  if (sec < 60) return `${sec}秒`;
  if (sec < 3600) {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return s ? `${m}分${s}秒` : `${m}分`;
  }
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return m ? `${h}時間${m}分` : `${h}時間`;
}

function renderPollStatus(job: StoredJob): string {
  const now = Date.now();
  const intervalSec = Math.round((job.intervalMs || 0) / 1000);
  const elapsedSec = Math.round((now - (job.startedAt || now)) / 1000);
  const lines = [
    "【ポーリング実行】",
    "以下のタスクをポーリング実行しています。",
    `実行間隔: ${intervalSec}秒`,
    `経過時間: ${formatDelay(elapsedSec)} (${jstTime(job.startedAt || now)}に開始、次回${jstTime(job.fireAt)}に実行予定)`,
    `実行回数: ${job.attempts || 0}回（最大${job.maxAttempts}回）`,
    `最新実行状況: ${job.lastStatus || "—"}`,
    "",
    "【タスク内容】",
    job.instruction,
  ];
  return lines.join("\n");
}

function renderPollFinished(job: StoredJob, kind: "done" | "timeout"): string {
  if (kind === "done") {
    return [
      "【ポーリング実行】",
      "☑️ タスクのポーリングが完了しました！",
      "新しいメッセージで返答を行いました。",
    ].join("\n");
  }
  // timeout: 最大回数に達して終了
  return [
    "【ポーリング実行】",
    `⏱️ 最大${job.maxAttempts}回に達したためポーリングを終了しました。`,
    `最後の状況: ${job.lastStatus || "—"}`,
  ].join("\n");
}

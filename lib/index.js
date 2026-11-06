/**
 * dsh-btw-local — /btw（横質問）のホスト半身。
 *
 * Claude Code の /btw と同じ性質を DSH 0.2.0-rc.2 で実現する:
 * - 進行中の会話の文脈だけを使い、ツールは使わない
 * - 1 回だけ答え、やり取りはセッション履歴に残さない
 * - メインのターンを止めずに使える（別リクエストとして並行に走る）
 *
 * 実装上の判断（0.2.0-rc.2 の実装を読んで確認）:
 * - /api の interceptor は 1 本しか登録できない（dsh-client-connection の
 *   registerInterceptor が重複を throw する。api-gateway が既に所有している）。
 *   そのため専用チャネル /btw を connection.rpc.handle() で登録する。
 * - 会話文脈はクライアントの SessionSnapshot ではなく、ホスト側のセッション
 *   イベントログ（user/message・assistant/message）から組み立てる。0.2.0-rc.2 の
 *   クライアント snapshot に nodes は無く、会話ビューは別の view store にある。
 * - 応答は llm.stream() のステートレス 1 回。ジョブはメモリ上だけ、保存しない。
 *
 * 着想元: dsh-btw 0.0.3 (MIT, iluluyu) の /btw 面。API が合わないため、
 * トランスポート・文脈収集・UI を 0.2.0-rc.2 向けに書き直した。
 */
import { randomUUID } from "node:crypto";

export const name = "dsh-btw-local";
// connection.rpc.handle() は呼び出し側の Context で webServer.register() するため、webServer も inject が要る
// （無いと "cannot get property webServer without inject" で /btw の登録に失敗し、405 になる）。
export const inject = ["llm", "agentDefaultModel", "agents", "connection", "webServer"];

/** 応答全体の上限。超えたら abort して打ち切る。 */
const ASK_TIMEOUT_MS = 180_000;
/** 終了済みジョブをメモリに残す時間（poll の取りこぼし対策）。 */
const JOB_TTL_MS = 10 * 60_000;
/** 文脈として渡す会話の最大文字数。 */
const TRANSCRIPT_MAX = 48_000;
const QUESTION_MAX = 8_000;
/** 直近何往復を文脈に入れるか（user/assistant をそれぞれ 1 行と数える）。 */
const RECENT_LINES = 14;
const LINE_MAX = 1_600;

const ASK_SYSTEM = [
  "You answer a quick side question about an ongoing coding session.",
  "The recent conversation is provided as context inside <conversation> tags; the question follows inside <question> tags.",
  "Answer directly and concisely, in the language of the question.",
  "When the answer is in the context (file paths, names, decisions), quote them exactly.",
  "When it is not, say so plainly in one line — do not invent, do not ask follow-up questions.",
  "No tool use; a few short paragraphs at most.",
].join(" ");

/** メッセージ content からテキストブロックだけを連結する。 */
function textOf(content) {
  if (!Array.isArray(content)) return "";
  let out = "";
  for (const part of content) {
    if (part !== null && part.type === "text" && typeof part.text === "string") out += part.text;
  }
  return out.trim();
}

function clip(text, max) {
  return text.length > max ? text.slice(0, max) + "…" : text;
}

export function apply(ctx) {
  const llm = ctx.get("llm");
  const defaults = ctx.get("agentDefaultModel");
  const agents = ctx.get("agents");
  const connection = ctx.get("connection");
  if (llm === undefined || defaults === undefined || agents === undefined || connection === undefined) return;

  /** jobId -> { ac, text, done, error, created, timer } */
  const jobs = new Map();

  const ok = (value) => ({ ok: true, value });
  // note: ブラウザ側の応答スキーマは error.code を既知の語彙に限定するため internal を使う。
  const err = (message) => ({ ok: false, error: { code: "internal", message, details: {} } });

  /** 現在のセッションの直近の会話をプレーンテキストにする。 */
  function transcriptOf(sessionId) {
    if (typeof sessionId !== "string" || sessionId === "") return "";
    const agent = agents.get(sessionId);
    if (agent === undefined) return "";
    const events = agent.session.snapshotEvents();
    const lines = [];
    for (const event of events) {
      if (event.type === "user/message") {
        const text = textOf(event.data?.content);
        if (text !== "") lines.push("User: " + clip(text, LINE_MAX));
      } else if (event.type === "assistant/message") {
        const text = textOf(event.data?.message?.content);
        if (text !== "") lines.push("Assistant: " + clip(text, LINE_MAX));
      }
    }
    const recent = lines.length > RECENT_LINES ? ["…", ...lines.slice(-RECENT_LINES)] : lines;
    const joined = recent.join("\n\n");
    return joined.length > TRANSCRIPT_MAX ? joined.slice(joined.length - TRANSCRIPT_MAX) : joined;
  }

  function finish(job, error) {
    job.done = true;
    job.error = error ?? null;
    if (job.timer !== null) {
      clearTimeout(job.timer);
      job.timer = null;
    }
  }

  function runAsk(job, question, transcript) {
    job.timer = setTimeout(() => {
      try { job.ac.abort(); } catch { /* already settled */ }
      // abort 由来の catch で上書きされないよう、先にエラーを確定させる。
      if (!job.done) finish(job, "横質問がタイムアウトしました（3分）。");
    }, ASK_TIMEOUT_MS);

    void (async () => {
      let selection;
      try { selection = defaults.currentSelection(); } catch { selection = undefined; }
      if (selection === undefined || !selection.provider || !selection.model) {
        finish(job, "既定モデルが未設定です（設定 → モデルで選んでください）。");
        return;
      }
      // 文脈が空でも system の約束どおり質問は <question> で包む。
      const body = transcript === ""
        ? `<question>\n${question}\n</question>`
        : `<conversation>\n${transcript}\n</conversation>\n\n<question>\n${question}\n</question>`;
      const options = {
        provider: selection.provider,
        model: selection.model,
        system: ASK_SYSTEM,
        messages: [{
          id: randomUUID(),
          role: "user",
          content: [{ type: "text", text: body }],
          source: { kind: "user" },
        }],
        signal: job.ac.signal,
      };
      if (selection.reasoningEffort !== undefined) options.reasoningEffort = selection.reasoningEffort;
      try {
        for await (const chunk of llm.stream(options)) {
          if (chunk.type === "text-delta" && typeof chunk.text === "string") job.text += chunk.text;
          else if (chunk.type === "finish") break;
        }
        finish(job, null);
      } catch (error) {
        if (job.done) return; // abort 後は確定済みの理由を保つ
        finish(job, error instanceof Error ? error.message : String(error));
      }
    })();
  }

  function gcJobs() {
    const now = Date.now();
    for (const [id, job] of jobs) {
      if (job.done && now - job.created > JOB_TTL_MS) jobs.delete(id);
    }
  }

  function handleAsk(payload) {
    gcJobs();
    const question = typeof payload?.question === "string" ? payload.question.trim() : "";
    if (question === "") return err("質問が空です。");
    if (question.length > QUESTION_MAX) return err("質問が長すぎます。");
    const sessionId = typeof payload?.sessionId === "string" ? payload.sessionId : "";
    // 履歴表示中など、ライブでないセッションは文脈を読めない。空の文脈で
    // 一般論を答えて誤解させないよう、ここで断る。
    if (sessionId === "" || agents.get(sessionId) === undefined) {
      return err("このセッションの文脈を読めません（履歴の表示中は使えません）。");
    }
    const transcript = transcriptOf(sessionId);
    const jobId = randomUUID();
    jobs.set(jobId, {
      ac: new AbortController(),
      text: "",
      done: false,
      error: null,
      created: Date.now(),
      timer: null,
    });
    runAsk(jobs.get(jobId), question, transcript);
    return ok({ jobId, transcriptChars: transcript.length });
  }

  function handlePoll(payload) {
    gcJobs(); // ask が来ない間も期限切れのジョブを捨てる
    const job = jobs.get(payload?.jobId);
    if (job === undefined) return err("横質問のジョブが見つかりません（期限切れ）。");
    return ok({ text: job.text, done: job.done, error: job.error });
  }

  function handleCancel(payload) {
    const job = jobs.get(payload?.jobId);
    if (job === undefined) return ok({ cancelled: false });
    try { job.ac.abort(); } catch { /* already settled */ }
    if (!job.done) finish(job, "中止しました。");
    return ok({ cancelled: true });
  }

  // 専用 RPC チャネル。認証は connection が経路単位で行う（ブラウザの cookie）。
  const dispose = connection.rpc.handle("/btw", async (endpoint, payload) => {
    try {
      switch (endpoint) {
        case "ask": return handleAsk(payload);
        case "poll": return handlePoll(payload);
        case "cancel": return handleCancel(payload);
        default: return err(`unknown endpoint: ${endpoint}`);
      }
    } catch (error) {
      return err(error instanceof Error ? error.message : String(error));
    }
  });

  ctx.effect(() => () => {
    try { void dispose(); } catch { /* already down */ }
    for (const job of jobs.values()) {
      try { job.ac.abort(); } catch { /* already settled */ }
    }
    jobs.clear();
  });
}

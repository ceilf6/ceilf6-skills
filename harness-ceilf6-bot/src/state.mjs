// 文件持久化状态：processed.jsonl 只增；queue.jsonl、threads.jsonl 与 awaiting.jsonl 全量重写。
// 事件总线可能重放消息，processed 去重是正确性底线。
import { readFileSync, appendFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export class Store {
  constructor(stateDir) {
    mkdirSync(stateDir, { recursive: true });
    this.processedPath = join(stateDir, 'processed.jsonl');
    this.queuePath = join(stateDir, 'queue.jsonl');
    this.threadsPath = join(stateDir, 'threads.jsonl');
    this.awaitingPath = join(stateDir, 'awaiting.jsonl');
    this.processed = new Set(this.#readEntries(this.processedPath).map((e) => e.id));
    this.queue = this.#readEntries(this.queuePath);
    this.threads = new Map(this.#readEntries(this.threadsPath)
      .filter((e) => typeof e.threadId === 'string' && e.threadId && e.info)
      .map((e) => [e.threadId, e.info]));
    this.awaiting = new Map(this.#readEntries(this.awaitingPath)
      .filter((e) => typeof e.messageId === 'string' && e.messageId)
      .map((e) => [e.messageId, e]));
  }
  #readEntries(p) {
    if (!existsSync(p)) return [];
    const out = [];
    for (const line of readFileSync(p, 'utf8').split('\n').filter(Boolean)) {
      // 坏行只跳过不抛：KeepAlive 守护进程下构造器 throw 会变成 crash-loop，
      // 一行损坏连带全部可用状态失效；跳过则最坏丢单条记录。
      try {
        const v = JSON.parse(line);
        if (!v || typeof v !== 'object') throw new Error('非对象行');
        out.push(v);
      } catch {
        console.error(`[state] 跳过无法解析的行（${p}）：${line.slice(0, 200)}`);
      }
    }
    return out;
  }
  #flushLines(path, entries) {
    // 先写临时文件再 rename（同目录原子）：中途被杀不得截断在用状态。
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, entries.map((e) => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : ''));
    renameSync(tmp, path);
  }
  #flushQueue() { this.#flushLines(this.queuePath, this.queue); }
  #flushThreads() {
    this.#flushLines(this.threadsPath, [...this.threads].map(([threadId, info]) => ({ threadId, info })));
  }
  isProcessed(id) { return this.processed.has(id); }
  markProcessed(id) {
    if (this.processed.has(id)) return;
    this.processed.add(id);
    appendFileSync(this.processedPath, JSON.stringify({ id, at: new Date().toISOString() }) + '\n');
  }
  enqueue(task) { this.queue.push(task); this.#flushQueue(); }
  dequeue() {
    const t = this.queue.shift() ?? null;
    if (t) this.#flushQueue();
    return t;
  }
  size() { return this.queue.length; }
  // 线程登记表：thread_id → 任务现场，话题内回复靠它找到归属任务的 worktree。
  // 同 threadId 覆盖：worktree 重建（同名冲突追加序号）后旧登记就是坏地址。
  recordThread(threadId, info) { this.threads.set(threadId, info); this.#flushThreads(); }
  findThread(threadId) { return this.threads.get(threadId) ?? null; }
  dropThread(threadId) {
    if (!this.threads.delete(threadId)) return false; // 无此登记就不空转写盘
    this.#flushThreads();
    return true;
  }
  // awaiting 登记表：等私信回复的任务（懒续跑真源）。条目跨多轮 ask 存续，终态才删。
  #flushAwaiting() { this.#flushLines(this.awaitingPath, [...this.awaiting.values()]); }
  recordAsk(messageId, info) {
    const prev = this.awaiting.get(messageId) ?? {};
    const { questionMsgId, ...rest } = info;
    this.awaiting.set(messageId, {
      ...prev, ...rest, messageId,
      questionMsgIds: [...(prev.questionMsgIds ?? []), ...(questionMsgId ? [questionMsgId] : [])],
      resumeFlags: prev.resumeFlags ?? [],
      waiting: true,
      askedAt: new Date().toISOString(),
    });
    this.#flushAwaiting();
  }
  findAwaiting(messageId) { return this.awaiting.get(messageId) ?? null; }
  findAwaitingByQuestionMsg(msgId) {
    for (const e of this.awaiting.values()) if (e.questionMsgIds?.includes(msgId)) return e;
    return null;
  }
  listWaiting() { return [...this.awaiting.values()].filter((e) => e.waiting); }
  patchAwaiting(messageId, patch) {
    const prev = this.awaiting.get(messageId);
    if (!prev) return false;
    this.awaiting.set(messageId, { ...prev, ...patch });
    this.#flushAwaiting();
    return true;
  }
  dropAwaiting(messageId) {
    if (!this.awaiting.delete(messageId)) return false;
    this.#flushAwaiting();
    return true;
  }
  // 在册全量：含已不在等待态的条目（会话仍活着，只是没在等回复）；只要等待中的用 listWaiting。
  listAwaiting() { return [...this.awaiting.values()]; }
  listQueued() { return [...this.queue]; }
  // 控制面停止排队中任务：按 id 精确出队，避免 dequeue 的 FIFO 语义误伤队首。
  removeQueued(messageId) {
    const i = this.queue.findIndex((t) => t.messageId === messageId);
    if (i < 0) return null;
    const [t] = this.queue.splice(i, 1);
    this.#flushQueue();
    return t;
  }
}

// 文件持久化状态：processed.jsonl 只增；queue.jsonl 全量重写。
// 事件总线可能重放消息，processed 去重是正确性底线。
import { readFileSync, appendFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export class Store {
  constructor(stateDir) {
    mkdirSync(stateDir, { recursive: true });
    this.processedPath = join(stateDir, 'processed.jsonl');
    this.queuePath = join(stateDir, 'queue.jsonl');
    this.processed = new Set(this.#readEntries(this.processedPath).map((e) => e.id));
    this.queue = this.#readEntries(this.queuePath);
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
  #flushQueue() {
    // 先写临时文件再 rename（同目录原子）：中途被杀不得截断在用队列。
    const tmp = `${this.queuePath}.tmp`;
    writeFileSync(tmp, this.queue.map((t) => JSON.stringify(t)).join('\n') + (this.queue.length ? '\n' : ''));
    renameSync(tmp, this.queuePath);
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
}

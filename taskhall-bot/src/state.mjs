// 文件持久化状态：processed.jsonl 只增；queue.jsonl 全量重写。
// 事件总线可能重放消息，processed 去重是正确性底线。
import { readFileSync, appendFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export class Store {
  constructor(stateDir) {
    mkdirSync(stateDir, { recursive: true });
    this.processedPath = join(stateDir, 'processed.jsonl');
    this.queuePath = join(stateDir, 'queue.jsonl');
    this.processed = new Set(this.#readLines(this.processedPath).map((l) => JSON.parse(l).id));
    this.queue = this.#readLines(this.queuePath).map((l) => JSON.parse(l));
  }
  #readLines(p) {
    if (!existsSync(p)) return [];
    return readFileSync(p, 'utf8').split('\n').filter(Boolean);
  }
  #flushQueue() {
    writeFileSync(this.queuePath, this.queue.map((t) => JSON.stringify(t)).join('\n') + (this.queue.length ? '\n' : ''));
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

import type { Clock } from "../domain/clock.ts";
import { MessageNotFoundError } from "../domain/errors.ts";
import type { SourceMessage } from "../domain/types.ts";
import { formatId, nextCounter, text, type Database, type Row } from "./database.ts";

/**
 * Messages are the ground truth memories point at. They are immutable: correcting a fact
 * adds a new message, it never rewrites an old one, because provenance that can be edited
 * is not provenance.
 */
export class MessageStore {
  private readonly db: Database;
  private readonly clock: Clock;

  constructor(db: Database, clock: Clock) {
    this.db = db;
    this.clock = clock;
  }

  append(author: SourceMessage["author"], body: string): SourceMessage {
    const message: SourceMessage = {
      id: formatId("msg", nextCounter(this.db, "message")),
      author,
      text: body,
      createdAt: this.clock.now(),
    };

    this.db
      .prepare(`INSERT INTO messages (id, author, text, created_at) VALUES (?, ?, ?, ?)`)
      .run(message.id, message.author, message.text, message.createdAt);

    return message;
  }

  find(id: string): SourceMessage | undefined {
    const row = this.db.prepare(`SELECT * FROM messages WHERE id = ?`).get(id) as
      | Row
      | undefined;
    return row ? toMessage(row) : undefined;
  }

  require(id: string): SourceMessage {
    const message = this.find(id);
    if (!message) throw new MessageNotFoundError(id);
    return message;
  }

  list(): SourceMessage[] {
    const rows = this.db.prepare(`SELECT * FROM messages ORDER BY id`).all() as Row[];
    return rows.map(toMessage);
  }
}

function toMessage(row: Row): SourceMessage {
  const author = text(row, "author");
  if (author !== "user" && author !== "assistant") {
    throw new TypeError(`Unexpected message author "${author}".`);
  }
  return {
    id: text(row, "id"),
    author,
    text: text(row, "text"),
    createdAt: text(row, "created_at"),
  };
}

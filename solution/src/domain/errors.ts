/** Base class so callers can distinguish our refusals from genuine bugs. */
export class MemoryEngineError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.code = code;
    this.name = new.target.name;
  }
}

export class MemoryNotFoundError extends MemoryEngineError {
  constructor(id: string) {
    super(`No memory with id "${id}".`, "MEMORY_NOT_FOUND");
  }
}

export class IllegalTransitionError extends MemoryEngineError {
  constructor(id: string, from: string, to: string) {
    super(
      `Memory "${id}" cannot move from ${from} to ${to}. ` +
        `superseded and deleted are terminal states.`,
      "ILLEGAL_TRANSITION",
    );
  }
}

export class UnknownAttributeError extends MemoryEngineError {
  constructor(attribute: string) {
    super(
      `Attribute "${attribute}" is not in the registry, so its cardinality and ` +
        `therefore its supersession behaviour are undefined.`,
      "UNKNOWN_ATTRIBUTE",
    );
  }
}

export class MessageNotFoundError extends MemoryEngineError {
  constructor(id: string) {
    super(
      `No source message with id "${id}". Every memory must point at the message it came from.`,
      "MESSAGE_NOT_FOUND",
    );
  }
}

// stats-reporter.test.ts — unit tests for manager-side stats reporting

import { describe, expect, it } from "bun:test";
import {
  MANAGER_RUN_AGENT,
  getManagerRunName,
  buildPayloads,
  extractTokenTotals,
} from "../stats-reporter.js";

describe("manager stats reporter constants", () => {
  it("should have the correct synthetic agent name", () => {
    expect(MANAGER_RUN_AGENT).toBe("manager run");
  });

  it("should generate consistent run names for a given session ID", () => {
    const sessionId = "test-session-123";
    const name1 = getManagerRunName(sessionId);
    const name2 = getManagerRunName(sessionId);

    expect(name1).toBe(`manager-session-${sessionId}`);
    expect(name1).toBe(name2);
  });

  it("should produce different run names for different session IDs", () => {
    const name1 = getManagerRunName("session-a");
    const name2 = getManagerRunName("session-b");

    expect(name1).not.toBe(name2);
  });
});

describe("extractTokenTotals", () => {
  it("should extract token totals from messages with tokens", () => {
    const messages = [
      {
        info: {
          role: "user",
          tokens: { input: 10, output: 5 },
        },
      } as any,
      {
        info: {
          role: "assistant",
          tokens: { input: 0, output: 20 },
        },
      } as any,
    ];

    const totals = extractTokenTotals(messages);
    expect(totals).toEqual({ tokensIn: 10, tokensOut: 25, cost: 0 });
  });

  it("should handle messages without token info", () => {
    const messages = [
      { info: { role: "user" } } as any,
      { info: { role: "assistant" } } as any,
    ];

    const totals = extractTokenTotals(messages);
    expect(totals).toEqual({ tokensIn: 0, tokensOut: 0, cost: 0 });
  });

  it("should include cost when present", () => {
    const messages = [
      { info: { role: "user", cost: 0.01 } } as any,
      { info: { role: "assistant", cost: 0.02 } } as any,
    ];

    const totals = extractTokenTotals(messages);
    expect(totals).toEqual({ tokensIn: 0, tokensOut: 0, cost: 0.03 });
  });

  it("should handle mixed messages with and without tokens", () => {
    const messages = [
      { info: { role: "user", tokens: { input: 5 } } } as any,
      { info: { role: "assistant" } } as any, // no tokens
      { info: { role: "user", cost: 0.01 } } as any, // only cost
    ];

    const totals = extractTokenTotals(messages);
    expect(totals).toEqual({ tokensIn: 5, tokensOut: 0, cost: 0.01 });
  });
});

describe("buildPayloads", () => {
  it("should build message payload with all fields", () => {
    const messages = [
      {
        info: {
          id: "msg-1",
          role: "user",
          model: { providerID: "openai", modelID: "gpt-4" },
          time: { created: 1000, completed: 2000 },
          tokens: {
            input: 10,
            output: 5,
            reasoning: 2,
            cache: { read: 3, write: 1 },
          },
          cost: 0.042,
        },
        parts: [{ type: "text", text: "Hello" }],
      } as any,
    ];

    const { messagesPayload } = buildPayloads(messages, "session-1", 0);
    expect(messagesPayload).toHaveLength(1);

    const msg = messagesPayload[0];
    expect(msg).toEqual({
      id: "msg-1",
      idx: 0,
      role: "user",
      content: JSON.stringify([{ type: "text", text: "Hello" }]),
      model: "openai/gpt-4",
      tokensIn: 10,
      tokensOut: 5,
      tokensReasoning: 2,
      tokensCacheRead: 3,
      tokensCacheWrite: 1,
      cost: 0.042,
      createdAt: new Date(1000).toISOString(),
      completedAt: new Date(2000).toISOString(),
    });
  });

  it("should build message payload with string model", () => {
    const messages = [
      { info: { role: "user", model: "openai/gpt-4" }, parts: [] } as any,
    ];

    const { messagesPayload } = buildPayloads(messages, "session-1", 0);
    expect(messagesPayload[0].model).toBe("openai/gpt-4");
  });

  it("should extract file operations from tool parts with filePath", () => {
    const messages = [
      {
        info: { role: "assistant" },
        parts: [
          {
            type: "tool",
            tool: "write_file",
            input: { filePath: "/path/to/file.ts" } as any,
          } as any,
        ],
      } as any,
    ];

    const { fileOpsPayload } = buildPayloads(messages, "session-1", 0);
    expect(fileOpsPayload).toHaveLength(1);
    expect(fileOpsPayload[0]).toEqual({
      messageIdx: 0,
      filePath: "/path/to/file.ts",
      operation: "write",
    });
  });

  it("should extract file operations from tool parts with path", () => {
    const messages = [
      {
        info: { role: "assistant" },
        parts: [
          {
            type: "tool",
            tool: "read_file",
            state: { input: { path: "/path/to/file.ts" } } as any,
          } as any,
        ],
      } as any,
    ];

    const { fileOpsPayload } = buildPayloads(messages, "session-1", 0);
    expect(fileOpsPayload).toHaveLength(1);
    expect(fileOpsPayload[0]).toEqual({
      messageIdx: 0,
      filePath: "/path/to/file.ts",
      operation: "read",
    });
  });

  it("should extract file operations from tool parts with input.path (tool name variation)", () => {
    const messages = [
      {
        info: { role: "assistant" },
        parts: [
          {
            type: "tool",
            tool: "readFile",
            state: { input: { path: "/src/app.ts" } } as any,
          } as any,
        ],
      } as any,
    ];

    const { fileOpsPayload } = buildPayloads(messages, "session-1", 0);
    expect(fileOpsPayload).toHaveLength(1);
    expect(fileOpsPayload[0]).toEqual({
      messageIdx: 0,
      filePath: "/src/app.ts",
      operation: "read",
    });
  });

  it("should extract file operations from tool-use parts with filePath", () => {
    const messages = [
      {
        info: { role: "assistant" },
        parts: [
          {
            type: "tool-use",
            name: "edit_file",
            input: { path: "/src/app.ts" } as any,
          } as any,
        ],
      } as any,
    ];

    const { fileOpsPayload } = buildPayloads(messages, "session-1", 0);
    expect(fileOpsPayload).toHaveLength(1);
    expect(fileOpsPayload[0].filePath).toBe("/src/app.ts");
  });

  it("should detect file operations correctly based on tool name", () => {
    const testCases: Array<{ tool: string; expectedOp: string }> = [
      { tool: "read_file", expectedOp: "read" },
      { tool: "readFile", expectedOp: "read" },
      { tool: "read", expectedOp: "read" },
      { tool: "write_file", expectedOp: "write" },
      { tool: "writeFile", expectedOp: "write" },
      { tool: "write", expectedOp: "write" },
      { tool: "edit", expectedOp: "write" },
      { tool: "multiedit", expectedOp: "write" },
      { tool: "delete_file", expectedOp: "delete" },
      { tool: "rm", expectedOp: "access" }, // unknown tool defaults to access
    ];

    testCases.forEach(({ tool, expectedOp }) => {
      const messages = [
        { 
          info: { role: "assistant" }, 
          parts: [{ type: "tool", tool, state: { input: { filePath: "/test.ts" } } }] as any 
        } as any,
      ];

      const { fileOpsPayload } = buildPayloads(messages, "session-1", 0);
      expect(fileOpsPayload).toHaveLength(1);
      expect(fileOpsPayload[0].operation).toBe(expectedOp);
    });
  });

  it("should include file path from file part", () => {
    const messages = [
      {
        info: { role: "user" },
        parts: [{ type: "file", path: "/read/file.txt" }] as any,
      } as any,
    ];

    const { fileOpsPayload } = buildPayloads(messages, "session-1", 0);
    expect(fileOpsPayload).toHaveLength(1);
    expect(fileOpsPayload[0]).toEqual({
      messageIdx: 0,
      filePath: "/read/file.txt",
      operation: "read",
    });
  });

  it("should handle unknown part types gracefully", () => {
    const messages = [
      {
        info: { role: "assistant" },
        parts: [{ type: "unknown-type", someField: "value" }] as any,
      } as any,
    ];

    // Should not throw and should produce empty fileOps
    const { fileOpsPayload } = buildPayloads(messages, "session-1", 0);
    expect(fileOpsPayload).toHaveLength(0);
  });

  it("should handle message parts that are null/undefined", () => {
    const messages = [{ info: { role: "user" }, parts: null }] as any;

    // Should not throw
    const result = buildPayloads(messages, "session-1", 0);
    expect(result.messagesPayload).toHaveLength(1);
  });

  it("should handle empty messages array", () => {
    const { messagesPayload, toolCallsPayload, fileOpsPayload } =
      buildPayloads([], "session-1", 0);

    expect(messagesPayload).toEqual([]);
    expect(toolCallsPayload).toEqual([]);
    expect(fileOpsPayload).toEqual([]);
  });

  it("should apply baseIdx to message indices", () => {
    const messages = [
      { info: { role: "user" }, parts: [] } as any,
    ];

    const { messagesPayload } = buildPayloads(messages, "session-1", 5);
    expect(messagesPayload[0].idx).toBe(5); // baseIdx + 0
  });
});

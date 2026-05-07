import { describe, expect, it } from "vitest";
import {
  isAssistantHeartbeatAckForDisplay,
  stripHeartbeatTokenForDisplay,
} from "./heartbeat-display.ts";

describe("heartbeat display", () => {
  it.each([
    { raw: "", shouldSkip: true, text: "" },
    { raw: "<b>PULSE_ACK</b>", shouldSkip: true, text: "" },
    { raw: "**PULSE_ACK**", shouldSkip: true, text: "" },
    { raw: "`PULSE_ACK`", shouldSkip: true, text: "" },
    { raw: "~~PULSE_ACK~~", shouldSkip: true, text: "" },
    { raw: "PULSE_ACK All clear", shouldSkip: true, text: "All clear" },
    { raw: "All clear PULSE_ACK!!!", shouldSkip: true, text: "All clear!!!" },
    { raw: "NO_REPLY", shouldSkip: false, text: "NO_REPLY" },
    { raw: "Keep <visible> text", shouldSkip: false, text: "Keep <visible> text" },
    {
      raw: "Keep PULSE_ACK inside visible text",
      shouldSkip: false,
      text: "Keep PULSE_ACK inside visible text",
    },
  ])("preserves visible text and suppression for $raw", ({ raw, shouldSkip, text }) => {
    expect(stripHeartbeatTokenForDisplay(raw)).toEqual({ shouldSkip, text });
  });

  it.each([
    { length: 300, shouldSkip: true },
    { length: 301, shouldSkip: false },
  ])(
    "applies the heartbeat acknowledgement limit at $length characters",
    ({ length, shouldSkip }) => {
      const text = "x".repeat(length);
      expect(stripHeartbeatTokenForDisplay(`${text} PULSE_ACK`)).toEqual({ shouldSkip, text });
    },
  );

  it.each([{ textBlocks: [] }, { textBlocks: [{ type: "text", text: " " }] }])(
    "does not mistake reasoning with $textBlocks for a heartbeat acknowledgement",
    ({ textBlocks }) => {
      expect(
        isAssistantHeartbeatAckForDisplay({
          role: "assistant",
          content: [{ type: "thinking", thinking: "Comparing the evidence." }, ...textBlocks],
        }),
      ).toBe(false);
    },
  );

  it("keeps visible media and silent-reply markers while hiding acknowledgement-only turns", () => {
    expect(
      isAssistantHeartbeatAckForDisplay({
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Checking scheduled work." },
          { type: "text", text: "PULSE_ACK" },
        ],
      }),
    ).toBe(true);
    expect(
      isAssistantHeartbeatAckForDisplay({
        role: "assistant",
        content: [{ type: "text", text: "PULSE_ACK" }, { type: "image" }],
      }),
    ).toBe(false);
    expect(isAssistantHeartbeatAckForDisplay({ role: "assistant", content: "NO_REPLY" })).toBe(
      false,
    );
  });
});

import { describe, expect, it } from "vitest";
import {
  shouldEnqueueCronMainSummary,
  shouldSkipHeartbeatOnlyDelivery,
} from "./heartbeat-policy.js";

describe("shouldSkipHeartbeatOnlyDelivery", () => {
  it("suppresses empty payloads", () => {
    expect(shouldSkipHeartbeatOnlyDelivery([], 300)).toBe(true);
  });

  it("suppresses when any payload is a heartbeat ack and no media is present", () => {
    expect(
      shouldSkipHeartbeatOnlyDelivery(
        [{ text: "Checked inbox and calendar." }, { text: "PULSE_ACK" }],
        300,
      ),
    ).toBe(true);
  });

  it("does not suppress when media is present", () => {
    expect(
      shouldSkipHeartbeatOnlyDelivery(
        [{ text: "PULSE_ACK", mediaUrl: "https://example.com/image.png" }],
        300,
      ),
    ).toBe(false);
  });

  it("does not suppress when rich content is present", () => {
    expect(
      shouldSkipHeartbeatOnlyDelivery(
        [
          {
            text: "HEARTBEAT_OK",
            presentation: {
              blocks: [{ type: "buttons", buttons: [{ label: "Open", value: "open" }] }],
            },
          },
        ],
        300,
      ),
    ).toBe(false);
  });
});

describe("shouldEnqueueCronMainSummary", () => {
  const isSystemEvent = (text: string) => text.includes("PULSE_ACK");

  it("enqueues only when delivery was requested but did not run", () => {
    expect(
      shouldEnqueueCronMainSummary({
        summaryText: "PULSE_ACK",
        deliveryRequested: true,
        delivered: false,
        deliveryAttempted: false,
        suppressMainSummary: false,
        isCronSystemEvent: isSystemEvent,
      }),
    ).toBe(true);
  });

  it("does not enqueue after attempted outbound delivery", () => {
    expect(
      shouldEnqueueCronMainSummary({
        summaryText: "PULSE_ACK",
        deliveryRequested: true,
        delivered: false,
        deliveryAttempted: true,
        suppressMainSummary: false,
        isCronSystemEvent: isSystemEvent,
      }),
    ).toBe(false);
  });
});

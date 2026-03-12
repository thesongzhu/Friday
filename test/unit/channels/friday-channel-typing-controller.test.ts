import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createFridayChannelTypingController } from "#channels";

describe("FridayChannelTypingController", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("emits typing immediately on start", () => {
    const emitTyping = vi.fn();
    const controller = createFridayChannelTypingController({ emitTyping });

    controller.start();
    expect(emitTyping).toHaveBeenCalledTimes(1);
    controller.seal();
  });

  it("emits typing on pulse interval", () => {
    const emitTyping = vi.fn();
    const controller = createFridayChannelTypingController({
      emitTyping,
      pulseMs: 1000,
    });

    controller.start();
    expect(emitTyping).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1000);
    expect(emitTyping).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(1000);
    expect(emitTyping).toHaveBeenCalledTimes(3);

    controller.seal();
  });

  it("stops after both stopRun and stopDispatch are called", () => {
    const emitTyping = vi.fn();
    const controller = createFridayChannelTypingController({
      emitTyping,
      pulseMs: 1000,
    });

    controller.start();
    expect(emitTyping).toHaveBeenCalledTimes(1);

    // Only stopRun — should keep pulsing
    controller.stopRun();
    vi.advanceTimersByTime(1000);
    expect(emitTyping).toHaveBeenCalledTimes(2);

    // Now stopDispatch — both gates closed, should stop
    controller.stopDispatch();
    vi.advanceTimersByTime(5000);
    const countAfterStop = emitTyping.mock.calls.length;
    vi.advanceTimersByTime(5000);
    expect(emitTyping).toHaveBeenCalledTimes(countAfterStop);
  });

  it("stops after both stopDispatch and stopRun in reverse order", () => {
    const emitTyping = vi.fn();
    const controller = createFridayChannelTypingController({
      emitTyping,
      pulseMs: 1000,
    });

    controller.start();
    controller.stopDispatch();

    vi.advanceTimersByTime(1000);
    expect(emitTyping).toHaveBeenCalledTimes(2); // still pulsing

    controller.stopRun();
    const countAfterStop = emitTyping.mock.calls.length;
    vi.advanceTimersByTime(5000);
    expect(emitTyping).toHaveBeenCalledTimes(countAfterStop);
  });

  it("seal prevents any further emissions", () => {
    const emitTyping = vi.fn();
    const controller = createFridayChannelTypingController({
      emitTyping,
      pulseMs: 1000,
    });

    controller.start();
    expect(emitTyping).toHaveBeenCalledTimes(1);

    controller.seal();
    vi.advanceTimersByTime(10000);
    expect(emitTyping).toHaveBeenCalledTimes(1);
  });

  it("seal prevents restart after seal", () => {
    const emitTyping = vi.fn();
    const controller = createFridayChannelTypingController({
      emitTyping,
      pulseMs: 1000,
    });

    controller.seal();
    controller.start(); // should be a no-op
    vi.advanceTimersByTime(5000);
    expect(emitTyping).toHaveBeenCalledTimes(0);
  });

  it("stops automatically after TTL expires", () => {
    const emitTyping = vi.fn();
    const controller = createFridayChannelTypingController({
      emitTyping,
      pulseMs: 1000,
      ttlMs: 3000,
    });

    controller.start();
    expect(emitTyping).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1000);
    expect(emitTyping).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(1000);
    expect(emitTyping).toHaveBeenCalledTimes(3);

    // TTL expires at 3000ms
    vi.advanceTimersByTime(1000);
    const countAtTtl = emitTyping.mock.calls.length;

    vi.advanceTimersByTime(5000);
    expect(emitTyping).toHaveBeenCalledTimes(countAtTtl);
  });

  it("uses default 6s pulse when pulseMs not specified", () => {
    const emitTyping = vi.fn();
    const controller = createFridayChannelTypingController({ emitTyping });

    controller.start();
    expect(emitTyping).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(5999);
    expect(emitTyping).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1);
    expect(emitTyping).toHaveBeenCalledTimes(2);

    controller.seal();
  });
});

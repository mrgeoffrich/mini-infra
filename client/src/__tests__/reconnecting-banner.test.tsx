/**
 * Tests for the global "reconnecting to server…" banner (Phase 6 of
 * docs/planning/not-shipped/frontend-backend-contract-plan.md).
 *
 * Drives a fake Socket.IO client through connect/disconnect/connect and
 * asserts the banner's show/hide logic:
 *   - hidden while the socket has never connected (first page-load handshake)
 *   - still hidden immediately after the first successful connect
 *   - shown once a previously-connected socket drops
 *   - hidden again the instant it reconnects
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen, act } from "@testing-library/react";

// vi.mock factories (and vi.hoisted callbacks) are hoisted above all
// imports, so the fake socket is built from scratch here rather than
// importing an event-emitter implementation.
const { fakeSocket } = vi.hoisted(() => {
  type Handler = (...args: unknown[]) => void;

  function createFakeSocket() {
    const listeners = new Map<string, Set<Handler>>();
    const socket = {
      connected: false,
      // use-socket.ts logs a "reconnect" success via socket.io.on(...) —
      // stub it out, no assertions depend on it.
      io: { on: () => {}, off: () => {} },
      on(event: string, cb: Handler) {
        if (!listeners.has(event)) listeners.set(event, new Set());
        listeners.get(event)!.add(cb);
      },
      off(event: string, cb: Handler) {
        listeners.get(event)?.delete(cb);
      },
      emit(event: string, ...args: unknown[]) {
        listeners.get(event)?.forEach((cb) => cb(...args));
      },
      connect() {
        socket.connected = true;
        socket.emit("connect");
      },
      disconnect() {
        socket.connected = false;
        socket.emit("disconnect");
      },
    };
    return socket;
  }

  return { fakeSocket: createFakeSocket() };
});

vi.mock("socket.io-client", () => ({
  io: () => fakeSocket,
}));

import { ReconnectingBanner } from "@/components/reconnecting-banner";

describe("ReconnectingBanner", () => {
  it("stays hidden on initial load, appears after a drop, hides again on reconnect", () => {
    render(<ReconnectingBanner />);

    // Initial load: the socket hasn't connected yet at all — must not alarm.
    expect(screen.queryByRole("status")).not.toBeInTheDocument();

    // First successful handshake — still no banner, we've never dropped.
    act(() => {
      fakeSocket.connect();
    });
    expect(screen.queryByRole("status")).not.toBeInTheDocument();

    // The connection drops after having been established — now show it.
    act(() => {
      fakeSocket.disconnect();
    });
    const banner = screen.getByRole("status");
    expect(banner).toBeInTheDocument();
    expect(banner).toHaveAttribute("aria-live", "polite");
    expect(screen.getByText(/reconnecting to server/i)).toBeInTheDocument();

    // Reconnects — banner clears automatically.
    act(() => {
      fakeSocket.connect();
    });
    expect(screen.queryByRole("status")).not.toBeInTheDocument();

    // A further drop shows it again (not a one-shot latch in the wrong direction).
    act(() => {
      fakeSocket.disconnect();
    });
    expect(screen.getByRole("status")).toBeInTheDocument();
  });
});

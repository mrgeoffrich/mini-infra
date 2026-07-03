import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import {
  ApiRoute,
  Channel,
  queryKeys,
  ServerEvent,
  type TailscaleDeviceStatus,
  type TailscaleDeviceStatusEvent,
  type TailscaleDevicesResponse,
} from "@mini-infra/types";
import { useSocket, useSocketChannel, useSocketEvent } from "./use-socket";
import { apiFetch } from "@/lib/api-client";

const POLL_INTERVAL_DISCONNECTED = 30_000;

async function fetchTailscaleDevices(): Promise<TailscaleDevicesResponse> {
  // Raw (non-enveloped) endpoint — returns the snapshot body directly.
  return apiFetch<TailscaleDevicesResponse>(ApiRoute.tailscaleDevices.list(), {
    correlationIdPrefix: "tailscale-devices",
    unwrap: false,
  });
}

/**
 * Live device-status hook for the Connect panel.
 *
 * Subscribes to the `tailscale` Socket.IO channel and patches the device
 * map in place when `tailscale:device:online` / `tailscale:device:offline`
 * events arrive — no full re-fetch per event. Polling falls back to 30s
 * only when the socket is disconnected (per `client/CLAUDE.md`'s
 * data-fetching rules); `refetchOnReconnect: true` covers events missed
 * during a brief disconnection.
 */
export function useTailscaleDevices() {
  const { connected } = useSocket();
  const queryClient = useQueryClient();

  useSocketChannel(Channel.TAILSCALE);

  const patchDevice = useCallback(
    (incoming: TailscaleDeviceStatus) => {
      queryClient.setQueryData<TailscaleDevicesResponse>(
        queryKeys.tailscaleDevices.all,
        (prev) => {
          if (!prev) return prev;
          const others = prev.devices.filter((d) => d.id !== incoming.id);
          return {
            ...prev,
            devices: [...others, incoming],
          };
        },
      );
    },
    [queryClient],
  );

  useSocketEvent(
    ServerEvent.TAILSCALE_DEVICE_ONLINE,
    (data: TailscaleDeviceStatusEvent) => patchDevice(data.device),
  );
  useSocketEvent(
    ServerEvent.TAILSCALE_DEVICE_OFFLINE,
    (data: TailscaleDeviceStatusEvent) => patchDevice(data.device),
  );

  const query = useQuery({
    queryKey: queryKeys.tailscaleDevices.all,
    queryFn: fetchTailscaleDevices,
    refetchInterval: connected ? false : POLL_INTERVAL_DISCONNECTED,
    refetchOnReconnect: true,
  });

  return query;
}

/**
 * Convenience selector — turn the device array into a hostname → status map
 * for O(1) lookups from per-row components.
 */
export function indexDevicesByHostname(
  devices: TailscaleDeviceStatus[] | undefined,
): Map<string, TailscaleDeviceStatus> {
  const map = new Map<string, TailscaleDeviceStatus>();
  if (!devices) return map;
  for (const device of devices) {
    map.set(device.hostname, device);
  }
  return map;
}

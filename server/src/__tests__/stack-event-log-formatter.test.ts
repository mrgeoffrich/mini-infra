import { describe, it, expect } from 'vitest';
import {
  formatPlanStep,
  formatServiceStep,
  formatResourceGroupStep,
  formatDestroyContainerStep,
  formatDestroyNetworkStep,
  formatDestroyVolumeStep,
  formatDestroyResourceStep,
} from '../services/stacks/stack-event-log-formatter';
import { ServiceApplyResult, ResourceResult } from '@mini-infra/types';

describe('stack-event-log-formatter', () => {
  describe('formatPlanStep', () => {
    it('formats plan summary with action counts', () => {
      const result = formatPlanStep(1, 5, {
        creates: 2,
        recreates: 1,
        removes: 0,
        updates: 0,
      });
      expect(result).toBe(
        '[1/5] Planning stack changes...\n' +
        '      → 2 to create, 1 to recreate, 0 to remove\n'
      );
    });

    it('includes updates count when non-zero', () => {
      const result = formatPlanStep(1, 3, {
        creates: 0,
        recreates: 0,
        removes: 0,
        updates: 2,
      });
      expect(result).toBe(
        '[1/3] Planning stack changes...\n' +
        '      → 0 to create, 0 to recreate, 0 to remove, 2 to update\n'
      );
    });
  });

  describe('formatServiceStep', () => {
    it('formats a successful create action', () => {
      const result: ServiceApplyResult = {
        serviceName: 'postgres',
        action: 'create',
        success: true,
        duration: 2300,
      };
      const output = formatServiceStep(2, 5, result);
      expect(output).toBe(
        '[2/5] Creating service: postgres\n' +
        '      ✓ Completed (2.3s)\n'
      );
    });

    it('formats a successful recreate action', () => {
      const result: ServiceApplyResult = {
        serviceName: 'web-app',
        action: 'recreate',
        success: true,
        duration: 4100,
      };
      const output = formatServiceStep(3, 5, result);
      expect(output).toBe(
        '[3/5] Recreating service: web-app\n' +
        '      ✓ Completed (4.1s)\n'
      );
    });

    it('formats a successful remove action', () => {
      const result: ServiceApplyResult = {
        serviceName: 'old-worker',
        action: 'remove',
        success: true,
        duration: 500,
      };
      const output = formatServiceStep(4, 5, result);
      expect(output).toBe(
        '[4/5] Removing service: old-worker\n' +
        '      ✓ Completed (0.5s)\n'
      );
    });

    it('formats a successful update action', () => {
      const result: ServiceApplyResult = {
        serviceName: 'web',
        action: 'update',
        success: true,
        duration: 3200,
      };
      const output = formatServiceStep(2, 3, result);
      expect(output).toBe(
        '[2/3] Updating service: web\n' +
        '      ✓ Completed (3.2s)\n'
      );
    });

    it('formats a failed action with error', () => {
      const result: ServiceApplyResult = {
        serviceName: 'web-app',
        action: 'create',
        success: false,
        duration: 1200,
        error: 'port 8080 already in use',
      };
      const output = formatServiceStep(2, 5, result);
      expect(output).toBe(
        '[2/5] Creating service: web-app\n' +
        '      ✗ Failed (1.2s)\n' +
        '        Error: port 8080 already in use\n'
      );
    });

    it('formats a failed action without error message', () => {
      const result: ServiceApplyResult = {
        serviceName: 'redis',
        action: 'create',
        success: false,
        duration: 800,
      };
      const output = formatServiceStep(3, 5, result);
      expect(output).toBe(
        '[3/5] Creating service: redis\n' +
        '      ✗ Failed (0.8s)\n'
      );
    });
  });

  describe('formatResourceGroupStep', () => {
    it('formats successful TLS results', () => {
      const results: ResourceResult[] = [
        { resourceType: 'tls', resourceName: 'web.example.com', action: 'create', success: true },
      ];
      const output = formatResourceGroupStep(4, 5, 'tls', results);
      expect(output).toBe(
        '[4/5] Reconciling TLS certificates\n' +
        '      ✓ web.example.com — create\n'
      );
    });

    it('formats mixed success/failure DNS results', () => {
      const results: ResourceResult[] = [
        { resourceType: 'dns', resourceName: 'web.example.com', action: 'create', success: true },
        { resourceType: 'dns', resourceName: 'api.example.com', action: 'create', success: false, error: 'Rate limited' },
      ];
      const output = formatResourceGroupStep(5, 6, 'dns', results);
      expect(output).toBe(
        '[5/6] Reconciling DNS records\n' +
        '      ✓ web.example.com — create\n' +
        '      ✗ api.example.com — create: Rate limited\n'
      );
    });

    it('formats tunnel results', () => {
      const results: ResourceResult[] = [
        { resourceType: 'tunnel', resourceName: 'web-tunnel', action: 'create', success: true },
      ];
      const output = formatResourceGroupStep(6, 6, 'tunnel', results);
      expect(output).toBe(
        '[6/6] Reconciling tunnel ingress\n' +
        '      ✓ web-tunnel — create\n'
      );
    });
  });

  describe('formatDestroyContainerStep', () => {
    it('formats container removal step', () => {
      const output = formatDestroyContainerStep(2, 5, 3, 3);
      expect(output).toBe(
        '[2/5] Removing containers\n' +
        '      ✓ 3 of 3 containers removed\n'
      );
    });

    it('formats partial container removal', () => {
      const output = formatDestroyContainerStep(2, 5, 2, 3);
      expect(output).toBe(
        '[2/5] Removing containers\n' +
        '      ✗ 2 of 3 containers removed (1 failed)\n'
      );
    });
  });

  describe('formatDestroyNetworkStep', () => {
    it('formats network removal', () => {
      const output = formatDestroyNetworkStep(3, 5, ['net-a', 'net-b']);
      expect(output).toBe(
        '[3/5] Removing networks\n' +
        '      ✓ Removed: net-a, net-b\n'
      );
    });

    it('formats no networks removed', () => {
      const output = formatDestroyNetworkStep(3, 5, []);
      expect(output).toBe(
        '[3/5] Removing networks\n' +
        '      ✓ No networks to remove\n'
      );
    });
  });

  describe('formatDestroyVolumeStep', () => {
    it('formats volume removal', () => {
      const output = formatDestroyVolumeStep(4, 5, ['vol-a']);
      expect(output).toBe(
        '[4/5] Removing volumes\n' +
        '      ✓ Removed: vol-a\n'
      );
    });

    it('formats no volumes removed', () => {
      const output = formatDestroyVolumeStep(4, 5, []);
      expect(output).toBe(
        '[4/5] Removing volumes\n' +
        '      ✓ No volumes to remove\n'
      );
    });
  });

  describe('formatDestroyResourceStep', () => {
    it('formats resource destruction step', () => {
      const output = formatDestroyResourceStep(1, 5, true);
      expect(output).toBe(
        '[1/5] Destroying stack resources (TLS, DNS, tunnels)\n' +
        '      ✓ Resources cleaned up\n'
      );
    });

    it('formats failed resource destruction', () => {
      const output = formatDestroyResourceStep(1, 5, false, 'Cloudflare API error');
      expect(output).toBe(
        '[1/5] Destroying stack resources (TLS, DNS, tunnels)\n' +
        '      ✗ Failed: Cloudflare API error\n'
      );
    });
  });
});

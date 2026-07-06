import { stackNetworkName, resourceNetworkName, egressNetworkName } from '../network-names';

describe('network-names', () => {
  describe('stackNetworkName', () => {
    it('joins project name and network name with an underscore (docker-compose convention)', () => {
      expect(stackNetworkName('mini-infra-monitoring', 'default')).toBe('mini-infra-monitoring_default');
      expect(stackNetworkName('prod-webapp', 'app_network')).toBe('prod-webapp_app_network');
    });
  });

  describe('resourceNetworkName', () => {
    it('uses `<environment>-<purpose>` when an environment name is given', () => {
      expect(resourceNetworkName('applications', 'prod')).toBe('prod-applications');
    });

    it('uses `mini-infra-<purpose>` for host-scoped resources (no environment)', () => {
      expect(resourceNetworkName('vault')).toBe('mini-infra-vault');
      expect(resourceNetworkName('vault', null)).toBe('mini-infra-vault');
      expect(resourceNetworkName('vault', undefined)).toBe('mini-infra-vault');
    });
  });

  describe('egressNetworkName', () => {
    it('derives `<environment>-egress`, matching resourceNetworkName with purpose "egress"', () => {
      expect(egressNetworkName('staging')).toBe('staging-egress');
      expect(egressNetworkName('staging')).toBe(resourceNetworkName('egress', 'staging'));
    });
  });
});

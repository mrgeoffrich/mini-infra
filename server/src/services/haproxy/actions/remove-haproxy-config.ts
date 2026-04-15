import { getLogger } from '../../../lib/logger-factory';

const logger = getLogger("haproxy", "remove-haproxy-config");

export class RemoveHAProxyConfig {
    execute(): void {
        logger.info('Action: Removing backend and servers from HAProxy...');
    }
}